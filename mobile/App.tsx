import { StatusBar } from 'expo-status-bar';
import { StyleSheet, View, Text, Alert } from 'react-native';
import { useState, useEffect } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { initDatabase } from './services/database';
import { PinLogin } from './components/PinLogin';
import { HomeScreen } from './components/HomeScreen';
import { POSScreen } from './components/POSScreen';
import { InventoryScreen } from './components/InventoryScreen';
import { ReportsScreen } from './components/ReportsScreen';
import { DebtorsScreen } from './components/DebtorsScreen';
import { SettingsScreen } from './components/SettingsScreen';
import { ExpensesScreen } from './components/ExpensesScreen';
import { OrdersScreen } from './components/OrdersScreen';
import { SupplierScreen } from './components/SupplierScreen';
import { SettlementScreen } from './components/SettlementScreen';
import { VoiceAssistant } from './components/VoiceAssistant';
import { GlassDock } from './components/ui/GlassDock';
import { ThemeProvider, useTheme } from './context/ThemeContext';
import { AMBIENT } from './constants/theme';
import { tabsForRole, canAccess, landingTab, type Tab } from './services/permissions';

/** Icon + label per destination. One table, mirroring the desktop NAV array.
 *  Icons are the minimal geometric outline family (sharp/uniform stroke look),
 *  matching the dock's glow-blur design language. Filled twins render on the
 *  active tab; every icon here must have a `-outline` twin in Ionicons. */
const TAB_META: { tab: Tab; icon: keyof typeof Ionicons.glyphMap; label: string }[] = [
    { tab: 'Home', icon: 'home', label: 'Accueil' },
    { tab: 'POS', icon: 'cart', label: 'Caisse' },
    { tab: 'Inventory', icon: 'cube', label: 'Stock' },
    { tab: 'Reports', icon: 'stats-chart', label: 'Stats' },
    { tab: 'Debtors', icon: 'people', label: 'Dettes' },
    { tab: 'Expenses', icon: 'wallet', label: 'Frais' },
    { tab: 'Orders', icon: 'receipt', label: 'Cmdes' },
    { tab: 'Suppliers', icon: 'pricetag', label: 'Fourn.' },
    { tab: 'Settlements', icon: 'card', label: 'Règl.' },
    { tab: 'Settings', icon: 'settings', label: 'Réglages' },
];

function AppContent() {
    const { theme, colors } = useTheme();
    const [dbReady, setDbReady] = useState(false);
    const [user, setUser] = useState<{ id: number; name: string; role: string } | null>(null);
    const [activeTab, setActiveTab] = useState<Tab>('POS');

    useEffect(() => {
        initDatabase()
            .then(() => setDbReady(true))
            .catch(e => Alert.alert('Error', 'Database failed to initialize'));
    }, []);

    if (!dbReady) {
        return (
            <View style={[styles.center, { backgroundColor: colors.background }]}>
                <LinearGradient colors={AMBIENT[theme] as any} style={StyleSheet.absoluteFill as any} />
                <View style={styles.bootBrand}>
                    <View style={[styles.bootMark, { backgroundColor: colors.accentSoft, borderColor: colors.accentRing }]}>
                        <Ionicons name="diamond-outline" size={26} color={colors.accent} />
                    </View>
                    <Text style={[styles.bootWord, { color: colors.text }]}>Dapper</Text>
                    <Text style={[styles.bootSub, { color: colors.textMuted }]}>Retail System</Text>
                </View>
                <View style={[styles.loader, { borderColor: colors.accent, borderTopColor: 'transparent' }]} />
            </View>
        );
    }

    if (!user) {
        return <PinLogin onLogin={(u) => { setUser(u); setActiveTab(landingTab(u.role)); }} />;
    }

    const allowedTabs = tabsForRole(user.role);

    /** Single gate for every navigation source — dock, home shortcuts, voice. */
    const goToTab = (tab: Tab) => {
        if (canAccess(user.role, tab)) setActiveTab(tab);
    };

    const renderContent = () => {
        const tab = canAccess(user.role, activeTab) ? activeTab : landingTab(user.role);
        switch (tab) {
            case 'Home': return <HomeScreen userName={user.name} role={user.role} onNavigate={goToTab} />;
            case 'POS': return <POSScreen />;
            case 'Inventory': return <InventoryScreen />;
            case 'Reports': return <ReportsScreen />;
            case 'Debtors': return <DebtorsScreen />;
            case 'Expenses': return <ExpensesScreen />;
            case 'Orders': return <OrdersScreen />;
            case 'Suppliers': return <SupplierScreen />;
            case 'Settlements': return <SettlementScreen />;
            case 'Settings': return <SettingsScreen />;
        }
    };

    const visible = TAB_META.filter(m => allowedTabs.includes(m.tab));

    return (
        <SafeAreaProvider>
            <View style={[styles.container, { backgroundColor: colors.background }]}>
                {/* Single soft ambient wash behind everything (matches Kit.Screen). */}
                <LinearGradient colors={AMBIENT[theme] as any} style={StyleSheet.absoluteFill as any} />
                <StatusBar style={theme === 'dark' ? 'light' : 'dark'} translucent backgroundColor="transparent" />

                <View style={styles.content}>
                    {renderContent()}
                </View>

                {/* Floating glass dock — blur + gradient glow + animated active pill */}
                <GlassDock tabs={visible} activeTab={activeTab} onSelect={goToTab} />

                <VoiceAssistant onNavigate={(tab) => goToTab(tab as Tab)} />
            </View>
        </SafeAreaProvider>
    );
}

export default function App() {
    return (
        <ThemeProvider>
            <AppContent />
        </ThemeProvider>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1 },
    center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    bootBrand: { alignItems: 'center', marginBottom: 28 },
    bootMark: { width: 62, height: 62, borderRadius: 20, alignItems: 'center', justifyContent: 'center', borderWidth: 1, marginBottom: 12 },
    bootWord: { fontSize: 26, fontWeight: '800', letterSpacing: -0.8 },
    bootSub: { fontSize: 12, fontWeight: '600', letterSpacing: 1.5, textTransform: 'uppercase', marginTop: 2, opacity: 0.7 },
    loader: { width: 34, height: 34, borderRadius: 17, borderWidth: 3 },
    content: { flex: 1 },
});
