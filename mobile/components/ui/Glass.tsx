import React from 'react'
import { View, StyleSheet, type ViewStyle } from 'react-native'
import { BlurView } from 'expo-blur'
import { GLASS, RADIUS, SHADOWS } from '../../constants/theme'
import { useTheme } from '../../context/ThemeContext'

type GlassVariant = 'ultraThin' | 'regular' | 'chrome'

interface GlassProps {
    variant?: GlassVariant
    /** Adds card padding + radius. */
    card?: boolean
    /** Applies the indigo accent bloom (desktop --shadow-accent) around the surface. */
    glow?: boolean
    radius?: number
    style?: ViewStyle | ViewStyle[]
    children?: React.ReactNode
}

/**
 * Liquid Glass material primitive — mirrors the desktop <Glass>.
 * Renders an expo-blur surface with a translucent tint + hairline border, falling
 * back to the tint colour where blur is unsupported. Follows the app ThemeContext
 * (not the OS scheme) so the whole app stays on the chosen indigo canvas.
 */
export function Glass({ variant = 'regular', card = false, glow = false, radius, style, children }: GlassProps) {
    const { theme, colors } = useTheme()
    const mat = GLASS[theme][variant]
    const r = radius ?? RADIUS.lg
    const border = theme === 'dark' ? 'rgba(255,255,255,0.10)' : colors.border
    return (
        <View style={[styles.wrap, glow && SHADOWS.accent, { borderRadius: r, borderColor: border }, style as ViewStyle]}>
            <BlurView intensity={mat.intensity} tint={theme === 'dark' ? 'dark' : 'light'} style={[StyleSheet.absoluteFill, { borderRadius: r }]} />
            <View style={[{ backgroundColor: mat.bg, borderRadius: r }, card && styles.card]}>
                {children}
            </View>
        </View>
    )
}

const styles = StyleSheet.create({
    wrap: { overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth },
    card: { padding: 16 },
})
