import React, { useState, useCallback } from 'react'
import {
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
    Dimensions,
    ActivityIndicator,
    Animated,
    Alert
} from 'react-native'
import * as LocalAuthentication from 'expo-local-authentication'
import { LinearGradient } from 'expo-linear-gradient'
import { Ionicons } from '@expo/vector-icons'
import { UserService, ConfigService } from '../services/database'
import { SPACING, RADIUS, SHADOWS } from '../constants/theme'
import { useTheme } from '../context/ThemeContext'

interface PinLoginProps {
    onLogin: (user: { id: number; name: string; role: string }) => void
}

const { width } = Dimensions.get('window')
const BUTTON_SIZE = Math.min((width - 80) / 3, 80)

export function PinLogin({ onLogin }: PinLoginProps) {
    const { colors, theme } = useTheme()
    const [pin, setPin] = useState('')
    const [error, setError] = useState('')
    const [isLoading, setIsLoading] = useState(false)
    const [shakeAnimation] = useState(new Animated.Value(0))
    const [isBiometricAvailable, setIsBiometricAvailable] = useState(false)
    // White-label: show the client's own business name (no product brand).
    const [brandName, setBrandName] = useState('Caisse')

    React.useEffect(() => {
        ConfigService.get('company_name').then(v => { if (v && v.trim()) setBrandName(v.trim()) }).catch(() => { })
    }, [])

    const shake = () => {
        Animated.sequence([
            Animated.timing(shakeAnimation, { toValue: 10, duration: 50, useNativeDriver: true }),
            Animated.timing(shakeAnimation, { toValue: -10, duration: 50, useNativeDriver: true }),
            Animated.timing(shakeAnimation, { toValue: 10, duration: 50, useNativeDriver: true }),
            Animated.timing(shakeAnimation, { toValue: 0, duration: 50, useNativeDriver: true }),
        ]).start()
    }

    React.useEffect(() => {
        checkBiometrics()
    }, [])

    const checkBiometrics = async () => {
        const hasHardware = await LocalAuthentication.hasHardwareAsync()
        const isEnrolled = await LocalAuthentication.isEnrolledAsync()
        setIsBiometricAvailable(hasHardware && isEnrolled)
    }

    const handleBiometricAuth = async () => {
        try {
            const result = await LocalAuthentication.authenticateAsync({
                promptMessage: 'Login with Biometrics',
                fallbackLabel: 'Use PIN',
                disableDeviceFallback: false,
            })

            if (result.success) {
                setIsLoading(true)
                const user = await UserService.getAll().then(users => (users as any[]).find(u => u.id === 1)) as any
                if (user) {
                    onLogin(user)
                }
                setIsLoading(false)
            }
        } catch (err) {
            console.error('Biometric error:', err)
        }
    }

    const handleDigitClick = useCallback((digit: string) => {
        if (pin.length < 4) {
            setPin(prev => prev + digit)
            setError('')
        }
    }, [pin])

    const handleBackspace = useCallback(() => {
        setPin(prev => prev.slice(0, -1))
        setError('')
    }, [])

    const handleClear = useCallback(() => {
        setPin('')
        setError('')
    }, [])

    const handleSubmit = useCallback(async () => {
        if (pin.length !== 4) {
            setError('Please enter a 4-digit PIN')
            return
        }

        setIsLoading(true)
        try {
            const user = await UserService.findByPin(pin) as { id: number; name: string; role: string } | null

            if (user) {
                onLogin(user)
            } else {
                setError('Invalid PIN')
                setPin('')
                shake()
            }
        } catch (err) {
            setError('Authentication failed')
            setPin('')
            shake()
        } finally {
            setIsLoading(false)
        }
    }, [pin, onLogin])

    const renderKey = (key: string) => {
        const isAction = key === 'C' || key === '⌫';
        return (
            <TouchableOpacity
                key={key}
                style={[
                    styles.key,
                    isAction && styles.actionKey,
                    { backgroundColor: theme === 'dark' ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.05)', borderColor: theme === 'dark' ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0,0,0,0.1)' }
                ]}
                onPress={() => {
                    if (key === 'C') handleClear()
                    else if (key === '⌫') handleBackspace()
                    else handleDigitClick(key)
                }}
                disabled={isLoading}
                activeOpacity={0.7}
            >
                {key === '⌫' ? (
                    <Ionicons name="backspace-outline" size={24} color={colors.white} />
                ) : (
                    <Text style={[
                        styles.keyText,
                        isAction && styles.actionKeyText,
                        { color: colors.white }
                    ]}>
                        {key}
                    </Text>
                )}
            </TouchableOpacity>
        )
    }

    return (
        <LinearGradient
            colors={[colors.primary, colors.primaryLight]}
            style={styles.container}
        >
            <View style={styles.content}>
                <View style={styles.header}>
                    <View style={[styles.logoContainer, { backgroundColor: colors.accent + '15', borderColor: colors.accent + '33' }]}>
                        <Ionicons name="lock-closed" size={32} color={colors.accent} />
                    </View>
                    <Text style={[styles.title, { color: colors.white }]}>{brandName}</Text>
                    <Text style={[styles.subtitle, { color: 'rgba(255, 255, 255, 0.6)' }]}>Espace caisse sécurisé</Text>
                </View>

                <Animated.View style={[styles.pinDisplay, { transform: [{ translateX: shakeAnimation }] }]}>
                    {[0, 1, 2, 3].map(i => (
                        <View
                            key={i}
                            style={[
                                styles.pinDot,
                                i < pin.length && { backgroundColor: colors.accent, borderColor: colors.accent, ...SHADOWS.md, shadowColor: colors.accent },
                                error ? { borderColor: colors.error, backgroundColor: colors.error } : null
                            ]}
                        />
                    ))}
                </Animated.View>

                {error ? <Text style={[styles.errorText, { color: colors.error }]}>{error}</Text> : null}

                <View style={styles.keypad}>
                    {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].map(renderKey)}
                </View>

                {isBiometricAvailable && (
                    <TouchableOpacity
                        style={[styles.biometricBtn, { backgroundColor: colors.accent + '15' }]}
                        onPress={handleBiometricAuth}
                    >
                        <Ionicons name="finger-print" size={32} color={colors.accent} />
                    </TouchableOpacity>
                )}

                <TouchableOpacity
                    style={[styles.loginBtn, (pin.length !== 4 || isLoading) && styles.loginBtnDisabled, { backgroundColor: colors.accent, ...(pin.length === 4 && !isLoading ? SHADOWS.accent : null) }]}
                    onPress={handleSubmit}
                    disabled={pin.length !== 4 || isLoading}
                >
                    {isLoading ? (
                        <ActivityIndicator color={colors.white} />
                    ) : (
                        <Text style={[styles.loginBtnText, { color: colors.white }]}>Unlock System</Text>
                    )}
                </TouchableOpacity>
            </View>
        </LinearGradient>
    )
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    content: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: SPACING.xl,
    },
    header: {
        alignItems: 'center',
        marginBottom: SPACING.xxl,
    },
    logoContainer: {
        width: 64,
        height: 64,
        borderRadius: RADIUS.lg,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: SPACING.md,
        borderWidth: 1,
    },
    title: {
        fontSize: 32,
        fontWeight: '800',
        letterSpacing: 1,
    },
    subtitle: {
        fontSize: 16,
        marginTop: SPACING.xs,
    },
    pinDisplay: {
        flexDirection: 'row',
        gap: SPACING.lg,
        marginBottom: SPACING.xl,
    },
    pinDot: {
        width: 14,
        height: 14,
        borderRadius: 7,
        borderWidth: 2,
        borderColor: 'rgba(255, 255, 255, 0.2)',
        backgroundColor: 'transparent',
    },
    errorText: {
        fontSize: 14,
        position: 'absolute',
        top: '42%',
    },
    keypad: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'center',
        gap: SPACING.md,
        width: 300,
        marginBottom: SPACING.lg,
    },
    key: {
        width: BUTTON_SIZE,
        height: BUTTON_SIZE,
        borderRadius: BUTTON_SIZE / 2,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
    },
    actionKey: {
        backgroundColor: 'transparent',
        borderColor: 'transparent',
    },
    keyText: {
        fontSize: 24,
        fontWeight: '600',
    },
    actionKeyText: {
        fontSize: 16,
        opacity: 0.6,
    },
    biometricBtn: {
        marginBottom: SPACING.xl,
        width: 64,
        height: 64,
        borderRadius: 32,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.1)',
    },
    loginBtn: {
        width: '100%',
        maxWidth: 300,
        height: 56,
        borderRadius: RADIUS.md,
        alignItems: 'center',
        justifyContent: 'center',
        ...SHADOWS.md,
    },
    loginBtnDisabled: {
        opacity: 0.3,
        shadowOpacity: 0,
    },
    loginBtnText: {
        fontSize: 18,
        fontWeight: '700',
    },
})
