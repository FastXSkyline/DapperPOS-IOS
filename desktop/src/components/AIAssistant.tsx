import { useState, useRef, useCallback } from 'react'
import { Mic, Square, Send, X, Bot } from 'lucide-react'
import './AIAssistant.css'

type Status = 'idle' | 'recording' | 'processing'

/**
 * Desktop voice/chat copilot trigger. Records audio via MediaRecorder → ai.processVoice,
 * or sends typed text → ai.processText. Plays the returned spoken reply and shows the
 * transcript/response. The backend (capability registry + orchestrator) does the work.
 */
export function AIAssistant() {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<Status>('idle')
  const [transcript, setTranscript] = useState('')
  const [response, setResponse] = useState('')
  const [error, setError] = useState('')
  const [text, setText] = useState('')
  const [pending, setPending] = useState<{ name: string; args: any } | null>(null)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)

  const aiAvailable = typeof window !== 'undefined' && !!window.electron?.ai

  const handleResult = useCallback((result: any) => {
    setStatus('idle')
    if (!result || 'error' in result) {
      setError(result?.error || 'Erreur')
      return
    }
    setError('')
    if (result.text) setTranscript(result.text)
    setResponse(result.response || '')
    setPending(result.needsConfirmation && result.pendingAction ? result.pendingAction : null)
    if (result.audio) {
      try {
        const audio = new Audio(`data:audio/mp3;base64,${result.audio}`)
        audio.play().catch(() => { /* autoplay may be blocked; text still shown */ })
      } catch { /* ignore */ }
    }
  }, [])

  const confirmPending = async () => {
    if (!pending) return
    const action = pending
    setPending(null)
    setStatus('processing')
    try {
      const res: any = await window.electron.ai.confirmAction(action)
      setStatus('idle')
      if (!res || 'error' in res) { setError(res?.error || 'Erreur'); return }
      setResponse(res.response || '')
      if (res.audio) { try { new Audio(`data:audio/mp3;base64,${res.audio}`).play().catch(() => {}) } catch { /* ignore */ } }
    } catch (e: any) {
      setError(e?.message || 'Erreur'); setStatus('idle')
    }
  }

  const cancelPending = () => {
    setPending(null)
    setResponse('صايي، حبستها.')
  }

  const stopTracks = () => {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
  }

  const startRecording = useCallback(async () => {
    setError('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const mr = new MediaRecorder(stream)
      chunksRef.current = []
      mr.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data) }
      mr.onstop = async () => {
        setStatus('processing')
        try {
          const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
          const buf = new Uint8Array(await blob.arrayBuffer())
          handleResult(await window.electron.ai.processVoice(buf))
        } catch (e: any) {
          setError(e?.message || 'Erreur'); setStatus('idle')
        } finally {
          stopTracks()
        }
      }
      recorderRef.current = mr
      mr.start()
      setStatus('recording')
    } catch {
      setError('Micro indisponible')
      setStatus('idle')
    }
  }, [handleResult])

  const stopRecording = useCallback(() => {
    recorderRef.current?.stop()
    recorderRef.current = null
  }, [])

  const toggleMic = () => {
    if (status === 'recording') stopRecording()
    else if (status === 'idle') startRecording()
  }

  const sendText = async () => {
    const t = text.trim()
    if (!t || status === 'processing') return
    setText('')
    setTranscript(t)
    setResponse('')
    setStatus('processing')
    setError('')
    try {
      handleResult(await window.electron.ai.processText(t))
    } catch (e: any) {
      setError(e?.message || 'Erreur'); setStatus('idle')
    }
  }

  const closePanel = () => {
    if (status === 'recording') stopRecording()
    setOpen(false)
  }

  if (!aiAvailable) return null

  return (
    <>
      {open && (
        <div className="ai-panel glass glass--thick">
          <div className="ai-panel-head">
            <span className="ai-title"><Bot size={16} /> Assistant</span>
            <button className="ai-close" onClick={closePanel} aria-label="Fermer"><X size={16} /></button>
          </div>

          <div className="ai-convo">
            {transcript && <div className="ai-bubble ai-user">{transcript}</div>}
            {response && <div className="ai-bubble ai-bot">{response}</div>}
            {pending && (
              <div className="ai-confirm-row">
                <button className="ai-confirm-yes" onClick={confirmPending}>Confirmer</button>
                <button className="ai-confirm-no" onClick={cancelPending}>Annuler</button>
              </div>
            )}
            {error && <div className="ai-bubble ai-error">{error}</div>}
            {status === 'recording' && <div className="ai-status">🎙️ كي تسمع… (clic pour arrêter)</div>}
            {status === 'processing' && <div className="ai-status">…</div>}
            {!transcript && !response && !error && status === 'idle' && (
              <div className="ai-hint">
                Parlez ou écrivez, en darija / français / عربية :<br />
                « warini stock » · « ch7al rebe7na lyoum » · « zid produit tricot b 1200 » · « chkoun li kraydin »
              </div>
            )}
          </div>

          <div className="ai-input-row">
            <button
              className={`ai-mic ${status === 'recording' ? 'recording' : ''}`}
              onClick={toggleMic}
              disabled={status === 'processing'}
              aria-label={status === 'recording' ? 'Arrêter' : 'Parler'}
            >
              {status === 'recording' ? <Square size={16} /> : <Mic size={16} />}
            </button>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') sendText() }}
              placeholder="Écrire une commande…"
              disabled={status === 'processing'}
            />
            <button className="ai-send" onClick={sendText} disabled={!text.trim() || status === 'processing'} aria-label="Envoyer">
              <Send size={16} />
            </button>
          </div>
        </div>
      )}

      <div className="ai-fab-wrap">
        <button
          className={`ai-fab ${open ? 'open' : ''} ${status === 'recording' ? 'recording' : ''}`}
          onClick={() => (open ? closePanel() : setOpen(true))}
          aria-label="Assistant"
          title="Assistant"
        >
          {status === 'recording' ? <Square size={22} /> : open ? <X size={22} /> : <Bot size={22} />}
        </button>
      </div>
    </>
  )
}
