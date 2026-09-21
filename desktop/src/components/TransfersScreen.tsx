import { useState, useEffect, useCallback, useMemo } from 'react'
import {
    ArrowRightLeft, Truck, PackageCheck, Plus, Search, X, Trash2,
    AlertTriangle, Clock, Check,
} from 'lucide-react'
import { formatCurrency, formatDateTime } from '../utils/formatters'
import type { Product } from '../../shared/types'
import type {
    Store, TransferRow, TransferItemRow, InTransitRow, TransferStatus, VariantWithStock,
} from '../vite-env'
import { useRetailEvents } from '../hooks/useRetailEvents'
import './TransfersScreen.css'

interface Props {
    userId: number
    storeId: number | null
}

const STATUS_LABEL: Record<TransferStatus, string> = {
    draft: 'Brouillon', requested: 'Demandé', approved: 'Approuvé', prepared: 'Préparé',
    shipped: 'Expédié', received: 'Reçu', cancelled: 'Annulé',
}

interface DraftLine {
    key: string
    productId: number
    variantId: number | null
    productName: string
    size: string | null
    color: string | null
    quantity: number
    available: number
}

const variantLabel = (l: { size: string | null; color: string | null }) =>
    [l.size, l.color].filter(Boolean).join(' · ') || '—'

/**
 * Transferts entre magasins.
 *
 * Two phases on purpose: goods leave the source when SHIPPED and arrive at the
 * destination when RECEIVED. The gap between is real — the stock is in the van —
 * and is shown as "en transit" rather than being hidden by pretending the move is
 * instantaneous. That gap is also the only way anyone notices a transfer that was
 * sent and never arrived.
 */
export function TransfersScreen({ userId, storeId }: Props) {
    const [stores, setStores] = useState<Store[]>([])
    const [transfers, setTransfers] = useState<TransferRow[]>([])
    const [inTransit, setInTransit] = useState<InTransitRow[]>([])
    const [selected, setSelected] = useState<(TransferRow & { items: TransferItemRow[] }) | null>(null)
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)
    const [notice, setNotice] = useState('')

    // creation
    const [creating, setCreating] = useState(false)
    const [fromStore, setFromStore] = useState<number | null>(storeId)
    const [toStore, setToStore] = useState<number | null>(null)
    const [notes, setNotes] = useState('')
    const [query, setQuery] = useState('')
    const [hits, setHits] = useState<Product[]>([])
    const [picked, setPicked] = useState<Product | null>(null)
    const [variants, setVariants] = useState<VariantWithStock[]>([])
    const [draftLines, setDraftLines] = useState<DraftLine[]>([])

    // per-line quantity overrides on ship / receive
    const [qtyOverride, setQtyOverride] = useState<Record<number, number>>({})

    const load = useCallback(async () => {
        const [list, transit, storeList] = await Promise.all([
            window.electron.transfer.list({ limit: 100 }),
            window.electron.transfer.inTransit(),
            window.electron.store.list(),
        ])
        setTransfers(list)
        setInTransit(transit)
        setStores(storeList)
        if (fromStore === null && storeList.length) setFromStore(storeList[0].id)
    }, [fromStore])

    useEffect(() => { load() }, [load])

    // The other store shipping to us is the whole point of watching here.
    useRetailEvents(['transfer.created', 'transfer.shipped', 'transfer.received'], load, { storeId })

    useEffect(() => {
        if (!creating) return
        const term = query.trim()
        if (term.length < 2) { setHits([]); return }
        let cancelled = false
        const t = setTimeout(async () => {
            const found = await window.electron.product.getAll({ search: term, limit: 8 })
            if (!cancelled) setHits(found)
        }, 180)
        return () => { cancelled = true; clearTimeout(t) }
    }, [query, creating])

    const choose = async (p: Product) => {
        setPicked(p)
        setVariants(p.has_variants ? await window.electron.product.getVariants(p.id) : [])
    }

    const addLine = (v: VariantWithStock | null) => {
        if (!picked) return
        const key = `${picked.id}:${v?.id ?? 0}`
        setDraftLines(prev => prev.find(l => l.key === key)
            ? prev.map(l => l.key === key ? { ...l, quantity: l.quantity + 1 } : l)
            : [...prev, {
                key,
                productId: picked.id,
                variantId: v?.id ?? null,
                productName: picked.name,
                size: v?.size ?? null,
                color: v?.color ?? null,
                quantity: 1,
                available: v?.stock_quantity ?? picked.stock_quantity ?? 0,
            }])
        setPicked(null); setVariants([]); setQuery(''); setHits([])
    }

    const resetDraft = () => {
        setCreating(false); setDraftLines([]); setNotes('')
        setPicked(null); setVariants([]); setQuery(''); setHits([]); setError('')
    }

    const submitDraft = async () => {
        if (fromStore === null || toStore === null || !draftLines.length) return
        setBusy(true); setError('')
        try {
            const res = await window.electron.transfer.create({
                fromStoreId: fromStore, toStoreId: toStore, userId, notes: notes || null,
                lines: draftLines.map(l => ({
                    productId: l.productId, variantId: l.variantId, productName: l.productName,
                    size: l.size, color: l.color, quantity: l.quantity,
                })),
            })
            if (!res.ok) { setError(res.message); return }
            setNotice(`Transfert ${res.data.transferNumber} créé.`)
            resetDraft()
            await load()
        } finally { setBusy(false) }
    }

    const open = async (id: number) => {
        setQtyOverride({})
        setError('')
        setSelected(await window.electron.transfer.get(id))
    }

    const act = async (fn: () => Promise<{ ok: true; data: unknown } | { ok: false; code: string; message: string }>, label: string) => {
        setBusy(true); setError('')
        try {
            const res = await fn()
            if (!res.ok) { setError(res.message); return }
            setNotice(label)
            if (selected) setSelected(await window.electron.transfer.get(selected.id))
            await load()
        } catch (e) {
            console.error('[Transfers] action failed:', e)
            setError('L’opération a échoué. Réessayez.')
        } finally { setBusy(false) }
    }

    const shipSelected = () => selected && act(
        () => window.electron.transfer.ship(selected.id, userId, qtyOverride),
        `${selected.transfer_number} expédié.`)

    const receiveSelected = () => selected && act(
        () => window.electron.transfer.receive(selected.id, userId, qtyOverride),
        `${selected.transfer_number} reçu.`)

    const draftTotal = useMemo(() => draftLines.reduce((n, l) => n + l.quantity, 0), [draftLines])

    const otherStores = stores.filter(s => s.id !== fromStore)

    return (
        <div className="trf-screen">
            <header className="trf-header">
                <div>
                    <h1>Transferts</h1>
                    <p>
                        Le stock quitte le magasin d’origine à l’expédition et arrive à destination
                        à la réception. Entre les deux, il est « en transit » — visible, jamais perdu.
                    </p>
                </div>
                <button className="trf-primary" onClick={() => setCreating(true)} disabled={creating}>
                    <Plus size={15} /> Nouveau transfert
                </button>
            </header>

            {notice && (
                <div className="trf-notice" role="status">
                    <Check size={16} /> <span>{notice}</span>
                    <button onClick={() => setNotice('')} aria-label="Fermer"><X size={15} /></button>
                </div>
            )}
            {error && (
                <div className="trf-error" role="alert">
                    <AlertTriangle size={16} /> <span>{error}</span>
                </div>
            )}

            {/* Goods that left and never arrived. Deliberately at the top: this is the
                one thing on this screen that means something is wrong right now. */}
            {inTransit.length > 0 && (
                <section className="trf-transit">
                    <h2><Clock size={15} /> En transit</h2>
                    <table className="trf-table">
                        <thead>
                            <tr><th>N°</th><th>Trajet</th><th className="num">Articles</th><th className="num">Valeur</th><th className="num">Depuis</th></tr>
                        </thead>
                        <tbody>
                            {inTransit.map(t => (
                                <tr key={t.id} className={t.days_in_transit >= 7 ? 'overdue' : ''}>
                                    <td className="mono">
                                        <button className="trf-link" onClick={() => open(t.id)}>{t.transfer_number}</button>
                                    </td>
                                    <td className="muted">{t.from_store_name} → {t.to_store_name}</td>
                                    <td className="num">{t.quantity}</td>
                                    <td className="num">{formatCurrency(t.value)}</td>
                                    <td className="num">
                                        {t.days_in_transit} j
                                        {t.days_in_transit >= 7 && <span className="trf-flag">à vérifier</span>}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </section>
            )}

            {creating && (
                <section className="trf-panel">
                    <div className="trf-panel-head">
                        <h2>Nouveau transfert</h2>
                        <button className="trf-icon" onClick={resetDraft} aria-label="Annuler"><X size={16} /></button>
                    </div>

                    <div className="trf-route">
                        <label>
                            <span>Depuis</span>
                            <select value={fromStore ?? ''} onChange={e => { setFromStore(Number(e.target.value)); setToStore(null) }}>
                                {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                            </select>
                        </label>
                        <ArrowRightLeft size={16} />
                        <label>
                            <span>Vers</span>
                            <select value={toStore ?? ''} onChange={e => setToStore(Number(e.target.value) || null)}>
                                <option value="">Choisir…</option>
                                {otherStores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                            </select>
                        </label>
                        <label className="grow">
                            <span>Note</span>
                            <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Motif, transporteur…" />
                        </label>
                    </div>

                    <div className="trf-picker">
                        <div className="trf-search">
                            <Search size={16} />
                            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Chercher un article à transférer…" />
                        </div>
                        {hits.length > 0 && !picked && (
                            <ul className="trf-hits">
                                {hits.map(p => (
                                    <li key={p.id}>
                                        <button onClick={() => choose(p)}>{p.name}</button>
                                    </li>
                                ))}
                            </ul>
                        )}
                        {picked && (
                            <div className="trf-variants">
                                <div className="trf-variants-head">
                                    <strong>{picked.name}</strong>
                                    <button className="trf-icon" onClick={() => { setPicked(null); setVariants([]) }} aria-label="Annuler"><X size={15} /></button>
                                </div>
                                {variants.length === 0 ? (
                                    <button className="trf-ghost" onClick={() => addLine(null)}><Plus size={14} /> Ajouter</button>
                                ) : (
                                    <div className="trf-variant-grid">
                                        {variants.map(v => (
                                            <button key={v.id} className="trf-variant" onClick={() => addLine(v)}>
                                                <span>{variantLabel(v)}</span>
                                                <span className="muted">{v.stock_quantity} dispo</span>
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                    {draftLines.length > 0 && (
                        <table className="trf-table">
                            <thead>
                                <tr><th>Article</th><th>Taille · Couleur</th><th className="num">Dispo</th><th className="num">Quantité</th><th /></tr>
                            </thead>
                            <tbody>
                                {draftLines.map(l => (
                                    <tr key={l.key}>
                                        <td>{l.productName}</td>
                                        <td className="muted">{variantLabel(l)}</td>
                                        <td className="num muted">{l.available}</td>
                                        <td className="num">
                                            <input
                                                className="trf-qty"
                                                type="number"
                                                min={1}
                                                value={l.quantity}
                                                onChange={e => {
                                                    const q = Math.max(1, Number(e.target.value) || 1)
                                                    setDraftLines(prev => prev.map(x => x.key === l.key ? { ...x, quantity: q } : x))
                                                }}
                                            />
                                        </td>
                                        <td className="num">
                                            <button className="trf-icon" aria-label="Retirer"
                                                onClick={() => setDraftLines(prev => prev.filter(x => x.key !== l.key))}>
                                                <Trash2 size={15} />
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}

                    {/* The quantity is only checked for real at shipping, against live
                        stock — this is a hint, not a gate, because stock moves between
                        writing the transfer and packing the box. */}
                    {draftLines.some(l => l.quantity > l.available) && (
                        <div className="trf-hint">
                            <AlertTriangle size={15} />
                            Certaines quantités dépassent le stock actuel. Le transfert peut être créé,
                            mais l’expédition sera refusée tant que le stock ne suit pas.
                        </div>
                    )}

                    <footer className="trf-actions">
                        <span className="muted">{draftTotal} article{draftTotal > 1 ? 's' : ''}</span>
                        <button className="trf-primary" onClick={submitDraft}
                            disabled={busy || !draftLines.length || toStore === null}>
                            {busy ? 'Création…' : 'Créer le transfert'}
                        </button>
                    </footer>
                </section>
            )}

            {selected && (
                <section className="trf-panel">
                    <div className="trf-panel-head">
                        <div>
                            <h2>{selected.transfer_number}</h2>
                            <div className="trf-meta">
                                <span>{selected.from_store_name} → {selected.to_store_name}</span>
                                <span className={`trf-badge ${selected.status}`}>{STATUS_LABEL[selected.status]}</span>
                                {selected.shipped_at && <span>Expédié {formatDateTime(selected.shipped_at)}</span>}
                                {selected.received_at && <span>Reçu {formatDateTime(selected.received_at)}</span>}
                            </div>
                        </div>
                        <button className="trf-icon" onClick={() => setSelected(null)} aria-label="Fermer"><X size={16} /></button>
                    </div>

                    <table className="trf-table">
                        <thead>
                            <tr>
                                <th>Article</th><th>Taille · Couleur</th>
                                <th className="num">Demandé</th>
                                <th className="num">{selected.status === 'shipped' || selected.status === 'received' ? 'Expédié' : 'Stock source'}</th>
                                <th className="num">
                                    {selected.status === 'shipped' ? 'Reçu' : selected.status === 'received' ? 'Reçu' : 'À expédier'}
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {selected.items.map(it => {
                                const editable = selected.status === 'shipped'
                                    ? true
                                    : selected.status !== 'received' && selected.status !== 'cancelled'
                                const max = selected.status === 'shipped' ? it.quantity_shipped : it.quantity_requested
                                const fallback = selected.status === 'shipped' ? it.quantity_shipped : it.quantity_requested
                                const short = selected.status === 'received' && it.quantity_received < it.quantity_shipped
                                return (
                                    <tr key={it.id} className={short ? 'short' : ''}>
                                        <td>{it.product_name}</td>
                                        <td className="muted">{variantLabel(it)}</td>
                                        <td className="num">{it.quantity_requested}</td>
                                        <td className={`num ${selected.status !== 'shipped' && selected.status !== 'received' && it.source_stock < it.quantity_requested ? 'warn' : 'muted'}`}>
                                            {selected.status === 'shipped' || selected.status === 'received'
                                                ? it.quantity_shipped
                                                : it.source_stock}
                                        </td>
                                        <td className="num">
                                            {selected.status === 'received' ? (
                                                <span className={short ? 'warn' : ''}>{it.quantity_received}</span>
                                            ) : selected.status === 'cancelled' ? '—' : (
                                                <input
                                                    className="trf-qty"
                                                    type="number"
                                                    min={0}
                                                    max={max}
                                                    disabled={!editable}
                                                    value={qtyOverride[it.id] ?? fallback}
                                                    onChange={e => {
                                                        const q = Math.max(0, Math.min(max, Number(e.target.value) || 0))
                                                        setQtyOverride(prev => ({ ...prev, [it.id]: q }))
                                                    }}
                                                />
                                            )}
                                        </td>
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>

                    <footer className="trf-actions">
                        {selected.status === 'received' && (
                            <span className="muted">Transfert terminé.</span>
                        )}
                        {selected.status === 'cancelled' && (
                            <span className="muted">Transfert annulé.</span>
                        )}
                        <div className="trf-buttons">
                            {selected.status !== 'received' && selected.status !== 'cancelled' && selected.status !== 'shipped' && (
                                <button className="trf-ghost" disabled={busy}
                                    onClick={() => act(() => window.electron.transfer.cancel(selected.id, userId, 'annulé depuis l’écran transferts'), 'Transfert annulé.')}>
                                    Annuler le transfert
                                </button>
                            )}
                            {selected.status !== 'shipped' && selected.status !== 'received' && selected.status !== 'cancelled' && (
                                <button className="trf-primary" onClick={shipSelected} disabled={busy}>
                                    <Truck size={16} /> {busy ? 'Expédition…' : 'Expédier'}
                                </button>
                            )}
                            {selected.status === 'shipped' && (
                                <button className="trf-primary" onClick={receiveSelected} disabled={busy}>
                                    <PackageCheck size={16} /> {busy ? 'Réception…' : 'Réceptionner'}
                                </button>
                            )}
                        </div>
                    </footer>
                </section>
            )}

            <section className="trf-panel">
                <h2>Tous les transferts</h2>
                {transfers.length === 0 ? (
                    <p className="trf-empty">Aucun transfert enregistré.</p>
                ) : (
                    <table className="trf-table">
                        <thead>
                            <tr>
                                <th>N°</th><th>Trajet</th><th>État</th>
                                <th className="num">Demandé</th><th className="num">Expédié</th><th className="num">Reçu</th>
                                <th>Créé</th>
                            </tr>
                        </thead>
                        <tbody>
                            {transfers.map(t => (
                                <tr key={t.id} className={selected?.id === t.id ? 'active' : ''}>
                                    <td className="mono">
                                        <button className="trf-link" onClick={() => open(t.id)}>{t.transfer_number}</button>
                                    </td>
                                    <td className="muted">{t.from_store_name} → {t.to_store_name}</td>
                                    <td><span className={`trf-badge ${t.status}`}>{STATUS_LABEL[t.status]}</span></td>
                                    <td className="num">{t.total_requested ?? 0}</td>
                                    <td className="num">{t.total_shipped ?? 0}</td>
                                    <td className="num">{t.total_received ?? 0}</td>
                                    <td className="muted">{formatDateTime(t.created_at)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </section>
        </div>
    )
}
