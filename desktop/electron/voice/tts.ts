import OpenAI from 'openai'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { app } from 'electron'
import { normalizeDarija } from './norm'

let _openai: OpenAI | null = null;
function getOpenAI() {
    if (!_openai) {
        _openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY || ''
        })
    }
    return _openai
}

const TTS_CACHE_DIR = path.join(app.getPath('userData'), 'tts_cache')
if (!fs.existsSync(TTS_CACHE_DIR)) {
    fs.mkdirSync(TTS_CACHE_DIR, { recursive: true })
}

export async function generateSpeech(text: string): Promise<string | null> {
    try {
        // Normalization for better Darija pronunciation
        const phoneticText = normalizeDarija(text)

        // 1. Check Cache
        const hash = crypto.createHash('md5').update(phoneticText).digest('hex')
        const cachePath = path.join(TTS_CACHE_DIR, `${hash}.mp3`)

        if (fs.existsSync(cachePath)) {
            console.log('[TTS] Cache Hit for:', text.substring(0, 30))
            const cachedBuffer = fs.readFileSync(cachePath)
            return cachedBuffer.toString('base64')
        }

        console.log('[TTS] Cache Miss. Generating speech for:', phoneticText.substring(0, 50) + '...')
        const openai = getOpenAI()
        const mp3 = await openai.audio.speech.create({
            model: "tts-1-hd",
            voice: "shimmer",
            input: phoneticText,
        });

        const buffer = Buffer.from(await mp3.arrayBuffer());

        // 2. Save to Cache
        fs.writeFileSync(cachePath, buffer)

        return buffer.toString('base64');
    } catch (e) {
        console.error('[TTS] Error:', e);
        return null;
    }
}
