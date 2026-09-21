import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme } from '../context/ThemeContext';
import { SPACING, SHADOWS } from '../constants/theme';
import {
    Screen, SectionHeader, Chip, Thumb, Bar, Divider, GradientPill,
} from './ui/Kit';
import { getDatabase, TransactionService } from '../services/database';
import { StockService } from '../services/stockService';
import type { Tab } from '../services/permissions';

const money = (n: number) => `${Math.round(n).toLocaleString()}`;

interface DayPoint { label: string; value: number; }

/** Quick Access tile — glyph at the top, label at the bottom, over a diagonal
 *  gradient surface (light enters from the `sheen` corner). */
function QuickAccessCard({ icon, label, onPress, badge, sheen = 'topLeft' }: {
    icon: keyof typeof Ionicons.glyphMap; label: string;
    onPress: () => void; badge?: number;
    sheen?: 'topLeft' | 'bottomRight';
}) {
    const { colors, theme } = useTheme();
    const dark = theme === 'dark';
    const g = sheen === 'topLeft'
        ? { colors: dark
            ? [colors.accent + '34', 'rgba(26,27,38,0.92)', 'rgba(17,18,28,0.95)']
            : [colors.accent + '34', 'rgba(255,255,255,0.97)', 'rgba(240,241,250,0.96)'],
            start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }
        : { colors: dark
            ? ['rgba(17,18,28,0.95)', 'rgba(26,27,38,0.92)', colors.accent + '34']
            : ['rgba(240,241,250,0.96)', 'rgba(255,255,255,0.97)', colors.accent + '34'],
            start: { x: 0, y: 0 }, end: { x: 1, y: 1 } };
    return (
        <TouchableOpacity activeOpacity={0.75} onPress={onPress} style={{ flex: 1 }}>
            <View style={[styles.qaCard, { borderColor: dark ? 'rgba(255,255,255,0.08)' : 'rgba(17,17,17,0.05)' }, SHADOWS.sm]}>
                <LinearGradient
                    colors={g.colors as any}
                    start={g.start as any} end={g.end as any}
                    style={[StyleSheet.absoluteFill, { borderRadius: 20 }]}
                />
                <View style={styles.qaCardInner}>
                    <View style={styles.qaGlyphPlate}>
                        <Ionicons name={icon} size={20} color={colors.accent} />
                        {badge !== undefined && badge > 0 && (
                            <View style={[styles.qaBadge, { backgroundColor: colors.error }]}>
                                <Text style={styles.qaBadgeText}>{badge}</Text>
                            </View>
                        )}
                    </View>
                    <Text style={[styles.qaCardLabel, { color: colors.text }]} numberOfLines={1}>{label}</Text>
                </View>
            </View>
        </TouchableOpacity>
    );
}

export function HomeScreen({ userName, role, onNavigate }: {
    userName: string; role: string; onNavigate: (t: Tab) => void;
}) {
    const { colors, theme, toggleTheme } = useTheme();
    const [revenue, setRevenue] = useState(0);
    const [orders, setOrders] = useState(0);
    const [lowStock, setLowStock] = useState<any[]>([]);
    const [outstanding, setOutstanding] = useState(0);
    const [week, setWeek] = useState<DayPoint[]>([]);
    const [refreshing, setRefreshing] = useState(false);
    const [heldCount, setHeldCount] = useState(0);

    const load = useCallback(async () => {
        const db = getDatabase();

        // Today's completed sales + count.
        try {
            if (db) {
                const row: any = await db.getFirstAsync(
                    `SELECT COALESCE(SUM(total_amount),0) AS rev, COUNT(*) AS n
                     FROM transactions
                     WHERE status='completed' AND date(created_at)=date('now','localtime')`
                );
                setRevenue(row?.rev ?? 0);
                setOrders(row?.n ?? 0);

                const bal: any = await db.getFirstAsync(
                    `SELECT COALESCE(SUM(MAX(total_amount - amount_paid,0)),0) AS owed
                     FROM transactions WHERE status='completed'`
                );
                setOutstanding(bal?.owed ?? 0);

                const days: any[] = await db.getAllAsync(
                    `SELECT date(created_at) AS d, COALESCE(SUM(total_amount),0) AS v
                     FROM transactions
                     WHERE status='completed' AND created_at >= datetime('now','-6 days','start of day','localtime')
                     GROUP BY date(created_at) ORDER BY d`
                );
                setWeek(buildWeek(days));
            }
        } catch { /* defensive: a missing column or empty db just yields zeros */ }

        // Low stock + held tickets.
        try {
            const low = await StockService.getLowStockProducts();
            setLowStock((low || []).slice(0, 5));
        } catch {
            try { setLowStock([]); } catch { setLowStock([]); }
        }
        try {
            const held = await TransactionService.getHeldTransactions();
            setHeldCount((held || []).length);
        } catch { setHeldCount(0); }
    }, []);

    useEffect(() => { load(); }, [load]);

    const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

    const maxWeek = Math.max(1, ...week.map(d => d.value));
    const firstName = (userName || '').split(' ')[0];
    const isPrivileged = ['owner', 'manager'].includes((role || '').toLowerCase());
    const dark = theme === 'dark';

    // The soft accent glow rising from the bottom of the page (behind the dock).
    const bottomGlow: [string, string, string] = dark
        ? ['rgba(123,116,246,0)', 'rgba(123,116,246,0.10)', 'rgba(123,116,246,0.26)']
        : ['rgba(91,87,232,0)', 'rgba(91,87,232,0.07)', 'rgba(91,87,232,0.15)'];

    return (
        <Screen>                {/* Bottom glow gradient — the reference's luminous base, one layer. */}
            <LinearGradient
                colors={bottomGlow}
                start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 1 }}
                style={StyleSheet.absoluteFill as any}
                pointerEvents="none"
            />
            <SafeAreaView edges={['top']} style={{ flex: 1 }}>
                <ScrollView
                    showsVerticalScrollIndicator={false}
                    contentContainerStyle={{ padding: SPACING.md, paddingBottom: 140 }}
                    refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} colors={[colors.accent]} />}
                >
                    {/* Hero greeting — reference header: avatar chip + name + round buttons */}
                    <View style={styles.hero}>
                        <View style={[styles.heroAvatar, {
                            backgroundColor: dark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.9)',
                            borderColor: dark ? 'rgba(255,255,255,0.07)' : 'rgba(17,17,17,0.05)',
                        }]}>
                            <Text style={[styles.heroAvatarText, { color: colors.text }]}>
                                {(firstName || 'D')[0].toUpperCase()}
                            </Text>
                        </View>
                        <View style={{ flex: 1 }}>
                            <Text style={[styles.heroName, { color: colors.text }]} numberOfLines={1}>
                                {firstName || 'Dapper'}
                            </Text>
                            <Text style={[styles.heroHi, { color: colors.textMuted }]}>
                                {greeting()} — Dapper POS
                            </Text>
                        </View>
                        <TouchableOpacity
                            style={[styles.heroRoundBtn, {
                                backgroundColor: dark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.9)',
                                borderColor: dark ? 'rgba(255,255,255,0.07)' : 'rgba(17,17,17,0.05)',
                            }]}
                            onPress={toggleTheme}
                        >
                            <Ionicons name={dark ? 'sunny-outline' : 'moon-outline'} size={18} color={colors.text} />
                        </TouchableOpacity>
                    </View>

                    {/* Balance card — rich diagonal gradient: accent glow from
                        the top-left corner falling through the base, with a
                        deep anchor stop at the bottom for depth. */}
                    <View style={[styles.balanceCard, { borderColor: dark ? 'rgba(255,255,255,0.07)' : 'rgba(17,17,17,0.05)' }]}>
                        <LinearGradient
                            colors={dark
                                ? [colors.accent + '38', colors.accent + '12', 'rgba(26,27,38,0.92)', 'rgba(14,15,24,0.97)']
                                : [colors.accent + '38', colors.accent + '14', 'rgba(255,255,255,0.97)', 'rgba(238,240,250,0.97)']}
                            start={{ x: 0, y: 0 }} end={{ x: 0.85, y: 1 }}
                            style={[StyleSheet.absoluteFill, { borderRadius: 24 }]}
                        />
                        {/* Centered snapshot — reference "Portfolio Snapshot" block */}
                        <View style={styles.revHead}>
                            <Text style={[styles.revLabel, { color: colors.textMuted }]}>Portfolio du jour</Text>
                            <Text style={[styles.revValue, { color: colors.text }]}>
                                {money(revenue)} <Text style={{ fontSize: 15, fontWeight: '700', color: colors.textMuted }}>DZD</Text>
                            </Text>
                            <Chip label={`${orders} ticket${orders === 1 ? '' : 's'}`} tone="accent" icon="receipt-outline" />
                        </View>
                        <View style={styles.spark}>
                            {week.map((d, i) => (
                                <View key={i} style={styles.sparkCol}>
                                    <View style={styles.sparkBarWrap}>
                                        <View style={[styles.sparkBar, {
                                            height: `${Math.max(6, (d.value / maxWeek) * 100)}%`,
                                            backgroundColor: i === week.length - 1 ? colors.accent : (dark ? colors.accent + '50' : colors.accent + '2E'),
                                        }]} />
                                    </View>
                                    <Text style={[styles.sparkLabel, { color: i === week.length - 1 ? colors.accent : colors.textTertiary }]}>{d.label}</Text>
                                </View>
                            ))}
                        </View>
                        {/* Compact secondary figures inside the same card */}
                        <View style={[styles.balanceFoot, { borderTopColor: dark ? 'rgba(255,255,255,0.06)' : 'rgba(17,17,17,0.05)' }]}>
                            <View style={styles.balanceFootItem}>
                                <Text style={[styles.balanceFootLabel, { color: colors.textMuted }]}>Encaissé client</Text>
                                <Text style={[styles.balanceFootValue, { color: colors.text }]}>{money(outstanding)}</Text>
                            </View>
                            <View style={styles.balanceFootItem}>
                                <Text style={[styles.balanceFootLabel, { color: colors.textMuted }]}>Stock faible</Text>
                                <Text style={[styles.balanceFootValue, { color: lowStock.length ? colors.warning : colors.text }]}>{lowStock.length}</Text>
                            </View>
                            <View style={styles.balanceFootItem}>
                                <Text style={[styles.balanceFootLabel, { color: colors.textMuted }]}>En attente</Text>
                                <Text style={[styles.balanceFootValue, { color: colors.text }]}>{heldCount}</Text>
                            </View>
                        </View>
                    </View>

                    {/* Action pills — quiet pill left, gradient CTA right */}
                    <View style={styles.chipRow}>
                        <GradientPill tone="quiet" icon="cube-outline" label="Stock" onPress={() => onNavigate('Inventory')} style={{ flex: 1 }} />
                        <GradientPill icon="cart" label="Vendre" onPress={() => onNavigate('POS')} style={{ flex: 1 }} />
                    </View>

                    {/* Quick Access — diagonal gradient tiles, alternating light
                        direction so the row reads as one lit scene */}
                    <SectionHeader title="Accès rapide" />
                    <View style={styles.qaGrid}>
                        <QuickAccessCard icon="cart-outline" label="Vendre" onPress={() => onNavigate('POS')} badge={heldCount} sheen="topLeft" />
                        {isPrivileged && <QuickAccessCard icon="stats-chart-outline" label="Stats" onPress={() => onNavigate('Reports')} sheen="bottomRight" />}
                        {isPrivileged && <QuickAccessCard icon="people-outline" label="Dettes" onPress={() => onNavigate('Debtors')} sheen="topLeft" />}
                        {isPrivileged && <QuickAccessCard icon="wallet-outline" label="Frais" onPress={() => onNavigate('Expenses')} sheen="bottomRight" />}
                    </View>
                    <View style={styles.qaGrid}>
                        {isPrivileged && <QuickAccessCard icon="receipt-outline" label="Commandes" onPress={() => onNavigate('Orders')} sheen="bottomRight" />}
                        {isPrivileged && <QuickAccessCard icon="pricetag-outline" label="Fournisseurs" onPress={() => onNavigate('Suppliers')} sheen="topLeft" />}
                        {isPrivileged && <QuickAccessCard icon="card-outline" label="Règl." onPress={() => onNavigate('Settlements')} sheen="bottomRight" />}
                        <QuickAccessCard icon="settings-outline" label="Réglages" onPress={() => onNavigate('Settings')} sheen="topLeft" />
                    </View>

                    {/* Low stock widget — the mirrored gradient: accent glow rising
                        from the bottom-right (diagonal inverse of the balance card) */}
                    <View style={[styles.listCard, { marginTop: SPACING.md, borderColor: dark ? 'rgba(255,255,255,0.07)' : 'rgba(17,17,17,0.05)' }]}>
                        <LinearGradient
                            colors={dark
                                ? ['rgba(14,15,24,0.97)', 'rgba(26,27,38,0.92)', colors.accent + '10', colors.accent + '38']
                                : ['rgba(238,240,250,0.97)', 'rgba(255,255,255,0.97)', colors.accent + '14', colors.accent + '38']}
                            start={{ x: 0, y: 0 }} end={{ x: 0.85, y: 1 }}
                            style={[StyleSheet.absoluteFill, { borderRadius: 24 }]}
                        />
                        <View>
                        <SectionHeader title="Alertes de stock" icon="trending-down-outline"
                            action={<TouchableOpacity onPress={() => onNavigate('Inventory')}>
                                <Text style={{ color: colors.accent, fontWeight: '700', fontSize: 12.5 }}>Voir tout</Text>
                            </TouchableOpacity>} />
                        {lowStock.length === 0 ? (
                            <View style={styles.allGood}>
                                <Ionicons name="checkmark-circle" size={20} color={colors.success} />
                                <Text style={{ color: colors.textMuted, fontWeight: '600', fontSize: 13 }}>Aucune alerte — stock sain</Text>
                            </View>
                        ) : lowStock.map((p: any, i: number) => {
                            const qty = p.stock_quantity ?? p.quantity ?? 0;
                            const min = p.min_stock_level ?? 5;
                            const pct = min > 0 ? Math.min(100, (qty / (min * 2 || 1)) * 100) : 0;
                            return (
                                <View key={p.id ?? i}>
                                    {i > 0 && <Divider style={{ marginVertical: 10 }} />}
                                    <View style={styles.stockRow}>
                                        <Thumb seed={p.id ?? i} label={p.name} size={40} icon="cube-outline" />
                                        <View style={{ flex: 1 }}>
                                            <Text style={[styles.stockName, { color: colors.text }]} numberOfLines={1}>{p.name}</Text>
                                            <View style={{ marginTop: 6 }}>
                                                <Bar pct={pct} color={qty === 0 ? colors.error : colors.warning} />
                                            </View>
                                        </View>
                                        <Chip label={`${qty} rest.`} tone={qty === 0 ? 'bad' : 'warn'} />
                                    </View>
                                </View>
                            );
                        })}
                        </View>
                    </View>
                </ScrollView>
            </SafeAreaView>
        </Screen>
    );
}

function greeting() {
    const h = new Date().getHours();
    if (h < 12) return 'Bonjour';
    if (h < 18) return 'Bon après-midi';
    return 'Bonsoir';
}

/** Build a fixed 7-slot week (Mon..today) from sparse grouped rows. */
function buildWeek(rows: { d: string; v: number }[]): DayPoint[] {
    const labels = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];
    const out: DayPoint[] = [];
    const byDate: Record<string, number> = {};
    rows.forEach(r => { byDate[r.d] = r.v; });
    for (let i = 6; i >= 0; i--) {
        const dt = new Date();
        dt.setDate(dt.getDate() - i);
        const key = dt.toISOString().slice(0, 10);
        out.push({ label: labels[dt.getDay()], value: byDate[key] ?? 0 });
    }
    return out;
}

const styles = StyleSheet.create({
    hero: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: SPACING.sm },
    heroHi: { fontSize: 12, fontWeight: '600' },
    heroName: { fontSize: 19, fontWeight: '800', letterSpacing: -0.4 },
    heroAvatar: {
        width: 46, height: 46, borderRadius: 23,
        alignItems: 'center', justifyContent: 'center', borderWidth: 1,
    },
    heroAvatarText: { fontSize: 18, fontWeight: '800' },
    heroRoundBtn: {
        width: 42, height: 42, borderRadius: 21,
        alignItems: 'center', justifyContent: 'center', borderWidth: 1,
    },

    balanceCard: {
        marginTop: SPACING.md,
        borderRadius: 24,
        borderWidth: 1,
        padding: 20,
        ...SHADOWS.sm,
    },
    revHead: { alignItems: 'center', gap: 4 },
    revLabel: { fontSize: 13, fontWeight: '600' },
    revValue: { fontSize: 36, fontWeight: '800', letterSpacing: -1, marginTop: 2, fontVariant: ['tabular-nums'] as any },
    spark: { flexDirection: 'row', alignItems: 'flex-end', height: 56, marginTop: 16, gap: 6 },
    sparkCol: { flex: 1, alignItems: 'center', height: '100%' },
    sparkBarWrap: { flex: 1, width: '100%', justifyContent: 'flex-end', alignItems: 'center' },
    sparkBar: { width: '62%', borderRadius: 6 },
    sparkLabel: { fontSize: 10.5, fontWeight: '700', marginTop: 6 },
    balanceFoot: {
        flexDirection: 'row', marginTop: 16, paddingTop: 14, borderTopWidth: 1, gap: 8,
        borderTopColor: 'rgba(255,255,255,0.06)',
    },
    balanceFootItem: { flex: 1, alignItems: 'center' },
    balanceFootLabel: { fontSize: 11.5, fontWeight: '600' },
    balanceFootValue: { fontSize: 16, fontWeight: '800', marginTop: 2, fontVariant: ['tabular-nums'] as any },

    chipRow: { flexDirection: 'row', gap: 10, marginTop: SPACING.md },
    chipDark: {
        flexDirection: 'row', alignItems: 'center', gap: 7,
        borderRadius: 999, borderWidth: 1,
        paddingVertical: 12, paddingHorizontal: 22,
    },
    chipDarkText: { fontSize: 14.5, fontWeight: '700' },
    chipCTA: {
        flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
        borderRadius: 999, overflow: 'hidden',
        paddingVertical: 12, paddingHorizontal: 22,
    },
    chipCTAText: { color: '#fff', fontSize: 14.5, fontWeight: '800' },

    qaGrid: { flexDirection: 'row', gap: 10, marginTop: SPACING.sm },
    qaCard: {
        flex: 1,
        borderRadius: 20,
        borderWidth: 1,
        minHeight: 96,
        overflow: 'hidden',
    },
    qaCardInner: {
        padding: 14,
        minHeight: 96,
        justifyContent: 'space-between',
    },
    qaGlyphPlate: { alignSelf: 'flex-start' },
    qaCardLabel: { fontSize: 13, fontWeight: '700', marginTop: 10 },
    qaBadge: {
        position: 'absolute', top: -4, right: -8, minWidth: 18, height: 18,
        borderRadius: 9, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4,
    },
    qaBadgeText: { color: '#fff', fontSize: 10, fontWeight: '800' },

    listCard: {
        borderRadius: 24, borderWidth: 1, padding: 18, ...SHADOWS.sm,
    },

    allGood: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
    stockRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    stockName: { fontSize: 14, fontWeight: '700' },
});
