import { useState, useRef, useEffect } from 'react'
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    TextInput,
    FlatList,
    Modal,
    Animated,
    KeyboardAvoidingView,
    Platform,
    Keyboard
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { BlurView } from 'expo-blur'
import { Audio } from 'expo-av'
import { processVoiceCommand, processTextCommand, playAudio } from '../services/aiService'
import { COLORS, SPACING, RADIUS } from '../constants/theme'

interface Message {
    id: string
    role: 'user' | 'assistant'
    text: string
    timestamp: number
}

interface VoiceAssistantProps {
    onNavigate?: (tab: string) => void
}

export function VoiceAssistant({ onNavigate }: VoiceAssistantProps) {
    const [isOpen, setIsOpen] = useState(false)
    const [messages, setMessages] = useState<Message[]>([])
    const [inputText, setInputText] = useState('')
    const [status, setStatus] = useState<'idle' | 'recording' | 'thinking'>('idle')

    const recording = useRef<Audio.Recording | null>(null)
    const pulseAnim = useRef(new Animated.Value(1)).current
    const flatListRef = useRef<FlatList>(null)

    useEffect(() => {
        // Request audio permissions on mount
        Audio.requestPermissionsAsync()
        Audio.setAudioModeAsync({
            allowsRecordingIOS: true,
            playsInSilentModeIOS: true
        })
    }, [])

    useEffect(() => {
        // Pulse animation when recording
        if (status === 'recording') {
            Animated.loop(
                Animated.sequence([
                    Animated.timing(pulseAnim, { toValue: 1.2, duration: 500, useNativeDriver: true }),
                    Animated.timing(pulseAnim, { toValue: 1, duration: 500, useNativeDriver: true })
                ])
            ).start()
        } else {
            pulseAnim.setValue(1)
        }
    }, [status])

    const startRecording = async () => {
        try {
            setStatus('recording')
            const { recording: rec } = await Audio.Recording.createAsync(
                Audio.RecordingOptionsPresets.HIGH_QUALITY
            )
            recording.current = rec
        } catch (error) {
            console.error('[VoiceAssistant] Start recording error:', error)
            setStatus('idle')
        }
    }

    const stopRecording = async () => {
        if (!recording.current) return

        try {
            setStatus('thinking')
            await recording.current.stopAndUnloadAsync()
            const uri = recording.current.getURI()
            recording.current = null

            if (uri) {
                // Add user message placeholder
                const userMsg: Message = {
                    id: Date.now().toString(),
                    role: 'user',
                    text: '🎤 ...',
                    timestamp: Date.now()
                }
                setMessages(prev => [...prev, userMsg])

                // Process voice command
                const result = await processVoiceCommand(uri)

                // Update user message with transcript
                setMessages(prev => prev.map(m =>
                    m.id === userMsg.id ? { ...m, text: result.text || '(inaudible)' } : m
                ))

                // Add assistant response
                const assistantMsg: Message = {
                    id: (Date.now() + 1).toString(),
                    role: 'assistant',
                    text: result.response,
                    timestamp: Date.now()
                }
                setMessages(prev => [...prev, assistantMsg])

                // Handle navigation
                handleIntentNavigation(result.intent)
            }
        } catch (error) {
            console.error('[VoiceAssistant] Stop recording error:', error)
        } finally {
            setStatus('idle')
        }
    }

    const handleTextSubmit = async () => {
        if (!inputText.trim()) return

        const text = inputText.trim()
        setInputText('')
        Keyboard.dismiss()
        setStatus('thinking')

        const userMsg: Message = {
            id: Date.now().toString(),
            role: 'user',
            text,
            timestamp: Date.now()
        }
        setMessages(prev => [...prev, userMsg])

        try {
            const result = await processTextCommand(text)

            const assistantMsg: Message = {
                id: (Date.now() + 1).toString(),
                role: 'assistant',
                text: result.response,
                timestamp: Date.now()
            }
            setMessages(prev => [...prev, assistantMsg])

            handleIntentNavigation(result.intent)
        } catch (error) {
            console.error('[VoiceAssistant] Text command error:', error)
        } finally {
            setStatus('idle')
        }
    }

    const handleIntentNavigation = (intent: string) => {
        if (!onNavigate) return

        switch (intent) {
            case 'SHOW_PRODUCTS':
            case 'SHOW_LOW_STOCK':
                onNavigate('Inventory')
                break
            case 'SHOW_EXPENSES':
                onNavigate('Expenses')
                break
            case 'SHOW_ORDERS':
                onNavigate('Orders')
                break
            case 'SHOW_REPORT':
                onNavigate('Reports')
                break
            case 'SHOW_DEBTORS':
            case 'SEARCH_CUSTOMER':
                onNavigate('Debtors')
                break
            case 'SHOW_POS':
            case 'ADD_TO_CART':
            case 'CHECKOUT':
                onNavigate('POS')
                break
            case 'SHOW_SETTINGS':
                onNavigate('Settings')
                break
        }
    }

    const clearHistory = () => {
        setMessages([])
    }

    const renderMessage = ({ item }: { item: Message }) => (
        <View style={[
            styles.messageBubble,
            item.role === 'user' ? styles.userBubble : styles.assistantBubble
        ]}>
            <Text style={[
                styles.messageText,
                item.role === 'user' ? styles.userText : styles.assistantText
            ]}>
                {item.text}
            </Text>
        </View>
    )

    const getStatusIcon = () => {
        switch (status) {
            case 'recording': return 'mic'
            case 'thinking': return 'sync'
            default: return 'mic-outline'
        }
    }

    return (
        <>
            {/* Floating Action Button */}
            <TouchableOpacity
                style={styles.fab}
                onPress={() => setIsOpen(true)}
                activeOpacity={0.8}
            >
                <Ionicons name="chatbubble-ellipses" size={26} color={COLORS.primary} />
            </TouchableOpacity>

            {/* Chat Modal */}
            <Modal visible={isOpen} animationType="slide" transparent>
                <View style={styles.modalOverlay}>
                    <KeyboardAvoidingView
                        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                        style={styles.modalContainer}
                    >
                        <BlurView intensity={80} tint="dark" style={styles.chatContainer}>
                            {/* Header */}
                            <View style={styles.header}>
                                <View style={styles.headerLeft}>
                                    <Ionicons name="sparkles" size={20} color={COLORS.accent} />
                                    <Text style={styles.headerTitle}>AI Assistant</Text>
                                </View>
                                <View style={styles.headerActions}>
                                    <TouchableOpacity style={styles.headerBtn} onPress={clearHistory}>
                                        <Ionicons name="trash-outline" size={20} color={COLORS.textMuted} />
                                    </TouchableOpacity>
                                    <TouchableOpacity style={styles.headerBtn} onPress={() => setIsOpen(false)}>
                                        <Ionicons name="close" size={24} color={COLORS.text} />
                                    </TouchableOpacity>
                                </View>
                            </View>

                            {/* Messages */}
                            <FlatList
                                ref={flatListRef}
                                data={messages}
                                keyExtractor={(item) => item.id}
                                renderItem={renderMessage}
                                style={styles.messageList}
                                contentContainerStyle={{ paddingHorizontal: SPACING.md, paddingBottom: SPACING.md }}
                                onContentSizeChange={() => flatListRef.current?.scrollToEnd()}
                                ListEmptyComponent={
                                    <View style={styles.emptyState}>
                                        <Ionicons name="chatbubbles-outline" size={48} color={COLORS.textMuted} />
                                        <Text style={styles.emptyText}>Héder b Darija, Français ou Arabe</Text>
                                    </View>
                                }
                            />

                            {/* Input Area */}
                            <View style={styles.inputArea}>
                                <TextInput
                                    style={styles.textInput}
                                    placeholder="Kteb hna..."
                                    placeholderTextColor={COLORS.textMuted}
                                    value={inputText}
                                    onChangeText={setInputText}
                                    onSubmitEditing={handleTextSubmit}
                                    returnKeyType="send"
                                />

                                {inputText.trim() ? (
                                    <TouchableOpacity style={styles.sendBtn} onPress={handleTextSubmit}>
                                        <Ionicons name="send" size={20} color={COLORS.primary} />
                                    </TouchableOpacity>
                                ) : (
                                    <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
                                        <TouchableOpacity
                                            style={[
                                                styles.micBtn,
                                                status === 'recording' && styles.micBtnRecording
                                            ]}
                                            onPressIn={startRecording}
                                            onPressOut={stopRecording}
                                            disabled={status === 'thinking'}
                                        >
                                            <Ionicons
                                                name={getStatusIcon()}
                                                size={24}
                                                color={status === 'recording' ? COLORS.error : COLORS.primary}
                                            />
                                        </TouchableOpacity>
                                    </Animated.View>
                                )}
                            </View>
                        </BlurView>
                    </KeyboardAvoidingView>
                </View>
            </Modal>
        </>
    )
}

const styles = StyleSheet.create({
    fab: {
        position: 'absolute',
        right: SPACING.lg,
        bottom: 130,
        width: 56,
        height: 56,
        borderRadius: 28,
        backgroundColor: COLORS.accent,
        alignItems: 'center',
        justifyContent: 'center',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 8,
        elevation: 8
    },
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        justifyContent: 'flex-end'
    },
    modalContainer: {
        height: '90%',
        width: '100%',
    },
    chatContainer: {
        flex: 1,
        borderTopLeftRadius: RADIUS.xl,
        borderTopRightRadius: RADIUS.xl,
        overflow: 'hidden',
        backgroundColor: 'rgba(30, 41, 59, 0.98)'
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: SPACING.md,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(255, 255, 255, 0.1)'
    },
    headerLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.xs
    },
    headerTitle: {
        fontSize: 16,
        fontWeight: '700',
        color: COLORS.text
    },
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.sm
    },
    headerBtn: {
        padding: SPACING.xs
    },
    messageList: {
        flex: 1,
        minHeight: 200
    },
    messageBubble: {
        maxWidth: '80%',
        padding: SPACING.md,
        borderRadius: RADIUS.lg,
        marginTop: SPACING.sm
    },
    userBubble: {
        alignSelf: 'flex-end',
        backgroundColor: COLORS.accent
    },
    assistantBubble: {
        alignSelf: 'flex-start',
        backgroundColor: COLORS.surface
    },
    messageText: {
        fontSize: 15,
        lineHeight: 20
    },
    userText: {
        color: COLORS.primary
    },
    assistantText: {
        color: COLORS.text
    },
    emptyState: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: SPACING.xl * 2
    },
    emptyText: {
        fontSize: 14,
        color: COLORS.textMuted,
        marginTop: SPACING.md
    },
    inputArea: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: SPACING.md,
        gap: SPACING.sm,
        borderTopWidth: 1,
        borderTopColor: 'rgba(255, 255, 255, 0.1)'
    },
    textInput: {
        flex: 1,
        backgroundColor: COLORS.surface,
        borderRadius: RADIUS.md,
        padding: SPACING.md,
        fontSize: 16,
        color: COLORS.text
    },
    sendBtn: {
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: COLORS.accent,
        alignItems: 'center',
        justifyContent: 'center'
    },
    micBtn: {
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: COLORS.accent,
        alignItems: 'center',
        justifyContent: 'center'
    },
    micBtnRecording: {
        backgroundColor: 'rgba(239, 68, 68, 0.2)',
        borderWidth: 2,
        borderColor: COLORS.error
    }
})
