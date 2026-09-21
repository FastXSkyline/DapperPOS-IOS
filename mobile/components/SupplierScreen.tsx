import { useState, useEffect, useMemo } from 'react'
import {
    View,
    Text,
    StyleSheet,
    FlatList,
    TextInput,
    Alert,
    KeyboardAvoidingView,
    Platform,
    Modal
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { BlurView } from 'expo-blur'
import { SafeAreaView } from 'react-native-safe-area-context'
import { SupplierService } from '../services/database'
import { SPACING, RADIUS, SHADOWS } from '../constants/theme'
import { useTheme } from '../context/ThemeContext'
import { Screen, GlassCard, PageTitle, Chip, Thumb, Divider, EmptyState, PrimaryButton, IconButton } from './ui/Kit'

interface Supplier {
    id: number
    company_name: string
    contact_name: string | null
    phone: string | null
    email: string | null
    address: string | null
    city: string | null
    credit_limit: number
}

export function SupplierScreen() {
    const { colors, theme } = useTheme()
    const styles = useMemo(() => makeStyles(colors, theme), [colors, theme])

    const [suppliers, setSuppliers] = useState<Supplier[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [showModal, setShowModal] = useState(false)
    const [formData, setFormData] = useState({
        company_name: '',
        contact_name: '',
        phone: '',
        email: '',
        address: '',
        city: '',
        payment_terms: '',
        credit_limit: ''
    })

    const loadSuppliers = async () => {
        try {
            const data = await SupplierService.getAll()
            setSuppliers(data as Supplier[])
        } catch (error) {
            console.error(error)
            Alert.alert('Error', 'Failed to load suppliers')
        } finally {
            setIsLoading(false)
        }
    }

    useEffect(() => {
        loadSuppliers()
    }, [])

    const handleSave = async () => {
        if (!formData.company_name.trim()) {
            Alert.alert('Error', 'Company name is required')
            return
        }

        try {
            await SupplierService.create({
                company_name: formData.company_name,
                contact_name: formData.contact_name || null,
                phone: formData.phone || null,
                email: formData.email || null,
                address: formData.address || null,
                city: formData.city || null,
                payment_terms: formData.payment_terms || null,
                credit_limit: parseFloat(formData.credit_limit) || 0
            })
            setShowModal(false)
            setFormData({
                company_name: '',
                contact_name: '',
                phone: '',
                email: '',
                address: '',
                city: '',
                payment_terms: '',
                credit_limit: ''
            })
            loadSuppliers()
        } catch (error) {
            Alert.alert('Error', 'Failed to save supplier')
        }
    }

    const handleDelete = (id: number) => {
        Alert.alert(
            'Delete Supplier',
            'Are you sure you want to delete this supplier?',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Delete',
                    style: 'destructive',
                    onPress: async () => {
                        try {
                            await SupplierService.delete(id)
                            loadSuppliers()
                        } catch (error) {
                            Alert.alert('Error', 'Failed to delete supplier')
                        }
                    }
                }
            ]
        )
    }

    const renderItem = ({ item }: { item: Supplier }) => (
        <GlassCard style={styles.card}>
            <View style={styles.cardHeader}>
                <Thumb seed={item.id} label={item.company_name} size={44} icon="business-outline" />
                <View style={styles.cardInfo}>
                    <Text style={[styles.companyName, { color: colors.text }]} numberOfLines={1}>{item.company_name}</Text>
                    {item.contact_name && (
                        <Text style={[styles.contactName, { color: colors.textMuted }]} numberOfLines={1}>{item.contact_name}</Text>
                    )}
                </View>
                <IconButton icon="trash-outline" size={36} onPress={() => handleDelete(item.id)} />
            </View>

            {(item.phone || item.city || item.credit_limit > 0) && (
                <>
                    <Divider style={styles.divider} />
                    <View style={styles.cardDetails}>
                        {item.phone && (
                            <View style={styles.detailRow}>
                                <Ionicons name="call-outline" size={15} color={colors.textTertiary} />
                                <Text style={[styles.detailText, { color: colors.textMuted }]}>{item.phone}</Text>
                            </View>
                        )}
                        {item.city && (
                            <View style={styles.detailRow}>
                                <Ionicons name="location-outline" size={15} color={colors.textTertiary} />
                                <Text style={[styles.detailText, { color: colors.textMuted }]}>{item.city}</Text>
                            </View>
                        )}
                        {item.credit_limit > 0 && (
                            <Chip
                                tone="ok"
                                icon="wallet-outline"
                                label={`Limit: ${item.credit_limit.toLocaleString()} DA`}
                            />
                        )}
                    </View>
                </>
            )}
        </GlassCard>
    )

    return (
        <Screen>
            <SafeAreaView edges={['top']} style={styles.safe}>
                <View style={styles.header}>
                    <PageTitle title="Suppliers" />
                </View>

                <View style={styles.addAction}>
                    <PrimaryButton label="Add Supplier" icon="add" onPress={() => setShowModal(true)} />
                </View>

                <FlatList
                    data={suppliers}
                    renderItem={renderItem}
                    keyExtractor={item => item.id.toString()}
                    showsVerticalScrollIndicator={false}
                    contentContainerStyle={styles.listContent}
                    ListEmptyComponent={
                        <EmptyState icon="business-outline" title="No suppliers found" />
                    }
                />

                <Modal visible={showModal} animationType="slide" transparent>
                    <KeyboardAvoidingView
                        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                        style={styles.modalContainer}
                    >
                        <View style={[styles.modalOverlay, { backgroundColor: colors.overlay }]}>
                            <BlurView intensity={Platform.OS === 'ios' ? 40 : 90} tint={theme === 'dark' ? 'dark' : 'light'} style={styles.modalContent}>
                                <View style={[styles.modalSheet, { backgroundColor: colors.glass, borderColor: colors.border }]}>
                                    <View style={[styles.grabber, { backgroundColor: colors.border }]} />
                                    <View style={styles.modalHeader}>
                                        <Text style={[styles.modalTitle, { color: colors.text }]}>New Supplier</Text>
                                        <IconButton icon="close" size={36} onPress={() => setShowModal(false)} />
                                    </View>

                                    <View style={styles.form}>
                                        <TextInput
                                            style={[styles.input, { backgroundColor: colors.background, borderColor: colors.border, color: colors.text }]}
                                            placeholder="Company Name *"
                                            placeholderTextColor={colors.textTertiary}
                                            value={formData.company_name}
                                            onChangeText={t => setFormData({ ...formData, company_name: t })}
                                        />
                                        <TextInput
                                            style={[styles.input, { backgroundColor: colors.background, borderColor: colors.border, color: colors.text }]}
                                            placeholder="Contact Person"
                                            placeholderTextColor={colors.textTertiary}
                                            value={formData.contact_name}
                                            onChangeText={t => setFormData({ ...formData, contact_name: t })}
                                        />
                                        <View style={styles.row}>
                                            <TextInput
                                                style={[styles.input, styles.rowInput, { backgroundColor: colors.background, borderColor: colors.border, color: colors.text }]}
                                                placeholder="Phone"
                                                placeholderTextColor={colors.textTertiary}
                                                value={formData.phone}
                                                onChangeText={t => setFormData({ ...formData, phone: t })}
                                                keyboardType="phone-pad"
                                            />
                                            <TextInput
                                                style={[styles.input, styles.rowInput, { backgroundColor: colors.background, borderColor: colors.border, color: colors.text }]}
                                                placeholder="City"
                                                placeholderTextColor={colors.textTertiary}
                                                value={formData.city}
                                                onChangeText={t => setFormData({ ...formData, city: t })}
                                            />
                                        </View>
                                        <TextInput
                                            style={[styles.input, { backgroundColor: colors.background, borderColor: colors.border, color: colors.text }]}
                                            placeholder="Credit Limit"
                                            placeholderTextColor={colors.textTertiary}
                                            value={formData.credit_limit}
                                            onChangeText={t => setFormData({ ...formData, credit_limit: t })}
                                            keyboardType="numeric"
                                        />

                                        <PrimaryButton label="Save Supplier" icon="checkmark" onPress={handleSave} style={styles.saveBtn} />
                                    </View>
                                </View>
                            </BlurView>
                        </View>
                    </KeyboardAvoidingView>
                </Modal>
            </SafeAreaView>
        </Screen>
    )
}

const makeStyles = (colors: ReturnType<typeof useTheme>['colors'], _theme: 'light' | 'dark') => StyleSheet.create({
    safe: {
        flex: 1
    },
    header: {
        paddingHorizontal: SPACING.md,
        paddingTop: SPACING.md
    },
    addAction: {
        paddingHorizontal: SPACING.md,
        paddingTop: SPACING.sm,
        paddingBottom: SPACING.sm
    },
    listContent: {
        paddingHorizontal: SPACING.md,
        paddingTop: SPACING.sm,
        paddingBottom: 140
    },
    card: {
        marginBottom: SPACING.sm
    },
    cardHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.sm
    },
    cardInfo: {
        flex: 1
    },
    companyName: {
        fontSize: 16,
        fontWeight: '800',
        letterSpacing: -0.3
    },
    contactName: {
        fontSize: 13.5,
        fontWeight: '500',
        marginTop: 2
    },
    divider: {
        marginVertical: SPACING.sm + 2
    },
    cardDetails: {
        gap: SPACING.sm,
        alignItems: 'flex-start'
    },
    detailRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.sm
    },
    detailText: {
        fontSize: 13.5,
        fontWeight: '500',
        fontVariant: ['tabular-nums']
    },
    modalContainer: {
        flex: 1,
        justifyContent: 'flex-end'
    },
    modalOverlay: {
        flex: 1,
        justifyContent: 'flex-end'
    },
    modalContent: {
        borderTopLeftRadius: RADIUS.xl + 6,
        borderTopRightRadius: RADIUS.xl + 6,
        overflow: 'hidden',
        ...SHADOWS.lg
    },
    modalSheet: {
        borderTopLeftRadius: RADIUS.xl + 6,
        borderTopRightRadius: RADIUS.xl + 6,
        borderWidth: 1,
        borderBottomWidth: 0,
        paddingHorizontal: SPACING.lg,
        paddingTop: SPACING.sm,
        paddingBottom: SPACING.xl
    },
    grabber: {
        alignSelf: 'center',
        width: 40,
        height: 4,
        borderRadius: RADIUS.full,
        marginBottom: SPACING.md
    },
    modalHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: SPACING.lg
    },
    modalTitle: {
        fontSize: 21,
        fontWeight: '800',
        letterSpacing: -0.6
    },
    form: {
        gap: SPACING.sm + 2
    },
    input: {
        borderRadius: RADIUS.md,
        paddingHorizontal: SPACING.md,
        paddingVertical: 13,
        fontSize: 15,
        fontWeight: '500',
        borderWidth: 1
    },
    row: {
        flexDirection: 'row',
        gap: SPACING.sm + 2
    },
    rowInput: {
        flex: 1
    },
    saveBtn: {
        marginTop: SPACING.sm
    }
})
