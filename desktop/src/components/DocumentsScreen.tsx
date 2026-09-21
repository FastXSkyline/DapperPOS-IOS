import { useState, useEffect, useCallback } from 'react'
import { FilePlus2, CalendarRange, BookmarkPlus, Printer, ArrowRightCircle, XCircle, Plus, Trash2, FileStack } from 'lucide-react'

interface Props { userId: number }

const DOC_TYPES = [
    { value: 'devis', label: 'Devis' },
    { value: 'proforma', label: 'Facture proforma' },
    { value: 'bon_commande', label: 'Bon de commande' },
]
const TITLES: Record<string, string> = {
    devis: 'Devis', proforma: 'Proforma', bon_commande: 'Bon de commande',
    bon_livraison: 'Bon de livraison', facture: 'Facture', facture_recap: 'Facture récapitulative',
}

export function DocumentsScreen({ userId }: Props) {
    const [docs, setDocs] = useState<any[]>([])
    const [products, setProducts] = useState<any[]>([])
    const [customers, setCustomers] = useState<any[]>([])
    const [docType, setDocType] = useState('devis')
    const [customerId, setCustomerId] = useState('')
    const [lines, setLines] = useState<{ productId: string; qty: string }[]>([{ productId: '', qty: '1' }])
    const [notes, setNotes] = useState('')
    const [msg, setMsg] = useState('')
    // Récapitulative
    const [recapCustomer, setRecapCustomer] = useState('')
    const [recapYear, setRecapYear] = useState(String(new Date().getFullYear()))
    const [recapMonth, setRecapMonth] = useState(String(new Date().getMonth() + 1))
    // Reservations (acompte)
    const [reservations, setReservations] = useState<any[]>([])
    const [resvProduct, setResvProduct] = useState('')
    const [resvQty, setResvQty] = useState('1')
    const [resvCustomer, setResvCustomer] = useState('')
    const [resvDeposit, setResvDeposit] = useState('')

    const load = useCallback(() => {
        window.electron?.document?.list?.(undefined, 100).then(setDocs).catch(() => {})
        window.electron?.reservation?.list?.('active').then(setReservations).catch(() => {})
    }, [])

    const createReservation = async () => {
        setMsg('')
        if (!resvProduct || Number(resvQty) <= 0) { setMsg('Choisissez un produit et une quantité.'); return }
        const res = await window.electron.reservation.create(resvCustomer ? Number(resvCustomer) : null, Number(resvProduct), Number(resvQty), Number(resvDeposit) || 0, userId)
        if (res.success) { setMsg('✓ Réservation créée.'); setResvDeposit(''); load() }
        else setMsg(res.error || 'Échec de la réservation.')
    }
    const fulfillReservation = async (id: number) => {
        const res = await window.electron.reservation.fulfill(id, userId)
        if (res.success) setMsg(`✓ Réservation convertie en vente ${res.transaction_number}.`)
        else setMsg(res.error || 'Échec.')
        load()
    }
    const releaseReservation = async (id: number) => { await window.electron.reservation.release(id); load() }
    useEffect(() => {
        load()
        window.electron?.product?.getAll?.({}).then((p: any[]) => setProducts(p || [])).catch(() => {})
        window.electron?.customer?.getAll?.().then((c: any[]) => setCustomers(c || [])).catch(() => {})
    }, [load])

    const create = async () => {
        setMsg('')
        const items = lines.filter(l => l.productId && Number(l.qty) > 0).map(l => ({ productId: Number(l.productId), quantity: Number(l.qty) }))
        if (items.length === 0) { setMsg('Ajoutez au moins un article.'); return }
        const res = await window.electron.document.create(docType, customerId ? Number(customerId) : null, userId, items, notes || undefined)
        setMsg(`✓ ${TITLES[docType]} ${res.transaction_number} créé.`)
        setLines([{ productId: '', qty: '1' }]); setNotes('')
        load()
    }
    const print = (id: number) => window.electron.document.print(id).catch(() => {})
    const convert = async (id: number) => {
        const res = await window.electron.document.convertToSale(id, userId)
        if (res.success) setMsg(`✓ Converti en bon de livraison ${res.transaction_number}. Finalisez l'encaissement au POS.`)
        else setMsg(res.error || 'Échec de la conversion.')
        load()
    }
    const genRecap = async () => {
        setMsg('')
        if (!recapCustomer) { setMsg('Choisissez un client pour le récapitulatif.'); return }
        const res = await window.electron.document.recapitulative(Number(recapCustomer), Number(recapYear), Number(recapMonth), userId)
        if (res.success) { setMsg(`✓ Facture récapitulative ${res.transaction_number} (${res.bl_count} BL).`); load() }
        else setMsg(res.error || 'Aucun BL pour cette période.')
    }

    return (
        <div className="el-page">
            <div className="el-page-head">
                <div>
                    <h1 className="el-page-title">Documents commerciaux</h1>
                    <p className="el-page-sub">Devis, proformas, bons de commande, récapitulatifs et réservations.</p>
                </div>
            </div>

            <section className="el-card">
                <div className="el-card-head">
                    <span className="ac-ico"><FilePlus2 size={15} /></span>
                    <h2 className="el-card-title">Nouveau document</h2>
                    <div className="el-card-actions">
                        <span className="el-chip el-chip--neutral">{TITLES[docType] || docType}</span>
                    </div>
                </div>
                <div className="ac-btns doc-type-row">
                    <select className="el-select" value={docType} onChange={e => setDocType(e.target.value)} aria-label="Type de document">
                        {DOC_TYPES.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
                    </select>
                    <select className="el-select" value={customerId} onChange={e => setCustomerId(e.target.value)} aria-label="Client">
                        <option value="">— Client (optionnel) —</option>
                        {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                </div>
                <div className="ac-btns" style={{ alignItems: 'center' }}>
                    {lines.map((l, idx) => (
                        <div key={idx} className="doc-line">
                            <select className="el-select" value={l.productId} onChange={e => setLines(lines.map((x, i) => i === idx ? { ...x, productId: e.target.value } : x))} aria-label="Produit">
                                <option value="">— Produit —</option>
                                {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                            </select>
                            <input className="el-input doc-line-qty" type="number" min={0} step="any" value={l.qty} onChange={e => setLines(lines.map((x, i) => i === idx ? { ...x, qty: e.target.value } : x))} aria-label="Quantité" />
                            <button className="el-btn el-btn--ghost doc-line-x" onClick={() => setLines(lines.filter((_, i) => i !== idx))} title="Retirer la ligne" aria-label="Retirer la ligne">
                                <Trash2 size={14} />
                            </button>
                        </div>
                    ))}
                    <button className="el-btn el-btn--secondary" onClick={() => setLines([...lines, { productId: '', qty: '1' }])}><Plus size={14} />Ligne</button>
                    <input className="el-input doc-notes" placeholder="Notes (optionnel)" value={notes} onChange={e => setNotes(e.target.value)} />
                    <button className="el-btn el-btn--primary" onClick={create}><FilePlus2 size={14} />Créer le document</button>
                </div>
            </section>

            <section className="el-card">
                <div className="el-card-head">
                    <span className="ac-ico"><CalendarRange size={15} /></span>
                    <h2 className="el-card-title">Facture récapitulative</h2>
                    <div className="el-card-actions">
                        <span className="doc-hint">Consolidation mensuelle des BL</span>
                    </div>
                </div>
                <div className="ac-btns">
                    <select className="el-select" value={recapCustomer} onChange={e => setRecapCustomer(e.target.value)} aria-label="Client du récapitulatif">
                        <option value="">— Client —</option>
                        {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    <input className="el-input ac-month" type="number" value={recapMonth} min={1} max={12} onChange={e => setRecapMonth(e.target.value)} title="Mois" aria-label="Mois" />
                    <input className="el-input ac-year" type="number" value={recapYear} onChange={e => setRecapYear(e.target.value)} title="Année" aria-label="Année" />
                    <button className="el-btn el-btn--primary" onClick={genRecap}><CalendarRange size={14} />Générer</button>
                </div>
            </section>

            <section className="el-card">
                <div className="el-card-head">
                    <span className="ac-ico"><BookmarkPlus size={15} /></span>
                    <h2 className="el-card-title">Réservations (acompte)</h2>
                </div>
                <div className="ac-btns">
                    <select className="el-select" value={resvProduct} onChange={e => setResvProduct(e.target.value)} aria-label="Produit réservé">
                        <option value="">— Produit —</option>
                        {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                    <input className="el-input doc-line-qty" type="number" min={0} step="any" placeholder="Qté" value={resvQty} onChange={e => setResvQty(e.target.value)} aria-label="Quantité" />
                    <select className="el-select" value={resvCustomer} onChange={e => setResvCustomer(e.target.value)} aria-label="Client">
                        <option value="">— Client —</option>
                        {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    <input className="el-input doc-deposit" type="number" min={0} step="any" placeholder="Acompte DA" value={resvDeposit} onChange={e => setResvDeposit(e.target.value)} aria-label="Acompte" />
                    <button className="el-btn el-btn--primary" onClick={createReservation}><BookmarkPlus size={14} />Réserver</button>
                </div>
                {reservations.length > 0 && (
                    <div className="el-table-wrap" style={{ marginTop: '12px' }}>
                        <table className="el-table">
                            <thead>
                                <tr><th>Produit</th><th className="num">Qté</th><th>Client</th><th className="num">Acompte</th><th></th></tr>
                            </thead>
                            <tbody>
                                {reservations.map(r => (
                                    <tr key={r.id}>
                                        <td className="strong">{r.product_name}</td>
                                        <td className="num muted">{r.quantity}</td>
                                        <td className="muted">{r.customer_name || '—'}</td>
                                        <td className="num strong">{(r.deposit || 0).toLocaleString()} DA</td>
                                        <td className="num">
                                            <button className="el-btn el-btn--secondary" onClick={() => fulfillReservation(r.id)}><ArrowRightCircle size={14} />Vente</button>
                                            <button className="el-btn el-btn--ghost" onClick={() => releaseReservation(r.id)} title="Annuler" aria-label="Annuler"><XCircle size={14} /></button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>

            <section className="el-card el-card--pad0">
                <div className="el-card-head el-card-head--ruled">
                    <span className="ac-ico"><FileStack size={15} /></span>
                    <h2 className="el-card-title">Registre des documents</h2>
                    <div className="el-card-actions">
                        <span className="el-chip el-chip--neutral">{docs.length}</span>
                    </div>
                </div>
                <div className="el-table-wrap">
                    <table className="el-table">
                        <thead>
                            <tr>
                                <th>Numéro</th><th>Type</th><th>Client</th><th className="num">Total</th><th>Statut</th><th></th>
                            </tr>
                        </thead>
                        <tbody>
                            {docs.map(d => (
                                <tr key={d.id}>
                                    <td className="strong">{d.transaction_number}</td>
                                    <td className="muted">{TITLES[d.doc_type] || d.doc_type}</td>
                                    <td className="muted">{d.customer_name || '—'}</td>
                                    <td className="num strong">{(d.total_amount || 0).toLocaleString()} DA</td>
                                    <td>
                                        <span className={`el-chip ${d.status === 'pending' ? 'el-chip--warn' : 'el-chip--ok'}`}>{d.status}</span>
                                    </td>
                                    <td className="num">
                                        <button className="el-btn el-btn--secondary" onClick={() => print(d.id)}><Printer size={14} />Imprimer</button>
                                        {['devis', 'proforma', 'bon_commande'].includes(d.doc_type) && d.status === 'pending' && (
                                            <button className="el-btn el-btn--primary" onClick={() => convert(d.id)}><ArrowRightCircle size={14} />Vente</button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                            {docs.length === 0 && (
                                <tr><td colSpan={6}><div className="el-empty">Aucun document.</div></td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </section>

            {msg && (
                <div className="ac-msg">
                    <span className="el-chip el-chip--ok">{msg}</span>
                </div>
            )}
        </div>
    )
}
