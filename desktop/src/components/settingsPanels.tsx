import { useState, useEffect } from 'react'
import { useLanguage } from '../LanguageContext'

/**
 * Settings panels lifted verbatim out of App.tsx.
 *
 * They were defined inline above the shell component, which is why App.tsx was
 * 1000 lines of navigation mixed with Firestore credential forms. Behaviour is
 * unchanged — only the address moved. SettingsScreen.tsx mounts them.
 */

// Helper component for Sync Address
/** Firestore relay settings. Lets the phone work away from the shop; the LAN
 *  server stays the fast path when both are on shop wifi. Credentials live in the
 *  local config table, never in the repo. */
function CloudSyncSettings() {
  const [cfg, setCfg] = useState<Record<string, string>>({
    apiKey: '', authDomain: '', projectId: '', appId: '', shopId: '', email: '', password: ''
  })
  const [enabled, setEnabled] = useState(false)
  const [hasPassword, setHasPassword] = useState(false)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const load = async () => {
    const c = await window.electron.cloud?.getConfig?.()
    if (!c) return
    setCfg({
      apiKey: c.apiKey || '', authDomain: c.authDomain || '', projectId: c.projectId || '',
      appId: c.appId || '', shopId: c.shopId || '', email: c.email || '', password: ''
    })
    setEnabled(!!c.enabled)
    setHasPassword(!!c.hasPassword)
  }
  useEffect(() => { load() }, [])

  const save = async (extra: Record<string, string | boolean> = {}) => {
    setBusy(true); setMsg('')
    try {
      const patch: Record<string, string | boolean> = { ...cfg, enabled, ...extra }
      // Don't overwrite a stored password with an empty box.
      if (!cfg.password) delete patch.password
      await window.electron.cloud.setConfig(patch)
      await load()
      setMsg('✓ Enregistré.')
    } finally { setBusy(false) }
  }

  const test = async () => {
    setBusy(true); setMsg('')
    await save()
    const r = await window.electron.cloud.test()
    setMsg(r.success ? '✓ Connexion cloud OK.' : `✗ ${r.error}`)
    setBusy(false)
  }

  const push = async () => {
    setBusy(true); setMsg('')
    const r = await window.electron.cloud.pushCatalog()
    setMsg(r.success ? `✓ ${r.pushed} fiches envoyées au cloud.` : `✗ ${r.error}`)
    setBusy(false)
  }

  const pull = async () => {
    setBusy(true); setMsg('')
    const r = await window.electron.cloud.pullTransactions()
    setMsg(r.success ? `✓ ${r.success_count ?? 0} vente(s) récupérée(s), ${r.skipped ?? 0} déjà connue(s).` : `✗ ${r.error}`)
    setBusy(false)
  }

  const field = (key: keyof typeof cfg, label: string, placeholder = '', type = 'text') => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: '0.78em', color: 'var(--text-muted)', fontWeight: 600 }}>{label}</span>
      <input
        type={type}
        value={cfg[key]}
        placeholder={placeholder}
        onChange={e => setCfg(prev => ({ ...prev, [key]: e.target.value }))}
        style={{ padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border-light)', background: 'var(--surface-2)', color: 'var(--text-main)' }}
      />
    </label>
  )

  return (
    <div style={{ background: 'var(--bg-main)', padding: '1rem', borderRadius: 'var(--radius-md)', marginTop: '1.5rem', border: '1px solid var(--border-light)' }}>
      <label style={{ display: 'block', marginBottom: '0.35rem', fontWeight: 'bold', color: 'var(--text-main)' }}>
        Synchronisation cloud (Firestore)
      </label>
      <p style={{ color: 'var(--text-muted)', fontSize: '0.82em', marginTop: 0, lineHeight: 1.5 }}>
        Permet au téléphone de fonctionner <b>hors du magasin</b>. En boutique, le Wi-Fi local reste
        utilisé en priorité (plus rapide, marche sans internet, et c'est la seule voie pour imprimer).
        La clé Firebase est publique par nature — ce sont les règles de sécurité qui protègent les données.
      </p>

      <label style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--text-main)', margin: '10px 0 14px' }}>
        <input type="checkbox" checked={enabled} onChange={e => { setEnabled(e.target.checked); save({ enabled: e.target.checked }) }} />
        Activer la synchronisation cloud
      </label>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        {field('projectId', 'Project ID', 'mon-projet-firebase')}
        {field('apiKey', 'API key', 'AIza…')}
        {field('authDomain', 'Auth domain', 'mon-projet.firebaseapp.com')}
        {field('appId', 'App ID', '1:123…:web:abc…')}
        {field('shopId', 'Identifiant du magasin', 'boutique-1')}
        {field('email', 'Compte Firebase (email)', 'boutique@exemple.com')}
        {field('password', hasPassword ? 'Mot de passe (déjà enregistré)' : 'Mot de passe', '••••••••', 'password')}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
        <button className="btn-secondary" onClick={() => save()} disabled={busy} style={{ padding: '7px 14px' }}>Enregistrer</button>
        <button className="btn-secondary" onClick={test} disabled={busy} style={{ padding: '7px 14px' }}>Tester la connexion</button>
        <button className="btn-secondary" onClick={push} disabled={busy} style={{ padding: '7px 14px' }}>Envoyer le catalogue</button>
        <button className="btn-secondary" onClick={pull} disabled={busy} style={{ padding: '7px 14px' }}>Récupérer les ventes</button>
      </div>

      {msg && <p style={{ marginTop: 10, fontSize: '0.85em', color: msg.startsWith('✓') ? 'var(--success)' : 'var(--error)' }}>{msg}</p>}
    </div>
  )
}

function SyncAddressDisplay() {
  const { t } = useLanguage()
  const [ip, setIp] = useState<string>('Chargement…')
  const [token, setToken] = useState<string>('')

  useEffect(() => {
    if (window.electron?.getLocalIP) {
      window.electron.getLocalIP().then(setIp)
    }
    if (window.electron?.getSyncToken) {
      window.electron.getSyncToken().then(setToken)
    }
  }, [])

  return (
    <div style={{ marginTop: '8px', padding: '12px', background: 'var(--bg-main)', borderRadius: '6px', border: '1px solid var(--border-light)' }}>
      <strong>{t('set.serverAddress')} :</strong>
      <code style={{ display: 'block', padding: '8px', background: 'var(--surface)', marginTop: '4px', borderRadius: '4px', fontSize: '1.2em', border: '1px solid var(--border-light)' }}>
        http://{ip}:4000
      </code>
      <strong style={{ display: 'block', marginTop: '12px' }}>{t('set.pairingToken')} :</strong>
      <p style={{ margin: '2px 0', fontSize: '0.8em', color: 'var(--text-muted)' }}>
        {t('set.pairingHint')}
      </p>
      <code style={{ display: 'block', padding: '8px', background: 'var(--surface)', marginTop: '4px', borderRadius: '4px', fontSize: '1em', border: '1px solid var(--border-light)', wordBreak: 'break-all', userSelect: 'all' }}>
        {token || '…'}
      </code>
    </div>
  )
}

function AIUsageDisplay() {
  const { t } = useLanguage()
  const [usage, setUsage] = useState<{ tokens: number; calls: number } | null>(null)

  useEffect(() => {
    if (window.electron?.ai?.getUsage) {
      window.electron.ai.getUsage().then(setUsage).catch(() => {})
    }
  }, [])

  if (!usage) return null

  return (
    <div style={{ marginTop: '8px', padding: '12px', background: 'var(--bg-main)', borderRadius: '6px', border: '1px solid var(--border-light)', color: 'var(--text-muted)', fontSize: '0.9em' }}>
      <strong style={{ color: 'var(--text-main)' }}>{t('set.aiUsage')} :</strong>{' '}
      {usage.calls.toLocaleString()} commandes · {usage.tokens.toLocaleString()} tokens
    </div>
  )
}

const IFU_CEILING = 8_000_000

function FiscalRegimeSettings() {
  const [regime, setRegime] = useState<string>('reel')
  const [pricesTTC, setPricesTTC] = useState(false)
  const [turnover, setTurnover] = useState(0)
  const [aml, setAml] = useState('')
  const [cashRound, setCashRound] = useState(false)
  const [residency, setResidency] = useState(false)

  useEffect(() => {
    window.electron?.config?.get('regime').then(v => setRegime(v || 'reel')).catch(() => {})
    window.electron?.config?.get('prices_include_tax').then(v => setPricesTTC(v === '1')).catch(() => {})
    window.electron?.config?.get('aml_cash_threshold').then(v => setAml(v || '')).catch(() => {})
    window.electron?.config?.get('cash_rounding_5').then(v => setCashRound(v === '1')).catch(() => {})
    window.electron?.config?.get('data_residency_strict').then(v => setResidency(v === '1')).catch(() => {})
    window.electron?.report?.getStats?.().then((s: any) => setTurnover(s?.annualTurnover || 0)).catch(() => {})
  }, [])

  const saveRegime = async (v: string) => { setRegime(v); await window.electron.config.set('regime', v) }
  const savePrices = async (v: boolean) => { setPricesTTC(v); await window.electron.config.set('prices_include_tax', v ? '1' : '0') }
  const saveAml = async (v: string) => { setAml(v); await window.electron.config.set('aml_cash_threshold', v.replace(/[^\d]/g, '') || '0') }
  const saveCashRound = async (v: boolean) => { setCashRound(v); await window.electron.config.set('cash_rounding_5', v ? '1' : '0') }
  const saveResidency = async (v: boolean) => { setResidency(v); await window.electron.config.set('data_residency_strict', v ? '1' : '0') }

  return (
    <div style={{ background: 'var(--bg-main)', padding: '1rem', borderRadius: 'var(--radius-md)', marginTop: '1.5rem', border: '1px solid var(--border-light)' }}>
      <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold', color: 'var(--text-main)' }}>Régime fiscal & TVA</label>
      <div style={{ display: 'flex', gap: '1.5rem', marginBottom: '10px', color: 'var(--text-main)' }}>
        <label style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <input type="radio" name="regime" checked={regime === 'reel'} onChange={() => saveRegime('reel')} /> Réel (avec TVA)
        </label>
        <label style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <input type="radio" name="regime" checked={regime === 'ifu'} onChange={() => saveRegime('ifu')} /> IFU (sans TVA)
        </label>
      </div>
      <label style={{ display: 'flex', gap: '8px', alignItems: 'center', color: 'var(--text-muted)', fontSize: '0.9em' }}>
        <input type="checkbox" checked={pricesTTC} onChange={e => savePrices(e.target.checked)} /> Les prix saisis sont TTC (TVA incluse)
      </label>
      <label style={{ display: 'flex', gap: '8px', alignItems: 'center', color: 'var(--text-muted)', fontSize: '0.9em', marginTop: '6px' }}>
        <input type="checkbox" checked={cashRound} onChange={e => saveCashRound(e.target.checked)} /> Arrondi des espèces à 5 DA
      </label>
      <label style={{ display: 'flex', gap: '8px', alignItems: 'center', color: 'var(--text-muted)', fontSize: '0.9em', marginTop: '6px' }}>
        <input type="checkbox" checked={residency} onChange={e => saveResidency(e.target.checked)} /> Résidence des données stricte (désactive l'IA cloud — Loi 18-07)
      </label>
      <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <label style={{ fontSize: '0.8em', color: 'var(--text-muted)' }}>Seuil d'alerte paiement espèces (DA) — 0 = désactivé</label>
        <input value={aml} onChange={e => saveAml(e.target.value)} placeholder="ex: 1000000"
          style={{ padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--border-light)', background: 'var(--surface)', color: 'var(--text-main)', maxWidth: '200px' }} />
      </div>
      {regime === 'ifu' && turnover > IFU_CEILING * 0.9 && (
        <div style={{ marginTop: '10px', padding: '8px 10px', borderRadius: '6px', background: 'color-mix(in srgb, var(--warning) 14%, transparent)', border: '1px solid var(--warning)', fontSize: '0.85em', color: 'var(--text-main)' }}>
          ⚠️ Chiffre d'affaires annuel: {turnover.toLocaleString()} DA — proche du plafond IFU (8 000 000 DA). Le passage au régime réel sera bientôt requis.
        </div>
      )}
    </div>
  )
}

function CompanyFiscalSettings() {
  const [cfg, setCfg] = useState<any | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    window.electron?.receipt?.getConfig?.().then(setCfg).catch(() => {})
  }, [])

  if (!cfg) return null

  const field = (key: string, label: string) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      <label style={{ fontSize: '0.8em', color: 'var(--text-muted)' }}>{label}</label>
      <input
        value={cfg[key] ?? ''}
        onChange={e => { setCfg({ ...cfg, [key]: e.target.value }); setSaved(false) }}
        style={{ padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--border-light)', background: 'var(--surface)', color: 'var(--text-main)' }}
      />
    </div>
  )

  const save = async () => { await window.electron.receipt.saveConfig(cfg); setSaved(true) }

  return (
    <div style={{ background: 'var(--bg-main)', padding: '1rem', borderRadius: 'var(--radius-md)', marginTop: '1.5rem', border: '1px solid var(--border-light)' }}>
      <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold', color: 'var(--text-main)' }}>Identité fiscale (imprimée sur les documents)</label>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
        {field('companyName', 'Raison sociale')}
        {field('formeJuridique', 'Forme juridique (EURL, SARL…)')}
        {field('companyAddress', 'Adresse')}
        {field('companyPhone', 'Téléphone')}
        {field('nif', 'NIF')}
        {field('nis', 'NIS')}
        {field('rc', 'RC (Registre de Commerce)')}
        {field('articleImposition', "Article d'imposition")}
        {field('capital', 'Capital social')}
        {field('bankAccount', 'Compte bancaire / RIB')}
      </div>
      <label style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '10px', color: 'var(--text-muted)', fontSize: '0.9em' }}>
        <input type="checkbox" checked={!!cfg.bilingualArabic} onChange={e => { setCfg({ ...cfg, bilingualArabic: e.target.checked }); setSaved(false) }} />
        Documents bilingues (arabe + français) — Loi 91-05
      </label>
      <button onClick={save} className="btn-secondary" style={{ marginTop: '12px', padding: '8px 16px' }}>
        {saved ? '✓ Enregistré' : 'Enregistrer'}
      </button>
    </div>
  )
}

function PricingRulesSettings() {
  const { t } = useLanguage()
  const [rules, setRules] = useState<any[]>([])
  const [products, setProducts] = useState<any[]>([])
  const [form, setForm] = useState({ productId: '', minQty: '10', type: 'percentage', value: '5' })

  const load = () => {
    window.electron?.pricing?.listRules?.().then(setRules).catch(() => {})
  }
  useEffect(() => {
    load()
    window.electron?.product?.getAll?.({}).then((p: any[]) => setProducts(p || [])).catch(() => {})
  }, [])

  const add = async () => {
    if (!form.productId) return
    const prod = products.find(p => String(p.id) === form.productId)
    await window.electron.pricing.createRule({
      name: `Remise ${prod?.name || ''} ≥${form.minQty}`,
      rule_type: 'bulk',
      product_id: Number(form.productId),
      min_quantity: Number(form.minQty) || 1,
      discount_type: form.type,
      discount_value: Number(form.value) || 0,
    })
    load()
  }
  const remove = async (id: number) => { await window.electron.pricing.deleteRule(id); load() }

  const sel = { padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--border-light)', background: 'var(--surface)', color: 'var(--text-main)' } as const

  return (
    <div style={{ background: 'var(--bg-main)', padding: '1rem', borderRadius: 'var(--radius-md)', marginTop: '1.5rem', border: '1px solid var(--border-light)' }}>
      <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold', color: 'var(--text-main)' }}>{t('set.bulkTitle')}</label>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'end', marginBottom: '12px' }}>
        <select value={form.productId} onChange={e => setForm({ ...form, productId: e.target.value })} style={{ ...sel, minWidth: '180px' }}>
          <option value="">{t('set.anyProduct')}</option>
          {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontSize: '0.7em', color: 'var(--text-muted)' }}>{t('set.fromQty')}</span>
          <input type="number" value={form.minQty} onChange={e => setForm({ ...form, minQty: e.target.value })} style={{ ...sel, width: '90px' }} />
        </div>
        <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })} style={sel}>
          <option value="percentage">{t('set.pctOff')}</option>
          <option value="fixed">{t('set.daOff')}</option>
          <option value="price_override">{t('set.fixedPrice')}</option>
        </select>
        <input type="number" value={form.value} onChange={e => setForm({ ...form, value: e.target.value })} style={{ ...sel, width: '100px' }} />
        <button onClick={add} className="btn-secondary" style={{ padding: '7px 14px' }}>{t('ui.add')}</button>
      </div>
      {rules.length === 0 ? (
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85em' }}>{t('set.noRule')}</p>
      ) : (
        <table style={{ width: '100%', fontSize: '0.85em', color: 'var(--text-main)', borderCollapse: 'collapse' }}>
          <thead><tr style={{ textAlign: 'left', color: 'var(--text-muted)' }}><th>Règle</th><th>Qté min</th><th>Remise</th><th></th></tr></thead>
          <tbody>
            {rules.map(r => (
              <tr key={r.id} style={{ borderTop: '1px solid var(--border-light)' }}>
                <td style={{ padding: '4px 0' }}>{r.name}</td>
                <td>{r.min_quantity}</td>
                <td>{r.discount_type === 'percentage' ? `${r.discount_value}%` : r.discount_type === 'fixed' ? `−${r.discount_value} DA` : `${r.discount_value} DA`}</td>
                <td style={{ textAlign: 'right' }}><button onClick={() => remove(r.id)} style={{ background: 'none', border: 'none', color: 'var(--danger, #dc2626)', cursor: 'pointer' }}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

export { CloudSyncSettings, SyncAddressDisplay, AIUsageDisplay, FiscalRegimeSettings, CompanyFiscalSettings, PricingRulesSettings }
