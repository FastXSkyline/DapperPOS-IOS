import React, { useState, useEffect } from 'react';
import {
    View,
    Text,
    StyleSheet,
    FlatList,
    TouchableOpacity,
    StatusBar
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ProductService, Product } from '../services/productService';
import { ProductDetail } from './ProductDetail';
import { SPACING } from '../constants/theme';
import { useTheme } from '../context/ThemeContext';
import { Screen, GlassCard, PageTitle, SearchField, Chip, Thumb, Bar, EmptyState, Divider } from './ui/Kit';

export function InventoryScreen() {
    const { colors } = useTheme();
    const [products, setProducts] = useState<Product[]>([]);
    const [search, setSearch] = useState('');
    const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        loadProducts();
    }, [search]);

    const loadProducts = async () => {
        setLoading(true);
        try {
            const data = await ProductService.getAll({ search: search.length > 2 ? search : undefined });
            setProducts(data);
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    };

    const getStockStatus = (item: Product) => {
        const qty = item.stock_quantity || 0;
        if (qty <= 0) return { label: 'Out of Stock', color: colors.error, tone: 'bad' as const };
        if (qty <= (item.min_stock_level || 5)) return { label: 'Low Stock', color: colors.warning, tone: 'warn' as const };
        return { label: 'In Stock', color: colors.success, tone: 'ok' as const };
    };

    const renderItem = ({ item }: { item: Product }) => {
        const status = getStockStatus(item);
        const stockPercent = (item.stock_quantity || 0) > (item.min_stock_level || 5) ? 1 : (item.stock_quantity || 0) / (item.min_stock_level || 5);

        return (
            <TouchableOpacity
                onPress={() => setSelectedProduct(item)}
                activeOpacity={0.8}
                style={styles.cardWrap}
            >
                <GlassCard>
                    <View style={styles.cardMain}>
                        <Thumb seed={item.id} label={item.name} icon="cube-outline" size={46} />
                        <View style={styles.info}>
                            <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>{item.name}</Text>
                            <Text style={[styles.sku, { color: colors.textMuted }]}>SKU: {item.sku || '-'}</Text>
                        </View>
                        <View style={styles.priceContainer}>
                            <Text style={[styles.price, { color: colors.success }]}>DZD {item.retail_price.toLocaleString()}</Text>
                            <Chip label={status.label} tone={status.tone} />
                        </View>
                    </View>

                    <Divider style={styles.stockDivider} />

                    <View style={styles.stockSection}>
                        <View style={styles.stockHeader}>
                            <Text style={[styles.stockLabel, { color: colors.textMuted }]}>Stock Level</Text>
                            <Text style={[styles.stockValue, { color: colors.text }]}>{item.stock_quantity || 0} units</Text>
                        </View>
                        <Bar pct={stockPercent * 100} color={status.color} />
                    </View>
                </GlassCard>
            </TouchableOpacity>
        );
    };

    if (selectedProduct) {
        return <ProductDetail product={selectedProduct} onClose={() => setSelectedProduct(null)} />;
    }

    return (
        <Screen>
            <StatusBar barStyle="light-content" />
            <SafeAreaView edges={['top']}>
                <View style={styles.header}>
                    <PageTitle title="Inventory" />
                    <SearchField
                        value={search}
                        onChangeText={setSearch}
                        placeholder="Search catalogue..."
                    />
                </View>
            </SafeAreaView>

            <FlatList
                data={products}
                renderItem={renderItem}
                keyExtractor={item => item.id.toString()}
                contentContainerStyle={styles.list}
                showsVerticalScrollIndicator={false}
                ListEmptyComponent={
                    <EmptyState icon="file-tray-outline" title="No products found" />
                }
            />
        </Screen>
    );
}

const styles = StyleSheet.create({
    header: { paddingHorizontal: SPACING.md, paddingTop: SPACING.md, paddingBottom: SPACING.sm, gap: SPACING.md },
    list: { padding: SPACING.md, paddingBottom: 140 },
    cardWrap: { marginBottom: SPACING.md },
    cardMain: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md },
    info: { flex: 1 },
    name: { fontWeight: '700', fontSize: 15, letterSpacing: -0.2, marginBottom: 2 },
    sku: { fontSize: 12, fontVariant: ['tabular-nums'] },
    priceContainer: { alignItems: 'flex-end', gap: 6 },
    price: { fontWeight: '800', fontSize: 15, fontVariant: ['tabular-nums'] },
    stockDivider: { marginVertical: SPACING.sm },
    stockSection: { gap: 6 },
    stockHeader: { flexDirection: 'row', justifyContent: 'space-between' },
    stockLabel: { fontSize: 12, fontWeight: '600' },
    stockValue: { fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] }
});
