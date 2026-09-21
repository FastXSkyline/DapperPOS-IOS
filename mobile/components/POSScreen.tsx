import React, { useState, useEffect } from 'react';
import {
    View,
    Text,
    StyleSheet,
    FlatList,
    TouchableOpacity,
    Alert,
    Modal,
    TextInput,
    ScrollView,
    Dimensions,
    Platform,
    ActivityIndicator
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { ProductService, Product } from '../services/productService';
import { TransactionService, UserService, CustomerService, TaxService, VariantService, ProductVariant } from '../services/database';
import { SyncService } from '../services/SyncService';
import { ProductScanner } from './ProductScanner';
import { SPACING, RADIUS, SHADOWS, COLORS } from '../constants/theme';
import { useTheme } from '../context/ThemeContext';
import { Thumb, Chip } from './ui/Kit';

const { width } = Dimensions.get('window');
const CARD_WIDTH = (width - SPACING.md * 3) / 2;

export function POSScreen() {
    const { colors, theme } = useTheme();
    const [products, setProducts] = useState<Product[]>([]);
    const [cart, setCart] = useState<{ product: Product; quantity: number; variant?: ProductVariant | null }[]>([]);
    // Pending size/colour choice for a garment on its way into the cart.
    const [variantPick, setVariantPick] = useState<{ product: Product; variants: ProductVariant[] } | null>(null);
    const [search, setSearch] = useState('');
    const [scanning, setScanning] = useState(false);
    const [checkoutModal, setCheckoutModal] = useState(false);
    const [heldModal, setHeldModal] = useState(false);
    const [customerModal, setCustomerModal] = useState(false);
    const [customers, setCustomers] = useState<any[]>([]);
    const [customerSearch, setCustomerSearch] = useState('');
    const [selectedCustomer, setSelectedCustomer] = useState<any | null>(null);
    const [heldTransactions, setHeldTransactions] = useState<any[]>([]);
    const [processing, setProcessing] = useState(false);
    const [taxRates, setTaxRates] = useState<Record<number, number>>({});
    const [ifu, setIfu] = useState(false);
    const [ttc, setTtc] = useState(false);

    useEffect(() => {
        loadProducts();
    }, [search]);

    useEffect(() => {
        TaxService.getRates().then(setTaxRates).catch(() => { });
        TaxService.getRegime().then(r => setIfu(r === 'ifu')).catch(() => { });
        TaxService.pricesIncludeTax().then(setTtc).catch(() => { });
    }, []);

    useEffect(() => {
        if (customerModal) {
            loadCustomers();
        }
    }, [customerModal, customerSearch]);

    const loadProducts = async () => {
        try {
            const data = await ProductService.getAll({ search: search.length > 1 ? search : undefined });
            setProducts(data);
        } catch (e) {
            console.error(e);
        }
    };

    const loadCustomers = async () => {
        try {
            if (customerSearch.length > 1) {
                const data = await CustomerService.search(customerSearch);
                setCustomers(data as any[]);
            } else {
                const data = await CustomerService.getAll();
                setCustomers(data as any[]);
            }
        } catch (e) {
            console.error(e);
        }
    };

    const loadHeldTransactions = async () => {
        try {
            const held = await TransactionService.getHeldTransactions();
            setHeldTransactions(held as any[]);
        } catch (e) {
            console.error(e);
            Alert.alert('Error', 'Failed to load held transactions');
        }
    };

    /** Cart lines are keyed by product AND variant — two sizes of one shirt are
     *  separate lines and decrement separate stock. */
    const lineKey = (productId: number, variantId: number | null | undefined) => `${productId}:${variantId ?? ''}`;

    const addLine = (product: Product, variant: ProductVariant | null) => {
        const key = lineKey(product.id, variant?.id);
        setCart(prev => {
            const existing = prev.find(item => lineKey(item.product.id, item.variant?.id) === key);
            if (existing) {
                return prev.map(item => lineKey(item.product.id, item.variant?.id) === key
                    ? { ...item, quantity: item.quantity + 1 } : item);
            }
            return [...prev, { product, quantity: 1, variant }];
        });
    };

    /** A garment cannot be sold without saying which size/colour left the shelf,
     *  so adding one opens the picker instead of guessing. */
    const addToCart = async (product: Product) => {
        const variants = await VariantService.forProduct(product.id);
        if (variants.length > 0) {
            setVariantPick({ product, variants });
            return;
        }
        addLine(product, null);
    };

    const removeFromCart = (key: string) => {
        setCart(prev => prev.filter(item => lineKey(item.product.id, item.variant?.id) !== key));
    };

    const updateQuantity = (key: string, delta: number) => {
        setCart(prev => prev.map(item => {
            if (lineKey(item.product.id, item.variant?.id) === key) {
                const newQty = Math.max(1, item.quantity + delta);
                return { ...item, quantity: newQty };
            }
            return item;
        }));
    };

    let subtotalHT = 0;
    let taxAmount = 0;
    for (const i of cart) {
        const rate = ifu ? 0 : (taxRates[(i.product as any).tax_category_id] ?? 0);
        const gross = i.product.retail_price * i.quantity;
        if (!rate) { subtotalHT += gross; }
        else if (ttc) { const ht = gross / (1 + rate / 100); subtotalHT += ht; taxAmount += gross - ht; }
        else { subtotalHT += gross; taxAmount += gross * rate / 100; }
    }
    const total = subtotalHT + taxAmount;
    const cartCount = cart.reduce((s, i) => s + i.quantity, 0);


    const handleCheckout = () => {
        if (cart.length === 0) return;

        Alert.alert('Checkout Confirm', `Confirm total: DZD ${total.toLocaleString()}`, [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Complete Sale',
                onPress: processSale
            }
        ]);
    };

    const handleHold = async () => {
        if (cart.length === 0) return;

        Alert.alert('Hold Transaction', 'Suspend this transaction to resume later?', [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Hold',
                onPress: async () => {
                    setProcessing(true);
                    try {
                        const users = await UserService.getAll() as any[];
                        const currentUser = users[0] || { id: 1 };

                        await TransactionService.holdTransaction(currentUser.id, cart, subtotalHT, selectedCustomer?.id, selectedCustomer ? `Hold for ${selectedCustomer.name}` : undefined);
                        setCart([]);
                        setSelectedCustomer(null);
                        setCheckoutModal(false);
                        Alert.alert('Success', 'Transaction held.');
                    } catch (e: any) {
                        Alert.alert('Error', e.message);
                    } finally {
                        setProcessing(false);
                    }
                }
            }
        ]);
    };

    const handleResume = async (heldId: number) => {
        try {
            const held = await TransactionService.retrieveHeldTransaction(heldId);
            if (held && held.items_json) {
                const items = JSON.parse(held.items_json);
                setCart(items);
                setHeldModal(false);
                Alert.alert('Resumed', 'Transaction resumed successfully.');
            }
        } catch (e: any) {
            Alert.alert('Error', 'Failed to resume: ' + e.message);
        }
    };

    const processSale = async () => {
        setProcessing(true);
        try {
            const users = await UserService.getAll() as any[];
            const currentUser = users[0] || { id: 1 };

            const result = await TransactionService.create({
                items: cart,
                subtotal: subtotalHT,
                total: total,
                discount: 0,
                paid: total,
                change: 0,
                userId: currentUser.id,
                customerId: selectedCustomer?.id
            });

            await SyncService.syncTransactions();
            const printSuccess = await SyncService.printReceipt(result.transaction_number);

            setCart([]);
            setSelectedCustomer(null);
            setCheckoutModal(false);

            if (printSuccess) {
                Alert.alert('Success', 'Order saved and printed!');
            } else {
                Alert.alert('Saved', 'Order saved. Printer connection failed.');
            }

        } catch (e: any) {
            console.error(e);
            Alert.alert('Error', 'Transaction failed: ' + e.message);
        } finally {
            setProcessing(false);
        }
    };

    const renderProduct = ({ item }: { item: Product }) => {
        const qty = item.stock_quantity || 0;
        const isLowStock = qty <= (item.min_stock_level || 5);
        const isOut = qty <= 0;

        return (
            <TouchableOpacity
                style={[styles.productCard, { backgroundColor: colors.surface, borderColor: colors.border }]}
                onPress={() => addToCart(item)}
                activeOpacity={0.85}
            >
                <View style={styles.productThumbRow}>
                    <Thumb seed={item.id} label={item.name} size={54} icon="shirt-outline" />
                    <View style={styles.stockPillWrap}>
                        <Chip
                            label={isOut ? 'Rupture' : `${qty}`}
                            tone={isOut ? 'bad' : isLowStock ? 'warn' : 'ok'}
                            icon={isOut ? undefined : 'cube-outline'}
                        />
                    </View>
                </View>

                <Text style={[styles.productName, { color: colors.text }]} numberOfLines={2}>{item.name}</Text>

                <View style={styles.productFoot}>
                    <Text style={[styles.productPrice, { color: colors.text }]}>
                        <Text style={{ fontSize: 11, color: colors.textMuted, fontWeight: '700' }}>DZD </Text>
                        {item.retail_price.toLocaleString()}
                    </Text>
                    <View style={[styles.addBtn, { backgroundColor: colors.accent }, SHADOWS.accent]}>
                        <Ionicons name="add" size={20} color={colors.white} />
                    </View>
                </View>
            </TouchableOpacity>
        );
    };

    return (
        <View style={[styles.container, { backgroundColor: colors.background }]}>
            {/* Header */}
            <SafeAreaView edges={['top']} style={[styles.safeArea, { backgroundColor: colors.background }]}>
                <View style={styles.header}>
                    <TouchableOpacity
                        style={[styles.iconBtn, { backgroundColor: colors.surface, borderColor: colors.border }]}
                        onPress={() => {
                            loadHeldTransactions();
                            setHeldModal(true);
                        }}
                    >
                        <Ionicons name="pause-circle-outline" size={24} color={colors.accent} />
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={[styles.iconBtn, { backgroundColor: selectedCustomer ? colors.accent + '20' : colors.surface, borderColor: selectedCustomer ? colors.accent : colors.border }]}
                        onPress={() => setCustomerModal(true)}
                    >
                        <Ionicons name="person-outline" size={24} color={selectedCustomer ? colors.accent : colors.textMuted} />
                    </TouchableOpacity>

                    <View style={[styles.searchContainer, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                        <Ionicons name="search" size={18} color={colors.textMuted} />
                        <TextInput
                            style={[styles.searchInput, { color: colors.text }]}
                            placeholder="Find products..."
                            placeholderTextColor={colors.textMuted}
                            value={search}
                            onChangeText={setSearch}
                        />
                        {search.length > 0 && (
                            <TouchableOpacity onPress={() => setSearch('')}>
                                <Ionicons name="close-circle" size={18} color={colors.textMuted} />
                            </TouchableOpacity>
                        )}
                    </View>
                    <TouchableOpacity style={[styles.scanBtn, { backgroundColor: colors.accent, ...SHADOWS.accent }]} onPress={() => setScanning(true)}>
                        <Ionicons name="scan" size={22} color={colors.white} />
                    </TouchableOpacity>
                </View>

                {selectedCustomer && (
                    <View style={[styles.customerBar, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
                        <Text style={[styles.customerLabel, { color: colors.textMuted }]}>Client:</Text>
                        <Text style={[styles.customerName, { color: colors.text }]}>{selectedCustomer.name}</Text>
                        <TouchableOpacity onPress={() => setSelectedCustomer(null)} style={{ marginLeft: 'auto' }}>
                            <Ionicons name="close" size={16} color={colors.textMuted} />
                        </TouchableOpacity>
                    </View>
                )}
            </SafeAreaView>

            {/* Product Grid */}
            <FlatList
                data={products}
                renderItem={renderProduct}
                keyExtractor={item => item.id.toString()}
                numColumns={2}
                contentContainerStyle={styles.listContent}
                showsVerticalScrollIndicator={false}
                ListHeaderComponent={
                    <View style={styles.listHeader}>
                        <Text style={[styles.sectionTitle, { color: colors.text }]}>Catalogue</Text>
                        <Text style={[styles.sectionSubtitle, { color: colors.textMuted }]}>{products.length} products found</Text>
                    </View>
                }
            />

            {/* Floating Cart Button */}
            {cartCount > 0 && (
                <TouchableOpacity
                    style={styles.floatingCart}
                    onPress={() => setCheckoutModal(true)}
                    activeOpacity={0.9}
                >
                    <LinearGradient
                        colors={[colors.accentGradFrom, colors.accentGradTo]}
                        start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                        style={styles.cartGradient}
                    >
                        <View style={styles.cartInfo}>
                            <View style={[styles.badge, { backgroundColor: 'rgba(255,255,255,0.22)' }]}>
                                <Text style={[styles.badgeText, { color: colors.white }]}>{cartCount}</Text>
                            </View>
                            <Text style={[styles.cartLabel, { color: 'rgba(255,255,255,0.9)' }]}>Panier</Text>
                        </View>
                        <View style={styles.cartPriceContainer}>
                            <Text style={[styles.cartTotal, { color: colors.white }]}>DZD {total.toLocaleString()}</Text>
                            <Ionicons name="chevron-forward" size={18} color={colors.white} />
                        </View>
                    </LinearGradient>
                </TouchableOpacity>
            )}

            {/* Checkout Modal */}
            <Modal visible={checkoutModal} animationType="slide" presentationStyle="pageSheet">
                <View style={[styles.modalContent, { backgroundColor: colors.background }]}>
                    <View style={[styles.modalHeader, { borderBottomColor: colors.border }]}>
                        <View>
                            <Text style={[styles.modalTitle, { color: colors.text }]}>Vente Actuelle</Text>
                            <Text style={[styles.modalSubtitle, { color: colors.textMuted }]}>{cartCount} articles</Text>
                        </View>
                        <TouchableOpacity style={styles.closeBtn} onPress={() => setCheckoutModal(false)}>
                            <Ionicons name="close" size={24} color={colors.text} />
                        </TouchableOpacity>
                    </View>

                    {selectedCustomer && (
                        <View style={{ padding: SPACING.md, backgroundColor: colors.surfaceElevated, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                            <Ionicons name="person" size={16} color={colors.accent} />
                            <Text style={{ color: colors.text, fontWeight: '600' }}>{selectedCustomer.name}</Text>
                        </View>
                    )}

                    <ScrollView style={styles.cartItems} showsVerticalScrollIndicator={false}>
                        {cart.map(item => {
                            const key = lineKey(item.product.id, item.variant?.id);
                            const variantLabel = item.variant
                                ? [item.variant.size, item.variant.color].filter(Boolean).join(' / ')
                                : '';
                            return (
                                <View key={key} style={[styles.cartItem, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                                    <View style={styles.itemInfo}>
                                        <Text style={[styles.itemName, { color: colors.text }]}>
                                            {item.product.name}{variantLabel ? ` (${variantLabel})` : ''}
                                        </Text>
                                        <Text style={[styles.itemPrice, { color: colors.success }]}>DZD {item.product.retail_price.toLocaleString()}</Text>
                                    </View>
                                    <View style={[styles.qtyContainer, { backgroundColor: colors.surfaceElevated }]}>
                                        <TouchableOpacity style={styles.qtyBtn} onPress={() => updateQuantity(key, -1)}>
                                            <Ionicons name="remove" size={18} color={colors.text} />
                                        </TouchableOpacity>
                                        <Text style={[styles.qtyValue, { color: colors.text }]}>{item.quantity}</Text>
                                        <TouchableOpacity style={styles.qtyBtn} onPress={() => updateQuantity(key, 1)}>
                                            <Ionicons name="add" size={18} color={colors.text} />
                                        </TouchableOpacity>
                                    </View>
                                    <TouchableOpacity style={styles.removeBtn} onPress={() => removeFromCart(key)}>
                                        <Ionicons name="trash-outline" size={20} color={colors.error} />
                                    </TouchableOpacity>
                                </View>
                            );
                        })}
                    </ScrollView>

                    <View style={[styles.checkoutFooter, { backgroundColor: colors.surface, borderTopColor: colors.border }]}>
                        {taxAmount > 0 && (
                            <>
                                <View style={styles.summaryRow}>
                                    <Text style={[styles.summaryLabel, { color: colors.textMuted }]}>Total HT</Text>
                                    <Text style={[styles.summaryLabel, { color: colors.textMuted }]}>DZD {subtotalHT.toLocaleString()}</Text>
                                </View>
                                <View style={styles.summaryRow}>
                                    <Text style={[styles.summaryLabel, { color: colors.textMuted }]}>TVA</Text>
                                    <Text style={[styles.summaryLabel, { color: colors.textMuted }]}>DZD {taxAmount.toLocaleString()}</Text>
                                </View>
                            </>
                        )}
                        <View style={styles.summaryRow}>
                            <Text style={[styles.summaryLabel, { color: colors.textMuted }]}>{taxAmount > 0 ? 'Total TTC' : 'Total à payer'}</Text>
                            <Text style={[styles.summaryValue, { color: colors.success }]}>DZD {total.toLocaleString()}</Text>
                        </View>

                        {/* Phase 4.11 — mobile is a cash-only companion caisse. Credit/partial
                            settlement, discounts and the kredi ledger live on the desktop
                            (its sync ingest is the authoritative source for balances). */}
                        <Text style={{ color: colors.textMuted, fontSize: 12, textAlign: 'center', marginBottom: 8 }}>
                            Caisse compagnon — paiement comptant. Le crédit, les remises et le règlement partiel se gèrent sur le PC.
                        </Text>

                        <View style={{ flexDirection: 'row', gap: 10 }}>
                            <TouchableOpacity
                                style={[styles.payButton, { flex: 1, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.accent }]}
                                onPress={handleHold}
                                disabled={processing}
                            >
                                <Text style={[styles.payButtonText, { color: colors.accent }]}>Attente</Text>
                            </TouchableOpacity>

                            <TouchableOpacity
                                style={[styles.payButton, { flex: 2, backgroundColor: colors.accent, opacity: processing ? 0.7 : 1, ...SHADOWS.accent }]}
                                onPress={handleCheckout}
                                disabled={processing}
                            >
                                {processing ? (
                                    <ActivityIndicator color={colors.white} />
                                ) : (
                                    <Text style={[styles.payButtonText, { color: colors.white }]}>Finaliser</Text>
                                )}
                            </TouchableOpacity>
                        </View>
                    </View>
                </View>
            </Modal>

            {/* Held Transactions Modal */}
            <Modal visible={heldModal} animationType="slide" presentationStyle="pageSheet">
                <View style={[styles.modalContent, { backgroundColor: colors.background }]}>
                    <View style={[styles.modalHeader, { borderBottomColor: colors.border }]}>
                        <Text style={[styles.modalTitle, { color: colors.text }]}>Ventes en Attente</Text>
                        <TouchableOpacity style={styles.closeBtn} onPress={() => setHeldModal(false)}>
                            <Ionicons name="close" size={24} color={colors.text} />
                        </TouchableOpacity>
                    </View>

                    <FlatList
                        data={heldTransactions}
                        keyExtractor={item => item.id.toString()}
                        contentContainerStyle={{ padding: SPACING.lg }}
                        renderItem={({ item }) => (
                            <TouchableOpacity
                                style={[styles.heldItem, { backgroundColor: colors.surface, borderColor: colors.border }]}
                                onPress={() => handleResume(item.id)}
                            >
                                <View>
                                    <Text style={[styles.heldTime, { color: colors.textMuted }]}>{new Date(item.created_at).toLocaleString()}</Text>
                                    <Text style={[styles.heldName, { color: colors.text }]}>{item.hold_name || `Transaction #${item.id}`}</Text>
                                </View>
                                <Text style={[styles.heldAmount, { color: colors.success }]}>DZD {item.subtotal.toLocaleString()}</Text>
                            </TouchableOpacity>
                        )}
                        ListEmptyComponent={
                            <View style={styles.emptyState}>
                                <Ionicons name="file-tray-outline" size={48} color={colors.textMuted} />
                                <Text style={[styles.emptyText, { color: colors.textMuted }]}>Aucune vente en attente</Text>
                            </View>
                        }
                    />
                </View>
            </Modal>

            {/* Customer Selection Modal */}
            <Modal visible={customerModal} animationType="slide" presentationStyle="pageSheet">
                <View style={[styles.modalContent, { backgroundColor: colors.background }]}>
                    <View style={[styles.modalHeader, { borderBottomColor: colors.border }]}>
                        <View style={{ flex: 1 }}>
                            <Text style={[styles.modalTitle, { color: colors.text }]}>Sélectionner Client</Text>
                            <TextInput
                                style={[styles.searchInput, { color: colors.text, marginTop: 10, borderWidth: 1, borderColor: colors.border, padding: 10, borderRadius: 8 }]}
                                placeholder="Rechercher..."
                                placeholderTextColor={colors.textMuted}
                                value={customerSearch}
                                onChangeText={setCustomerSearch}
                            />
                        </View>
                        <TouchableOpacity style={[styles.closeBtn, { marginLeft: 10 }]} onPress={() => setCustomerModal(false)}>
                            <Ionicons name="close" size={24} color={colors.text} />
                        </TouchableOpacity>
                    </View>

                    <FlatList
                        data={customers}
                        keyExtractor={item => (item.id || Math.random()).toString()}
                        contentContainerStyle={{ padding: SPACING.lg }}
                        renderItem={({ item }) => (
                            <TouchableOpacity
                                style={[styles.heldItem, { backgroundColor: colors.surface, borderColor: colors.border }]}
                                onPress={() => {
                                    setSelectedCustomer(item);
                                    setCustomerModal(false);
                                }}
                            >
                                <View>
                                    <Text style={[styles.heldName, { color: colors.text }]}>{item.name}</Text>
                                    <Text style={[styles.heldTime, { color: colors.textMuted }]}>{item.phone || item.email || 'Pas d\'info contact'}</Text>
                                </View>
                                <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
                            </TouchableOpacity>
                        )}
                        ListEmptyComponent={
                            <View style={styles.emptyState}>
                                <Ionicons name="people-outline" size={48} color={colors.textMuted} />
                                <Text style={[styles.emptyText, { color: colors.textMuted }]}>Aucun client trouvé</Text>
                            </View>
                        }
                    />
                </View>
            </Modal>

            {/* Scanner Overlay */}
            {scanning && (
                <View style={StyleSheet.absoluteFill}>
                    <ProductScanner
                        onProductFound={(p) => {
                            setScanning(false);
                            // Routed through addToCart so a scanned garment opens the
                            // size/colour picker rather than being added unspecified.
                            addToCart(p);
                        }}
                        onClose={() => setScanning(false)}
                    />
                </View>
            )}

            {/* Size / colour picker — shown between scanning a garment and the cart. */}
            <Modal visible={!!variantPick} transparent animationType="fade" onRequestClose={() => setVariantPick(null)}>
                <TouchableOpacity
                    style={styles.variantOverlay}
                    activeOpacity={1}
                    onPress={() => setVariantPick(null)}
                >
                    <View style={[styles.variantSheet, { backgroundColor: colors.surface }]}>
                        <Text style={[styles.variantTitle, { color: colors.text }]}>{variantPick?.product.name}</Text>
                        <Text style={[styles.variantHint, { color: colors.textMuted }]}>Choisissez la taille / couleur</Text>
                        <ScrollView style={{ maxHeight: 340 }}>
                            <View style={styles.variantGrid}>
                                {variantPick?.variants.map(v => {
                                    const out = v.stock_quantity <= 0;
                                    const label = [v.size, v.color].filter(Boolean).join(' / ') || '—';
                                    return (
                                        <TouchableOpacity
                                            key={v.id}
                                            disabled={out}
                                            style={[
                                                styles.variantChip,
                                                { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
                                                out && { opacity: 0.4 },
                                            ]}
                                            onPress={() => {
                                                addLine(variantPick.product, v);
                                                setVariantPick(null);
                                            }}
                                        >
                                            <Text style={[styles.variantChipLabel, { color: colors.text }]}>{label}</Text>
                                            {/* Out-of-stock sizes stay visible but unselectable, so staff can
                                                see the size exists and is finished rather than never stocked. */}
                                            <Text style={[styles.variantChipStock, { color: out ? colors.error : colors.textMuted }]}>
                                                {out ? 'Rupture' : `${v.stock_quantity} en stock`}
                                            </Text>
                                        </TouchableOpacity>
                                    );
                                })}
                            </View>
                        </ScrollView>
                        <TouchableOpacity style={styles.variantCancel} onPress={() => setVariantPick(null)}>
                            <Text style={{ color: colors.textMuted, fontWeight: '600' }}>Annuler</Text>
                        </TouchableOpacity>
                    </View>
                </TouchableOpacity>
            </Modal>
        </View>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1 },
    safeArea: {},
    header: {
        flexDirection: 'row',
        padding: SPACING.md,
        gap: SPACING.sm,
        alignItems: 'center',
    },
    iconBtn: {
        width: 46,
        height: 46,
        borderRadius: RADIUS.full,
        justifyContent: 'center',
        alignItems: 'center',
        ...SHADOWS.md,
        borderWidth: 1,
    },
    searchContainer: {
        flex: 1,
        flexDirection: 'row',
        borderRadius: RADIUS.full,
        paddingHorizontal: SPACING.md,
        height: 46,
        alignItems: 'center',
        gap: SPACING.xs,
        borderWidth: 1,
        ...SHADOWS.sm,
    },
    searchInput: {
        flex: 1,
        fontSize: 15,
        fontWeight: '500'
    },
    scanBtn: {
        width: 46,
        height: 46,
        borderRadius: RADIUS.full,
        justifyContent: 'center',
        alignItems: 'center',
        ...SHADOWS.md,
    },
    listContent: {
        padding: SPACING.md,
        paddingBottom: 200,
    },
    listHeader: { marginBottom: SPACING.lg },
    sectionTitle: { fontSize: 28, fontWeight: '800', letterSpacing: -0.5 },
    sectionSubtitle: { fontSize: 13, marginTop: 4 },
    productCard: {
        width: CARD_WIDTH,
        borderRadius: RADIUS.lg,
        padding: SPACING.md,
        marginBottom: SPACING.md,
        marginRight: SPACING.md,
        ...SHADOWS.md,
        borderWidth: 1,
    },
    productThumbRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        marginBottom: SPACING.sm,
    },
    stockPillWrap: { marginTop: 2 },
    productName: {
        fontSize: 14,
        fontWeight: '700',
        height: 38,
        letterSpacing: -0.2,
    },
    productFoot: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginTop: SPACING.xs,
    },
    productPrice: {
        fontSize: 16,
        fontWeight: '800',
        fontVariant: ['tabular-nums'],
        letterSpacing: -0.3,
    },
    addBtn: {
        width: 32,
        height: 32,
        borderRadius: 11,
        alignItems: 'center',
        justifyContent: 'center',
    },
    floatingCart: {
        position: 'absolute',
        bottom: 120,
        left: SPACING.md,
        right: SPACING.md,
        borderRadius: RADIUS.xl,
        overflow: 'hidden',
        ...SHADOWS.lg,
    },
    cartGradient: {
        flexDirection: 'row',
        padding: SPACING.md,
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    cartInfo: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
    badge: {
        width: 24,
        height: 24,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center'
    },
    badgeText: { fontSize: 12, fontWeight: '900' },
    cartLabel: { fontWeight: '700', fontSize: 15, letterSpacing: -0.2 },
    cartPriceContainer: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
    cartTotal: { fontWeight: '900', fontSize: 19, fontVariant: ['tabular-nums'] },

    // Modal Styles
    modalContent: { flex: 1 },
    modalHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: SPACING.lg,
        borderBottomWidth: 1,
    },
    modalTitle: { fontSize: 24, fontWeight: '800', letterSpacing: -0.5 },
    modalSubtitle: { fontSize: 13, marginTop: 2 },
    closeBtn: { padding: SPACING.xs },
    cartItems: { flex: 1, padding: SPACING.md },
    cartItem: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: SPACING.md,
        borderRadius: RADIUS.lg,
        marginBottom: SPACING.sm,
        gap: SPACING.md,
        borderWidth: 1,
        ...SHADOWS.sm,
    },
    itemInfo: { flex: 1 },
    itemName: { fontWeight: '600', fontSize: 15 },
    itemPrice: { fontWeight: '800', marginTop: 2, fontSize: 15, fontVariant: ['tabular-nums'] },
    qtyContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: RADIUS.full,
        padding: 4,
        gap: 12,
    },
    qtyBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
    qtyValue: { fontWeight: '800' },
    removeBtn: { padding: SPACING.xs },

    // --- Size / colour picker (Dapper Phase 6) ---
    variantOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.6)',
        justifyContent: 'center',
        alignItems: 'center',
        padding: SPACING.lg,
    },
    variantSheet: {
        width: '100%',
        borderRadius: RADIUS.xl,
        padding: SPACING.lg,
        ...SHADOWS.lg,
    },
    variantTitle: { fontSize: 18, fontWeight: '700' },
    variantHint: { fontSize: 13, marginTop: 2, marginBottom: SPACING.md },
    variantGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
    variantChip: {
        minWidth: 96,
        paddingVertical: SPACING.sm,
        paddingHorizontal: SPACING.md,
        borderRadius: RADIUS.md,
        borderWidth: 1,
        alignItems: 'center',
    },
    variantChipLabel: { fontSize: 14, fontWeight: '700' },
    variantChipStock: { fontSize: 11, marginTop: 2 },
    variantCancel: { alignSelf: 'flex-end', marginTop: SPACING.md, padding: SPACING.sm },
    checkoutFooter: {
        padding: SPACING.xl,
        borderTopWidth: 1,
    },
    summaryRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginBottom: SPACING.lg
    },
    summaryLabel: { fontSize: 16, fontWeight: '600' },
    summaryValue: { fontSize: 24, fontWeight: '800', fontVariant: ['tabular-nums'] },
    payButton: {
        height: 60,
        borderRadius: RADIUS.full,
        alignItems: 'center',
        justifyContent: 'center',
        ...SHADOWS.md,
    },
    payButtonText: { fontSize: 18, fontWeight: '700', letterSpacing: -0.2 },
    heldItem: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: SPACING.md,
        borderRadius: RADIUS.lg,
        marginBottom: SPACING.md,
        borderWidth: 1,
        ...SHADOWS.sm,
    },
    heldTime: { fontSize: 12, marginBottom: 4 },
    heldName: { fontSize: 16, fontWeight: '600' },
    heldAmount: { fontSize: 18, fontWeight: '800', fontVariant: ['tabular-nums'] },
    emptyState: { alignItems: 'center', marginTop: 50 },
    emptyText: { marginTop: 10, fontSize: 16 },
    customerBar: { flexDirection: 'row', padding: 10, alignItems: 'center', gap: 10, borderBottomWidth: 1 },
    customerLabel: { fontWeight: '600' },
    customerName: { fontWeight: '700' }
});
