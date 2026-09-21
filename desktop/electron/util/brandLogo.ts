/**
 * The DAPPER wordmark, for printed documents.
 *
 * Every receipt, facture, bon and purchase order carries it, so it lives in ONE
 * place rather than being re-pasted per template. Returned as a data: URI so the
 * print window never has to resolve a file path — packaged builds move
 * VITE_PUBLIC around, and a broken <img src> on a receipt is invisible until a
 * customer is holding the paper.
 *
 * Transparent background by construction: the SVG has no background rect, so the
 * mark sits on white paper, on a coloured header band, or on a dark preview
 * without a white box around it.
 *
 * Geometry is identical to src/components/BrandLogo.tsx — change one, change both.
 */
const WORDMARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 64">`
    + `<text x="160" y="46" text-anchor="middle"`
    + ` font-family="Georgia, 'Times New Roman', Times, serif"`
    + ` font-size="46" letter-spacing="3.5" fill="#000">DAPPER</text></svg>`

/** data: URI for an <img src>. Base64 rather than raw, so the '#' in a colour and
 *  the quotes in the font stack cannot terminate the attribute. */
export function brandLogoDataUri(): string {
    return 'data:image/svg+xml;base64,' + Buffer.from(WORDMARK, 'utf8').toString('base64')
}

/**
 * A ready-to-drop <img> for a print template.
 * @param widthMm  printed width; receipts are narrow (58/80mm paper), A4 is not.
 */
export function brandLogoImg(widthMm: number, extraStyle = ''): string {
    return `<img src="${brandLogoDataUri()}" alt="DAPPER"`
        + ` style="width:${widthMm}mm;height:auto;display:block;margin:0 auto;${extraStyle}">`
}
