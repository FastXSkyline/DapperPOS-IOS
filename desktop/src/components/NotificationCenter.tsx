import { useState, useEffect, useCallback, useRef } from 'react'
import { Bell, RefreshCw, CheckCheck, AlertTriangle, AlertOctagon, Info, CheckCircle2 } from 'lucide-react'
import { formatDateTime } from '../utils/formatters'
import type { NotificationRow, Severity } from '../vite-env'
import './NotificationCenter.css'

interface Props {
    storeId: number | null
    /** Jump the shell to the screen that can act on an alert. */
    onNavigate?: (entityType: string | null, entityId: number | null) => void
}

const ICON: Record<Severity, typeof Info> = {
    critical: AlertOctagon,
    warning: AlertTriangle,
    success: CheckCircle2,
    info: Info,
}

/**
 * Notification centre.
 *
 * A PULL model: the sweep re-evaluates every rule against the current state, on
 * open and on demand. A shop PC is not always running, so a rule that only fired
 * at the instant a condition arose would miss everything that changed while the
 * machine was off — the centre would be a log of moments the app happened to be
 * awake rather than a statement about now.
 */
export function NotificationCenter({ storeId, onNavigate }: Props) {
    const [open, setOpen] = useState(false)
    const [rows, setRows] = useState<NotificationRow[]>([])
    const [unread, setUnread] = useState(0)
    const [unreadOnly, setUnreadOnly] = useState(true)
    const [sweeping, setSweeping] = useState(false)
    const panelRef = useRef<HTMLDivElement>(null)

    const store = storeId ?? undefined

    const refresh = useCallback(async () => {
        const [list, count] = await Promise.all([
            window.electron.notification.list({ storeId: store, unreadOnly, limit: 60 }),
            window.electron.notification.unreadCount(store),
        ])
        setRows(list)
        setUnread(count)
    }, [store, unreadOnly])

    // The badge is polled rather than pushed: without realtime there is no channel
    // to push on, and a stale badge is worse than a slightly delayed one. Five
    // minutes is well inside the resolution of every rule here (days, not seconds).
    useEffect(() => {
        window.electron?.notification?.unreadCount?.(store).then(setUnread).catch(() => {})
        const t = setInterval(() => {
            window.electron?.notification?.unreadCount?.(store).then(setUnread).catch(() => {})
        }, 5 * 60 * 1000)
        return () => clearInterval(t)
    }, [store])

    useEffect(() => { if (open) refresh() }, [open, refresh])

    // Sweep once when the panel is first opened, so what is shown reflects the
    // state of the shop right now rather than the last time anyone looked.
    const openPanel = async () => {
        setOpen(true)
        setSweeping(true)
        try {
            await window.electron.notification.sweep(storeId)
        } catch (e) {
            console.error('[Notifications] sweep failed:', e)
        } finally {
            setSweeping(false)
            await refresh()
        }
    }

    useEffect(() => {
        if (!open) return
        const onClick = (e: MouseEvent) => {
            if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false)
        }
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onClick)
        document.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('mousedown', onClick)
            document.removeEventListener('keydown', onKey)
        }
    }, [open])

    const dismiss = async (row: NotificationRow) => {
        await window.electron.notification.markRead(row.id)
        await refresh()
    }

    const dismissAll = async () => {
        await window.electron.notification.markAllRead(store)
        await refresh()
    }

    const rerun = async () => {
        setSweeping(true)
        try { await window.electron.notification.sweep(storeId) } finally {
            setSweeping(false)
            await refresh()
        }
    }

    return (
        <div className="ntf" ref={panelRef}>
            <button
                className={`ntf-trigger ${unread > 0 ? 'has-unread' : ''}`}
                onClick={() => (open ? setOpen(false) : openPanel())}
                aria-label={`Notifications${unread > 0 ? ` (${unread} non lues)` : ''}`}
                aria-expanded={open}
            >
                <Bell size={18} />
                {unread > 0 && <span className="ntf-badge">{unread > 99 ? '99+' : unread}</span>}
            </button>

            {open && (
                <div className="ntf-panel" role="dialog" aria-label="Notifications">
                    <header className="ntf-head">
                        <strong>Notifications</strong>
                        <div className="ntf-head-actions">
                            <button onClick={rerun} disabled={sweeping} title="Réanalyser">
                                <RefreshCw size={14} className={sweeping ? 'spin' : ''} />
                            </button>
                            <button onClick={dismissAll} disabled={unread === 0} title="Tout marquer comme lu">
                                <CheckCheck size={14} />
                            </button>
                        </div>
                    </header>

                    <div className="ntf-tabs">
                        <button className={unreadOnly ? 'active' : ''} onClick={() => setUnreadOnly(true)}>
                            Non lues {unread > 0 && `(${unread})`}
                        </button>
                        <button className={!unreadOnly ? 'active' : ''} onClick={() => setUnreadOnly(false)}>
                            Toutes
                        </button>
                    </div>

                    <div className="ntf-list">
                        {sweeping && rows.length === 0 && <p className="ntf-state">Analyse…</p>}
                        {!sweeping && rows.length === 0 && (
                            <p className="ntf-state">
                                {unreadOnly ? 'Rien à signaler.' : 'Aucune notification.'}
                            </p>
                        )}
                        {rows.map(r => {
                            const Icon = ICON[r.severity]
                            return (
                                <article key={r.id} className={`ntf-item ${r.severity} ${r.read_at ? 'read' : ''}`}>
                                    <Icon size={16} />
                                    <div className="ntf-body">
                                        <button
                                            className="ntf-title"
                                            onClick={() => {
                                                onNavigate?.(r.entity_type, r.entity_id)
                                                setOpen(false)
                                            }}
                                        >
                                            {r.title}
                                        </button>
                                        {r.body && <p>{r.body}</p>}
                                        <span className="ntf-when">
                                            {formatDateTime(r.created_at)}
                                            {r.store_name && ` · ${r.store_name}`}
                                        </span>
                                    </div>
                                    {!r.read_at && (
                                        <button className="ntf-dismiss" onClick={() => dismiss(r)} title="Marquer comme lu">
                                            <CheckCheck size={14} />
                                        </button>
                                    )}
                                </article>
                            )
                        })}
                    </div>
                </div>
            )}
        </div>
    )
}
