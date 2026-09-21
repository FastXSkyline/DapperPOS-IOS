import { useState, useEffect, useMemo } from 'react'
import {
    View,
    Text,
    StyleSheet,
    TextInput,
    TouchableOpacity,
    FlatList,
    Alert,
    KeyboardAvoidingView,
    Platform
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { SafeAreaView } from 'react-native-safe-area-context'
import { ExpenseService } from '../services/database'
import { SPACING, RADIUS } from '../constants/theme'
import { useTheme } from '../context/ThemeContext'
import { Screen, GlassCard, PageTitle, SectionHeader, StatTile, PrimaryButton, EmptyState } from './ui/Kit'

interface Expense {
    id: number
    name: string
    amount: number
    created_at: string
}

interface ExpenseTotals {
    total7D: number
    total1M: number
    total6M: number
    total1Y: number
}

export function ExpensesScreen() {
    const { colors, theme } = useTheme()
    const styles = useMemo(() => makeStyles(colors, theme), [colors, theme])

    const [expenses, setExpenses] = useState<Expense[]>([])
    const [totals, setTotals] = useState<ExpenseTotals>({ total7D: 0, total1M: 0, total6M: 0, total1Y: 0 })
    const [name, setName] = useState('')
    const [amount, setAmount] = useState('')
    const [loading, setLoading] = useState(false)

    const loadData = async () => {
        try {
            const [expenseList, expenseTotals] = await Promise.all([
                ExpenseService.list(),
                ExpenseService.totals()
            ])
            setExpenses(expenseList as Expense[])
            setTotals(expenseTotals)
        } catch (error) {
            console.error('Failed to load expenses:', error)
        }
    }

    useEffect(() => {
        loadData()
    }, [])

    const handleSubmit = async () => {
        if (!name.trim() || !amount) {
            Alert.alert('Erreur', 'Veuillez remplir tous les champs')
            return
        }

        setLoading(true)
        try {
            await ExpenseService.create(name.trim(), parseFloat(amount))
            setName('')
            setAmount('')
            await loadData()
        } catch (error) {
            console.error('Failed to add expense:', error)
            Alert.alert('Erreur', 'Impossible d\'ajouter la dépense')
        } finally {
            setLoading(false)
        }
    }

    const handleDelete = async (id: number) => {
        Alert.alert(
            'Confirmer',
            'Supprimer cette dépense ?',
            [
                { text: 'Annuler', style: 'cancel' },
                {
                    text: 'Supprimer',
                    style: 'destructive',
                    onPress: async () => {
                        try {
                            await ExpenseService.delete(id)
                            await loadData()
                        } catch (error) {
                            console.error('Failed to delete expense:', error)
                        }
                    }
                }
            ]
        )
    }

    const formatCurrency = (val: number) => val.toLocaleString('fr-DZ', { minimumFractionDigits: 2 }) + ' DZD'

    const formatDate = (dateStr: string) => {
        const date = new Date(dateStr)
        return date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' })
    }

    const renderExpenseItem = ({ item }: { item: Expense }) => (
        <GlassCard pad="tight" style={styles.expenseItem}>
            <View style={styles.expenseRow}>
                <View style={[styles.expenseIcon, { backgroundColor: colors.accentSoft }]}>
                    <Ionicons name="receipt-outline" size={16} color={colors.accent} />
                </View>
                <View style={styles.expenseInfo}>
                    <Text style={[styles.expenseName, { color: colors.text }]} numberOfLines={1}>{item.name}</Text>
                    <Text style={[styles.expenseDate, { color: colors.textTertiary }]}>{formatDate(item.created_at)}</Text>
                </View>
                <Text style={[styles.expenseAmount, { color: colors.success }]} numberOfLines={1}>{formatCurrency(item.amount)}</Text>
                <TouchableOpacity
                    onPress={() => handleDelete(item.id)}
                    style={[styles.deleteBtn, { backgroundColor: colors.error + '14' }]}
                >
                    <Ionicons name="trash-outline" size={16} color={colors.error} />
                </TouchableOpacity>
            </View>
        </GlassCard>
    )

    return (
        <Screen>
            <SafeAreaView style={styles.safe} edges={['top']}>
                <KeyboardAvoidingView
                    behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                    style={styles.container}
                >
                    {/* Header */}
                    <View style={styles.header}>
                        <PageTitle title="Dépenses" />
                    </View>

                    {/* Stats Cards */}
                    <View style={styles.statsGrid}>
                        <View style={styles.statRow}>
                            <StatTile label="7 Jours" value={formatCurrency(totals.total7D)} icon="calendar-outline" accent={colors.info} />
                            <StatTile label="1 Mois" value={formatCurrency(totals.total1M)} icon="calendar-outline" accent={colors.accent} />
                        </View>
                        <View style={styles.statRow}>
                            <StatTile label="6 Mois" value={formatCurrency(totals.total6M)} icon="trending-up-outline" accent={colors.warning} />
                            <StatTile label="1 An" value={formatCurrency(totals.total1Y)} icon="pie-chart-outline" accent={colors.success} />
                        </View>
                    </View>

                    {/* Add Expense Form */}
                    <View style={styles.formSection}>
                        <GlassCard>
                            <SectionHeader title="Ajouter une Dépense" icon="add-circle-outline" />
                            <View style={styles.form}>
                                <TextInput
                                    style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
                                    placeholder="Nom (ex: Carburant)"
                                    placeholderTextColor={colors.textTertiary}
                                    value={name}
                                    onChangeText={setName}
                                />
                                <TextInput
                                    style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
                                    placeholder="Montant (DZD)"
                                    placeholderTextColor={colors.textTertiary}
                                    value={amount}
                                    onChangeText={setAmount}
                                    keyboardType="numeric"
                                />
                                <PrimaryButton
                                    label={loading ? 'Ajout...' : 'Ajouter'}
                                    icon="add-circle"
                                    onPress={handleSubmit}
                                    disabled={loading}
                                    style={styles.submitBtn}
                                />
                            </View>
                        </GlassCard>
                    </View>

                    {/* Expense History */}
                    <View style={styles.historySection}>
                        <View style={styles.historyHead}>
                            <SectionHeader title="Historique" icon="time-outline" />
                        </View>
                        {expenses.length === 0 ? (
                            <EmptyState icon="receipt-outline" title="Aucune dépense enregistrée" />
                        ) : (
                            <FlatList
                                data={expenses}
                                keyExtractor={(item) => item.id.toString()}
                                renderItem={renderExpenseItem}
                                style={styles.list}
                                showsVerticalScrollIndicator={false}
                                contentContainerStyle={styles.listContent}
                            />
                        )}
                    </View>
                </KeyboardAvoidingView>
            </SafeAreaView>
        </Screen>
    )
}

const makeStyles = (colors: ReturnType<typeof useTheme>['colors'], _theme: 'light' | 'dark') => StyleSheet.create({
    safe: {
        flex: 1
    },
    container: {
        flex: 1
    },
    header: {
        paddingHorizontal: SPACING.md,
        paddingTop: SPACING.md,
        paddingBottom: SPACING.sm
    },
    statsGrid: {
        paddingHorizontal: SPACING.md,
        gap: SPACING.sm
    },
    statRow: {
        flexDirection: 'row',
        gap: SPACING.sm
    },
    formSection: {
        marginTop: SPACING.md,
        paddingHorizontal: SPACING.md
    },
    form: {
        gap: SPACING.sm
    },
    input: {
        borderRadius: RADIUS.md,
        paddingHorizontal: SPACING.md,
        paddingVertical: 13,
        fontSize: 15,
        fontWeight: '500',
        borderWidth: 1
    },
    submitBtn: {
        marginTop: SPACING.xs
    },
    historySection: {
        flex: 1,
        marginTop: SPACING.md,
        paddingHorizontal: SPACING.md
    },
    historyHead: {
        marginBottom: SPACING.sm,
        paddingHorizontal: SPACING.xs
    },
    list: {
        flex: 1
    },
    listContent: {
        paddingBottom: 140
    },
    expenseItem: {
        marginBottom: SPACING.sm
    },
    expenseRow: {
        flexDirection: 'row',
        alignItems: 'center'
    },
    expenseIcon: {
        width: 32,
        height: 32,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: SPACING.sm
    },
    expenseInfo: {
        flex: 1
    },
    expenseName: {
        fontSize: 14.5,
        fontWeight: '700',
        letterSpacing: -0.2
    },
    expenseDate: {
        fontSize: 12,
        fontWeight: '500',
        marginTop: 2,
        fontVariant: ['tabular-nums']
    },
    expenseAmount: {
        fontSize: 15,
        fontWeight: '800',
        letterSpacing: -0.3,
        fontVariant: ['tabular-nums'],
        marginRight: SPACING.sm
    },
    deleteBtn: {
        width: 32,
        height: 32,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center'
    }
})
