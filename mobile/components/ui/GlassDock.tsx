import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../context/ThemeContext';
import type { Tab } from '../../services/permissions';

export interface DockTabMeta {
    tab: Tab;
    icon: keyof typeof Ionicons.glyphMap;
    label: string;
}

const DOCK_H = 60;

/**
 * Floating dock — flat soft bar; the ACTIVE tab's icon GLOWS.
 *
 * Glow method (final): ONE disc — a radial-ish gradient built from three
 * concentric alpha rings of the same accent colour, blended by the GPU as a
 * single LinearGradient — sits behind the glyph. A gradient's alpha ramp is
 * continuous, so there is no edge and no box; and because it is ONE element,
 * there are no ghost copies of the icon. The glyph itself keeps only a tight
 * 6px shadow for edge crispness. Glow colour = the app theme accent.
 */
export function GlassDock({ tabs, activeTab, onSelect }: {
    tabs: DockTabMeta[];
    activeTab: Tab;
    onSelect: (tab: Tab) => void;
}) {
    const { theme, colors } = useTheme();
    const dark = theme === 'dark';
    const accent = colors.accent;

    return (
        <View style={styles.dockFloat} pointerEvents="box-none">
            <View
                style={[
                    styles.shell,
                    dark ? styles.shellDark : styles.shellLight,
                    Platform.OS === 'ios'
                        ? { shadowColor: '#000', shadowOpacity: dark ? 0.55 : 0.14, shadowOffset: { width: 0, height: 10 }, shadowRadius: 24 }
                        : { elevation: 12 },
                ]}
            >
                <ScrollView horizontal showsHorizontalScrollIndicator={false}
                    contentContainerStyle={[styles.scroll, compact(tabs.length) && styles.scrollCompact]}>
                    {tabs.map(m => {
                        const active = activeTab === m.tab;
                        return (
                            <TouchableOpacity
                                key={m.tab}
                                activeOpacity={0.7}
                                onPress={() => onSelect(m.tab)}
                                style={[styles.item, compact(tabs.length) && styles.itemCompact]}
                            >
                                <View style={styles.glowSlot}>
                                    <Ionicons
                                        name={active ? (m.icon as any) : (`${m.icon}-outline` as any)}
                                        size={22}
                                        color={active ? accent : (dark ? 'rgba(200,201,215,0.80)' : 'rgba(90,94,110,0.95)')}
                                        style={active ? ({ ...styles.iconCore, textShadowColor: accent } as any) : undefined}
                                    />
                                </View>
                                {!compact(tabs.length) && (
                                    <Text
                                        style={[
                                            styles.label,
                                            { color: active ? accent : colors.textMuted },
                                            active && styles.labelActive,
                                        ]}
                                        numberOfLines={1}
                                    >
                                        {m.label}
                                    </Text>
                                )}
                            </TouchableOpacity>
                        );
                    })}
                </ScrollView>
            </View>
        </View>
    );
}

/** Owner/manager see 10 tabs — collapse to icons-only before the bar crowds. */
function compact(n: number): boolean {
    return n > 6;
}

const styles = StyleSheet.create({
    dockFloat: {
        position: 'absolute',
        left: 20, right: 20,
        bottom: Platform.OS === 'ios' ? 28 : 24,
    },

    // One flat shell — quiet surface, hairline border, single shadow.
    shell: {
        borderRadius: 999,
        height: DOCK_H,
        borderWidth: 1,
    },
    shellLight: {
        backgroundColor: 'rgba(255,255,255,0.96)',
        borderColor: 'rgba(17,17,17,0.06)',
    },
    shellDark: {
        backgroundColor: 'rgba(24,25,32,0.94)',
        borderColor: 'rgba(255,255,255,0.08)',
    },

    scroll: {
        flexDirection: 'row',
        alignItems: 'center',
        height: DOCK_H,
        paddingHorizontal: 14,
    },
    scrollCompact: { paddingHorizontal: 8 },
    item: { alignItems: 'center', justifyContent: 'center', width: 62, height: DOCK_H },
    itemCompact: { width: 54 },

    glowSlot: {
        width: 30,
        height: 30,
        alignItems: 'center',
        justifyContent: 'center',
    },

    // THE glow: the accent halo on the glyph itself. 14px is the largest radius
    // that stays smooth on Android — beyond it the halo renders with a hard
    // square edge (a native textShadow artifact), which you saw earlier.
    iconCore: {
        textShadowOffset: { width: 0, height: 0 },
        textShadowRadius: 14,
    } as any,

    label: { fontSize: 9.5, fontWeight: '600', letterSpacing: 0.1, marginTop: 2 },
    labelActive: { fontWeight: '800' },
});
