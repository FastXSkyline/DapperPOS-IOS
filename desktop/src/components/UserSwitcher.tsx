import { useEffect, useMemo, useState } from 'react'
import { Store, X, Check, Lock, ShieldCheck } from 'lucide-react'
import { BrandMark } from './BrandLogo'
import { useLanguage } from '../LanguageContext'
import './UserSwitcher.css'

export interface SwitchUser {
    id: number
    name: string
    role: string
}

interface StoreRow {
    id: number
    name: string
    code: string
}

interface UserSwitcherProps {
    currentUser: SwitchUser
    stores: StoreRow[]
    storeId: number | null
    onSwitchUser: (user: SwitchUser) => void
    onSwitchStore: (storeId: number) => void
    onClose: () => void
}

/** Roles that can see margins, payroll, the audit trail and the settings —
 *  i.e. the ones worth a PIN. Cashier and warehouse are day-to-day roles that
 *  the person standing at the till already has, so gating them buys nothing and
 *  costs a keypad on every shift change. */
export const ELEVATED_ROLES = ['owner', 'manager']
export const isElevated = (role: string) => ELEVATED_ROLES.includes((role || '').toLowerCase())

/** Role names live in the locale files, so the sidebar card and this dialog
 *  switch with the rest of the app instead of staying French in Arabic. */
export const roleKey = (role: string) => `roles.${(role || '').toLowerCase()}`

/**
 * Who am I, and which shop is this till selling for.
 *
 * These two questions live behind ONE control because they fail the same way:
 * a sale rung up as the wrong person, or against the wrong shop, looks
 * completely normal on screen and only surfaces at month end when the figures
 * are already wrong. Putting them side by side means you cannot change one
 * while forgetting the other.
 *
 * Stepping DOWN (to a vendeur) is free. Stepping UP to responsable or
 * propriétaire asks for that person's PIN — which is the only real boundary
 * left now that the launch keypad is gone, so it is verified in the main
 * process (auth.login) and never against anything the renderer holds.
 */
export function UserSwitcher({
    currentUser, stores, storeId, onSwitchUser, onSwitchStore, onClose,
}: UserSwitcherProps) {
    const { t } = useLanguage()
    const [users, setUsers] = useState<SwitchUser[]>([])
    const [pending, setPending] = useState<SwitchUser | null>(null)
    const [pin, setPin] = useState('')
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)
    const [storeError, setStoreError] = useState('')

    useEffect(() => {
        window.electron?.user?.getAll?.()
            .then((rows: any[]) => setUsers(rows.map(r => ({ id: r.id, name: r.name, role: r.role }))))
            .catch(() => setUsers([]))
    }, [])

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onClose])

    // Only an owner/manager may re-point this terminal at another shop; the main
    // process enforces it too, so this is a courtesy that avoids a pointless
    // round-trip and an alert.
    const canSwitchStore = isElevated(currentUser.role)

    const sorted = useMemo(
        () => [...users].sort((a, b) => a.name.localeCompare(b.name, 'fr')),
        [users],
    )

    const choose = (u: SwitchUser) => {
        if (u.id === currentUser.id) { onClose(); return }
        setError('')
        setPin('')
        if (isElevated(u.role)) setPending(u)
        else onSwitchUser(u)
    }

    const confirmPin = async () => {
        if (!pending || pin.length < 4) return
        setBusy(true)
        setError('')
        try {
            // login() resolves the PIN to whoever owns it. Matching the id is what
            // makes this an identity check rather than "any valid PIN opens any
            // account" — a cashier's PIN must not unlock the owner.
            const who = await window.electron.auth.login(pin)
            if (who && who.id === pending.id) {
                onSwitchUser({ id: who.id, name: who.name, role: who.role })
            } else {
                setError(t('usw.wrongCode'))
                setPin('')
            }
        } catch {
            setError(t('usw.cantVerify'))
        } finally {
            setBusy(false)
        }
    }

    const pickStore = async (id: number) => {
        if (id === storeId) return
        setStoreError('')
        const res = await window.electron.store.setCurrent(id, currentUser.id)
        if (res?.ok) onSwitchStore(id)
        else setStoreError(res?.message || t('usw.storeRefused'))
    }

    return (
        <div className="el-modal-overlay" onClick={onClose} role="presentation">
            <div
                className="el-modal usw"
                onClick={e => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label={t('usw.title')}
            >
                <div className="el-modal-head">
                    <h2>{pending ? `${t('usw.codeOf')} ${pending.name}` : t('usw.title')}</h2>
                    <button className="el-icon-btn el-modal-x" onClick={onClose} aria-label={t('ui.close')}>
                        <X size={18} />
                    </button>
                </div>

                {pending ? (
                    <div className="el-modal-body usw-pin">
                        <div className="usw-pin-icon"><ShieldCheck size={26} /></div>
                        <p className="usw-pin-text">
                            <strong>{t(roleKey(pending.role))}</strong> — {t('usw.enterCode')}
                            {' '}{pending.name} {t('usw.openSession')}
                        </p>
                        <input
                            className="el-input usw-pin-input"
                            type="password"
                            inputMode="numeric"
                            autoComplete="off"
                            autoFocus
                            maxLength={8}
                            value={pin}
                            onChange={e => { setPin(e.target.value.replace(/\D/g, '')); setError('') }}
                            onKeyDown={e => { if (e.key === 'Enter') confirmPin() }}
                            aria-label={t('usw.codeOf')}
                            aria-invalid={!!error}
                        />
                        {error && <span className="el-error-text">{error}</span>}
                        <div className="usw-pin-actions">
                            <button className="el-btn el-btn--secondary" onClick={() => { setPending(null); setPin(''); setError('') }}>
                                {t('ui.back')}
                            </button>
                            <button
                                className="el-btn el-btn--primary"
                                onClick={confirmPin}
                                disabled={busy || pin.length < 4}
                            >
                                {busy ? t('usw.checking') : t('usw.openBtn')}
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="el-modal-body usw-body">
                        <section>
                            <h3 className="usw-section">{t('usw.storeOfPost')}</h3>
                            <p className="el-hint usw-section-hint">
                                {t('usw.storeHint')}
                                comptés pour ce magasin.
                            </p>
                            <div className="usw-stores">
                                {stores.map(s => (
                                    <button
                                        key={s.id}
                                        className={`usw-store ${s.id === storeId ? 'active' : ''}`}
                                        onClick={() => pickStore(s.id)}
                                        disabled={!canSwitchStore && s.id !== storeId}
                                    >
                                        <span className="usw-store-icon"><Store size={16} /></span>
                                        <span className="usw-store-text">
                                            <strong>{s.name}</strong>
                                            <small>{s.code}</small>
                                        </span>
                                        {s.id === storeId
                                            ? <Check size={16} className="usw-check" />
                                            : (!canSwitchStore && <Lock size={14} className="usw-lock" />)}
                                    </button>
                                ))}
                                {stores.length === 0 && (
                                    <p className="el-hint">{t('usw.noStores')}</p>
                                )}
                            </div>
                            {!canSwitchStore && stores.length > 1 && (
                                <p className="el-hint usw-locked-note">
                                    {t('usw.onlyManager')}
                                </p>
                            )}
                            {storeError && <span className="el-error-text">{storeError}</span>}
                        </section>

                        <hr className="el-divider" />

                        <section>
                            <h3 className="usw-section">{t('usw.whoUses')}</h3>
                            <p className="el-hint usw-section-hint">
                                {t('usw.whoHint')}
                            </p>
                            <div className="usw-users">
                                {sorted.map(u => (
                                    <button
                                        key={u.id}
                                        className={`usw-user ${u.id === currentUser.id ? 'active' : ''}`}
                                        onClick={() => choose(u)}
                                    >
                                        <span className="usw-avatar"><BrandMark size={17} letter={u.name} /></span>
                                        <span className="usw-user-text">
                                            <strong>{u.name}</strong>
                                            <small>{t(roleKey(u.role))}</small>
                                        </span>
                                        {u.id === currentUser.id
                                            ? <Check size={16} className="usw-check" />
                                            : (isElevated(u.role) && <Lock size={14} className="usw-lock" />)}
                                    </button>
                                ))}
                                {sorted.length === 0 && (
                                    <p className="el-hint">{t('usw.noUsers')}</p>
                                )}
                            </div>
                        </section>
                    </div>
                )}
            </div>
        </div>
    )
}
