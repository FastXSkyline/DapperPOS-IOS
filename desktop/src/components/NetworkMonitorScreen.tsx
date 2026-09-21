import { useState, useEffect, useCallback } from 'react'
import {
    Wifi, Server, Smartphone, MonitorSmartphone, RefreshCw, Globe,
    Database, Activity, UploadCloud, Radio, Laptop,
} from 'lucide-react'
import { formatDateTime } from '../utils/formatters'
import { useLanguage } from '../LanguageContext'
import type {
    NetworkDevice, NetworkLogs, NetworkLocalStatus, NetworkRemoteStatus,
} from '../vite-env'
import './NetworkMonitorScreen.css'

type Tab = 'devices' | 'logs' | 'remote'

const TABS: { id: Tab; key: string; icon: typeof Wifi }[] = [
    { id: 'devices', key: 'net.tabDevices', icon: Smartphone },
    { id: 'logs', key: 'net.tabLogs', icon: Database },
    { id: 'remote', key: 'net.tabRemote', icon: Globe },
]

/** How often the live lists re-read. Five seconds matches the online window the
 *  backend uses, so a phone that drops off wifi goes grey within one refresh. */
const REFRESH_MS = 5000

function timeAgo(sqlite: string | null): string {
    if (!sqlite) return '—'
    const t = Date.parse(sqlite.replace(' ', 'T') + 'Z')
    if (Number.isNaN(t)) return sqlite
    const s = Math.max(0, Math.round((Date.now() - t) / 1000))
    if (s < 10) return 'à l’instant'
    if (s < 60) return `il y a ${s}s`
    const m = Math.round(s / 60)
    if (m < 60) return `il y a ${m} min`
    const h = Math.round(m / 60)
    if (h < 24) return `il y a ${h} h`
    return `il y a ${Math.round(h / 24)} j`
}

function DeviceIcon({ type }: { type: string | null }) {
    const t = (type || '').toLowerCase()
    if (t.includes('phone') || t.includes('mobile') || t.includes('android') || t.includes('ios'))
        return <Smartphone size={17} />
    if (t.includes('tablet') || t.includes('ipad'))
        return <MonitorSmartphone size={17} />
    if (t.includes('desktop') || t.includes('terminal') || t.includes('pos'))
        return <Laptop size={17} />
    return <Radio size={17} />
}

function DeviceTable({ devices, emptyHint }: { devices: NetworkDevice[]; emptyHint: string }) {
    if (devices.length === 0) {
        return (
            <div className="el-empty">
                <span className="el-empty-icon"><Wifi size={24} /></span>
                <strong>Aucun appareil</strong>
                <span>{emptyHint}</span>
            </div>
        )
    }
    return (
        <div className="el-table-wrap">
            <table className="el-table nm-table">
                <thead>
                    <tr>
                        <th>Appareil</th>
                        <th>Type</th>
                        <th>Adresse IP</th>
                        <th>Dernière requête</th>
                        <th className="num">Requêtes</th>
                        <th>Vue</th>
                        <th>État</th>
                    </tr>
                </thead>
                <tbody>
                    {devices.map(d => (
                        <tr key={d.device_key}>
                            <td>
                                <span className="nm-device">
                                    <span className={`nm-device-icon ${d.online ? 'is-online' : ''}`}>
                                        <DeviceIcon type={d.device_type} />
                                    </span>
                                    <span className="nm-device-name">{d.label}</span>
                                </span>
                            </td>
                            <td className="muted">{d.device_type || '—'}</td>
                            <td className="muted tabular">{d.ip_address || '—'}</td>
                            <td className="muted nm-endpoint">{d.last_endpoint || '—'}</td>
                            <td className="num">{d.request_count}</td>
                            <td className="muted" title={d.last_seen_at ? formatDateTime(d.last_seen_at) : ''}>
                                {timeAgo(d.last_seen_at)}
                            </td>
                            <td>
                                <span className={`el-chip ${d.online ? 'el-chip--ok' : 'el-chip--neutral'}`}>
                                    <span className={`nm-dot ${d.online ? 'is-online' : ''}`} />
                                    {d.online ? 'En ligne' : 'Hors ligne'}
                                </span>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

function LogsView({ data }: { data: NetworkLogs | null }) {
    if (!data) return <div className="el-empty">Chargement…</div>
    const { logs, ingest } = data
    return (
        <div className="nm-logs">
            <div className="el-card nm-glass">
                <div className="el-card-head">
                    <h2 className="el-card-title"><Activity size={15} /> Journaux d’import &amp; de sync</h2>
                    <span className="el-chip el-chip--accent">{logs.length}</span>
                </div>
                {logs.length === 0 ? (
                    <div className="el-empty">
                        <span className="el-empty-icon"><Database size={22} /></span>
                        <strong>Aucune entrée</strong>
                        <span>Les imports de catalogue, les syncs mobile et les envois vers le serveur apparaîtront ici.</span>
                    </div>
                ) : (
                    <div className="el-table-wrap">
                        <table className="el-table nm-table">
                            <thead>
                                <tr>
                                    <th>Date</th>
                                    <th>Utilisateur</th>
                                    <th>Action</th>
                                    <th>Détail</th>
                                    <th>Appareil / IP</th>
                                </tr>
                            </thead>
                            <tbody>
                                {logs.map(r => (
                                    <tr key={r.id}>
                                        <td className="muted nowrap">{formatDateTime(r.created_at)}</td>
                                        <td>{r.user_name || '—'}</td>
                                        <td>
                                            <span className={`el-chip nm-kind-${r.kind}`}>{r.action}</span>
                                        </td>
                                        <td className="muted nm-detail">{r.summary || '—'}</td>
                                        <td className="muted nm-endpoint">
                                            {r.device_info || '—'}{r.ip_address ? ` · ${r.ip_address}` : ''}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            <div className="el-card nm-glass">
                <div className="el-card-head">
                    <h2 className="el-card-title"><UploadCloud size={15} /> Ventes reçues par appareil</h2>
                    <span className="el-chip el-chip--accent">{ingest.length}</span>
                </div>
                {ingest.length === 0 ? (
                    <p className="el-hint">Aucune vente importée depuis un appareil mobile pour le moment.</p>
                ) : (
                    <div className="el-table-wrap">
                        <table className="el-table nm-table">
                            <thead>
                                <tr>
                                    <th>Appareil source</th>
                                    <th className="num">Ventes</th>
                                    <th className="num">Chiffre d’affaires</th>
                                    <th>Première</th>
                                    <th>Dernière</th>
                                </tr>
                            </thead>
                            <tbody>
                                {ingest.map(r => (
                                    <tr key={r.source_device}>
                                        <td className="strong">{r.source_device}</td>
                                        <td className="num">{r.sales}</td>
                                        <td className="num tabular">{(r.revenue ?? 0).toLocaleString('fr-FR')}</td>
                                        <td className="muted nowrap">{formatDateTime(r.first_at)}</td>
                                        <td className="muted nowrap">{formatDateTime(r.last_at)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    )
}

/** A live "who is on right now" panel. `devices` is the full known list; only
 *  the ones inside the online window are shown, so a phone that leaves wifi
 *  drops off within one refresh. Used twice: localhost and server-hosted. */
function ActiveUsersPanel({ title, icon, devices, hint, errored }: {
    title: string
    icon: typeof Wifi
    devices: NetworkDevice[] | null
    hint: string
    errored?: string | null
}) {
    const Icon = icon
    const active = (devices || []).filter(d => d.online)
    return (
        <div className="el-card el-card--pad0 nm-glass nm-users-card">
            <div className="el-card-head el-card-head--ruled">
                <h2 className="el-card-title"><Icon size={15} /> {title}</h2>
                <span className="el-chip el-chip--accent">
                    <span className="nm-dot is-online" /> {active.length} actif{active.length === 1 ? '' : 's'}
                </span>
            </div>
            {errored ? (
                <div className="el-empty"><span className="nm-err">{errored}</span></div>
            ) : active.length === 0 ? (
                <div className="el-empty">
                    <span className="el-empty-icon"><Wifi size={22} /></span>
                    <strong>Aucun utilisateur actif</strong>
                    <span>{hint}</span>
                </div>
            ) : (
                <ul className="nm-users">
                    {active.map(d => (
                        <li key={d.device_key} className="nm-user">
                            <span className="nm-device-icon is-online"><DeviceIcon type={d.device_type} /></span>
                            <span className="nm-user-main">
                                <span className="nm-user-name">{d.label}</span>
                                <span className="nm-user-sub">
                                    {d.ip_address || '—'} · {d.device_type || 'appareil'} · {timeAgo(d.last_seen_at)}
                                </span>
                            </span>
                            <span className="nm-dot is-online" />
                        </li>
                    ))}
                </ul>
            )}
        </div>
    )
}

export function NetworkMonitorScreen() {
    const { t } = useLanguage()
    const [tab, setTab] = useState<Tab>('devices')
    const [localStatus, setLocalStatus] = useState<NetworkLocalStatus | null>(null)
    const [devices, setDevices] = useState<NetworkDevice[]>([])
    const [logs, setLogs] = useState<NetworkLogs | null>(null)
    const [remoteStatus, setRemoteStatus] = useState<NetworkRemoteStatus | null>(null)
    const [remoteDevices, setRemoteDevices] = useState<NetworkDevice[] | { error: string } | null>(null)
    const [remoteLogs, setRemoteLogs] = useState<NetworkLogs | { error: string } | null>(null)
    const [spin, setSpin] = useState(false)

    const loadLocal = useCallback(async () => {
        const [s, d, l] = await Promise.all([
            window.electron.network.localStatus(),
            window.electron.network.devices(),
            window.electron.network.importLogs(),
        ])
        setLocalStatus(s); setDevices(d); setLogs(l)
    }, [])

    const loadRemote = useCallback(async () => {
        const [rs, rd, rl] = await Promise.all([
            window.electron.network.remoteStatus(),
            window.electron.network.remoteDevices(),
            window.electron.network.remoteLogs(),
        ])
        setRemoteStatus(rs); setRemoteDevices(rd); setRemoteLogs(rl)
    }, [])

    const refresh = useCallback(async () => {
        setSpin(true)
        try {
            // Always read both sources so the "active users" panels (localhost vs
            // server-hosted) stay live on every tab, not just the remote one.
            await Promise.all([loadLocal(), loadRemote()])
        } finally {
            // Let the spinner be seen for a beat rather than flashing.
            setTimeout(() => setSpin(false), 250)
        }
    }, [loadLocal, loadRemote])

    useEffect(() => { void refresh() }, [refresh])
    useEffect(() => {
        const id = setInterval(() => { void refresh() }, REFRESH_MS)
        return () => clearInterval(id)
    }, [refresh])

    const online = devices.filter(d => d.online).length
    const remoteIsError = (v: unknown): v is { error: string } => !!v && typeof v === 'object' && 'error' in v

    return (
        <div className="el-page nm-page">
            <div className="el-page-head">
                <div>
                    <h1 className="el-page-title">{t('net.title')}</h1>
                    <p className="el-page-sub">{t('net.subtitle')}</p>
                </div>
                <div className="el-page-actions">
                    {localStatus && (
                        <span className="el-chip el-chip--accent nm-server-chip">
                            <Server size={13} />
                            {localStatus.isClient ? 'Terminal client' : 'Serveur du magasin'}
                            {localStatus.ip ? ` · ${localStatus.ip}:${localStatus.port}` : ''}
                        </span>
                    )}
                    <button className="el-btn el-btn--secondary nm-glow-btn" onClick={() => void refresh()}>
                        <RefreshCw size={15} className={spin ? 'nm-spin' : ''} /> Actualiser
                    </button>
                </div>
            </div>

            <div className="el-grid el-grid--stats nm-stats">
                <div className="el-stat nm-glass">
                    <span className="el-stat-label">Appareils en ligne</span>
                    <span className="el-stat-value">{online}</span>
                    <span className="el-stat-foot"><span className="nm-dot is-online" /> <span className="el-stat-note">vus il y a moins de 5 min</span></span>
                </div>
                <div className="el-stat nm-glass">
                    <span className="el-stat-label">Appareils connus</span>
                    <span className="el-stat-value">{devices.length}</span>
                    <span className="el-stat-foot"><span className="el-stat-note">sur ce serveur</span></span>
                </div>
                <div className="el-stat nm-glass">
                    <span className="el-stat-label">Entrées de journal</span>
                    <span className="el-stat-value">{logs?.logs.length ?? 0}</span>
                    <span className="el-stat-foot"><span className="el-stat-note">imports &amp; syncs</span></span>
                </div>
                <div className="el-stat nm-glass">
                    <span className="el-stat-label">Serveur distant</span>
                    <span className="el-stat-value nm-stat-remote">
                        {remoteStatus ? (remoteStatus.isClient ? (remoteStatus.connected ? 'Actif' : 'Inactif') : 'Local') : '—'}
                    </span>
                    <span className="el-stat-foot">
                        <span className={`nm-dot ${remoteStatus?.isClient && remoteStatus.connected ? 'is-online' : ''}`} />
                        <span className="el-stat-note">{remoteStatus?.serverUrl || 'ce poste est le serveur'}</span>
                    </span>
                </div>
            </div>

            {/* Active users — split by where they connect: this PC's own server
                (localhost / LAN) vs the hosted / remote store server. */}
            <div className="nm-users-grid">
                <ActiveUsersPanel
                    title="Utilisateurs actifs — localhost (ce serveur)"
                    icon={Laptop}
                    devices={devices}
                    hint="Les utilisateurs connectés au serveur de ce PC apparaîtront ici en temps réel."
                />
                <ActiveUsersPanel
                    title="Utilisateurs actifs — serveur hébergé"
                    icon={Globe}
                    devices={remoteIsError(remoteDevices) ? null : (remoteDevices as NetworkDevice[] | null)}
                    errored={remoteIsError(remoteDevices) ? remoteDevices.error : null}
                    hint="Les utilisateurs connectés au serveur hébergé / distant apparaîtront ici."
                />
            </div>

            <div className="el-tabs nm-tabs">
                {TABS.map(x => {
                    const Icon = x.icon
                    return (
                        <button
                            key={x.id}
                            className={`el-tab nm-tab ${tab === x.id ? 'active' : ''}`}
                            onClick={() => setTab(x.id)}
                        >
                            <Icon size={15} /> {t(x.key)}
                        </button>
                    )
                })}
            </div>

            {tab === 'devices' && (
                <div className="el-card el-card--pad0 nm-glass">
                    <div className="el-card-head el-card-head--ruled">
                        <h2 className="el-card-title"><Wifi size={15} /> Appareils connectés à ce serveur (localhost / LAN)</h2>
                        <span className="el-chip el-chip--neutral">{devices.length}</span>
                    </div>
                    <DeviceTable
                        devices={devices}
                        emptyHint="Les téléphones et terminaux qui se connectent au serveur de ce PC apparaîtront ici."
                    />
                </div>
            )}

            {tab === 'logs' && <LogsView data={logs} />}

            {tab === 'remote' && (
                <div className="nm-remote">
                    <div className="el-card nm-glass">
                        <div className="el-card-head">
                            <h2 className="el-card-title"><Globe size={15} /> Connexion au serveur du magasin</h2>
                            {remoteStatus && (
                                <span className={`el-chip ${remoteStatus.isClient && remoteStatus.connected ? 'el-chip--ok' : 'el-chip--neutral'}`}>
                                    <span className={`nm-dot ${remoteStatus.isClient && remoteStatus.connected ? 'is-online' : ''}`} />
                                    {remoteStatus.isClient ? (remoteStatus.connected ? 'Connecté' : 'Déconnecté') : 'Ce poste est le serveur'}
                                </span>
                            )}
                        </div>
                        {remoteStatus?.isClient ? (
                            <p className="el-hint">
                                Ce terminal est un <strong>client</strong> du serveur <code>{remoteStatus.serverUrl}</code>.
                                {remoteStatus.lastError ? <> Dernière erreur : <span className="nm-err">{remoteStatus.lastError}</span>.</> : ' Aucune erreur.'}
                                Les appareils et journaux ci-dessous sont lus <strong>depuis ce serveur distant</strong>.
                            </p>
                        ) : (
                            <p className="el-hint">
                                Ce poste <strong>est</strong> le serveur du magasin — les données « distantes » sont donc les siennes.
                                Pour surveiller un autre serveur, configurez ce terminal en mode client dans Paramètres › Synchronisation.
                            </p>
                        )}
                    </div>

                    <div className="el-card el-card--pad0 nm-glass">
                        <div className="el-card-head el-card-head--ruled">
                            <h2 className="el-card-title"><Smartphone size={15} /> Appareils sur le serveur distant</h2>
                        </div>
                        {remoteIsError(remoteDevices)
                            ? <div className="el-empty"><span className="nm-err">{remoteDevices.error}</span></div>
                            : <DeviceTable
                                devices={(remoteDevices as NetworkDevice[]) || []}
                                emptyHint="Aucun appareil enregistré sur le serveur distant."
                            />}
                    </div>

                    {remoteIsError(remoteLogs)
                        ? <div className="el-card nm-glass"><span className="nm-err">{remoteLogs.error}</span></div>
                        : <LogsView data={(remoteLogs as NetworkLogs) || null} />}
                </div>
            )}
        </div>
    )
}
