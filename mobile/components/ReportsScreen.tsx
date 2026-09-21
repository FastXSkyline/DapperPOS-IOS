import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { ProductService } from '../services/productService';
import { SyncQueueService } from '../services/syncQueue';
import { SPACING } from '../constants/theme';
import { useTheme } from '../context/ThemeContext';
import { Screen, GlassCard, PageTitle, SectionHeader, StatTile, Chip, IconButton, PrimaryButton, GhostButton } from './ui/Kit';

export function ReportsScreen() {
    const { colors } = useTheme();
    const [refreshing, setRefreshing] = useState(false);
    const [stats, setStats] = useState({
        products: 0,
        lowStock: 0,
        syncQueue: 0,
        lastUpdate: '--:--'
    });

    useEffect(() => {
        loadStats();
    }, []);

    const loadStats = async () => {
        try {
            const products = await ProductService.getAll();
            const lowStock = products.filter(p => (p.stock_quantity || 0) <= (p.min_stock_level || 5)).length;
            const queue = await SyncQueueService.getPendingCount();

            setStats({
                products: products.length,
                lowStock,
                syncQueue: queue,
                lastUpdate: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            });
        } catch (e) {
            console.error(e);
        }
    };

    const onRefresh = async () => {
        setRefreshing(true);
        await loadStats();
        setRefreshing(false);
    };

    return (
        <Screen>
            <SafeAreaView edges={['top']}>
                <View style={styles.header}>
                    <PageTitle
                        title="Dashboard"
                        subtitle={`Last updated at ${stats.lastUpdate}`}
                        right={<IconButton icon="refresh" onPress={onRefresh} tone="accent" size={44} />}
                    />
                </View>
            </SafeAreaView>

            <ScrollView
                style={styles.content}
                contentContainerStyle={styles.scrollContent}
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
                showsVerticalScrollIndicator={false}
            >
                <GlassCard pad="none" glow style={styles.heroSection}>
                    <LinearGradient
                        colors={[colors.primary, colors.primaryLight]}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 1 }}
                        style={styles.heroGradient}
                    >
                        <View style={styles.heroInfo}>
                            <Text style={styles.heroLabel}>Inventory Health</Text>
                            <Text style={[styles.heroValue, { color: colors.white }]}>Operational</Text>
                        </View>
                        <Chip label="System Online" tone="ok" icon="pulse" />
                    </LinearGradient>
                </GlassCard>

                <View style={styles.metricsGrid}>
                    <View style={styles.metricCell}>
                        <StatTile
                            label="Total Products"
                            value={String(stats.products)}
                            icon="cube"
                            accent="#A855F7"
                            note="Managed items"
                        />
                    </View>
                    <View style={styles.metricCell}>
                        <StatTile
                            label="Low Stock"
                            value={String(stats.lowStock)}
                            icon="warning"
                            accent="#EF4444"
                            note="Alerts active"
                        />
                    </View>
                    <View style={styles.metricCell}>
                        <StatTile
                            label="Sync Queue"
                            value={String(stats.syncQueue)}
                            icon="cloud-upload"
                            accent="#F59E0B"
                            note="Pending tasks"
                        />
                    </View>
                    <View style={styles.metricCell}>
                        <StatTile
                            label="Inventory Value"
                            value="High"
                            icon="stats-chart"
                            accent="#10B981"
                            note="Current equity"
                        />
                    </View>
                </View>

                <GlassCard style={styles.actionSection}>
                    <SectionHeader title="Quick Actions" icon="flash" />
                    <View style={styles.actionGrid}>
                        <PrimaryButton label="Export PDF" icon="print" onPress={() => {}} style={styles.actionBtn} />
                        <GhostButton label="Email Report" icon="mail" onPress={() => {}} style={styles.actionBtn} />
                    </View>
                </GlassCard>
            </ScrollView>
        </Screen>
    );
}

const styles = StyleSheet.create({
    header: { paddingHorizontal: SPACING.md, paddingTop: SPACING.md, paddingBottom: SPACING.sm },
    content: { flex: 1 },
    scrollContent: { paddingBottom: 140 },
    heroSection: { margin: SPACING.md },
    heroGradient: {
        flexDirection: 'row',
        padding: SPACING.xl,
        justifyContent: 'space-between',
        alignItems: 'center'
    },
    heroInfo: { gap: 4 },
    heroLabel: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1, color: 'rgba(255,255,255,0.7)' },
    heroValue: { fontSize: 26, fontWeight: '900', letterSpacing: -0.5 },
    metricsGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        paddingHorizontal: SPACING.md,
        gap: SPACING.sm
    },
    metricCell: { flexGrow: 1, flexBasis: '46%' },
    actionSection: { margin: SPACING.md },
    actionGrid: { flexDirection: 'row', gap: SPACING.sm },
    actionBtn: { flex: 1 }
});
