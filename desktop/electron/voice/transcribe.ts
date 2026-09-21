import OpenAI from 'openai'

let _openai: OpenAI | null = null;
function getOpenAI() {
    if (!_openai) {
        _openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY || ''
        })
    }
    return _openai
}

export async function transcribeAudio(audioBuffer: Buffer, filename: string = 'voice.webm'): Promise<string | null> {
    try {
        const openai = getOpenAI()

        // Whisper detects the container by the filename extension. Desktop records webm;
        // mobile sends its actual extension (m4a/caf) via the /ai/voice route.
        const safeName = /\.(webm|m4a|mp3|mp4|wav|ogg|caf|aac|flac)$/i.test(filename) ? filename : 'voice.webm'
        const file = await OpenAI.toFile(audioBuffer, safeName)

        const transcription = await openai.audio.transcriptions.create({
            file: file,
            model: "whisper-1",
            // Prompt helps Whisper recognize the Algerian accent and POS context
            prompt: "zid depense ta3 lgaz b 500 dinar. dir bon de commande. wri les produits. safye dertha."
        })

        console.log('[Transcribe] Result:', transcription.text)
        return transcription.text
    } catch (e) {
        console.error('[Transcribe] Error:', e)
        return null
    }
}
