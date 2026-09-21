import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SPACING } from '../constants/theme';
import { useTheme } from '../context/ThemeContext';
import { Screen, GlassCard, PageTitle, Chip, Thumb } from './ui/Kit';

export function DebtorsScreen() {
    const { colors } = useTheme();
    return (
        <Screen>
            <SafeAreaView edges={['top']}>
                <View style={styles.header}>
                    <PageTitle title="Debt Management" />
                </View>
            </SafeAreaView>

            <View style={styles.content}>
                <GlassCard glow>
                    <View style={styles.cardInner}>
                        <Thumb seed={7} icon="people" size={96} />
                        <Text style={[styles.title, { color: colors.text }]}>Customer Credits</Text>
                        <Text style={[styles.subtitle, { color: colors.textMuted }]}>
                            Monitor and manage customer debts directly from your mobile device.
                            This module is currently in synchronization with the desktop host.
                        </Text>
                        <Chip label="Deployment Pending" tone="accent" icon="time" />
                    </View>
                </GlassCard>
            </View>
        </Screen>
    );
}

const styles = StyleSheet.create({
    header: { paddingHorizontal: SPACING.md, paddingTop: SPACING.md, paddingBottom: SPACING.sm },
    content: { flex: 1, padding: SPACING.lg, justifyContent: 'center' },
    cardInner: { alignItems: 'center', justifyContent: 'center', paddingVertical: SPACING.xl, gap: SPACING.md },
    title: { fontSize: 22, fontWeight: '800', letterSpacing: -0.5 },
    subtitle: { textAlign: 'center', lineHeight: 22, fontSize: 14, paddingHorizontal: SPACING.sm }
});
