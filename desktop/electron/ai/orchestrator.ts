/**
 * Tool-calling orchestrator — the AI "brain". Generates OpenAI tools from the Capability
 * Registry, runs the function-calling loop (read → act → answer), aggregates UI events,
 * and composes a short natural reply in the user's language. Replaces the old fixed
 * intent-enum switch. See docs/AI_ASSISTANT.md.
 */
import OpenAI from 'openai'
import { getDatabase } from '../database'
import { CAPABILITIES, getCapability, type CapabilityContext, type CapabilityResult, type UiEvent } from './capabilities'

let _openai: OpenAI | null = null

// ---- Session memory (2.11): last few exchanges so follow-ups resolve ("w imprimih"). ----
const MAX_HISTORY = 6 // 3 user/assistant pairs
const history: { role: 'user' | 'assistant'; content: string }[] = []

function rememberExchange(userText: string, reply: string) {
    history.push({ role: 'user', content: userText }, { role: 'assistant', content: reply })
    while (history.length > MAX_HISTORY) history.shift()
}

// ---- Usage metering (2.12): accumulate AI token spend so the shop can see it. ----
function recordUsage(tokens: number) {
    if (!tokens) return
    try {
        const db = getDatabase()
        const row = db.prepare("SELECT value FROM config WHERE key = 'ai_usage'").get() as { value: string } | undefined
        const cur = row ? JSON.parse(row.value) : { tokens: 0, calls: 0 }
        cur.tokens += tokens
        cur.calls += 1
        db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('ai_usage', ?)").run(JSON.stringify(cur))
    } catch (e) {
        console.error('[Orchestrator] usage metering failed:', e)
    }
}
function getOpenAI() {
    if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' })
    return _openai
}

const SYSTEM_PROMPT = `You are the voice/chat control brain of a Point-of-Sale + business-management system used by Algerian shop owners.
The user speaks Algerian Darija mixed with Arabic and French. Understand them and act.

- Use the provided tools to READ data, take ACTIONS, and answer business questions. You may call several tools in sequence (e.g. create a product, then print).
- Resolve fuzzy product/supplier/customer names with the search/list tools when unsure.
- After acting, reply with ONE short sentence in the SAME language/dialect the user used (Darija written in Arabic script is perfectly fine). Never explain how the software works.
- Currency is the Algerian Dinar (DZD). Algerians often quote money in centimes or say "million/melyoun" (1 million centimes = 10 000 DA) or "alf/آلاف". Convert any spoken amount to DINARS, and ALWAYS state the amount you used explicitly in DA in your reply (e.g. "… b 1500 DA") so the owner can catch a wrong amount before it is saved.
- If a request maps to no tool at all, say briefly that you didn't understand and ask them to rephrase.

Keep replies concise, natural, and friendly — like a helpful shop assistant.`

export interface OrchestratorResult {
    reply: string
    events: UiEvent[]
    success: boolean
    error?: string
    toolsUsed: string[]
    /** Set when a destructive action awaits user confirmation before it runs. */
    needsConfirmation?: boolean
    pendingAction?: { name: string; args: any }
}

const CONFIRM_QUESTIONS: Record<string, (a: any) => string> = {
    products_delete: (a) => `واش بصح تحب تمحي "${a.product_name}" من الستوك؟`,
    debts_settle: (a) => `تأكّد: نخلّص الكريدي كامل تاع "${a.customer_name}"؟`,
}
function confirmQuestion(name: string, args: any): string {
    return CONFIRM_QUESTIONS[name]?.(args) || 'تأكّد العملية باش نكمّل؟'
}

/** Execute a previously-proposed destructive action after the user confirmed it. */
export async function executeConfirmed(
    pending: { name: string; args: any },
    ctx: CapabilityContext,
): Promise<OrchestratorResult> {
    const cap = getCapability(pending.name)
    if (!cap) return { reply: 'ما لقيتش العملية.', events: [], success: false, toolsUsed: [] }
    try {
        const result = await cap.handler(pending.args, ctx)
        return {
            reply: result.ok ? 'صايي، دار.' : (result.summary || 'ما نجّمتش نكمّل.'),
            events: result.events || [],
            success: result.ok,
            toolsUsed: [pending.name],
        }
    } catch (e: any) {
        return { reply: 'وقع مشكل فالتنفيذ.', events: [], success: false, error: e?.message, toolsUsed: [pending.name] }
    }
}

// ---- Offline fast-path -------------------------------------------------------------
// Highly templated commands (navigation, theme, language, print-last-doc) are resolved
// locally with a keyword grammar — they work WITHOUT internet and skip a cloud round-trip.
// Anything not matched falls through to the cloud LLM. Patterns are deliberately
// conservative so they never clobber data commands ("zid produit ...").
interface FastMatch { name: string; args: any }

function stripDiacritics(s: string): string {
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
}

function tryFastPath(text: string): FastMatch | null {
    const t = stripDiacritics((text || '').toLowerCase())
    const has = (...words: string[]) => words.some((w) => t.includes(w))

    if (has('mode nuit', 'mode sombre', 'dark mode', 'mode clair', 'badel loun', 'badel couleur', 'change theme', 'change couleur'))
        return { name: 'ui_toggle_theme', args: {} }

    if (has('3arbiya', '3arabiya', 'arabe', 'عربية', 'بالعربية')) return { name: 'ui_change_language', args: { language: 'ar' } }
    if (has('francais', 'french', 'بالفرنسية')) return { name: 'ui_change_language', args: { language: 'fr' } }
    if (has('anglais', 'english', 'بالانجليزية')) return { name: 'ui_change_language', args: { language: 'en' } }

    if (has('imprim', 'kherjli', 'tbaa', 'طبع')) {
        if (has('facture', 'invoice', 'فاتورة')) return { name: 'print_last_invoice', args: {} }
        if (has('bon de commande', 'purchase order', 'بون')) return { name: 'print_last_purchase_order', args: {} }
    }

    if ((has('low stock') || (has('naqes', 'khalsou', 'ناقص') && has('stock', 'produit'))))
        return { name: 'products_low_stock', args: {} }

    // Navigation requires an explicit show/open verb so we never hijack data commands.
    const showVerb = has('warini', 'wri ', 'montre', 'affiche', 'chouf', 'chof', 'ouvre', 'open', 'show', 'go to', 'rou7 l', 'اعرض', 'ورّيني', 'وريني')
    if (showVerb) {
        if (has('stock', 'produit', 'inventaire', 'products', 'inventory')) return { name: 'ui_navigate', args: { view: 'products' } }
        if (has('rapport', 'report', 'statistique', 'reports')) return { name: 'ui_navigate', args: { view: 'reports' } }
        if (has('dette', 'kredi', 'kraydin', 'debt', 'debtor', 'creance')) return { name: 'ui_navigate', args: { view: 'debtors' } }
        if (has('masrouf', 'depense', 'expense')) return { name: 'ui_navigate', args: { view: 'expenses' } }
        if (has('commande', 'order', 'achat')) return { name: 'ui_navigate', args: { view: 'orders' } }
        if (has('caisse', 'vente', 'pos')) return { name: 'ui_navigate', args: { view: 'pos' } }
        if (has('reglage', 'parametre', 'settings')) return { name: 'ui_navigate', args: { view: 'settings' } }
    }

    return null
}

const FAST_ACKS: Record<string, string> = {
    ui_navigate: 'تفضّل.',
    ui_toggle_theme: 'صايي، بدّلت اللون.',
    ui_change_language: 'صايي، بدّلت اللغة.',
    print_last_invoice: 'راني نطبع الفاتورة.',
    print_last_purchase_order: 'راني نطبع بون دو كوموند.',
    products_low_stock: 'تفضّل، هاهي لي ناقصة فالستوك.',
}

export function getUsage(): { tokens: number; calls: number } {
    try {
        const row = getDatabase().prepare("SELECT value FROM config WHERE key = 'ai_usage'").get() as { value: string } | undefined
        return row ? JSON.parse(row.value) : { tokens: 0, calls: 0 }
    } catch {
        return { tokens: 0, calls: 0 }
    }
}

function buildTools() {
    return CAPABILITIES.map((c) => ({
        type: 'function' as const,
        function: {
            name: c.name,
            description: c.description,
            parameters: { type: 'object', properties: c.params, required: c.required || [] },
        },
    }))
}

export async function runAssistant(userText: string, ctx: CapabilityContext): Promise<OrchestratorResult> {
    // 1) Offline-capable fast-path (no network) for highly templated commands.
    const fp = tryFastPath(userText)
    if (fp) {
        const cap = getCapability(fp.name)
        if (cap) {
            try {
                const result = await cap.handler(fp.args, ctx)
                return {
                    reply: result.ok ? (FAST_ACKS[fp.name] || 'صايي.') : (result.summary || 'ما لقيتش.'),
                    events: result.events || [],
                    success: result.ok,
                    toolsUsed: [fp.name],
                }
            } catch (e: any) {
                return { reply: 'وقع مشكل صغير.', events: [], success: false, error: e?.message, toolsUsed: [fp.name] }
            }
        }
    }

    // 2a) Data residency (Phase 6.9): when strict mode is on, never send data
    // across the border to the cloud LLM — only the offline fast-path is allowed.
    try {
        const { getDatabase } = require('../database') as typeof import('../database')
        const row = getDatabase().prepare("SELECT value FROM config WHERE key = 'data_residency_strict'").get() as { value: string } | undefined
        if (row?.value === '1') {
            return { reply: 'وضع إقامة البيانات مفعّل — المساعد السحابي معطّل. استعمل الأوامر المباشرة.', events: [], success: false, error: 'residency_strict', toolsUsed: [] }
        }
    } catch { /* config unavailable — fall through */ }

    // 2b) Cloud LLM for free-form requests.
    if (!process.env.OPENAI_API_KEY) {
        // Distinct from "not understood" so the field can be supported.
        return { reply: 'المساعد ماشي مكونفيݣي. لازم تزيد المفتاح فالإعدادات.', events: [], success: false, error: 'no_key', toolsUsed: [] }
    }

    const events: UiEvent[] = []
    const toolsUsed: string[] = []

    try {
        const openai = getOpenAI()
        const tools = buildTools()
        const messages: any[] = [
            { role: 'system', content: SYSTEM_PROMPT },
            ...history,
            { role: 'user', content: userText },
        ]

        for (let turn = 0; turn < 5; turn++) {
            const resp = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages,
                tools,
                tool_choice: 'auto',
                temperature: 0.2,
            })

            recordUsage(resp.usage?.total_tokens || 0)

            const msg = resp.choices[0]?.message
            if (!msg) break
            messages.push(msg)

            if (msg.tool_calls && msg.tool_calls.length) {
                for (const call of msg.tool_calls) {
                    if (call.type !== 'function') continue
                    const cap = getCapability(call.function.name)
                    if (!cap) {
                        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: false, summary: `Unknown capability ${call.function.name}.` }) })
                        continue
                    }
                    let args: any = {}
                    try { args = call.function.arguments ? JSON.parse(call.function.arguments) : {} } catch { args = {} }

                    // Confirmation gate: do NOT run destructive/financial actions yet — ask first.
                    if (cap.destructive) {
                        return {
                            reply: confirmQuestion(cap.name, args),
                            events,
                            success: true,
                            needsConfirmation: true,
                            pendingAction: { name: cap.name, args },
                            toolsUsed,
                        }
                    }

                    let result: CapabilityResult
                    try {
                        result = await cap.handler(args, ctx)
                    } catch (e: any) {
                        result = { ok: false, summary: `Action failed: ${e?.message || 'error'}` }
                    }
                    if (result.events) events.push(...result.events)
                    toolsUsed.push(cap.name)
                    messages.push({
                        role: 'tool',
                        tool_call_id: call.id,
                        content: JSON.stringify({ ok: result.ok, summary: result.summary, data: result.data ?? null }),
                    })
                }
                continue // observe tool results, then either call more tools or answer
            }

            // No tool calls => final natural-language answer
            {
                const reply = (msg.content || '').trim() || 'صايي.'
                rememberExchange(userText, reply)
                return { reply, events, success: true, toolsUsed }
            }
        }

        return { reply: 'صايي.', events, success: true, toolsUsed }
    } catch (e: any) {
        console.error('[Orchestrator] Error:', e)
        const status = e?.status ?? e?.code
        const reply = status === 401 || status === 403
            ? 'كاين مشكل فالمفتاح تاع المساعد.'
            : 'ماكاش الاتصال بالأنترنت، عاودلي من بعد.'
        return { reply, events, success: false, error: String(status ?? e?.message ?? 'error'), toolsUsed }
    }
}
