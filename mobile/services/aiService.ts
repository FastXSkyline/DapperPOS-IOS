/**
 * Mobile AI service — thin client over the DESKTOP "brain".
 *
 * The OpenAI key NO LONGER lives in the mobile app (an EXPO_PUBLIC_* key is inlined into
 * the shipped bundle and is extractable). Instead the phone sends commands to the paired
 * desktop's authenticated /ai and /ai/voice endpoints, which hold the key server-side and
 * run the shared capability registry. See docs/AI_ASSISTANT.md §6.
 */
import * as FileSystem from 'expo-file-system/legacy'
import { Audio } from 'expo-av'
import { SyncService } from './SyncService'

export interface AssistantResult {
    text: string
    intent: string
    data: any
    response: string
    audioUri: string | null
    success: boolean
}

// Map the desktop's "view-change" target to the mobile navigation intent the UI understands.
const VIEW_TO_INTENT: Record<string, string> = {
    products: 'SHOW_PRODUCTS',
    reports: 'SHOW_REPORT',
    expenses: 'SHOW_EXPENSES',
    orders: 'SHOW_ORDERS',
    debtors: 'SHOW_DEBTORS',
    pos: 'SHOW_POS',
    settings: 'SHOW_SETTINGS',
}

function intentFromEvents(events: any[]): string {
    const nav = Array.isArray(events) ? events.find((e) => e?.channel === 'view-change') : null
    return (nav && VIEW_TO_INTENT[nav.payload]) || ''
}

const NOT_PAIRED: AssistantResult = {
    text: '', intent: '', data: {}, audioUri: null, success: false,
    response: 'ربط الجهاز مع الـ PC أولا من الإعدادات (URL + Token).',
}
const NO_CONNECTION: AssistantResult = {
    text: '', intent: '', data: {}, audioUri: null, success: false,
    response: 'ماكاش الاتصال بالـ PC، تأكد بلي راه يخدم ونفس الشبكة.',
}

async function callBrain(path: string, body: any): Promise<AssistantResult> {
    const url = await SyncService.getServerUrl()
    const token = await SyncService.getSyncToken()
    if (!url || !token) return NOT_PAIRED
    try {
        const res = await fetch(`${url}${path}`, {
            method: 'POST',
            headers: await SyncService.authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(body),
        })
        if (!res.ok) return NO_CONNECTION
        const data = await res.json()
        return {
            text: data.text || '',
            intent: intentFromEvents(data.events),
            data: {},
            response: data.reply || '',
            audioUri: null,
            success: !!data.success,
        }
    } catch (e) {
        console.error('[AI Service] Brain call failed:', e)
        return NO_CONNECTION
    }
}

export async function processTextCommand(text: string): Promise<AssistantResult> {
    return callBrain('/ai', { text })
}

export async function processVoiceCommand(audioUri: string): Promise<AssistantResult> {
    try {
        const info = await FileSystem.getInfoAsync(audioUri)
        if (!info.exists) return { ...NO_CONNECTION, response: 'سماحلي، ما سمعتش مليح.' }
        const audioBase64 = await FileSystem.readAsStringAsync(audioUri, { encoding: 'base64' })
        // Forward the real extension so Whisper detects the container (Expo records m4a/caf).
        const ext = (audioUri.split('.').pop() || 'm4a').toLowerCase().split('?')[0]
        return callBrain('/ai/voice', { audioBase64, filename: `voice.${ext}` })
    } catch (e) {
        console.error('[AI Service] Voice command failed:', e)
        return NO_CONNECTION
    }
}

/** Play an audio file (kept for any local playback needs; desktop replies are text today). */
export async function playAudio(uri: string): Promise<void> {
    try {
        const { sound } = await Audio.Sound.createAsync({ uri })
        await sound.playAsync()
        sound.setOnPlaybackStatusUpdate((status) => {
            if (status.isLoaded && status.didJustFinish) sound.unloadAsync()
        })
    } catch (error) {
        console.error('[AI Service] Audio playback error:', error)
    }
}
