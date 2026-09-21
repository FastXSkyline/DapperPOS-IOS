import React from 'react';
import {
    View, Text, StyleSheet, TouchableOpacity, TextInput, ViewStyle,
    TextStyle, StyleProp, Platform, Pressable,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../context/ThemeContext';
import { SPACING, RADIUS, SHADOWS, AMBIENT } from '../../constants/theme';

type C = ReturnType<typeof useTheme>['colors'];

/* ------------------------------------------------------------------ Screen
   Ambient field behind every page — ONE soft vertical wash (indigo breath at
   the top settling dark at the base), matching the reference's quiet canvas.
   Single layer: the previous three stacked gradients read as banding. */
export function Screen({ children, style, edges = true }: {
    children: React.ReactNode; style?: StyleProp<ViewStyle>; edges?: boolean;
}) {
    const { theme } = useTheme();
    const field = AMBIENT[theme];
    return (
        <View style={[styles.screenRoot, style]}>
            <LinearGradient colors={field as any} style={StyleSheet.absoluteFill as any} />
            {children}
        </View>
    );
}

/* -------------------------------------------------------------- GlassCard
   The app's card: ONE gradient surface — a light catch from the chosen corner
   (accent-tinted) falling diagonally into the base, hairline border, quiet
   shadow. `sheen` picks where the light comes from; alternate it between
   neighbouring cards so the page reads as one lit scene. */
export function GlassCard({ children, style, pad = 'md', glow = false, radius = 20, sheen = 'top' }: {
    children: React.ReactNode; style?: StyleProp<ViewStyle>;
    pad?: 'none' | 'tight' | 'md'; glow?: boolean; radius?: number;
    sheen?: 'top' | 'bottom' | 'topLeft' | 'bottomRight';
}) {
    const { theme, colors } = useTheme();
    const dark = theme === 'dark';
    const accent = colors.accent;
    const padding = pad === 'none' ? 0 : pad === 'tight' ? 14 : 18;

    const gradients: Record<string, { colors: string[]; start: { x: number; y: number }; end: { x: number; y: number } }> = {
        top: dark
            ? { colors: [accent + '26', 'rgba(26,27,38,0.94)', 'rgba(17,18,28,0.96)'], start: { x: 0.5, y: 0 }, end: { x: 0.5, y: 1 } }
            : { colors: [accent + '30', 'rgba(255,255,255,0.97)', 'rgba(241,242,250,0.96)'], start: { x: 0.5, y: 0 }, end: { x: 0.5, y: 1 } },
        bottom: dark
            ? { colors: ['rgba(17,18,28,0.96)', 'rgba(26,27,38,0.94)', accent + '26'], start: { x: 0.5, y: 0 }, end: { x: 0.5, y: 1 } }
            : { colors: ['rgba(241,242,250,0.96)', 'rgba(255,255,255,0.97)', accent + '30'], start: { x: 0.5, y: 0 }, end: { x: 0.5, y: 1 } },
        topLeft: dark
            ? { colors: [accent + '2E', 'rgba(26,27,38,0.94)', 'rgba(17,18,28,0.96)'], start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }
            : { colors: [accent + '34', 'rgba(255,255,255,0.97)', 'rgba(240,241,250,0.96)'], start: { x: 0, y: 0 }, end: { x: 1, y: 1 } },
        bottomRight: dark
            ? { colors: ['rgba(17,18,28,0.96)', 'rgba(26,27,38,0.94)', accent + '2E'], start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }
            : { colors: ['rgba(240,241,250,0.96)', 'rgba(255,255,255,0.97)', accent + '34'], start: { x: 0, y: 0 }, end: { x: 1, y: 1 } },
    };
    const g = gradients[sheen];

    return (
        <View style={[
            { borderRadius: radius, borderWidth: 1, overflow: 'hidden',
              borderColor: dark ? 'rgba(255,255,255,0.07)' : 'rgba(17,17,17,0.05)' },
            glow ? SHADOWS.md : SHADOWS.sm,
            style,
        ]}>
            <LinearGradient colors={g.colors as any} start={g.start as any} end={g.end as any}
                style={[StyleSheet.absoluteFill, { borderRadius: radius }]} />
            <View style={{ padding, borderRadius: radius }}>
                {children}
            </View>
        </View>
    );
}

/* ------------------------------------------------------------ GradientPill
   The CTA pill: the accent gradient diagonal (light top-left → deep
   bottom-right) with a specular sheen, used for the primary action anywhere
   in the app. */
export function GradientPill({ label, onPress, icon, disabled, style, tone = 'accent' }: {
    label: string; onPress: () => void; icon?: keyof typeof Ionicons.glyphMap;
    disabled?: boolean; style?: StyleProp<ViewStyle>;
    tone?: 'accent' | 'quiet';
}) {
    const { colors, theme } = useTheme();
    if (tone === 'quiet') {
        return (
            <TouchableOpacity activeOpacity={0.8} onPress={onPress} disabled={disabled}
                style={[styles.qPill, { opacity: disabled ? 0.5 : 1 },
                    { backgroundColor: theme === 'dark' ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.94)',
                      borderColor: theme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(17,17,17,0.05)' },
                    style]}>
                {!!icon && <Ionicons name={icon} size={16} color={colors.text} />}
                <Text style={[styles.qPillText, { color: colors.text }]}>{label}</Text>
            </TouchableOpacity>
        );
    }
    return (
        <TouchableOpacity activeOpacity={0.85} onPress={onPress} disabled={disabled}
            style={[{ borderRadius: 999, overflow: 'hidden', opacity: disabled ? 0.5 : 1 }, SHADOWS.accent, style]}>
            <LinearGradient
                colors={[colors.accentGradFrom, colors.accentGradTo]}
                start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                style={styles.qPillGrad}
            >
                <LinearGradient
                    colors={['rgba(255,255,255,0.30)', 'rgba(255,255,255,0)']}
                    style={[StyleSheet.absoluteFill, { borderRadius: 999 }]}
                />
                {!!icon && <Ionicons name={icon} size={16} color="#fff" />}
                <Text style={styles.qPillTextAccent}>{label}</Text>
            </LinearGradient>
        </TouchableOpacity>
    );
}

/* ------------------------------------------------------------- PageTitle
   The .el-page-title / .el-page-sub pair. */
export function PageTitle({ title, subtitle, right }: {
    title: string; subtitle?: string; right?: React.ReactNode;
}) {
    const { colors } = useTheme();
    return (
        <View style={styles.pageHead}>
            <View style={{ flex: 1 }}>
                <Text style={[styles.pageTitle, { color: colors.text }]}>{title}</Text>
                {!!subtitle && <Text style={[styles.pageSub, { color: colors.textMuted }]}>{subtitle}</Text>}
            </View>
            {right}
        </View>
    );
}

/* ---------------------------------------------------------- SectionHeader
   Card head: 15/700 title with an optional trailing action. */
export function SectionHeader({ title, action, icon }: {
    title: string; action?: React.ReactNode; icon?: keyof typeof Ionicons.glyphMap;
}) {
    const { colors } = useTheme();
    return (
        <View style={styles.secHead}>
            {!!icon && <Ionicons name={icon} size={15} color={colors.accent} style={{ marginRight: 7 }} />}
            <Text style={[styles.secTitle, { color: colors.text }]}>{title}</Text>
            <View style={{ marginLeft: 'auto' }}>{action}</View>
        </View>
    );
}

/* --------------------------------------------------------------- StatTile
   .el-stat: muted label, huge tabular value, and a delta chip whose colour is
   the SIGN chosen by the caller, never guessed from the metric. */
export function StatTile({ label, value, icon, delta, deltaDir = 'flat', note, accent, sheen = 'top' }: {
    label: string; value: string; icon?: keyof typeof Ionicons.glyphMap;
    delta?: string; deltaDir?: 'up' | 'down' | 'flat'; note?: string; accent?: string;
    sheen?: 'top' | 'bottom' | 'topLeft' | 'bottomRight';
}) {
    const { colors } = useTheme();
    const tint = accent || colors.accent;
    const deltaColor = deltaDir === 'up' ? colors.success : deltaDir === 'down' ? colors.error : colors.textTertiary;
    return (
        <GlassCard pad="md" style={{ flex: 1 }} sheen={sheen}>
            <View style={styles.statTop}>
                {!!icon && (
                    <View style={[styles.statIcon, { backgroundColor: tint + '1A' }]}>
                        <Ionicons name={icon} size={16} color={tint} />
                    </View>
                )}
            </View>
            <Text style={[styles.statLabel, { color: colors.textMuted }]} numberOfLines={1}>{label}</Text>
            <Text style={[styles.statValue, { color: colors.text }]} numberOfLines={1}>{value}</Text>
            {(delta || note) && (
                <View style={styles.statFoot}>
                    {!!delta && <Text style={[styles.statDelta, { color: deltaColor }]}>{delta}</Text>}
                    {!!note && <Text style={[styles.statNote, { color: colors.textTertiary }]} numberOfLines={1}>{note}</Text>}
                </View>
            )}
        </GlassCard>
    );
}

/* ------------------------------------------------------------------- Chip
   .el-chip--ok/warn/bad/accent/neutral. */
export function Chip({ label, tone = 'neutral', icon }: {
    label: string; tone?: 'ok' | 'warn' | 'bad' | 'accent' | 'neutral';
    icon?: keyof typeof Ionicons.glyphMap;
}) {
    const { colors } = useTheme();
    const map = {
        ok: { bg: colors.success + '1A', fg: colors.success },
        warn: { bg: colors.warning + '1F', fg: colors.warning },
        bad: { bg: colors.error + '18', fg: colors.error },
        accent: { bg: colors.accentSoft, fg: colors.accent },
        neutral: { bg: colors.backgroundDeep, fg: colors.textMuted },
    }[tone];
    return (
        <View style={[styles.chip, { backgroundColor: map.bg }]}>
            {!!icon && <Ionicons name={icon} size={11} color={map.fg} />}
            <Text style={[styles.chipText, { color: map.fg }]}>{label}</Text>
        </View>
    );
}

/* -------------------------------------------------------- SegmentedControl
   .el-segmented: a sunken track with a lifted white active thumb. */
export function SegmentedControl<T extends string>({ options, value, onChange }: {
    options: { value: T; label: string }[]; value: T; onChange: (v: T) => void;
}) {
    const { colors } = useTheme();
    return (
        <View style={[styles.segTrack, { backgroundColor: colors.backgroundDeep }]}>
            {options.map(o => {
                const active = o.value === value;
                return (
                    <Pressable key={o.value} onPress={() => onChange(o.value)}
                        style={[styles.segItem, active && { backgroundColor: colors.surface, ...SHADOWS.sm }]}>
                        <Text style={[styles.segText, { color: active ? colors.text : colors.textMuted },
                        active && { fontWeight: '700' }]}>{o.label}</Text>
                    </Pressable>
                );
            })}
        </View>
    );
}

/* ---------------------------------------------------------------- Buttons */
export function PrimaryButton({ label, onPress, icon, disabled, style }: {
    label: string; onPress: () => void; icon?: keyof typeof Ionicons.glyphMap;
    disabled?: boolean; style?: StyleProp<ViewStyle>;
}) {
    const { colors } = useTheme();
    return (
        <TouchableOpacity activeOpacity={0.85} onPress={onPress} disabled={disabled}
            style={[{ opacity: disabled ? 0.5 : 1, borderRadius: 999, overflow: 'hidden' }, SHADOWS.accent, style]}>
            <LinearGradient colors={[colors.accentGradFrom, colors.accentGradTo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                style={styles.primaryBtn}>
                {/* Specular sheen — light from the top edge, as on the Home CTA. */}
                <LinearGradient
                    colors={['rgba(255,255,255,0.28)', 'rgba(255,255,255,0)']}
                    style={[StyleSheet.absoluteFill, { borderRadius: 999 }]}
                />
                {!!icon && <Ionicons name={icon} size={17} color="#fff" />}
                <Text style={styles.primaryBtnText}>{label}</Text>
            </LinearGradient>
        </TouchableOpacity>
    );
}

export function GhostButton({ label, onPress, icon, tone, style }: {
    label: string; onPress: () => void; icon?: keyof typeof Ionicons.glyphMap;
    tone?: 'default' | 'danger'; style?: StyleProp<ViewStyle>;
}) {
    const { colors } = useTheme();
    const fg = tone === 'danger' ? colors.error : colors.text;
    const bd = tone === 'danger' ? colors.error + '55' : colors.border;
    return (
        <TouchableOpacity activeOpacity={0.7} onPress={onPress}
            style={[styles.ghostBtn, { borderColor: bd, backgroundColor: colors.surface }, style]}>
            {!!icon && <Ionicons name={icon} size={16} color={fg} />}
            <Text style={[styles.ghostBtnText, { color: fg }]}>{label}</Text>
        </TouchableOpacity>
    );
}

export function IconButton({ icon, onPress, tone = 'default', size = 40, active }: {
    icon: keyof typeof Ionicons.glyphMap; onPress: () => void;
    tone?: 'default' | 'accent'; size?: number; active?: boolean;
}) {
    const { colors } = useTheme();
    const accent = tone === 'accent' || active;
    return (
        <TouchableOpacity activeOpacity={0.7} onPress={onPress} style={[
            styles.iconBtn, { width: size, height: size, borderRadius: size / 2.6 },
            accent
                ? { backgroundColor: colors.accentSoft, borderColor: colors.accentRing }
                : { backgroundColor: colors.surface, borderColor: colors.border },
        ]}>
            <Ionicons name={icon} size={size * 0.5} color={accent ? colors.accent : colors.textMuted} />
        </TouchableOpacity>
    );
}

/* ------------------------------------------------------------- SearchField
   .el-search: leading magnifier, hairline border, accent focus ring. */
export function SearchField({ value, onChangeText, placeholder, onSubmit, right }: {
    value: string; onChangeText: (t: string) => void; placeholder?: string;
    onSubmit?: () => void; right?: React.ReactNode;
}) {
    const { colors } = useTheme();
    return (
        <View style={[styles.search, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Ionicons name="search" size={17} color={colors.textTertiary} />
            <TextInput
                style={[styles.searchInput, { color: colors.text }]}
                value={value} onChangeText={onChangeText} placeholder={placeholder}
                placeholderTextColor={colors.textTertiary} returnKeyType="search"
                onSubmitEditing={onSubmit}
            />
            {right}
            {value.length > 0 && !right && (
                <TouchableOpacity onPress={() => onChangeText('')}>
                    <Ionicons name="close-circle" size={17} color={colors.textTertiary} />
                </TouchableOpacity>
            )}
        </View>
    );
}

/* ------------------------------------------------------------ QuickAction
   Home-hub shortcut, reference style: ONE flat white card, a soft tinted circle
   holding the glyph, label under it. No nested borders — the old tinted plate
   over a card-with-border over another border is what looked buggy. */
export function QuickAction({ icon, label, onPress, tint, badge }: {
    icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void;
    tint?: string; badge?: string | number;
}) {
    const { colors, theme } = useTheme();
    const c = tint || colors.accent;
    return (
        <TouchableOpacity activeOpacity={0.8} onPress={onPress} style={{ flex: 1 }}>
            <View style={[
                styles.qaCard,
                theme === 'dark'
                    ? { backgroundColor: 'rgba(26,27,35,0.92)', borderColor: 'rgba(255,255,255,0.07)' }
                    : { backgroundColor: 'rgba(255,255,255,0.94)', borderColor: 'rgba(17,17,17,0.05)' },
            ]}>
                <View style={[styles.qaCircle, { backgroundColor: c + (theme === 'dark' ? '26' : '14') }]}>
                    <Ionicons name={icon} size={21} color={c} />
                    {badge !== undefined && (
                        <View style={[styles.qaBadge, { backgroundColor: colors.error }]}>
                            <Text style={styles.qaBadgeText}>{badge}</Text>
                        </View>
                    )}
                </View>
                <Text style={[styles.qaLabel, { color: colors.text }]} numberOfLines={1}>{label}</Text>
            </View>
        </TouchableOpacity>
    );
}

/* ------------------------------------------------------------------ Thumb
   .pthumb: a tinted plate with the article's initials over a faint glyph. */
const THUMB_TINTS = ['#5B57E8', '#C2410C', '#0F766E', '#A16207', '#0369A1', '#4D7C0F', '#6D28D9', '#BE185D'];
export function Thumb({ seed = 0, label, size = 44, icon = 'shirt-outline' }: {
    seed?: number; label?: string; size?: number; icon?: keyof typeof Ionicons.glyphMap;
}) {
    const { theme } = useTheme();
    const ink = THUMB_TINTS[Math.abs(seed) % THUMB_TINTS.length];
    const bg = theme === 'dark' ? ink + '26' : ink + '14';
    const initials = (label || '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
    return (
        <View style={[styles.thumb, { width: size, height: size, borderRadius: size * 0.26, backgroundColor: bg }]}>
            <Ionicons name={icon} size={size * 0.56} color={ink} style={{ opacity: 0.3, position: 'absolute' }} />
            {!!initials && <Text style={[styles.thumbInitials, { color: ink, fontSize: size * 0.3 }]}>{initials}</Text>}
        </View>
    );
}

/* -------------------------------------------------------------------- Bar
   .el-bar-track / fill — a slim progress meter. */
export function Bar({ pct, color }: { pct: number; color?: string }) {
    const { colors } = useTheme();
    const w = Math.max(0, Math.min(100, pct));
    return (
        <View style={[styles.barTrack, { backgroundColor: colors.backgroundDeep }]}>
            <View style={[styles.barFill, { width: `${w}%`, backgroundColor: color || colors.accent }]} />
        </View>
    );
}

/* -------------------------------------------------------------- LegendRow */
export function LegendRow({ color, label, value }: { color: string; label: string; value: string }) {
    const { colors } = useTheme();
    return (
        <View style={styles.legendRow}>
            <View style={[styles.legendDot, { backgroundColor: color }]} />
            <Text style={[styles.legendLabel, { color: colors.textMuted }]} numberOfLines={1}>{label}</Text>
            <Text style={[styles.legendValue, { color: colors.text }]}>{value}</Text>
        </View>
    );
}

export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
    const { colors } = useTheme();
    return <View style={[styles.divider, { backgroundColor: colors.separator }, style]} />;
}

/* ------------------------------------------------------------- EmptyState */
export function EmptyState({ icon = 'file-tray-outline', title, hint }: {
    icon?: keyof typeof Ionicons.glyphMap; title: string; hint?: string;
}) {
    const { colors } = useTheme();
    return (
        <View style={styles.empty}>
            <View style={[styles.emptyIcon, { backgroundColor: colors.accentSoft }]}>
                <Ionicons name={icon} size={26} color={colors.accent} />
            </View>
            <Text style={[styles.emptyTitle, { color: colors.text }]}>{title}</Text>
            {!!hint && <Text style={[styles.emptyHint, { color: colors.textMuted }]}>{hint}</Text>}
        </View>
    );
}

/* ---------------------------------------------------------- StatTile sheen
   StatTiles delegate to GlassCard; alternate their light source by index so a
   row of tiles reads as one lit scene rather than identical clones. */
export function StatTileAlt({ label, value, icon, delta, deltaDir = 'flat', note, accent, index = 0 }: {
    label: string; value: string; icon?: keyof typeof Ionicons.glyphMap;
    delta?: string; deltaDir?: 'up' | 'down' | 'flat'; note?: string; accent?: string;
    index?: number;
}) {
    return (
        <StatTile label={label} value={value} icon={icon} delta={delta} deltaDir={deltaDir}
            note={note} accent={accent} sheen={index % 2 === 0 ? 'topLeft' : 'bottomRight'} />
    );
}

const styles = StyleSheet.create({
    screenRoot: { flex: 1 },
    sheen: { position: 'absolute', top: 0, left: 0, right: 0, height: 40 },

    pageHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    pageTitle: { fontSize: 26, fontWeight: '800', letterSpacing: -0.7, lineHeight: 30 },
    pageSub: { fontSize: 13, fontWeight: '500', marginTop: 3 },

    secHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, minHeight: 24 },
    secTitle: { fontSize: 15, fontWeight: '700', letterSpacing: -0.3 },

    statTop: { flexDirection: 'row', marginBottom: 8 },
    statIcon: { width: 30, height: 30, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
    statLabel: { fontSize: 12.5, fontWeight: '600' },
    statValue: { fontSize: 25, fontWeight: '800', letterSpacing: -0.8, marginTop: 3, fontVariant: ['tabular-nums'] },
    statFoot: { flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 5 },
    statDelta: { fontSize: 12, fontWeight: '800', fontVariant: ['tabular-nums'] },
    statNote: { fontSize: 11.5, fontWeight: '500', flexShrink: 1 },

    chip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 9, paddingVertical: 4, borderRadius: RADIUS.full },
    chipText: { fontSize: 11.5, fontWeight: '700' },

    segTrack: { flexDirection: 'row', padding: 3, borderRadius: 11, gap: 2 },
    segItem: { flex: 1, paddingVertical: 7, borderRadius: 9, alignItems: 'center' },
    segText: { fontSize: 13, fontWeight: '600' },

    primaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 50, paddingHorizontal: 20 },
    primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '700', letterSpacing: -0.2 },

    qPill: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
        borderRadius: 999, borderWidth: 1, paddingVertical: 12, paddingHorizontal: 22,
    },
    qPillGrad: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
        borderRadius: 999, paddingVertical: 12, paddingHorizontal: 22,
    },
    qPillText: { fontSize: 14.5, fontWeight: '700' },
    qPillTextAccent: { color: '#fff', fontSize: 14.5, fontWeight: '800' },
    ghostBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, height: 50, paddingHorizontal: 18, borderRadius: 13, borderWidth: 1 },
    ghostBtnText: { fontSize: 15, fontWeight: '700' },
    iconBtn: { alignItems: 'center', justifyContent: 'center', borderWidth: 1 },

    search: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 44, borderRadius: 12, paddingHorizontal: 12, borderWidth: 1 },
    searchInput: { flex: 1, fontSize: 15, fontWeight: '500', paddingVertical: 0 },

    qaCard: {
        borderRadius: 20,
        borderWidth: 1,
        alignItems: 'center',
        paddingVertical: 16,
        paddingHorizontal: 8,
        ...SHADOWS.sm,
    },
    qaCircle: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
    qaBadge: { position: 'absolute', top: -2, right: -2, minWidth: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
    qaBadgeText: { color: '#fff', fontSize: 10, fontWeight: '800' },
    qaLabel: { fontSize: 12.5, fontWeight: '600', textAlign: 'center' },

    thumb: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
    thumbInitials: { fontWeight: '800', letterSpacing: 0.2 },

    barTrack: { height: 6, borderRadius: 3, overflow: 'hidden' },
    barFill: { height: '100%', borderRadius: 3 },

    legendRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    legendDot: { width: 8, height: 8, borderRadius: 4 },
    legendLabel: { fontSize: 12.5, fontWeight: '500', flex: 1 },
    legendValue: { fontSize: 12.5, fontWeight: '800', fontVariant: ['tabular-nums'] },

    divider: { height: 1 },

    empty: { alignItems: 'center', justifyContent: 'center', paddingVertical: 48, gap: 8 },
    emptyIcon: { width: 56, height: 56, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
    emptyTitle: { fontSize: 15, fontWeight: '700', marginTop: 4 },
    emptyHint: { fontSize: 13, textAlign: 'center', paddingHorizontal: 24 },
});
