/**
 * Escape a value for safe interpolation into HTML text / attribute contexts.
 * Use for ANY user- or DB-supplied string rendered into a print template — the
 * LAN /print/raw/* endpoints accept attacker-supplied data, so unescaped fields
 * would allow markup/script injection into the print BrowserWindow.
 */
export function escapeHtml(value: unknown): string {
    if (value === null || value === undefined) return ''
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}
