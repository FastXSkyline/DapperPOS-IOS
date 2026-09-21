import React from 'react'
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    ScrollView,
    Dimensions,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons'
import { LinearGradient } from 'expo-linear-gradient'
import { type Product } from '../services/productService'
import { COLORS, SPACING, RADIUS, SHADOWS } from '../constants/theme'
import { useTheme } from '../context/ThemeContext'

interface ProductDetailProps {
    product: Product
    onClose: () => void
    onAdjustStock?: (productId: number) => void
}

export function ProductDetail({ product, onClose, onAdjustStock }: ProductDetailProps) {
    const { colors, theme } = useTheme()
    const profitMargin = product.retail_price > 0
        ? ((product.retail_price - product.cost_price) / product.retail_price * 100).toFixed(1)
        : '0'

    const isLowStock = (product.stock_quantity || 0) <= (product.min_stock_level || 5)

    const InfoCard = ({ icon, label, value, subValue, color }: any) => (
        <View style={[styles.infoCard, { backgroundColor: colors.glass, borderColor: colors.border }]}>
            <View style={[styles.cardIconBox, { backgroundColor: `${color}15` }]}>
                <Ionicons name={icon} size={20} color={color} />
            </View>
            <View>
                <Text style={[styles.cardLabel, { color: colors.textMuted }]}>{label}</Text>
                <Text style={[styles.cardValue, { color: colors.text }]}>{value}</Text>
                {subValue && <Text style={[styles.cardSubValue, { color: colors.textMuted }]}>{subValue}</Text>}
            </View>
        </View>
    )

    return (
        <View style={[styles.container, { backgroundColor: colors.background }]}>
            <LinearGradient
                colors={[colors.primary, colors.primaryLight]}
                style={styles.topBar}
            >
                <SafeAreaView edges={['top']}>
                    <View style={styles.header}>
                        <TouchableOpacity onPress={onClose} style={styles.backButton}>
                            <Ionicons name="chevron-back" size={24} color={colors.white} />
                        </TouchableOpacity>
                        <Text style={[styles.title, { color: colors.white }]}>Product Details</Text>
                        <View style={{ width: 40 }} />
                    </View>
                </SafeAreaView>
            </LinearGradient>

            <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
                <View style={styles.mainHeader}>
                    <Text style={[styles.productName, { color: colors.text }]}>{product.name}</Text>
                    <View style={styles.idRow}>
                        {product.sku && (
                            <View style={[styles.idBadge, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                                <Text style={[styles.idText, { color: colors.textMuted }]}>SKU: {product.sku}</Text>
                            </View>
                        )}
                        {product.barcode && (
                            <View style={[styles.idBadge, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                                <Text style={[styles.idText, { color: colors.textMuted }]}>UPC: {product.barcode}</Text>
                            </View>
                        )}
                    </View>
                </View>

                <View style={styles.statsGrid}>
                    <InfoCard
                        icon="pricetag"
                        label="Retail Price"
                        value={`DZD ${product.retail_price.toLocaleString()}`}
                        subValue={`Cost: DZD ${product.cost_price}`}
                        color={colors.success}
                    />
                    <InfoCard
                        icon="trending-up"
                        label="Profit Margin"
                        value={`${profitMargin}%`}
                        subValue={`${(product.retail_price - product.cost_price).toFixed(2)} DZD`}
                        color={colors.accent}
                    />
                </View>

                <View style={[styles.stockPanel, isLowStock && styles.lowStockPanel, { backgroundColor: colors.surface, borderColor: colors.border, borderLeftColor: isLowStock ? colors.error : colors.success }]}>
                    <View style={styles.stockHeader}>
                        <View>
                            <Text style={[styles.stockLabel, { color: colors.textMuted }]}>Available Stock</Text>
                            <Text style={[styles.stockValue, { color: isLowStock ? colors.error : colors.success }]}>
                                {product.stock_quantity || 0} Units
                            </Text>
                        </View>
                        <View style={[styles.stockStatus, { backgroundColor: isLowStock ? colors.error : colors.success }]}>
                            <Text style={styles.stockStatusText}>{isLowStock ? 'Restock Required' : 'Healthy'}</Text>
                        </View>
                    </View>

                    <View style={styles.stockDetails}>
                        <View style={styles.stockDetailItem}>
                            <Text style={[styles.stockDetailLabel, { color: colors.textMuted }]}>Min Level</Text>
                            <Text style={[styles.stockDetailValue, { color: colors.text }]}>{product.min_stock_level}</Text>
                        </View>
                        <View style={styles.stockDetailItem}>
                            <Text style={[styles.stockDetailLabel, { color: colors.textMuted }]}>Lead Time</Text>
                            <Text style={[styles.stockDetailValue, { color: colors.text }]}>{product.lead_time_days} Days</Text>
                        </View>
                        <View style={styles.stockDetailItem}>
                            <Text style={[styles.stockDetailLabel, { color: colors.textMuted }]}>Category</Text>
                            <Text style={[styles.stockDetailValue, { color: colors.text }]}>{product.category_name || 'None'}</Text>
                        </View>
                    </View>
                </View>

                <View style={[styles.section, { backgroundColor: colors.glass, borderColor: colors.border }]}>
                    <Text style={[styles.sectionTitle, { color: colors.text }]}>General Information</Text>
                    <View style={styles.infoRow}>
                        <View style={styles.infoCol}>
                            <Text style={[styles.infoLabel, { color: colors.textMuted }]}>Supplier</Text>
                            <Text style={[styles.infoValue, { color: colors.text }]}>{product.supplier_name || 'Not Set'}</Text>
                        </View>
                    </View>
                </View>

                {onAdjustStock && (
                    <TouchableOpacity
                        style={[styles.actionButton, { backgroundColor: colors.accent, ...SHADOWS.accent }]}
                        onPress={() => onAdjustStock(product.id)}
                    >
                        <Ionicons name="options" size={20} color={colors.white} />
                        <Text style={[styles.actionButtonText, { color: colors.white }]}>Adjust Inventory</Text>
                    </TouchableOpacity>
                )}

                <View style={{ height: 100 }} />
            </ScrollView>
        </View>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1 },
    topBar: { paddingBottom: SPACING.md },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: SPACING.md,
        height: 56
    },
    backButton: {
        width: 40,
        height: 40,
        borderRadius: RADIUS.full,
        backgroundColor: 'rgba(255, 255, 255, 0.18)',
        alignItems: 'center',
        justifyContent: 'center'
    },
    title: { fontSize: 18, fontWeight: '700', letterSpacing: -0.5 },
    content: { flex: 1, padding: SPACING.md },
    mainHeader: { marginBottom: SPACING.lg },
    productName: { fontSize: 30, fontWeight: '800', marginBottom: SPACING.sm, letterSpacing: -0.5 },
    idRow: { flexDirection: 'row', gap: SPACING.sm },
    idBadge: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: RADIUS.full, borderWidth: 1 },
    idText: { fontSize: 12, fontWeight: '600' },

    statsGrid: { flexDirection: 'row', gap: SPACING.md, marginBottom: SPACING.lg },
    infoCard: {
        flex: 1,
        padding: SPACING.lg,
        borderRadius: RADIUS.lg,
        ...SHADOWS.md,
        gap: SPACING.sm,
        borderWidth: 1,
    },
    cardIconBox: { width: 40, height: 40, borderRadius: RADIUS.md, alignItems: 'center', justifyContent: 'center' },
    cardLabel: { fontSize: 12, fontWeight: '600' },
    cardValue: { fontSize: 18, fontWeight: '800', fontVariant: ['tabular-nums'] },
    cardSubValue: { fontSize: 10, marginTop: 2, fontVariant: ['tabular-nums'] },

    stockPanel: {
        padding: SPACING.lg,
        borderRadius: RADIUS.lg,
        marginBottom: SPACING.lg,
        ...SHADOWS.md,
        borderLeftWidth: 6,
        borderWidth: 1,
    },
    lowStockPanel: {},
    stockHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: SPACING.lg },
    stockLabel: { fontSize: 14, fontWeight: '600' },
    stockValue: { fontSize: 34, fontWeight: '900', letterSpacing: -0.5, fontVariant: ['tabular-nums'] },
    stockStatus: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center' },
    stockStatusText: { color: COLORS.white, fontSize: 10, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5 },
    stockDetails: { flexDirection: 'row', justifyContent: 'space-between' },
    stockDetailItem: { gap: 4 },
    stockDetailLabel: { fontSize: 10, fontWeight: '700' },
    stockDetailValue: { fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'] },

    section: { padding: SPACING.lg, borderRadius: RADIUS.lg, ...SHADOWS.md, marginBottom: SPACING.lg, borderWidth: 1 },
    sectionTitle: { fontSize: 17, fontWeight: '800', marginBottom: SPACING.md, letterSpacing: -0.5 },
    infoRow: { flexDirection: 'row', gap: SPACING.xl },
    infoCol: { flex: 1, gap: 4 },
    infoLabel: { fontSize: 12, fontWeight: '700' },
    infoValue: { fontSize: 15, fontWeight: '600' },

    actionButton: {
        flexDirection: 'row',
        height: 60,
        borderRadius: RADIUS.lg,
        alignItems: 'center',
        justifyContent: 'center',
        gap: SPACING.sm,
        ...SHADOWS.md
    },
    actionButtonText: { fontSize: 16, fontWeight: '700', letterSpacing: -0.5 }
});
