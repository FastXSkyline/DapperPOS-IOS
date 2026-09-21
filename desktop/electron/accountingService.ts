import { getDatabase } from './database'

// ---------------------------------------------------------------------------
// Accounting & declaration feeders (Phase 5)
//
// This module is a *feeder* for the accountant/DGI — it never auto-files.
// Every method returns structured rows + a ready-to-save CSV string (";"
// separated, the Algerian/French Excel convention). SCF (PCN) account codes
// are attached at export time by document type.
// ---------------------------------------------------------------------------

// Standard SCF / Plan Comptable National account codes used in the journals.
export const SCF = {
    clients: '411',
    fournisseurs: '401',
    ventes: '70',
    achats: '60',
    tvaCollectee: '4457',
    tvaDeductible: '44566',
    caisse: '53',
    banque: '512',
    timbre: '4456',
}

function csvCell(v: any): string {
    let s = String(v ?? '')
    // Neutralize spreadsheet formula injection (cells starting with = + - @).
    if (/^[=+\-@]/.test(s)) s = `'${s}`
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
function toCsv(headers: string[], rows: any[][]): string {
    const head = headers.map(csvCell).join(';')
    const body = rows.map(r => r.map(csvCell).join(';')).join('\n')
    return `${head}\n${body}\n`
}

function ym(year: number, month?: number) {
    return { y: String(year), m: month ? String(month).padStart(2, '0') : null }
}

export const AccountingService = {
    // ---- 5.1 Journals (ventes / achats / caisse) ----
    journalVentes(year: number, month?: number) {
        const db = getDatabase()
        const { y, m } = ym(year, month)
        const rows = db.prepare(`
            SELECT COALESCE(t.completed_at, t.created_at) AS date, t.transaction_number AS doc,
                   COALESCE(c.name, 'Comptoir') AS client, c.nif AS nif,
                   t.subtotal AS ht, t.tax_amount AS tva, t.total_amount AS ttc, t.timbre AS timbre, t.doc_type
            FROM transactions t LEFT JOIN customers c ON c.id = t.customer_id
            WHERE t.status IN ('completed','refunded')
              AND strftime('%Y', COALESCE(t.completed_at, t.created_at)) = ?
              ${m ? "AND strftime('%m', COALESCE(t.completed_at, t.created_at)) = ?" : ''}
            ORDER BY date
        `).all(...(m ? [y, m] : [y])) as any[]
        const csv = toCsv(
            ['Date', 'Pièce', 'Client', 'NIF', 'Compte client', 'HT', 'Compte vente', 'TVA', 'Compte TVA', 'Timbre', 'TTC'],
            rows.map(r => [r.date, r.doc, r.client, r.nif || '', SCF.clients, r.ht?.toFixed?.(2) ?? r.ht, SCF.ventes, r.tva?.toFixed?.(2) ?? r.tva, SCF.tvaCollectee, (r.timbre || 0).toFixed(2), r.ttc?.toFixed?.(2) ?? r.ttc])
        )
        return { rows, csv }
    },

    journalAchats(year: number, month?: number) {
        const db = getDatabase()
        const { y, m } = ym(year, month)
        // PO items carry no stored tax; derive TVA déductible from each product's tax rate.
        // NOTE: purchase_orders.total_amount is stored tax-EXCLUSIVE (HT) at PO
        // creation (no VAT line on POs), so it is the HT base; TTC = HT + derived TVA.
        const raw = db.prepare(`
            SELECT COALESCE(po.received_date, po.order_date) AS date, po.po_number AS doc,
                   s.company_name AS fournisseur, s.tax_id AS nif,
                   po.total_amount AS ht,
                   (SELECT COALESCE(SUM(poi.unit_cost * poi.quantity_received * COALESCE(tc.rate,0) / 100), 0)
                      FROM purchase_order_items poi
                      LEFT JOIN products p ON p.id = poi.product_id
                      LEFT JOIN tax_categories tc ON tc.id = p.tax_category_id
                     WHERE poi.purchase_order_id = po.id) AS tva
            FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id
            WHERE po.status IN ('received','partial')
              AND strftime('%Y', COALESCE(po.received_date, po.order_date)) = ?
              ${m ? "AND strftime('%m', COALESCE(po.received_date, po.order_date)) = ?" : ''}
            ORDER BY date
        `).all(...(m ? [y, m] : [y])) as any[]
        const rows = raw.map(r => ({ ...r, ttc: (r.ht || 0) + (r.tva || 0) }))
        const csv = toCsv(
            ['Date', 'Pièce', 'Fournisseur', 'NIF', 'Compte fournisseur', 'HT', 'Compte achat', 'TVA déductible', 'Compte TVA', 'TTC'],
            rows.map(r => [r.date, r.doc, r.fournisseur || '', r.nif || '', SCF.fournisseurs, (r.ht || 0).toFixed(2), SCF.achats, (r.tva || 0).toFixed(2), SCF.tvaDeductible, (r.ttc || 0).toFixed(2)])
        )
        return { rows, csv }
    },

    journalCaisse(year: number, month?: number) {
        const db = getDatabase()
        const { y, m } = ym(year, month)
        const rows = db.prepare(`
            SELECT p.created_at AS date, t.transaction_number AS doc, p.payment_method AS method, p.amount AS amount
            FROM payments p JOIN transactions t ON t.id = p.transaction_id
            WHERE p.payment_method = 'cash'
              AND strftime('%Y', p.created_at) = ?
              ${m ? "AND strftime('%m', p.created_at) = ?" : ''}
            ORDER BY p.created_at
        `).all(...(m ? [y, m] : [y])) as any[]
        const csv = toCsv(
            ['Date', 'Pièce', 'Compte caisse', 'Encaissement'],
            rows.map(r => [r.date, r.doc, SCF.caisse, (r.amount || 0).toFixed(2)])
        )
        return { rows, csv }
    },

    // ---- 5.2 Monthly G50 worksheet ----
    g50(year: number, month: number) {
        const db = getDatabase()
        const { y, m } = ym(year, month)
        // TVA collectée by rate (from sales lines).
        const collected = db.prepare(`
            SELECT ti.tax_rate AS rate, COALESCE(SUM(ti.line_total),0) AS base, COALESCE(SUM(ti.tax_amount),0) AS tva
            FROM transaction_items ti JOIN transactions t ON t.id = ti.transaction_id
            WHERE t.status IN ('completed','refunded')
              AND strftime('%Y', COALESCE(t.completed_at, t.created_at)) = ?
              AND strftime('%m', COALESCE(t.completed_at, t.created_at)) = ?
            GROUP BY ti.tax_rate
        `).all(y, m) as any[]
        const tvaCollectee = collected.reduce((s, r) => s + (r.tva || 0), 0)
        // TVA déductible from purchases.
        const ach = this.journalAchats(year, month).rows
        const tvaDeductible = ach.reduce((s, r) => s + (r.tva || 0), 0)
        const timbre = (db.prepare(`
            SELECT COALESCE(SUM(timbre),0) AS s FROM transactions
            WHERE status IN ('completed','refunded')
              AND strftime('%Y', COALESCE(completed_at, created_at)) = ? AND strftime('%m', COALESCE(completed_at, created_at)) = ?
        `).get(y, m) as { s: number }).s
        // IRG salaires from payroll, if the module produced payslips.
        let irg = 0
        try {
            irg = (db.prepare(`SELECT COALESCE(SUM(irg),0) AS s FROM payslips WHERE period = ?`).get(`${y}-${m}`) as { s: number }).s
        } catch { /* payroll module not initialised */ }
        const net = tvaCollectee - tvaDeductible
        const summary = {
            period: `${y}-${m}`,
            tvaCollecteeByRate: collected.map(r => ({ rate: r.rate, base: r.base, tva: r.tva })),
            tvaCollectee, tvaDeductible,
            tvaNet: net > 0 ? net : 0,
            tvaCredit: net < 0 ? -net : 0,
            timbre, irgSalaires: irg,
        }
        const csv = toCsv(
            ['Rubrique', 'Montant'],
            [
                ['Période', `${y}-${m}`],
                ...collected.map(r => [`TVA collectée ${r.rate}% (base ${(r.base || 0).toFixed(2)})`, (r.tva || 0).toFixed(2)]),
                ['TVA collectée totale', tvaCollectee.toFixed(2)],
                ['TVA déductible', tvaDeductible.toFixed(2)],
                ['TVA nette à payer', summary.tvaNet.toFixed(2)],
                ['Crédit de TVA', summary.tvaCredit.toFixed(2)],
                ['Droit de timbre', timbre.toFixed(2)],
                ['IRG salaires', irg.toFixed(2)],
            ]
        )
        return { summary, csv }
    },

    // ---- 5.3 Annual état 104 (relevé des clients) ----
    etat104(year: number) {
        const db = getDatabase()
        const rows = db.prepare(`
            SELECT c.name AS client, c.nif AS nif, c.rc AS rc, c.ai AS ai,
                   COALESCE(SUM(t.subtotal),0) AS ht, COALESCE(SUM(t.tax_amount),0) AS tva, COALESCE(SUM(t.total_amount),0) AS ttc
            FROM transactions t JOIN customers c ON c.id = t.customer_id
            WHERE t.status IN ('completed','refunded')
              AND strftime('%Y', COALESCE(t.completed_at, t.created_at)) = ?
            GROUP BY c.id HAVING ttc <> 0
            ORDER BY ttc DESC
        `).all(String(year)) as any[]
        const csv = toCsv(
            ['Client', 'NIF', 'RC', 'Article', 'Montant HT', 'TVA', 'Montant TTC'],
            rows.map(r => [r.client, r.nif || '', r.rc || '', r.ai || '', (r.ht || 0).toFixed(2), (r.tva || 0).toFixed(2), (r.ttc || 0).toFixed(2)])
        )
        return { rows, csv }
    },

    // ---- 5.4 Jibaya'tic-ready bundle (structured, no auto-filing) ----
    jibayatic(year: number, month: number) {
        const g = this.g50(year, month)
        const v = this.journalVentes(year, month)
        const a = this.journalAchats(year, month)
        const csv = `# Jibaya'tic export ${year}-${String(month).padStart(2, '0')}\n# G50\n${g.csv}\n# Journal des ventes\n${v.csv}\n# Journal des achats\n${a.csv}`
        return { csv, g50: g.summary }
    },

    // ---- 5.5 Inventory valuation (CMUP) + livre d'inventaire ----
    inventoryValuation() {
        const db = getDatabase()
        const rows = db.prepare(`
            SELECT p.id, p.name, p.sku, COALESCE(si.quantity,0) AS qty, COALESCE(p.cost_price,0) AS cmup,
                   COALESCE(si.quantity,0) * COALESCE(p.cost_price,0) AS value
            FROM products p LEFT JOIN stock_inventory si ON si.product_id = p.id AND si.variant_id IS NULL
            WHERE p.is_active = 1 ORDER BY p.name
        `).all() as any[]
        const total = rows.reduce((s, r) => s + (r.value || 0), 0)
        const csv = toCsv(
            ['Code', 'Désignation', 'Quantité', 'CMUP', 'Valeur'],
            rows.map(r => [r.sku || r.id, r.name, r.qty, (r.cmup || 0).toFixed(2), (r.value || 0).toFixed(2)])
        ) + `\n;;;Total stock;${total.toFixed(2)}\n`
        return { rows, total, csv }
    },

    /** Physical inventory écart: caller passes counted quantities; we compute the gap
     *  and post an adjustment movement per product to reconcile system → physical. */
    applyPhysicalInventory(counts: { product_id: number; counted: number }[], userId: number) {
        const db = getDatabase()
        const ecarts: any[] = []
        const run = db.transaction(() => {
            for (const c of counts) {
                const cur = (db.prepare('SELECT COALESCE(quantity,0) AS q FROM stock_inventory WHERE product_id = ? AND variant_id IS NULL').get(c.product_id) as { q: number } | undefined)?.q ?? 0
                const ecart = c.counted - cur
                if (ecart !== 0) {
                    const exists = db.prepare('SELECT 1 FROM stock_inventory WHERE product_id = ? AND variant_id IS NULL').get(c.product_id)
                    if (exists) db.prepare("UPDATE stock_inventory SET quantity = ?, updated_at = datetime('now') WHERE product_id = ? AND variant_id IS NULL").run(c.counted, c.product_id)
                    else db.prepare('INSERT INTO stock_inventory (product_id, quantity) VALUES (?, ?)').run(c.product_id, c.counted)
                    db.prepare(`INSERT INTO stock_movements (product_id, movement_type, quantity, reason, user_id) VALUES (?, 'adjustment', ?, 'Inventaire physique (écart)', ?)`).run(c.product_id, ecart, userId || null)
                    ecarts.push({ product_id: c.product_id, system: cur, counted: c.counted, ecart })
                }
            }
        })
        run()
        return { success: true, ecarts }
    },

    // ---- 5.7 Liasse fiscale supporting figures (annual summary) ----
    liasse(year: number) {
        const db = getDatabase()
        const y = String(year)
        const sales = db.prepare(`
            SELECT COALESCE(SUM(subtotal),0) AS ht, COALESCE(SUM(tax_amount),0) AS tva, COALESCE(SUM(total_amount),0) AS ttc
            FROM transactions WHERE status IN ('completed','refunded') AND strftime('%Y', COALESCE(completed_at, created_at)) = ?
        `).get(y) as any
        const purchases = this.journalAchats(year).rows.reduce((acc, r) => { acc.ttc += (r.ttc || 0); acc.tva += (r.tva || 0); return acc }, { ttc: 0, tva: 0 })
        const stock = this.inventoryValuation().total
        const expenses = (db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM expenses WHERE strftime('%Y', created_at) = ?`).get(y) as { s: number } | undefined)?.s ?? 0
        const figures = {
            chiffreAffairesHT: sales.ht, tvaCollectee: sales.tva, ventesTTC: sales.ttc,
            achatsHT: purchases.ttc - purchases.tva, tvaDeductible: purchases.tva, achatsTTC: purchases.ttc,
            valeurStock: stock, charges: expenses,
            margeBrute: sales.ht - (purchases.ttc - purchases.tva),
        }
        const csv = toCsv(['Rubrique', 'Montant'], [
            ['Exercice', y],
            ["Chiffre d'affaires HT", figures.chiffreAffairesHT.toFixed(2)],
            ['TVA collectée', figures.tvaCollectee.toFixed(2)],
            ['Achats HT', figures.achatsHT.toFixed(2)],
            ['TVA déductible', figures.tvaDeductible.toFixed(2)],
            ['Valeur du stock', figures.valeurStock.toFixed(2)],
            ['Charges (dépenses)', figures.charges.toFixed(2)],
            ['Marge brute', figures.margeBrute.toFixed(2)],
        ])
        return { figures, csv }
    },
}
