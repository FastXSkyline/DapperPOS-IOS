import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, Alert, ScrollView, Modal, Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { SyncService } from '../services/SyncService';
import { UserService } from '../services/database';
import { SPACING, RADIUS, SHADOWS } from '../constants/theme';
import { useTheme } from '../context/ThemeContext';
import SignatureScreen, { SignatureViewRef } from 'react-native-signature-canvas';
import { useRef } from 'react';
import {
    Screen,
    GlassCard,
    PageTitle,
    SectionHeader,
    Thumb,
    Divider,
    PrimaryButton,
    IconButton,
} from './ui/Kit';

export function SettingsScreen() {
    const { theme, colors, toggleTheme } = useTheme();
    const [serverUrl, setServerUrl] = useState('');
    const [syncToken, setSyncToken] = useState('');
    const [lastSync, setLastSync] = useState('');
    const [syncing, setSyncing] = useState(false);
    const [biometricEnabled, setBiometricEnabled] = useState(false);
    const [adminSignature, setAdminSignature] = useState('');
    const [showSignatureModal, setShowSignatureModal] = useState(false);
    const signatureRef = useRef<SignatureViewRef>(null);

    useEffect(() => {
        loadSettings();
    }, []);

    const loadSettings = async () => {
        const urlValue = await SyncService.getServerUrl();
        if (urlValue) setServerUrl(urlValue);

        const tokenValue = await SyncService.getSyncToken();
        if (tokenValue) setSyncToken(tokenValue);

        const sigValue = await SyncService.getAdminSignature();
        if (sigValue) setAdminSignature(sigValue);

        const users = await UserService.getAll() as any[];
        const owner = users.find(u => u.id === 1);
        if (owner) setBiometricEnabled(!!owner.biometric_enabled);
    };

    /** Normalize + persist the network settings. Shared by Save and Master Sync
     *  so tapping "Master Sync" alone never fails with "Server URL not set" just
     *  because the user forgot to press Save first. */
    const persistSettings = async (): Promise<string> => {
        let url = serverUrl.trim();
        if (url.endsWith('/')) url = url.slice(0, -1);
        if (url && !url.startsWith('http')) url = 'http://' + url;

        await SyncService.setServerUrl(url);
        setServerUrl(url);
        await SyncService.setSyncToken(syncToken.trim());
        await SyncService.setAdminSignature(adminSignature.trim());
        return url;
    };

    const handleSave = async () => {
        await persistSettings();
        Alert.alert('Configuration Saved', 'System connection points and print settings updated.');
    };

    const handleSync = async () => {
        const url = await persistSettings();
        if (!url) {
            Alert.alert('Action Required', 'Please configure the Server URL before syncing.');
            return;
        }

        setSyncing(true);
        try {
            // Sync suppliers first (they are referenced by products)
            const suppliersCount = await SyncService.syncSuppliers();
            // Then sync products
            const productsCount = await SyncService.syncProducts();
            Alert.alert('Sync Successful', `Synchronized ${productsCount} products and ${suppliersCount} suppliers.`);
            setLastSync(new Date().toLocaleTimeString());
        } catch (e: any) {
            Alert.alert('Sync Interrupted', e.message);
        } finally {
            setSyncing(false);
        }
    };

    const toggleBiometric = async () => {
        const newValue = !biometricEnabled;
        setBiometricEnabled(newValue);
        try {
            await UserService.updateBiometric(1, newValue ? 1 : 0);
        } catch (e) {
            console.error('Failed to update biometric setting:', e);
        }
    };

    const handleOK = (signature: string) => {
        setAdminSignature(signature);
        setShowSignatureModal(false);
    };

    const handleClear = () => {
        signatureRef.current?.clearSignature();
    };

    const handleConfirm = () => {
        signatureRef.current?.readSignature();
    };

    const SettingItem = ({ icon, label, onPress, color = colors.accent }: any) => (
        <TouchableOpacity style={styles.settingItem} onPress={onPress}>
            <View style={[styles.itemIcon, { backgroundColor: `${color}15` }]}>
                <Ionicons name={icon} size={20} color={color} />
            </View>
            <Text style={[styles.itemLabel, { color: colors.text }]}>{label}</Text>
            <Ionicons name="chevron-forward" size={18} color={colors.border} />
        </TouchableOpacity>
    );

    return (
        <Screen>
            <SafeAreaView edges={['top']} style={styles.safeArea}>
                <View style={styles.header}>
                    <PageTitle title="Account & Settings" />
                </View>
            </SafeAreaView>

            <ScrollView
                style={styles.content}
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator={false}
            >
                {/* Profile */}
                <View style={styles.section}>
                    <GlassCard glow>
                        <View style={styles.profileRow}>
                            <Thumb label="Pos Operator" icon="person-outline" size={56} seed={1} />
                            <View style={styles.profileInfo}>
                                <Text style={[styles.userName, { color: colors.text }]}>Pos Operator</Text>
                                <Text style={[styles.userRole, { color: colors.textMuted }]}>Store Manager</Text>
                            </View>
                            <IconButton icon="pencil" size={36} onPress={() => { }} />
                        </View>
                    </GlassCard>
                </View>

                {/* Appearance Section */}
                <View style={styles.section}>
                    <GlassCard>
                        <SectionHeader title="Appearance" icon="color-palette-outline" />
                        <TouchableOpacity style={styles.toggleRow} onPress={toggleTheme}>
                            <View style={[styles.rowIconBox, { backgroundColor: `${colors.accent}1F`, borderWidth: 1, borderColor: colors.border }]}>
                                <Ionicons name={theme === 'dark' ? "moon" : "sunny"} size={22} color={colors.accent} />
                            </View>
                            <View style={styles.rowText}>
                                <Text style={[styles.rowTitle, { color: colors.text }]}>{theme === 'dark' ? 'Dark Mode' : 'Light Mode'}</Text>
                                <Text style={[styles.rowDesc, { color: colors.textMuted }]}>Toggle system appearance</Text>
                            </View>
                            <View style={[styles.toggleTrack, { backgroundColor: theme === 'dark' ? colors.success : colors.border }]}>
                                <View style={[styles.toggleThumb, { left: theme === 'dark' ? 24 : 2 }]} />
                            </View>
                        </TouchableOpacity>
                    </GlassCard>
                </View>

                {/* Network & Print */}
                <View style={styles.section}>
                    <GlassCard>
                        <SectionHeader title="Network & Print Configuration" icon="server-outline" />
                        <Text style={[styles.inputLabel, { color: colors.textMuted }]}>Desktop Server Endpoint</Text>
                        <TextInput
                            style={[styles.input, { backgroundColor: colors.surfaceElevated, color: colors.text, borderColor: colors.border }]}
                            value={serverUrl}
                            onChangeText={setServerUrl}
                            placeholder="http://192.168.1.5:4000"
                            placeholderTextColor={colors.textMuted}
                            autoCapitalize="none"
                        />

                        <Text style={[styles.inputLabel, { color: colors.textMuted, marginTop: SPACING.md }]}>Pairing Token (from desktop Settings)</Text>
                        <TextInput
                            style={[styles.input, { backgroundColor: colors.surfaceElevated, color: colors.text, borderColor: colors.border }]}
                            value={syncToken}
                            onChangeText={setSyncToken}
                            placeholder="Paste the desktop pairing token"
                            placeholderTextColor={colors.textMuted}
                            autoCapitalize="none"
                            secureTextEntry
                        />

                        <Text style={[styles.inputLabel, { color: colors.textMuted, marginTop: SPACING.md }]}>Admin Signature (Printed on Docs)</Text>

                        {adminSignature ? (
                            <View style={[styles.signaturePreview, { backgroundColor: colors.white, borderColor: colors.border }]}>
                                <Image
                                    source={{ uri: adminSignature }}
                                    style={styles.signatureImage}
                                    resizeMode="contain"
                                />
                                <TouchableOpacity
                                    style={styles.clearSignatureBtn}
                                    onPress={() => setAdminSignature('')}
                                >
                                    <Ionicons name="trash-outline" size={16} color={colors.error} />
                                </TouchableOpacity>
                            </View>
                        ) : (
                            <TouchableOpacity
                                style={[styles.drawSignatureBtn, { borderColor: colors.accent }]}
                                onPress={() => setShowSignatureModal(true)}
                            >
                                <Ionicons name="create-outline" size={20} color={colors.accent} />
                                <Text style={[styles.drawSignatureText, { color: colors.accent }]}>Draw Signature</Text>
                            </TouchableOpacity>
                        )}

                        <PrimaryButton
                            label="Save Configuration"
                            icon="save-outline"
                            onPress={handleSave}
                            style={styles.saveAction}
                        />
                    </GlassCard>
                </View>

                {/* Data Management */}
                <View style={styles.section}>
                    <GlassCard>
                        <SectionHeader title="Data Management" icon="cloud-outline" />
                        <TouchableOpacity
                            style={[styles.toggleRow, syncing && styles.syncPanelDisabled]}
                            onPress={handleSync}
                            disabled={syncing}
                        >
                            <View style={[styles.rowIconBox, { backgroundColor: colors.accent + '15' }]}>
                                <Ionicons name={syncing ? "refresh" : "cloud-download"} size={24} color={colors.accent} />
                            </View>
                            <View style={styles.rowText}>
                                <Text style={[styles.rowTitle, { color: colors.text }]}>{syncing ? 'Synchronizing...' : 'Master Sync'}</Text>
                                <Text style={[styles.rowDesc, { color: colors.textMuted }]}>Update product list from desktop</Text>
                            </View>
                            {lastSync ? <Text style={[styles.lastSyncText, { color: colors.textMuted }]}>{lastSync}</Text> : null}
                        </TouchableOpacity>
                    </GlassCard>
                </View>

                {/* Security & Support */}
                <View style={styles.section}>
                    <GlassCard>
                        <SectionHeader title="Security & Support" icon="shield-checkmark-outline" />
                        <TouchableOpacity style={styles.settingItem} onPress={toggleBiometric}>
                            <View style={[styles.itemIcon, { backgroundColor: `${colors.accent}15` }]}>
                                <Ionicons name="finger-print-outline" size={20} color={colors.accent} />
                            </View>
                            <Text style={[styles.itemLabel, { color: colors.text }]}>Biometric Unlock</Text>
                            <View style={[styles.toggleTrack, { backgroundColor: biometricEnabled ? colors.success : colors.border, width: 40, height: 22 }]}>
                                <View style={[styles.toggleThumb, { left: biometricEnabled ? 20 : 2, width: 18, height: 18, borderRadius: 9 }]} />
                            </View>
                        </TouchableOpacity>
                        <Divider />
                        <SettingItem icon="help-circle-outline" label="Technical Support" />
                        <Divider />
                        <SettingItem icon="document-text-outline" label="System Logs" />
                        <Divider />
                        <SettingItem icon="log-out-outline" label="Terminate Session" color={colors.error} />
                    </GlassCard>
                </View>

                <Text style={[styles.versionInfo, { color: colors.textMuted }]}>System v1.0.2 • Powered by Deepmind</Text>
            </ScrollView>

            <Modal visible={showSignatureModal} animationType="slide">
                <SafeAreaView style={{ flex: 1, backgroundColor: colors.white }}>
                    <View style={styles.modalHeader}>
                        <TouchableOpacity onPress={() => setShowSignatureModal(false)}>
                            <Text style={{ color: colors.accent, fontWeight: '700' }}>Cancel</Text>
                        </TouchableOpacity>
                        <Text style={{ fontWeight: '800', fontSize: 18 }}>Draw Signature</Text>
                        <TouchableOpacity onPress={handleConfirm}>
                            <Text style={{ color: colors.success, fontWeight: '700' }}>Confirm</Text>
                        </TouchableOpacity>
                    </View>
                    <SignatureScreen
                        ref={signatureRef}
                        onOK={handleOK}
                        descriptionText="Sign here"
                        clearText="Clear"
                        confirmText="Save"
                        webStyle={`.m-signature-pad--footer {display: none; margin: 0px;}`}
                        autoClear={false}
                        imageType="image/png"
                    />
                    <View style={styles.modalFooter}>
                        <TouchableOpacity style={styles.modalBtn} onPress={handleClear}>
                            <Text>Clear</Text>
                        </TouchableOpacity>
                    </View>
                </SafeAreaView>
            </Modal>
        </Screen>
    );
}

const styles = StyleSheet.create({
    safeArea: {},
    header: { paddingHorizontal: SPACING.lg, paddingTop: SPACING.md, paddingBottom: SPACING.sm },
    content: { flex: 1 },
    scrollContent: { paddingHorizontal: SPACING.md, paddingBottom: 140 },
    section: { marginBottom: SPACING.lg },

    // Profile
    profileRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md },
    profileInfo: { flex: 1 },
    userName: { fontSize: 19, fontWeight: '800', letterSpacing: -0.5 },
    userRole: { fontSize: 12, fontWeight: '500', marginTop: 2 },

    // Generic icon rows (theme toggle / master sync)
    toggleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.md,
        paddingVertical: SPACING.sm,
    },
    rowIconBox: {
        width: 48,
        height: 48,
        borderRadius: RADIUS.md,
        alignItems: 'center',
        justifyContent: 'center',
    },
    rowText: { flex: 1 },
    rowTitle: { fontSize: 16, fontWeight: '800', letterSpacing: -0.5 },
    rowDesc: { fontSize: 12, fontWeight: '500', marginTop: 2 },
    lastSyncText: { fontSize: 10, fontWeight: '700', fontVariant: ['tabular-nums'] },
    syncPanelDisabled: { opacity: 0.6 },

    // Inputs
    inputLabel: { fontSize: 12, fontWeight: '700', marginBottom: SPACING.sm },
    input: {
        borderRadius: RADIUS.md,
        paddingHorizontal: SPACING.md,
        paddingVertical: SPACING.sm + 2,
        fontSize: 15,
        fontWeight: '600',
        marginBottom: SPACING.md,
        borderWidth: 1,
    },
    saveAction: { marginTop: SPACING.sm },

    // Settings list
    settingItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: SPACING.sm + 2,
    },
    itemIcon: {
        width: 36,
        height: 36,
        borderRadius: RADIUS.sm,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: SPACING.md
    },
    itemLabel: { flex: 1, fontSize: 15, fontWeight: '600' },
    versionInfo: { textAlign: 'center', fontSize: 10, fontWeight: '700', marginTop: SPACING.lg },

    // Toggles
    toggleTrack: {
        width: 48,
        height: 26,
        borderRadius: 13,
        padding: 2,
    },
    toggleThumb: {
        width: 22,
        height: 22,
        borderRadius: 11,
        backgroundColor: '#FFF',
        ...SHADOWS.sm,
    },

    // Signature
    signaturePreview: {
        width: '100%',
        height: 120,
        borderRadius: RADIUS.md,
        borderWidth: 1,
        marginBottom: SPACING.md,
        justifyContent: 'center',
        alignItems: 'center',
        overflow: 'hidden',
        position: 'relative'
    },
    signatureImage: {
        width: '90%',
        height: '90%',
    },
    clearSignatureBtn: {
        position: 'absolute',
        top: 5,
        right: 5,
        width: 30,
        height: 30,
        borderRadius: 15,
        backgroundColor: 'rgba(0,0,0,0.05)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    drawSignatureBtn: {
        width: '100%',
        height: 100,
        borderRadius: RADIUS.md,
        borderWidth: 2,
        borderStyle: 'dashed',
        marginBottom: SPACING.md,
        justifyContent: 'center',
        alignItems: 'center',
        gap: 8,
    },
    drawSignatureText: {
        fontWeight: '700',
        fontSize: 16,
    },
    modalHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: SPACING.md,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(0,0,0,0.08)',
    },
    modalFooter: {
        flexDirection: 'row',
        justifyContent: 'center',
        padding: SPACING.md,
        gap: 20,
    },
    modalBtn: {
        paddingVertical: 10,
        paddingHorizontal: 30,
        borderRadius: RADIUS.full,
        backgroundColor: 'rgba(0,0,0,0.05)',
    }
});
