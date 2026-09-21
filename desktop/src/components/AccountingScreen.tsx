import { useState, useEffect } from 'react'
import { BookOpen, Boxes, Download } from 'lucide-react'

interface Props { userId: number }

export function AccountingScreen({ userId }: Props) {
    const now = new Date()
    const [year, setYear] = useState(String(now.getFullYear()))
    const [month, setMonth] = useState(String(now.getMonth() + 1))
    const [msg, setMsg] = useState('')


    // Inventory écart
    const [valuation, setValuation] = useState<{ rows: any[]; total: number } | null>(null)
    const [counts, setCounts] = useState<Record<number, string>>({})

    useEffect(() => {
    }, [])

    const saveCsv = async (filename: string, csv: string) => {
        const res = await window.electron.accounting.exportCsv(filename, csv)
        setMsg(res.success ? `✓ Exporté: ${res.path}` : (res.error === 'cancelled' ? '' : 'Échec export.'))
    }
    const Y = () => Number(year), M = () => Number(month)
    const exp = {
        ventes: async () => { const r = await window.electron.accounting.journalVentes(Y(), M()); saveCsv(`journal_ventes_${year}_${month}.csv`, r.csv) },
        achats: async () => { const r = await window.electron.accounting.journalAchats(Y(), M()); saveCsv(`journal_achats_${year}_${month}.csv`, r.csv) },
        caisse: async () => { const r = await window.electron.accounting.journalCaisse(Y(), M()); saveCsv(`journal_caisse_${year}_${month}.csv`, r.csv) },
        g50: async () => { const r = await window.electron.accounting.g50(Y(), M()); saveCsv(`G50_${year}_${month}.csv`, r.csv) },
        etat104: async () => { const r = await window.electron.accounting.etat104(Y()); saveCsv(`etat104_${year}.csv`, r.csv) },
        jibayatic: async () => { const r = await window.electron.accounting.jibayatic(Y(), M()); saveCsv(`jibayatic_${year}_${month}.csv`, r.csv) },
        liasse: async () => { const r = await window.electron.accounting.liasse(Y()); saveCsv(`liasse_${year}.csv`, r.csv) },
    }

    const loadValuation = async () => { const v = await window.electron.accounting.inventoryValuation(); setValuation(v) }
    const exportValuation = async () => { const v = await window.electron.accounting.inventoryValuation(); saveCsv(`inventaire_valorise_${year}.csv`, v.csv) }
    const applyCounts = async () => {
        const payload = Object.entries(counts).filter(([, v]) => v !== '').map(([pid, v]) => ({ product_id: Number(pid), counted: Number(v) }))
        if (payload.length === 0) { setMsg('Saisissez au moins une quantité comptée.'); return }
        const res = await window.electron.accounting.physicalInventory(payload, userId)
        setMsg(`✓ Inventaire appliqué — ${res.ecarts.length} écart(s) ajusté(s).`)
        setCounts({}); loadValuation()
    }


    return (
        <div className="el-page">
            <div className="el-page-head">
                <div>
                    <h1 className="el-page-title">Comptabilité &amp; déclarations</h1>
                    <p className="el-page-sub">Exports pour le comptable / la DGI — aucune télédéclaration automatique.</p>
                </div>
                <div className="el-page-actions">
                    <input className="el-input ac-year" type="number" value={year} onChange={e => setYear(e.target.value)} aria-label="Année" />
                    <input className="el-input ac-month" type="number" min={1} max={12} value={month} onChange={e => setMonth(e.target.value)} aria-label="Mois" />
                </div>
            </div>

            <section className="el-card">
                <div className="el-card-head">
                    <span className="ac-ico"><BookOpen size={15} /></span>
                    <h2 className="el-card-title">Journaux &amp; déclarations</h2>
                </div>
                <div className="ac-btns">
                    <button className="el-btn el-btn--secondary" onClick={exp.ventes}><Download size={14} />Journal ventes (mois)</button>
                    <button className="el-btn el-btn--secondary" onClick={exp.achats}><Download size={14} />Journal achats (mois)</button>
                    <button className="el-btn el-btn--secondary" onClick={exp.caisse}><Download size={14} />Journal caisse (mois)</button>
                    <button className="el-btn el-btn--secondary" onClick={exp.g50}><Download size={14} />G50 (mois)</button>
                    <button className="el-btn el-btn--secondary" onClick={exp.jibayatic}><Download size={14} />Jibaya'tic (mois)</button>
                    <button className="el-btn el-btn--secondary" onClick={exp.etat104}><Download size={14} />État 104 (année)</button>
                    <button className="el-btn el-btn--secondary" onClick={exp.liasse}><Download size={14} />Liasse fiscale (année)</button>
                </div>
            </section>

            <section className="el-card">
                <div className="el-card-head">
                    <span className="ac-ico"><Boxes size={15} /></span>
                    <h2 className="el-card-title">Inventaire valorisé (CMUP) &amp; écart physique</h2>
                    <div className="el-card-actions">
                        {valuation && (
                            <span className="el-chip el-chip--accent">
                                {valuation.total.toLocaleString()} DA
                            </span>
                        )}
                    </div>
                </div>
                <div className="ac-btns">
                    <button className="el-btn el-btn--secondary" onClick={loadValuation}>Charger</button>
                    <button className="el-btn el-btn--secondary" onClick={exportValuation}><Download size={14} />Exporter CSV</button>
                </div>
                {valuation && (
                    <div className="el-table-wrap">
                        <table className="el-table">
                            <thead>
                                <tr><th>Produit</th><th className="num">Sys.</th><th className="num">CMUP</th><th className="num">Valeur</th><th className="num">Compté</th></tr>
                            </thead>
                            <tbody>
                                {valuation.rows.slice(0, 200).map(r => (
                                    <tr key={r.id}>
                                        <td>{r.name}</td>
                                        <td className="num muted">{r.qty}</td>
                                        <td className="num muted">{(r.cmup || 0).toFixed(2)}</td>
                                        <td className="num strong">{(r.value || 0).toFixed(2)}</td>
                                        <td className="num">
                                            <input
                                                className="el-input ac-count"
                                                type="number"
                                                step="any"
                                                value={counts[r.id] ?? ''}
                                                onChange={e => setCounts({ ...counts, [r.id]: e.target.value })}
                                            />
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
                {valuation && (
                    <div style={{ marginTop: '12px' }}>
                        <button className="el-btn el-btn--primary" onClick={applyCounts}>Appliquer l'inventaire (ajuster écarts)</button>
                    </div>
                )}
            </section>

            {/* The payroll block that lived here is gone: Employés now owns the
                register, the CNAS/IRG calculation AND the posting of the wage
                bill into the expense ledger. Two screens computing payslips
                from the same table is how the books and the payslips come to
                disagree. */}

            {msg && (
                <div className="ac-msg">
                    <span className="el-chip el-chip--ok">{msg}</span>
                </div>
            )}
        </div>
    )
}
