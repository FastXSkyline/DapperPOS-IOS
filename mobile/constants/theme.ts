// Design tokens — mirrors desktop src/styles/tokens.css ("Elegance" retail system):
// indigo accent on a cool light canvas, white cards, soft elevation, glass materials.
// The key names below are load-bearing: ~40 components import them directly, so
// values change but names must not.

export const LIGHT_COLORS = {
    // Brand — indigo, matching desktop --accent
    primary: '#5B57E8',
    primaryLight: '#7B78F0',
    accent: '#5B57E8',
    accentDark: '#3F3ACB',
    accentSoft: 'rgba(91, 87, 232, 0.09)',
    accentRing: 'rgba(91, 87, 232, 0.30)',
    accentGradFrom: '#6D69EE',
    accentGradTo: '#4B46DE',

    // Status — kept far from indigo on the wheel so a delta never reads as accent
    success: '#16A34A',
    warning: '#D97706',
    error: '#DC2626',
    info: '#0EA5E9',

    // Neutral / canvas
    white: '#FFFFFF',
    background: '#F5F6FA',
    backgroundDeep: '#EDEFF6',
    surface: '#FFFFFF',
    surfaceElevated: '#FAFBFD',
    surfaceHover: '#F2F4F9',
    text: '#14161F',
    textMuted: '#6B7180',
    textTertiary: '#9AA0AE',
    border: '#E3E6EF',
    separator: '#EBEDF3',

    // Transparent / glass
    glass: 'rgba(255, 255, 255, 0.90)',
    overlay: 'rgba(20, 22, 31, 0.45)',

    // Glow — indigo bloom used on active tabs and primary buttons
    glow: 'rgba(91, 87, 232, 0.22)',
    glowStrong: 'rgba(91, 87, 232, 0.28)',
};

export const DARK_COLORS = {
    // Brand — indigo lifted for contrast on near-black, matching desktop dark --accent
    primary: '#7B78F0',
    primaryLight: '#A5A2FA',
    accent: '#7B78F0',
    accentDark: '#6663E4',
    accentSoft: 'rgba(123, 120, 240, 0.16)',
    accentRing: 'rgba(123, 120, 240, 0.40)',
    accentGradFrom: '#8F8CF5',
    accentGradTo: '#6663E4',

    // Status
    success: '#4ADE80',
    warning: '#FBBF24',
    error: '#F87171',
    info: '#0EA5E9',

    // Neutral / canvas
    white: '#FFFFFF',
    background: '#0E0F16',
    backgroundDeep: '#08090E',
    surface: '#171922',
    surfaceElevated: '#1D202B',
    surfaceHover: '#252836',
    text: '#F2F3F7',
    textMuted: '#9BA1B2',
    textTertiary: '#6C7286',
    border: 'rgba(255, 255, 255, 0.10)',
    separator: 'rgba(255, 255, 255, 0.07)',

    // Transparent / glass
    glass: 'rgba(23, 25, 34, 0.92)',
    overlay: 'rgba(0, 0, 0, 0.66)',

    // Glow
    glow: 'rgba(123, 120, 240, 0.30)',
    glowStrong: 'rgba(123, 120, 240, 0.35)',
};

// Backward-compatibility alias. The app now defaults to the LIGHT theme (see
// ThemeContext); components that still import COLORS statically resolve to light
// so the shell reads as the desktop's cool indigo canvas rather than navy/gold.
export const COLORS = LIGHT_COLORS;

export const SPACING = {
    xs: 4,
    sm: 8,
    md: 16,
    lg: 24,
    xl: 32,
    xxl: 48
};

// Shadow colour is a deepened ink rather than pure black, matching desktop's
// rgba(20,22,31,…) elevation so lifted cards read the same on both platforms.
export const SHADOWS = {
    sm: {
        shadowColor: '#14161F',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.05,
        shadowRadius: 2,
        elevation: 1
    },
    md: {
        shadowColor: '#14161F',
        shadowOffset: { width: 0, height: 3 },
        shadowOpacity: 0.07,
        shadowRadius: 8,
        elevation: 3
    },
    lg: {
        shadowColor: '#14161F',
        shadowOffset: { width: 0, height: 10 },
        shadowOpacity: 0.10,
        shadowRadius: 22,
        elevation: 8
    },
    // Indigo bloom for the active tab / primary CTA — mirrors desktop --shadow-accent.
    accent: {
        shadowColor: '#5B57E8',
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.32,
        shadowRadius: 16,
        elevation: 8
    }
};

export const RADIUS = {
    xs: 6,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 20,
    full: 9999
};

// Glass materials — near-opaque white/dark tints so they render as the desktop's
// flat lifted cards, with blur intensity behind them.
export const GLASS = {
    light: {
        ultraThin: { tint: 'light' as const, intensity: 30, bg: 'rgba(255,255,255,0.82)' },
        regular: { tint: 'light' as const, intensity: 50, bg: 'rgba(255,255,255,0.90)' },
        chrome: { tint: 'light' as const, intensity: 70, bg: 'rgba(255,255,255,0.96)' },
    },
    dark: {
        ultraThin: { tint: 'dark' as const, intensity: 30, bg: 'rgba(29,32,43,0.72)' },
        regular: { tint: 'dark' as const, intensity: 50, bg: 'rgba(23,25,34,0.92)' },
        chrome: { tint: 'dark' as const, intensity: 70, bg: 'rgba(20,22,31,0.90)' },
    },
};

// Ambient field behind every page — ONE gradient, top→bottom: an airy indigo-
// tinted light at the top settling into the calm base (the reference canvas).
export const AMBIENT = {
    light: ['#F4F3FB', '#EFEFF7', '#E9EAF2'],
    dark: ['#101020', '#0C0C15', '#08080E'],
};
