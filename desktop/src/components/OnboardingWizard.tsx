import { useState, useEffect } from 'react'

interface Props { onDone: () => void }

// First-run setup (Phase 6.2): collect the Algeria-correct essentials so the
// app prints compliant documents from day one. Saved to config + receipt config.
export function OnboardingWizard({ onDone }: Props) {
    const [step, setStep] = useState(0)
    const [companyName, setCompanyName] = useState('')
    const [formeJuridique, setFormeJuridique] = useState('')
    const [nif, setNif] = useState('')
    const [nis, setNis] = useState('')
    const [rc, setRc] = useState('')
    const [ai, setAi] = useState('')
    const [regime, setRegime] = useState('reel')
    const [pricesTTC, setPricesTTC] = useState(false)
    const [bilingual, setBilingual] = useState(false)
    const [printers, setPrinters] = useState<string[]>([])
    const [printer, setPrinter] = useState('')

    useEffect(() => {
        window.electron?.getPrinters?.().then((p: any[]) => setPrinters((p || []).map(x => x.name || x))).catch(() => {})
    }, [])

    const finish = async () => {
        await window.electron.config.set('regime', regime)
        await window.electron.config.set('prices_include_tax', pricesTTC ? '1' : '0')
        const cfg = await window.electron.receipt.getConfig()
        await window.electron.receipt.saveConfig({ ...cfg, companyName, formeJuridique, nif, nis, rc, articleImposition: ai, bilingualArabic: bilingual })
        if (printer) {
            try {
                const pc = await window.electron.settings.getPrinterConfig()
                await window.electron.settings.savePrinterConfig({ ...(pc || {}), receipt: printer, order: printer })
            } catch { /* ignore */ }
        }
        await window.electron.config.set('onboarded', '1')
        onDone()
    }

    const inp: React.CSSProperties = { padding: '11px 14px', borderRadius: 'var(--r-sm)', border: '1px solid var(--border-light)', background: 'var(--surface)', color: 'var(--text-main)', width: '100%', fontSize: '15px', outlineColor: 'var(--accent)' }
    const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(8,4,14,0.55)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '20px' }
    const panel: React.CSSProperties = { background: 'var(--lg-thick-bg)', backdropFilter: 'blur(var(--lg-blur-thick)) saturate(var(--lg-saturate))', WebkitBackdropFilter: 'blur(var(--lg-blur-thick)) saturate(var(--lg-saturate))', borderRadius: 'var(--r-2xl)', padding: '32px', width: 'min(560px, 94vw)', maxHeight: '90vh', overflowY: 'auto', border: '1px solid var(--lg-border)', boxShadow: 'var(--lg-highlight), var(--shadow-float)' }
    const field = (label: string, node: React.ReactNode, required = false) => (
        <div style={{ marginBottom: '12px' }}>
            <label style={{ display: 'block', fontSize: '0.82em', color: 'var(--text-muted)', marginBottom: '4px' }}>
                {label}{required && <span style={{ color: 'var(--error, #ff3b30)' }}> *</span>}
            </label>
            {node}
        </div>
    )

    // Fiscal identity is LEGALLY REQUIRED for a facture conforme (décret 05-468),
    // so onboarding is mandatory — the client cannot skip it or go live without it.
    const step0Valid = companyName.trim() !== '' && formeJuridique.trim() !== ''
    const step1Valid = nif.trim() !== '' && nis.trim() !== '' && rc.trim() !== '' && ai.trim() !== ''
    const stepValid = step === 0 ? step0Valid : step === 1 ? step1Valid : true
    const allValid = step0Valid && step1Valid
    const reqInput = (val: string): React.CSSProperties => ({ ...inp, borderColor: val.trim() === '' ? 'var(--error, #ff3b30)' : 'var(--border-light)' })

    return (
        <div style={overlay}>
            <div style={panel}>
                <h2 style={{ marginTop: 0, color: 'var(--text-main)' }}>Bienvenue 👋 — Configuration initiale</h2>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.88em', marginTop: 0 }}>Quelques informations pour des documents conformes (étape {step + 1}/3).</p>

                {step === 0 && (
                    <div>
                        {field('Raison sociale', <input style={reqInput(companyName)} value={companyName} onChange={e => setCompanyName(e.target.value)} placeholder="Ex: SARL El Baraka" />, true)}
                        {field('Forme juridique', <input style={reqInput(formeJuridique)} value={formeJuridique} onChange={e => setFormeJuridique(e.target.value)} placeholder="EURL / SARL / Personne physique…" />, true)}
                    </div>
                )}
                {step === 1 && (
                    <div>
                        {field('NIF (Numéro d\'Identification Fiscale)', <input style={reqInput(nif)} value={nif} onChange={e => setNif(e.target.value)} />, true)}
                        {field('NIS', <input style={reqInput(nis)} value={nis} onChange={e => setNis(e.target.value)} />, true)}
                        {field('RC (Registre de Commerce)', <input style={reqInput(rc)} value={rc} onChange={e => setRc(e.target.value)} />, true)}
                        {field('Article d\'imposition', <input style={reqInput(ai)} value={ai} onChange={e => setAi(e.target.value)} />, true)}
                    </div>
                )}
                {step === 2 && (
                    <div>
                        {field('Régime fiscal', (
                            <div style={{ display: 'flex', gap: '16px', color: 'var(--text-main)' }}>
                                <label style={{ display: 'flex', gap: '6px', alignItems: 'center' }}><input type="radio" checked={regime === 'reel'} onChange={() => setRegime('reel')} /> Réel (avec TVA)</label>
                                <label style={{ display: 'flex', gap: '6px', alignItems: 'center' }}><input type="radio" checked={regime === 'ifu'} onChange={() => setRegime('ifu')} /> IFU (sans TVA)</label>
                            </div>
                        ))}
                        <label style={{ display: 'flex', gap: '8px', alignItems: 'center', color: 'var(--text-main)', fontSize: '0.9em', marginBottom: '10px' }}>
                            <input type="checkbox" checked={pricesTTC} onChange={e => setPricesTTC(e.target.checked)} /> Les prix saisis sont TTC
                        </label>
                        <label style={{ display: 'flex', gap: '8px', alignItems: 'center', color: 'var(--text-main)', fontSize: '0.9em', marginBottom: '10px' }}>
                            <input type="checkbox" checked={bilingual} onChange={e => setBilingual(e.target.checked)} /> Documents bilingues (arabe + français)
                        </label>
                        {printers.length > 0 && field('Imprimante par défaut', (
                            <select style={inp} value={printer} onChange={e => setPrinter(e.target.value)}>
                                <option value="">— Aucune —</option>
                                {printers.map(p => <option key={p} value={p}>{p}</option>)}
                            </select>
                        ))}
                    </div>
                )}

                {!stepValid && (
                    <p style={{ color: 'var(--error, #ff3b30)', fontSize: '0.8em', margin: '4px 0 0' }}>
                        Tous les champs marqués <b>*</b> sont obligatoires pour émettre des factures conformes.
                    </p>
                )}

                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '20px' }}>
                    {step > 0
                        ? <button className="btn-secondary" onClick={() => setStep(step - 1)}>Retour</button>
                        : <span />}
                    {step < 2
                        ? <button className="btn-primary" disabled={!stepValid} style={{ opacity: stepValid ? 1 : 0.5, cursor: stepValid ? 'pointer' : 'not-allowed' }} onClick={() => stepValid && setStep(step + 1)}>Suivant</button>
                        : <button className="btn-primary" disabled={!allValid} style={{ opacity: allValid ? 1 : 0.5, cursor: allValid ? 'pointer' : 'not-allowed' }} onClick={() => allValid && finish()}>Terminer</button>}
                </div>
            </div>
        </div>
    )
}
