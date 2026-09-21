import { useState, useEffect } from 'react'
import { Lock, Unlock, ArrowDownCircle, ArrowUpCircle, RefreshCw } from 'lucide-react'
import { formatCurrency, formatDateTime } from '../utils/formatters'
import type { CashSession, ZReport } from '../../electron/cashSessionService'
import './CashSessionScreen.css'

interface Props { userId: number }

/** État de la caisse — open the till with a counted float, watch the drawer during
 *  the day, then close against a physical count. The variance is the whole point:
 *  it is what tells the owner whether the till is short. */
export function CashSessionScreen({ userId }: Props) {
    const [session, setSession] = useState<CashSession | undefined>()
    const [report, setReport] = useState<ZReport | null>(null)
    const [history, setHistory] = useState<(CashSession & { opened_by_name?: string })[]>([])
    const [openingFloat, setOpeningFloat] = useState('')
    const [countedCash, setCountedCash] = useState('')
    const [mvAmount, setMvAmount] = useState('')
    const [mvReason, setMvReason] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')

    const load = async () => {
        const cur = await window.electron.cashSession.current()
        setSession(cur)
        setReport(cur ? await window.electron.cashSession.report(cur.id) as ZReport : null)
        setHistory(await window.electron.cashSession.list(15))
    }

    useEffect(() => {
        load()
    }, [])

    const guard = async (fn: () => Promise<{ success: boolean; error?: string }>) => {
        setBusy(true); setError('')
        try {
            const r = await fn()
            if (!r.success) setError(r.error || 'Opération impossible.')
            else await load()
            return r
        } finally { setBusy(false) }
    }

    const handleOpen = () => guard(async () => {
        const r = await window.electron.cashSession.open(userId, Number(openingFloat) || 0)
        if (r.success) setOpeningFloat('')
        return r
    })

    const handleMovement = (direction: 'in' | 'out') => guard(async () => {
        const r = await window.electron.cashSession.movement(direction, Number(mvAmount) || 0, mvReason, userId)
        if (r.success) { setMvAmount(''); setMvReason('') }
        return r
    })

    const handleClose = async () => {
        if (!report || 'error' in report) return
        const counted = Number(countedCash) || 0
        const variance = counted - report.expectedCash
        const msg = variance === 0
            ? 'Clôturer la caisse ? Le compte tombe juste.'
            : `Clôturer la caisse ?\n\nAttendu : ${report.expectedCash.toFixed(2)} DZD\nCompté : ${counted.toFixed(2)} DZD\nÉcart : ${variance > 0 ? '+' : ''}${variance.toFixed(2)} DZD`
        if (!confirm(msg)) return
        await guard(async () => {
            const r = await window.electron.cashSession.close(userId, counted)
            if (r.success) setCountedCash('')
            return r
        })
    }

    const rep = report && !('error' in report) ? report : null
    const counted = Number(countedCash)
    const liveVariance = rep && countedCash !== '' ? counted - rep.expectedCash : null

    return (
        <div className="cash-screen">
            <header className="cash-header">
                <div>
                    <h1>État de la caisse</h1>
                    <p>{session ? `Ouverte ${formatDateTime(session.opened_at)}` : 'Caisse fermée'}</p>
                </div>
                <button className="cash-refresh" onClick={load} disabled={busy}><RefreshCw size={16} /> Actualiser</button>
            </header>

            {error && <div className="cash-error">{error}</div>}

            {!session ? (
                <section className="cash-card cash-open-card">
                    <Unlock size={26} />
                    <h2>Ouvrir la caisse</h2>
                    <p>Comptez le fond de caisse avant de commencer la journée.</p>
                    <div className="cash-inline">
                        <input
                            type="number" inputMode="decimal" min="0" placeholder="Fond de caisse (DZD)"
                            value={openingFloat} onChange={e => setOpeningFloat(e.target.value)}
                        />
                        <button className="cash-primary" onClick={handleOpen} disabled={busy || openingFloat === ''}>Ouvrir</button>
                    </div>
                </section>
            ) : rep && (
                <>
                    <section className="cash-grid">
                        <Tile label="Fond de caisse" value={rep.session.opening_float} />
                        <Tile label="Encaissé espèces" value={rep.cashIn} accent />
                        <Tile label="Encaissé autres" value={rep.nonCashTotal} muted hint="Carte / chèque / virement — hors tiroir" />
                        <Tile label="Entrées tiroir" value={rep.movementsIn} />
                        <Tile label="Sorties tiroir" value={-rep.movementsOut} />
                        <Tile label="Dépenses (espèces)" value={-rep.expenses} />
                        <Tile label="Attendu en caisse" value={rep.expectedCash} strong />
                    </section>

                    <section className="cash-columns">
                        <div className="cash-card">
                            <h3>Ventes de la session</h3>
                            <dl className="cash-dl">
                                <div><dt>Tickets</dt><dd>{rep.salesCount}</dd></div>
                                <div><dt>Total TTC</dt><dd>{formatCurrency(rep.salesTotal)}</dd></div>
                                <div><dt>Dont TVA</dt><dd>{formatCurrency(rep.taxTotal)}</dd></div>
                                <div><dt>Remises</dt><dd>{formatCurrency(rep.discountTotal)}</dd></div>
                                <div><dt>Timbre</dt><dd>{formatCurrency(rep.timbreTotal)}</dd></div>
                                {rep.avoirCount > 0 && (
                                    <div className="cash-dl-note">
                                        <dt>Avoirs</dt>
                                        <dd>{rep.avoirCount} — {formatCurrency(rep.avoirTotal)}</dd>
                                    </div>
                                )}
                            </dl>
                            {rep.avoirCount > 0 && (
                                <p className="cash-hint">
                                    Un avoir ne sort pas d'argent du tiroir automatiquement : si vous avez remboursé
                                    en espèces, enregistrez aussi une sortie de tiroir.
                                </p>
                            )}

                            <h3>Par mode de paiement</h3>
                            {rep.byMethod.length === 0 ? <p className="cash-hint">Aucun encaissement.</p> : (
                                <ul className="cash-methods">
                                    {rep.byMethod.map(m => (
                                        <li key={m.payment_method}>
                                            <span>{m.payment_method}</span>
                                            <small>{m.count}</small>
                                            <strong>{formatCurrency(m.total)}</strong>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>

                        <div className="cash-card">
                            <h3>Mouvements de tiroir</h3>
                            <div className="cash-mv-form">
                                <input type="number" inputMode="decimal" min="0" placeholder="Montant"
                                    value={mvAmount} onChange={e => setMvAmount(e.target.value)} />
                                <input type="text" placeholder="Motif (ex : achat sachets)"
                                    value={mvReason} onChange={e => setMvReason(e.target.value)} />
                                <div className="cash-mv-actions">
                                    <button onClick={() => handleMovement('in')} disabled={busy || !mvAmount}><ArrowDownCircle size={15} /> Entrée</button>
                                    <button onClick={() => handleMovement('out')} disabled={busy || !mvAmount}><ArrowUpCircle size={15} /> Sortie</button>
                                </div>
                            </div>
                            {rep.movements.length === 0 ? <p className="cash-hint">Aucun mouvement.</p> : (
                                <ul className="cash-mv-list">
                                    {rep.movements.map(m => (
                                        <li key={m.id} className={m.direction}>
                                            <span>{m.reason || (m.direction === 'in' ? 'Entrée' : 'Sortie')}</span>
                                            <strong>{m.direction === 'in' ? '+' : '−'}{formatCurrency(m.amount)}</strong>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    </section>

                    <section className="cash-card cash-close-card">
                        <h3><Lock size={17} /> Clôture (rapport Z)</h3>
                        <p>Comptez physiquement le tiroir, puis saisissez le montant.</p>
                        <div className="cash-inline">
                            <input type="number" inputMode="decimal" min="0" placeholder="Espèces comptées (DZD)"
                                value={countedCash} onChange={e => setCountedCash(e.target.value)} />
                            <button className="cash-primary" onClick={handleClose} disabled={busy || countedCash === ''}>Clôturer</button>
                        </div>
                        {liveVariance !== null && (
                            <p className={`cash-variance ${liveVariance === 0 ? 'ok' : liveVariance > 0 ? 'over' : 'short'}`}>
                                {liveVariance === 0
                                    ? 'Le compte tombe juste.'
                                    : `Écart : ${liveVariance > 0 ? '+' : ''}${formatCurrency(liveVariance)} (${liveVariance > 0 ? 'excédent' : 'manquant'})`}
                            </p>
                        )}
                    </section>
                </>
            )}

            <section className="cash-card">
                <h3>Sessions précédentes</h3>
                {history.filter(h => h.status === 'closed').length === 0 ? (
                    <p className="cash-hint">Aucune session clôturée.</p>
                ) : (
                    <table className="cash-history">
                        <thead>
                            <tr><th>N° Z</th><th>Ouverte</th><th>Clôturée</th><th>Attendu</th><th>Compté</th><th>Écart</th></tr>
                        </thead>
                        <tbody>
                            {history.filter(h => h.status === 'closed').map(h => (
                                <tr key={h.id}>
                                    <td>{h.session_number || '—'}</td>
                                    <td>{formatDateTime(h.opened_at)}</td>
                                    <td>{h.closed_at ? formatDateTime(h.closed_at) : '—'}</td>
                                    <td>{formatCurrency(h.expected_cash || 0)}</td>
                                    <td>{formatCurrency(h.counted_cash || 0)}</td>
                                    <td className={(h.variance || 0) === 0 ? 'ok' : (h.variance || 0) > 0 ? 'over' : 'short'}>
                                        {(h.variance || 0) > 0 ? '+' : ''}{formatCurrency(h.variance || 0)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </section>
        </div>
    )
}

function Tile({ label, value, accent, muted, strong, hint }: {
    label: string; value: number; accent?: boolean; muted?: boolean; strong?: boolean; hint?: string
}) {
    return (
        <div className={`cash-tile${accent ? ' accent' : ''}${muted ? ' muted' : ''}${strong ? ' strong' : ''}`} title={hint}>
            <span>{label}</span>
            <strong>{formatCurrency(value)}</strong>
        </div>
    )
}
