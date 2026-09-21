import { useState, useEffect, useCallback } from 'react'
import {
    Store as StoreIcon, Monitor, ShieldCheck, Plus, Check, X,
    AlertTriangle, Pencil, Power,
} from 'lucide-react'
import type { Store, PosTerminal, RoleLimits } from '../vite-env'
import { TerminalModePanel } from './TerminalModePanel'
import { CloudMirrorPanel } from './CloudMirrorPanel'
import './StoreSettings.css'

interface Props {
    userId: number
    /** Called after a change that moves this terminal, so the shell can re-read. */
    onStoreChanged?: () => void
}

type Tab = 'stores' | 'terminals' | 'roles'

/**
 * Roles the database can actually hold.
 *
 * `users.role` carries a CHECK constraint allowing exactly these four, so this
 * list is the truth — NOT the keys of the grant map in Migration 35, which also
 * seeds `stock_manager` against a future widening of that CHECK. Listing a role
 * here that no user row can hold would let the owner spend time configuring
 * permissions that can never apply to anybody.
 */
const ROLES: { value: string; label: string; hint: string }[] = [
    { value: 'owner', label: 'Propriétaire', hint: 'Accès total, y compris les paramètres et l’audit.' },
    { value: 'manager', label: 'Gérant', hint: 'Tout le commerce et les rapports, sauf les paramètres.' },
    { value: 'cashier', label: 'Caissier', hint: 'La caisse : vendre, échanger, ouvrir et clôturer.' },
    { value: 'warehouse', label: 'Responsable stock', hint: 'Stock, inventaires, transferts et achats.' },
]

interface PermissionRow {
    code: string
    category: string
    label_fr: string
    label_ar: string
    is_sensitive: number
}

const CATEGORY_LABELS: Record<string, string> = {
    sales: 'Ventes', products: 'Produits', inventory: 'Stock',
    purchases: 'Achats', customers: 'Clients', employees: 'Employés',
    cash: 'Caisse', finance: 'Finance', reports: 'Rapports',
    stores: 'Magasins', settings: 'Paramètres',
}

const blankStore = () => ({
    code: '', name: '', address: '', city: '', phone: '', email: '',
    nif: '', nis: '', rc: '', article_imposition: '',
})

export function StoreSettings({ userId, onStoreChanged }: Props) {
    const [tab, setTab] = useState<Tab>('stores')
    const [stores, setStores] = useState<Store[]>([])
    const [terminals, setTerminals] = useState<PosTerminal[]>([])
    const [currentStoreId, setCurrentStoreId] = useState<number | null>(null)
    const [currentTerminalId, setCurrentTerminalId] = useState<number | null>(null)
    const [deviceId, setDeviceId] = useState('')
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)

    // stores tab
    const [editing, setEditing] = useState<number | 'new' | null>(null)
    const [draft, setDraft] = useState<Record<string, string>>(blankStore())

    // roles tab
    const [permissions, setPermissions] = useState<PermissionRow[]>([])
    const [role, setRole] = useState('cashier')
    const [granted, setGranted] = useState<Set<string>>(new Set())
    const [limits, setLimits] = useState<RoleLimits | null>(null)
    const [saved, setSaved] = useState(false)

    const load = useCallback(async () => {
        setStores(await window.electron.store.list(true))
        setTerminals(await window.electron.terminal.list())
        setCurrentStoreId(await window.electron.store.currentId())
        setCurrentTerminalId(await window.electron.terminal.currentId())
        setDeviceId(await window.electron.terminal.deviceId())
        setPermissions(await window.electron.permission.catalogue())
    }, [])

    useEffect(() => { load() }, [load])

    // Reads the ROLE's grants and the ROLE's limits. `permission.limits(userId)`
    // would answer for whoever is logged in — an owner editing the cashier role
    // would see their own 100 % ceiling and save it onto the cashier.
    const loadRole = useCallback(async (r: string) => {
        setGranted(new Set(await window.electron.permission.forRole(r)))
        setLimits(await window.electron.permission.roleLimits(r))
        setSaved(false)
    }, [])

    useEffect(() => { loadRole(role) }, [role, loadRole])

    // --- stores ------------------------------------------------------------

    const startEdit = (s: Store) => {
        setEditing(s.id)
        setDraft({
            code: s.code, name: s.name, address: s.address ?? '', city: s.city ?? '',
            phone: s.phone ?? '', email: s.email ?? '', nif: s.nif ?? '', nis: s.nis ?? '',
            rc: s.rc ?? '', article_imposition: s.article_imposition ?? '',
        })
    }

    const saveStore = async () => {
        if (!draft.name.trim() || !draft.code.trim()) {
            setError('Le code et le nom du magasin sont obligatoires.')
            return
        }
        setBusy(true); setError('')
        try {
            const res = editing === 'new'
                ? await window.electron.store.create({ ...draft, code: draft.code, name: draft.name }, userId)
                : await window.electron.store.update(editing as number, draft, userId)
            if (!res.ok) { setError(res.message); return }
            setEditing(null)
            await load()
            onStoreChanged?.()
        } finally { setBusy(false) }
    }

    const toggleActive = async (s: Store) => {
        setBusy(true); setError('')
        try {
            const res = s.is_active
                ? await window.electron.store.deactivate(s.id, userId)
                : await window.electron.store.update(s.id, { is_active: 1 }, userId)
            if (!res.ok) { setError(res.message); return }
            await load()
            onStoreChanged?.()
        } finally { setBusy(false) }
    }

    // --- terminals ---------------------------------------------------------

    const registerHere = async (storeId: number, isServer: boolean) => {
        setBusy(true); setError('')
        try {
            const res = await window.electron.terminal.register(storeId, undefined, isServer, userId)
            if (!res.ok) { setError(res.message); return }
            await load()
            onStoreChanged?.()
        } finally { setBusy(false) }
    }

    // --- roles -------------------------------------------------------------

    const toggle = (code: string) => {
        setSaved(false)
        setGranted(prev => {
            const next = new Set(prev)
            if (next.has(code)) next.delete(code); else next.add(code)
            return next
        })
    }

    const saveRole = async () => {
        setBusy(true); setError('')
        try {
            const res = await window.electron.permission.setRole(role, Array.from(granted), userId)
            if (!res.ok) { setError(res.message); return }
            setSaved(true)
        } finally { setBusy(false) }
    }

    const saveLimit = async (percent: number) => {
        setBusy(true); setError('')
        try {
            const res = await window.electron.permission.setLimits(role, { max_discount_percent: percent }, userId)
            if (!res.ok) { setError(res.message); return }
            setSaved(true)
        } finally { setBusy(false) }
    }

    const byCategory = permissions.reduce<Record<string, PermissionRow[]>>((acc, p) => {
        (acc[p.category] ||= []).push(p)
        return acc
    }, {})

    return (
        <div className="stset">
            <nav className="stset-tabs">
                <button className={tab === 'stores' ? 'active' : ''} onClick={() => setTab('stores')}>
                    <StoreIcon size={15} /> Magasins
                </button>
                <button className={tab === 'terminals' ? 'active' : ''} onClick={() => setTab('terminals')}>
                    <Monitor size={15} /> Caisses
                </button>
                <button className={tab === 'roles' ? 'active' : ''} onClick={() => setTab('roles')}>
                    <ShieldCheck size={15} /> Rôles &amp; permissions
                </button>
            </nav>

            {error && (
                <div className="stset-error" role="alert">
                    <AlertTriangle size={15} /> <span>{error}</span>
                </div>
            )}

            {tab === 'stores' && (
                <section className="stset-panel">
                    <div className="stset-head">
                        <h3>Magasins</h3>
                        <button
                            className="stset-primary"
                            onClick={() => { setEditing('new'); setDraft(blankStore()) }}
                        >
                            <Plus size={15} /> Nouveau magasin
                        </button>
                    </div>

                    {editing !== null && (
                        <div className="stset-form">
                            <div className="stset-grid">
                                {[
                                    ['code', 'Code (ex. CST)'], ['name', 'Nom'],
                                    ['address', 'Adresse'], ['city', 'Ville'],
                                    ['phone', 'Téléphone'], ['email', 'E-mail'],
                                ].map(([k, label]) => (
                                    <label key={k}>
                                        <span>{label}</span>
                                        <input
                                            value={draft[k] ?? ''}
                                            onChange={e => setDraft(d => ({ ...d, [k]: e.target.value }))}
                                        />
                                    </label>
                                ))}
                            </div>

                            {/* Per establishment, not per company: an Algerian facture must
                                print the identifiers of the shop that issued it. */}
                            <h4>Identifiants fiscaux de l’établissement</h4>
                            <div className="stset-grid">
                                {[
                                    ['nif', 'NIF'], ['nis', 'NIS'],
                                    ['rc', 'Registre de commerce'], ['article_imposition', 'Article d’imposition'],
                                ].map(([k, label]) => (
                                    <label key={k}>
                                        <span>{label}</span>
                                        <input
                                            value={draft[k] ?? ''}
                                            onChange={e => setDraft(d => ({ ...d, [k]: e.target.value }))}
                                        />
                                    </label>
                                ))}
                            </div>

                            <div className="stset-actions">
                                <button className="stset-ghost" onClick={() => { setEditing(null); setError('') }}>
                                    <X size={15} /> Annuler
                                </button>
                                <button className="stset-primary" onClick={saveStore} disabled={busy}>
                                    <Check size={15} /> {busy ? 'Enregistrement…' : 'Enregistrer'}
                                </button>
                            </div>
                        </div>
                    )}

                    <table className="stset-table">
                        <thead>
                            <tr><th>Code</th><th>Nom</th><th>Ville</th><th>Téléphone</th><th>NIF</th><th>État</th><th /></tr>
                        </thead>
                        <tbody>
                            {stores.map(s => (
                                <tr key={s.id} className={s.is_active ? '' : 'inactive'}>
                                    <td className="mono">{s.code}</td>
                                    <td>
                                        {s.name}
                                        {s.id === currentStoreId && <span className="stset-here">ce poste</span>}
                                    </td>
                                    <td className="muted">{s.city || '—'}</td>
                                    <td className="muted">{s.phone || '—'}</td>
                                    <td className="muted mono">{s.nif || '—'}</td>
                                    <td>
                                        <span className={`stset-badge ${s.is_active ? 'on' : 'off'}`}>
                                            {s.is_active ? 'Actif' : 'Inactif'}
                                        </span>
                                    </td>
                                    <td className="stset-row-actions">
                                        <button onClick={() => startEdit(s)} aria-label="Modifier"><Pencil size={15} /></button>
                                        {/* Never deleted: sales, stock and cash sessions all point at the
                                            store, so removing the row would orphan the history. */}
                                        <button onClick={() => toggleActive(s)} aria-label={s.is_active ? 'Désactiver' : 'Réactiver'}>
                                            <Power size={15} />
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </section>
            )}

            {tab === 'terminals' && <TerminalModePanel userId={userId} />}
            {tab === 'terminals' && <CloudMirrorPanel userId={userId} />}

            {tab === 'terminals' && (
                <section className="stset-panel">
                    <div className="stset-head">
                        <h3>Caisses</h3>
                        <span className="stset-device">Identifiant de ce PC : <code>{deviceId || '—'}</code></span>
                    </div>

                    <p className="stset-hint">
                        Enregistrez ce PC dans son magasin. L’identifiant ci-dessus est stable :
                        après une réinstallation, ce poste retrouve la même caisse au lieu d’en créer une nouvelle.
                    </p>

                    <div className="stset-register">
                        {stores.filter(s => s.is_active).map(s => (
                            <div key={s.id} className="stset-register-card">
                                <strong>{s.name}</strong>
                                <div>
                                    <button className="stset-ghost" onClick={() => registerHere(s.id, false)} disabled={busy}>
                                        Enregistrer ce PC comme caisse
                                    </button>
                                    {/* The server PC holds this store's database and answers the
                                        other tills on the LAN — see docs/RETAIL_PLAN.md §2. */}
                                    <button className="stset-ghost" onClick={() => registerHere(s.id, true)} disabled={busy}>
                                        …comme PC serveur
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>

                    <table className="stset-table">
                        <thead>
                            <tr><th>Code</th><th>Nom</th><th>Magasin</th><th>Rôle</th><th>Vue le</th></tr>
                        </thead>
                        <tbody>
                            {terminals.length === 0 ? (
                                <tr><td colSpan={5} className="muted">Aucune caisse enregistrée.</td></tr>
                            ) : terminals.map(t => (
                                <tr key={t.id}>
                                    <td className="mono">
                                        {t.code}
                                        {t.id === currentTerminalId && <span className="stset-here">ce poste</span>}
                                    </td>
                                    <td>{t.name || '—'}</td>
                                    <td className="muted">{t.store_name || '—'}</td>
                                    <td className="muted">{t.is_server ? 'Serveur' : 'Client'}</td>
                                    <td className="muted">{t.last_seen_at || '—'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </section>
            )}

            {tab === 'roles' && (
                <section className="stset-panel">
                    <div className="stset-head">
                        <h3>Rôles &amp; permissions</h3>
                        {saved && <span className="stset-saved"><Check size={14} /> Enregistré</span>}
                    </div>

                    <p className="stset-hint">
                        Ces permissions sont appliquées côté serveur, à chaque opération — masquer un
                        bouton ne suffit jamais. Une permission retirée ici le reste après redémarrage.
                    </p>

                    <div className="stset-roles">
                        {ROLES.map(r => (
                            <button
                                key={r.value}
                                className={`stset-role ${role === r.value ? 'active' : ''}`}
                                onClick={() => setRole(r.value)}
                            >
                                <strong>{r.label}</strong>
                                <span>{r.hint}</span>
                            </button>
                        ))}
                    </div>

                    <div className="stset-limit">
                        <label>
                            <span>Remise maximale autorisée</span>
                            <div>
                                <input
                                    type="number"
                                    min={0}
                                    max={100}
                                    defaultValue={limits?.max_discount_percent ?? 0}
                                    key={role}
                                    onBlur={e => saveLimit(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                                />
                                <em>%</em>
                            </div>
                        </label>
                        <p>
                            Le plafond s’applique aussi aux remises en montant : elles sont converties
                            en pourcentage du sous-total, sinon « 5 % maximum » se contourne en saisissant
                            une somme.
                        </p>
                    </div>

                    <div className="stset-perms">
                        {Object.entries(byCategory).map(([cat, rows]) => (
                            <fieldset key={cat}>
                                <legend>{CATEGORY_LABELS[cat] ?? cat}</legend>
                                {rows.map(p => (
                                    <label key={p.code} className={p.is_sensitive ? 'sensitive' : ''}>
                                        <input
                                            type="checkbox"
                                            checked={granted.has(p.code)}
                                            onChange={() => toggle(p.code)}
                                        />
                                        <span>{p.label_fr}</span>
                                        {p.is_sensitive === 1 && <em title="Action sensible">sensible</em>}
                                    </label>
                                ))}
                            </fieldset>
                        ))}
                    </div>

                    <div className="stset-actions">
                        <button className="stset-primary" onClick={saveRole} disabled={busy}>
                            <Check size={15} /> {busy ? 'Enregistrement…' : 'Enregistrer les permissions'}
                        </button>
                    </div>
                </section>
            )}
        </div>
    )
}
