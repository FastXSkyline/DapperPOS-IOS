import { useState, useEffect, useMemo } from 'react'
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    FlatList,
    Alert
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
import { LinearGradient } from 'expo-linear-gradient'
import { OrderService, SupplierService } from '../services/database'
import { SPACING, RADIUS, SHADOWS } from '../constants/theme'
import { useTheme } from '../context/ThemeContext'
import { Screen, GlassCard, PageTitle, StatTile, Chip, Divider, EmptyState } from './ui/Kit'

interface Supplier {
    id: number
    company_name: string
}

interface Order {
    id: number
    po_number: string
    supplier_id: number
    supplier_name: string
    status: string
    total_amount: number
    created_at: string
}

export function SettlementScreen() {
    const { colors, theme } = useTheme()
    const styles = useMemo(() => makeStyles(colors, theme), [colors, theme])

    const [orders, setOrders] = useState<Order[]>([])
    const [suppliers, setSuppliers] = useState<Supplier[]>([])
    const [selectedSupplierId, setSelectedSupplierId] = useState<number | null>(null)
    const [isLoading, setIsLoading] = useState(true)

    useEffect(() => {
        loadData()
    }, [])

    const loadData = async () => {
        try {
            const [ordersData, suppliersData] = await Promise.all([
                OrderService.list(),
                SupplierService.getAll()
            ])
            setOrders(ordersData as Order[])
            setSuppliers(suppliersData as Supplier[])
        } catch (error) {
            console.error(error)
            Alert.alert('Error', 'Failed to load data')
        } finally {
            setIsLoading(false)
        }
    }

    const filteredOrders = selectedSupplierId
        ? orders.filter(o => o.supplier_id === selectedSupplierId)
        : orders

    const totalAmount = filteredOrders.reduce((sum, o) => sum + o.total_amount, 0)

    const formatCurrency = (val: number) => val.toLocaleString('fr-DZ', { minimumFractionDigits: 2 }) + ' DZD'
    const formatDate = (dateStr: string) => new Date(dateStr).toLocaleDateString('fr-FR')

    const renderOrder = ({ item }: { item: Order }) => (
        <GlassCard style={styles.card}>
            <View style={styles.cardHeader}>
                <View style={styles.cardHeaderLeft}>
                    <View style={[styles.poPlate, { backgroundColor: colors.accentSoft }]}>
                        <Ionicons name="document-text-outline" size={15} color={colors.accent} />
                    </View>
                    <Text style={[styles.poNumber, { color: colors.text }]} numberOfLines={1}>{item.po_number}</Text>
                </View>
                <Text style={[styles.date, { color: colors.textTertiary }]}>{formatDate(item.created_at)}</Text>
            </View>

            <Divider style={styles.divider} />

            <View style={styles.row}>
                <View style={styles.supplierWrap}>
                    <Text style={[styles.supplier, { color: colors.text }]} numberOfLines={1}>{item.supplier_name}</Text>
                </View>
                <Text style={[styles.amount, { color: colors.success }]}>{formatCurrency(item.total_amount)}</Text>
            </View>

            <View style={styles.badgeRow}>
                <Chip
                    label={item.status === 'received' ? 'Reçue' : 'En attente'}
                    tone={item.status === 'received' ? 'ok' : 'accent'}
                    icon={item.status === 'received' ? 'checkmark-circle-outline' : 'time-outline'}
                />
            </View>
        </GlassCard>
    )

    return (
        <Screen>
            <SafeAreaView edges={['top']} style={styles.safe}>
                <View style={styles.head}>
                    <PageTitle title="Règlements" />
                </View>

                {/* Supplier Filter */}
                <View style={styles.filterContainer}>
                    <FlatList
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        data={[{ id: 0, company_name: 'Tous' }, ...suppliers]}
                        keyExtractor={item => item.id.toString()}
                        renderItem={({ item }) => {
                            const isSelected = item.id === (selectedSupplierId || 0)
                            return (
                                <TouchableOpacity
                                    activeOpacity={0.8}
                                    style={[
                                        styles.filterChip,
                                        { borderColor: isSelected ? 'transparent' : colors.border, backgroundColor: isSelected ? 'transparent' : colors.surface },
                                        isSelected && SHADOWS.accent
                                    ]}
                                    onPress={() => setSelectedSupplierId(item.id === 0 ? null : item.id)}
                                >
                                    {isSelected && (
                                        <LinearGradient
                                            colors={[colors.accentGradFrom, colors.accentGradTo]}
                                            start={{ x: 0, y: 0 }}
                                            end={{ x: 1, y: 1 }}
                                            style={StyleSheet.absoluteFill as any}
                                        />
                                    )}
                                    <Text style={[styles.filterText, { color: isSelected ? colors.white : colors.textMuted }]}>
                                        {item.company_name}
                                    </Text>
                                </TouchableOpacity>
                            )
                        }}
                        contentContainerStyle={styles.filterContent}
                    />
                </View>

                {/* Stats */}
                <View style={styles.statsWrap}>
                    <StatTile
                        label="Total Règlements"
                        value={formatCurrency(totalAmount)}
                        icon="cash-outline"
                        accent={colors.success}
                    />
                </View>

                <FlatList
                    data={filteredOrders}
                    renderItem={renderOrder}
                    keyExtractor={item => item.id.toString()}
                    showsVerticalScrollIndicator={false}
                    contentContainerStyle={styles.listContent}
                    ListEmptyComponent={
                        <EmptyState icon="documents-outline" title="Aucun règlement trouvé" />
                    }
                />
            </SafeAreaView>
        </Screen>
    )
}

const makeStyles = (colors: ReturnType<typeof useTheme>['colors'], _theme: 'light' | 'dark') => StyleSheet.create({
    safe: {
        flex: 1
    },
    head: {
        paddingHorizontal: SPACING.md,
        paddingTop: SPACING.md,
        paddingBottom: SPACING.sm
    },
    filterContainer: {
        marginBottom: SPACING.md
    },
    filterContent: {
        paddingHorizontal: SPACING.md,
        gap: SPACING.sm
    },
    filterChip: {
        paddingVertical: 9,
        paddingHorizontal: 16,
        borderRadius: RADIUS.full,
        borderWidth: 1,
        overflow: 'hidden'
    },
    filterText: {
        fontWeight: '700',
        fontSize: 13
    },
    statsWrap: {
        paddingHorizontal: SPACING.md,
        marginBottom: SPACING.md
    },
    listContent: {
        paddingHorizontal: SPACING.md,
        paddingBottom: 140
    },
    card: {
        marginBottom: SPACING.sm
    },
    cardHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: SPACING.sm
    },
    cardHeaderLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.sm,
        flex: 1
    },
    poPlate: {
        width: 30,
        height: 30,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center'
    },
    poNumber: {
        fontWeight: '800',
        fontSize: 15,
        letterSpacing: -0.3,
        flexShrink: 1
    },
    date: {
        fontSize: 12.5,
        fontWeight: '600',
        fontVariant: ['tabular-nums']
    },
    divider: {
        marginVertical: SPACING.sm + 2
    },
    row: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: SPACING.sm
    },
    supplierWrap: {
        flex: 1
    },
    supplier: {
        fontSize: 14.5,
        fontWeight: '600'
    },
    amount: {
        fontWeight: '800',
        fontSize: 17,
        letterSpacing: -0.4,
        fontVariant: ['tabular-nums']
    },
    badgeRow: {
        flexDirection: 'row',
        marginTop: SPACING.sm + 2
    }
})
