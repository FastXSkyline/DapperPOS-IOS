import { useState, useEffect } from 'react'

// ---------------------------------------------------------------------------
// Dépôts & transferts — DORMANT since Dapper Phase 4.
//
// Built for a distributor moving stock between a magasin, dépôts and chantiers.
// A single boutique has one stock point, so this is no longer rendered in
// Settings. Nothing here was deleted: the warehouses / depot_stock /
// transfer_orders tables, warehouseService.ts and its IPC handlers are all
// intact. To bring the feature back, import this component in App.tsx and
// render <DepotSettings /> in the Settings view again.
// ---------------------------------------------------------------------------

export function DepotSettings() {
  const [warehouses, setWarehouses] = useState<any[]>([])
  const [products, setProducts] = useState<any[]>([])
  const [newName, setNewName] = useState('')
  const [newType, setNewType] = useState('depot')
  const [from, setFrom] = useState('1')
  const [to, setTo] = useState('')
  const [lines, setLines] = useState<{ productId: string; qty: string }[]>([{ productId: '', qty: '1' }])
  const [msg, setMsg] = useState('')

  const load = () => { window.electron?.warehouse?.list?.().then(setWarehouses).catch(() => {}) }
  useEffect(() => {
    load()
    window.electron?.product?.getAll?.({}).then((p: any[]) => setProducts(p || [])).catch(() => {})
  }, [])

  const addWarehouse = async () => {
    if (!newName.trim()) return
    await window.electron.warehouse.create({ name: newName.trim(), type: newType })
    setNewName(''); load()
  }
  const doTransfer = async () => {
    setMsg('')
    const items = lines.filter(l => l.productId && Number(l.qty) > 0).map(l => ({ product_id: Number(l.productId), quantity: Number(l.qty) }))
    if (!from || !to || items.length === 0) { setMsg('Sélectionnez source, destination et au moins un article.'); return }
    const res = await window.electron.warehouse.createTransfer(Number(from), Number(to), items)
    if (res.success) {
      setMsg(`✓ Transfert ${res.transfer_number} créé.`)
      if (res.id) window.electron.warehouse.printTransfer(res.id).catch(() => {})
      setLines([{ productId: '', qty: '1' }])
    } else setMsg(res.error || 'Échec du transfert.')
  }

  const sel = { padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--border-light)', background: 'var(--surface)', color: 'var(--text-main)' } as const

  return (
    <div style={{ background: 'var(--bg-main)', padding: '1rem', borderRadius: 'var(--radius-md)', marginTop: '1.5rem', border: '1px solid var(--border-light)' }}>
      <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold', color: 'var(--text-main)' }}>Dépôts & transferts</label>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px', flexWrap: 'wrap' }}>
        {warehouses.map(w => <span key={w.id} style={{ fontSize: '0.8em', padding: '3px 8px', borderRadius: '12px', background: 'var(--surface)', border: '1px solid var(--border-light)', color: 'var(--text-main)' }}>{w.name} <em style={{ opacity: 0.6 }}>({w.type})</em></span>)}
      </div>
      <div style={{ display: 'flex', gap: '8px', marginBottom: '14px', flexWrap: 'wrap' }}>
        <input placeholder="Nouveau dépôt / chantier" value={newName} onChange={e => setNewName(e.target.value)} style={{ ...sel, minWidth: '180px' }} />
        <select value={newType} onChange={e => setNewType(e.target.value)} style={sel}>
          <option value="depot">Dépôt</option>
          <option value="chantier">Chantier</option>
          <option value="magasin">Magasin</option>
        </select>
        <button onClick={addWarehouse} className="btn-secondary" style={{ padding: '7px 14px' }}>Ajouter</button>
      </div>

      <div style={{ borderTop: '1px solid var(--border-light)', paddingTop: '10px' }}>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px', flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--text-muted)', fontSize: '0.85em' }}>De</span>
          <select value={from} onChange={e => setFrom(e.target.value)} style={sel}>
            {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <span style={{ color: 'var(--text-muted)', fontSize: '0.85em' }}>→</span>
          <select value={to} onChange={e => setTo(e.target.value)} style={sel}>
            <option value="">— Destination —</option>
            {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </div>
        {lines.map((l, idx) => (
          <div key={idx} style={{ display: 'flex', gap: '8px', marginBottom: '6px', alignItems: 'center' }}>
            <select value={l.productId} onChange={e => setLines(lines.map((x, i) => i === idx ? { ...x, productId: e.target.value } : x))} style={{ ...sel, minWidth: '200px' }}>
              <option value="">— Produit —</option>
              {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <input type="number" min="0" step="any" value={l.qty} onChange={e => setLines(lines.map((x, i) => i === idx ? { ...x, qty: e.target.value } : x))} style={{ ...sel, width: '90px' }} />
            <button className="btn-secondary" onClick={() => setLines(lines.filter((_, i) => i !== idx))}>✕</button>
          </div>
        ))}
        <button className="btn-secondary" onClick={() => setLines([...lines, { productId: '', qty: '1' }])} style={{ marginRight: '8px' }}>+ Ligne</button>
        <button className="btn-primary" onClick={doTransfer} style={{ padding: '7px 14px' }}>Transférer & imprimer</button>
        {msg && <span style={{ marginLeft: '10px', fontSize: '0.85em', color: 'var(--text-main)' }}>{msg}</span>}
      </div>
    </div>
  )
}
