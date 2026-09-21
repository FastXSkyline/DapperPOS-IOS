import { useState, useEffect, useMemo } from 'react'
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    FlatList,
    Alert,
    Modal,
    ScrollView
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { SafeAreaView } from 'react-native-safe-area-context'
import { OrderService, SupplierService } from '../services/database'
import { ProductService } from '../services/productService'
import { SPACING, RADIUS } from '../constants/theme'
import { useTheme } from '../context/ThemeContext'
import { SyncService } from '../services/SyncService'
import {
    Screen,
    GlassCard,
    PageTitle,
    SectionHeader,
    Chip,
    IconButton,
    SearchField,
    PrimaryButton,
    GhostButton,
    Thumb,
    Divider,
    EmptyState,
} from './ui/Kit'

interface Order {
    id: number
    po_number: string
    supplier_id: number
    supplier_name: string
    status: string
    total_amount: number
    created_at: string
}

interface Supplier {
    id: number
    company_name: string
}

interface Product {
    id: number
    name: string
    cost_price: number
}

interface CartItem {
    product: Product
    quantity: number
}

export function OrdersScreen() {
    const { colors, theme } = useTheme()
    const styles = useMemo(() => makeStyles(colors, theme), [colors, theme])

    const [orders, setOrders] = useState<Order[]>([])
    const [suppliers, setSuppliers] = useState<Supplier[]>([])
    const [products, setProducts] = useState<Product[]>([])
    const [showCreateModal, setShowCreateModal] = useState(false)
    const [selectedSupplier, setSelectedSupplier] = useState<number | null>(null)
    const [cart, setCart] = useState<CartItem[]>([])
    const [productSearch, setProductSearch] = useState('')
    const [loading, setLoading] = useState(false)

    const loadOrders = async () => {
        try {
            const orderList = await OrderService.list()
            setOrders(orderList as Order[])
        } catch (error) {
            console.error('Failed to load orders:', error)
        }
    }

    const loadSuppliers = async () => {
        try {
            const supplierList = await SupplierService.getAll()
            setSuppliers(supplierList as Supplier[])
        } catch (error) {
            console.error('Failed to load suppliers:', error)
        }
    }

    const loadProducts = async () => {
        try {
            const productList = await ProductService.getAll()
            setProducts(productList as Product[])
        } catch (error) {
            console.error('Failed to load products:', error)
        }
    }

    useEffect(() => {
        loadOrders()
        loadSuppliers()
        loadProducts()
    }, [])

    const handleReceive = async (orderId: number) => {
        Alert.alert(
            'Confirmer Réception',
            'Marquer cette commande comme reçue ? Le stock sera mis à jour.',
            [
                { text: 'Annuler', style: 'cancel' },
                {
                    text: 'Confirmer',
                    onPress: async () => {
                        try {
                            await OrderService.receive(orderId)
                            await loadOrders()
                            Alert.alert('Succès', 'Commande reçue et stock mis à jour')
                        } catch (error) {
                            console.error('Failed to receive order:', error)
                            Alert.alert('Erreur', 'Impossible de marquer comme reçu')
                        }
                    }
                }
            ]
        )
    }

    const addToCart = (product: Product) => {
        const existing = cart.find(item => item.product.id === product.id)
        if (existing) {
            setCart(cart.map(item =>
                item.product.id === product.id
                    ? { ...item, quantity: item.quantity + 1 }
                    : item
            ))
        } else {
            setCart([...cart, { product, quantity: 1 }])
        }
    }

    const removeFromCart = (productId: number) => {
        setCart(cart.filter(item => item.product.id !== productId))
    }

    const handleSubmitOrder = async () => {
        if (!selectedSupplier) {
            Alert.alert('Erreur', 'Veuillez sélectionner un fournisseur')
            return
        }
        if (cart.length === 0) {
            Alert.alert('Erreur', 'Veuillez ajouter au moins un produit')
            return
        }

        setLoading(true)
        try {
            const items = cart.map(item => ({
                productId: item.product.id,
                quantity: item.quantity,
                unitCost: item.product.cost_price || 0
            }))
            await OrderService.create(selectedSupplier, items)
            setShowCreateModal(false)
            setCart([])
            setSelectedSupplier(null)
            await loadOrders()
            Alert.alert('Succès', 'Bon de commande créé')
        } catch (error) {
            console.error('Failed to create order:', error)
            Alert.alert('Erreur', 'Impossible de créer la commande')
        } finally {
            setLoading(false)
        }
    }

    const formatCurrency = (val: number) => val.toLocaleString('fr-DZ', { minimumFractionDigits: 2 }) + ' DZD'

    const formatDate = (dateStr: string) => {
        const date = new Date(dateStr)
        return date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' })
    }

    const getStatusTone = (status: string): 'ok' | 'bad' | 'accent' => {
        switch (status) {
            case 'received': return 'ok'
            case 'cancelled': return 'bad'
            default: return 'accent'
        }
    }

    const getStatusText = (status: string) => {
        switch (status) {
            case 'received': return 'Reçue'
            case 'cancelled': return 'Annulée'
            default: return 'En attente'
        }
    }

    const filteredProducts = products.filter(p =>
        p.name.toLowerCase().includes(productSearch.toLowerCase())
    ).slice(0, 10)

    const cartTotal = cart.reduce((sum, item) =>
        sum + (item.quantity * (item.product.cost_price || 0)), 0
    )

    const renderOrderItem = ({ item }: { item: Order }) => (
        <GlassCard style={styles.orderCard}>
            <View style={styles.orderHeader}>
                <View style={styles.orderHeaderLeft}>
                    <Thumb
                        seed={item.supplier_id}
                        label={item.supplier_name || item.po_number}
                        size={42}
                        icon="cube-outline"
                    />
                    <View style={styles.orderHeaderText}>
                        <Text style={styles.poNumber}>{item.po_number}</Text>
                        <Text style={styles.supplierName}>{item.supplier_name || 'Fournisseur inconnu'}</Text>
                    </View>
                </View>
                <Chip label={getStatusText(item.status)} tone={getStatusTone(item.status)} />
            </View>
            <Divider style={styles.orderDivider} />
            <View style={styles.orderFooter}>
                <Text style={styles.orderDate}>{formatDate(item.created_at)}</Text>
                <Text style={styles.orderTotal}>{formatCurrency(item.total_amount)}</Text>
            </View>
            <View style={styles.orderActions}>
                <GhostButton
                    label="Imprimer"
                    icon="print-outline"
                    style={styles.orderActionBtn}
                    onPress={async () => {
                        try {
                            const printed = await SyncService.printOrder(item.id)
                            if (printed) {
                                Alert.alert('Succès', 'Bon de commande imprimé')
                            } else {
                                Alert.alert('Erreur', 'Échec de l\'impression')
                            }
                        } catch (e) {
                            Alert.alert('Erreur', 'Connexion impossible')
                        }
                    }}
                />
                {item.status === 'pending' && (
                    <PrimaryButton
                        label="Reçue"
                        icon="checkmark-circle"
                        style={styles.orderActionBtn}
                        onPress={() => handleReceive(item.id)}
                    />
                )}
            </View>
        </GlassCard>
    )

    return (
        <Screen>
            <SafeAreaView style={styles.container} edges={['top']}>
                {/* Header */}
                <View style={styles.header}>
                    <PageTitle
                        title="Commandes"
                        right={
                            <IconButton
                                icon="add"
                                tone="accent"
                                onPress={() => setShowCreateModal(true)}
                            />
                        }
                    />
                </View>

                {/* Orders List */}
                {orders.length === 0 ? (
                    <View style={styles.emptyState}>
                        <EmptyState
                            icon="folder-open-outline"
                            title="Aucune commande fournisseur"
                        />
                        <PrimaryButton
                            label="Créer une commande"
                            icon="add"
                            onPress={() => setShowCreateModal(true)}
                        />
                    </View>
                ) : (
                    <FlatList
                        data={orders}
                        keyExtractor={(item) => item.id.toString()}
                        renderItem={renderOrderItem}
                        contentContainerStyle={styles.listContent}
                        showsVerticalScrollIndicator={false}
                    />
                )}

                {/* Create Order Modal */}
                <Modal visible={showCreateModal} animationType="slide" presentationStyle="pageSheet">
                    <SafeAreaView style={styles.modalContainer}>
                        <View style={styles.modalHeader}>
                            <Text style={styles.modalTitle}>Nouvelle Commande</Text>
                            <IconButton
                                icon="close"
                                onPress={() => setShowCreateModal(false)}
                            />
                        </View>

                        <ScrollView
                            style={styles.modalScroll}
                            contentContainerStyle={styles.modalContent}
                            showsVerticalScrollIndicator={false}
                        >
                            {/* Supplier Selection */}
                            <GlassCard style={styles.modalSection}>
                                <SectionHeader title="Fournisseur" icon="business-outline" />
                                {suppliers.length === 0 ? (
                                    <View style={styles.noSuppliersBox}>
                                        <Ionicons name="alert-circle-outline" size={24} color={colors.accent} />
                                        <Text style={styles.noSuppliersText}>
                                            Aucun fournisseur trouvé. Synchronisez d'abord les données depuis le bureau.
                                        </Text>
                                    </View>
                                ) : (
                                    <View style={styles.supplierList}>
                                        {suppliers.map(supplier => (
                                            <TouchableOpacity
                                                key={supplier.id}
                                                style={[
                                                    styles.supplierChip,
                                                    selectedSupplier === supplier.id && styles.supplierChipActive
                                                ]}
                                                onPress={() => setSelectedSupplier(supplier.id)}
                                            >
                                                <Text style={[
                                                    styles.supplierChipText,
                                                    selectedSupplier === supplier.id && styles.supplierChipTextActive
                                                ]}>
                                                    {supplier.company_name}
                                                </Text>
                                            </TouchableOpacity>
                                        ))}
                                    </View>
                                )}
                            </GlassCard>

                            {/* Product Search */}
                            <GlassCard style={styles.modalSection}>
                                <SectionHeader title="Produits" icon="cube-outline" />
                                <SearchField
                                    value={productSearch}
                                    onChangeText={setProductSearch}
                                    placeholder="Rechercher un produit..."
                                />
                                {filteredProducts.length > 0 && (
                                    <View style={styles.productResults}>
                                        {filteredProducts.map((product, index) => (
                                            <View key={product.id}>
                                                {index > 0 && <Divider />}
                                                <TouchableOpacity
                                                    style={styles.productItem}
                                                    onPress={() => addToCart(product)}
                                                >
                                                    <Text style={styles.productName}>{product.name}</Text>
                                                    <Text style={styles.productCost}>{formatCurrency(product.cost_price || 0)}</Text>
                                                </TouchableOpacity>
                                            </View>
                                        ))}
                                    </View>
                                )}
                            </GlassCard>

                            {/* Cart */}
                            {cart.length > 0 && (
                                <GlassCard style={styles.modalSection} glow>
                                    <SectionHeader title={`Panier (${cart.length})`} icon="cart-outline" />
                                    {cart.map((item, index) => (
                                        <View key={item.product.id}>
                                            {index > 0 && <Divider />}
                                            <View style={styles.cartItem}>
                                                <View style={styles.cartItemInfo}>
                                                    <Text style={styles.cartItemName}>{item.product.name}</Text>
                                                    <Text style={styles.cartItemQty}>x{item.quantity}</Text>
                                                </View>
                                                <View style={styles.cartItemRight}>
                                                    <Text style={styles.cartItemTotal}>
                                                        {formatCurrency(item.quantity * (item.product.cost_price || 0))}
                                                    </Text>
                                                    <IconButton
                                                        icon="trash-outline"
                                                        size={34}
                                                        onPress={() => removeFromCart(item.product.id)}
                                                    />
                                                </View>
                                            </View>
                                        </View>
                                    ))}
                                    <Divider style={styles.cartTotalDivider} />
                                    <View style={styles.cartTotal}>
                                        <Text style={styles.cartTotalLabel}>Total:</Text>
                                        <Text style={styles.cartTotalValue}>{formatCurrency(cartTotal)}</Text>
                                    </View>
                                </GlassCard>
                            )}
                        </ScrollView>

                        {/* Submit Button */}
                        <View style={styles.modalFooter}>
                            <PrimaryButton
                                label={loading ? 'Création...' : 'Créer la Commande'}
                                icon="checkmark-circle-outline"
                                onPress={handleSubmitOrder}
                                disabled={loading}
                            />
                        </View>
                    </SafeAreaView>
                </Modal>
            </SafeAreaView>
        </Screen>
    )
}

const makeStyles = (colors: ReturnType<typeof useTheme>['colors'], theme: 'light' | 'dark') => StyleSheet.create({
    container: {
        flex: 1
    },
    header: {
        paddingHorizontal: SPACING.lg,
        paddingTop: SPACING.md,
        paddingBottom: SPACING.sm
    },
    listContent: {
        padding: SPACING.lg,
        paddingBottom: 140
    },
    emptyState: {
        flex: 1,
        justifyContent: 'center',
        paddingHorizontal: SPACING.xl,
        paddingBottom: 140
    },
    orderCard: {
        marginBottom: SPACING.md
    },
    orderHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: SPACING.sm
    },
    orderHeaderLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.sm,
        flex: 1
    },
    orderHeaderText: {
        flex: 1
    },
    poNumber: {
        fontSize: 16,
        fontWeight: '800',
        letterSpacing: -0.4,
        color: colors.text
    },
    supplierName: {
        fontSize: 13,
        fontWeight: '500',
        color: colors.textMuted,
        marginTop: 2
    },
    orderDivider: {
        marginVertical: SPACING.sm
    },
    orderFooter: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center'
    },
    orderDate: {
        fontSize: 12,
        fontWeight: '500',
        color: colors.textMuted
    },
    orderTotal: {
        fontSize: 18,
        fontWeight: '800',
        letterSpacing: -0.4,
        color: colors.success,
        fontVariant: ['tabular-nums']
    },
    orderActions: {
        flexDirection: 'row',
        gap: SPACING.sm,
        marginTop: SPACING.md
    },
    orderActionBtn: {
        flex: 1
    },
    modalContainer: {
        flex: 1,
        backgroundColor: colors.background
    },
    modalHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: SPACING.lg,
        paddingVertical: SPACING.md,
        borderBottomWidth: 1,
        borderBottomColor: colors.border
    },
    modalTitle: {
        fontSize: 24,
        fontWeight: '800',
        letterSpacing: -0.5,
        color: colors.text
    },
    modalScroll: {
        flex: 1
    },
    modalContent: {
        padding: SPACING.lg,
        paddingBottom: 140
    },
    modalSection: {
        marginBottom: SPACING.md
    },
    supplierList: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: SPACING.xs
    },
    supplierChip: {
        paddingHorizontal: SPACING.md,
        paddingVertical: SPACING.sm,
        borderRadius: RADIUS.full,
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: colors.border
    },
    supplierChipActive: {
        backgroundColor: colors.accent,
        borderColor: colors.accent
    },
    supplierChipText: {
        fontSize: 14,
        fontWeight: '500',
        color: colors.text
    },
    supplierChipTextActive: {
        color: colors.white,
        fontWeight: '700'
    },
    productResults: {
        marginTop: SPACING.sm
    },
    productItem: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: SPACING.sm,
        paddingVertical: SPACING.sm + 2,
        paddingHorizontal: SPACING.xs
    },
    productName: {
        fontSize: 14,
        fontWeight: '600',
        color: colors.text,
        flex: 1
    },
    productCost: {
        fontSize: 14,
        color: colors.success,
        fontWeight: '800',
        fontVariant: ['tabular-nums']
    },
    cartItem: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: SPACING.sm,
        paddingVertical: SPACING.sm + 2
    },
    cartItemInfo: {
        flex: 1
    },
    cartItemName: {
        fontSize: 14,
        fontWeight: '600',
        color: colors.text
    },
    cartItemQty: {
        fontSize: 12,
        fontWeight: '500',
        color: colors.textMuted,
        marginTop: 2
    },
    cartItemRight: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.sm
    },
    cartItemTotal: {
        fontSize: 14,
        fontWeight: '800',
        color: colors.success,
        fontVariant: ['tabular-nums']
    },
    cartTotalDivider: {
        marginTop: SPACING.sm
    },
    cartTotal: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingTop: SPACING.md
    },
    cartTotalLabel: {
        fontSize: 15,
        fontWeight: '700',
        color: colors.text
    },
    cartTotalValue: {
        fontSize: 20,
        fontWeight: '800',
        letterSpacing: -0.5,
        color: colors.success,
        fontVariant: ['tabular-nums']
    },
    modalFooter: {
        padding: SPACING.lg,
        borderTopWidth: 1,
        borderTopColor: colors.border
    },
    noSuppliersBox: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme === 'dark' ? 'rgba(234, 179, 8, 0.12)' : 'rgba(234, 179, 8, 0.10)',
        borderRadius: RADIUS.md,
        padding: SPACING.md,
        gap: SPACING.sm,
        borderWidth: 1,
        borderColor: colors.accent
    },
    noSuppliersText: {
        flex: 1,
        fontSize: 13,
        color: colors.textMuted,
        lineHeight: 18
    }
})
