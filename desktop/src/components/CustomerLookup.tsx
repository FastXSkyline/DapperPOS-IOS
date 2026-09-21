import { useState, useEffect } from 'react'
import type { Customer } from '../../shared/types'
import './CustomerLookup.css'

interface CustomerLookupProps {
    onSelect: (customer: Customer) => void
    onClose: () => void
}

export function CustomerLookup({ onSelect, onClose }: CustomerLookupProps) {
    const [search, setSearch] = useState('')
    const [results, setResults] = useState<Customer[]>([])
    const [showAddForm, setShowAddForm] = useState(false)
    const [newCustomer, setNewCustomer] = useState({ name: '', phone: '', email: '', nif: '', rc: '', customer_type: 'retail' as const })

    useEffect(() => {
        const fetchCustomers = async () => {
            if (search.trim()) {
                setResults(await window.electron.customer.search(search))
            } else {
                const all = await window.electron.customer.getAll()
                setResults(all.slice(0, 10))
            }
        }
        fetchCustomers()
    }, [search])

    const handleAddCustomer = async () => {
        if (!newCustomer.name.trim()) return
        const result = await window.electron.customer.create(newCustomer)
        const customer = await window.electron.customer.getById(result.lastInsertRowid as number)
        if (customer) {
            onSelect(customer)
        }
    }

    return (
        <div className="customer-lookup-overlay">
            <div className="customer-lookup">
                <div className="lookup-header">
                    <h2>Choisir un client</h2>
                    <button className="btn-close" onClick={onClose}>×</button>
                </div>

                <div className="lookup-search">
                    <input
                        type="text"
                        placeholder="Rechercher par nom ou téléphone…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        autoFocus
                    />
                </div>

                {!showAddForm ? (
                    <>
                        <div className="customer-list">
                            {results.map(customer => (
                                <div
                                    key={customer.id}
                                    className="customer-item"
                                    onClick={() => onSelect(customer)}
                                >
                                    <div className="customer-avatar">
                                        {customer.name.charAt(0).toUpperCase()}
                                    </div>
                                    <div className="customer-info">
                                        <div className="customer-name">{customer.name}</div>
                                        {customer.phone && <div className="customer-phone">{customer.phone}</div>}
                                        <span className={`customer-type ${customer.customer_type}`}>
                                            {customer.customer_type}
                                        </span>
                                    </div>
                                </div>
                            ))}
                            {results.length === 0 && search && (
                                <div className="no-results">No customers found</div>
                            )}
                        </div>

                        <button className="btn-add-customer" onClick={() => setShowAddForm(true)}>
                            + Add New Customer
                        </button>
                    </>
                ) : (
                    <div className="add-customer-form">
                        <input
                            type="text"
                            placeholder="Nom du client *"
                            value={newCustomer.name}
                            onChange={(e) => setNewCustomer({ ...newCustomer, name: e.target.value })}
                        />
                        <input
                            type="tel"
                            placeholder="Phone Number"
                            value={newCustomer.phone}
                            onChange={(e) => setNewCustomer({ ...newCustomer, phone: e.target.value })}
                        />
                        <input
                            type="email"
                            placeholder="Email"
                            value={newCustomer.email}
                            onChange={(e) => setNewCustomer({ ...newCustomer, email: e.target.value })}
                        />
                        <input
                            type="text"
                            placeholder="NIF (clients professionnels)"
                            value={newCustomer.nif}
                            onChange={(e) => setNewCustomer({ ...newCustomer, nif: e.target.value })}
                        />
                        <input
                            type="text"
                            placeholder="RC (Registre de Commerce)"
                            value={newCustomer.rc}
                            onChange={(e) => setNewCustomer({ ...newCustomer, rc: e.target.value })}
                        />
                        {/* Price-tier selector removed in Phase 4 — retail shop, one shelf
                            price for everyone. A specific customer can still be given a
                            negotiated price via customer_prices. */}
                        <div className="form-actions">
                            <button className="btn-cancel" onClick={() => setShowAddForm(false)}>Annuler</button>
                            <button className="btn-save" onClick={handleAddCustomer}>Enregistrer le client</button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}
