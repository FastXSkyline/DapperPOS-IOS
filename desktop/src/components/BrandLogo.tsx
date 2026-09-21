/**
 * The DAPPER wordmark.
 *
 * Inline SVG rather than <img src="dapper-logo.svg"> on purpose: inline, `fill:
 * currentColor` inherits from whatever the mark sits on, so the sidebar tints it
 * with --text-main and dark mode needs no second asset. The same wordmark is
 * printed on every document — see electron/util/brandLogo.ts, which serves the
 * identical geometry to the receipt/invoice templates. Change one, change both.
 */
export function BrandLogo({ height = 22, className, title = 'DAPPER' }: {
    height?: number
    className?: string
    title?: string
}) {
    return (
        <svg
            className={className}
            viewBox="0 0 320 64"
            height={height}
            width={height * 5}
            role="img"
            aria-label={title}
            style={{ display: 'block', overflow: 'visible' }}
        >
            <text
                x="160"
                y="46"
                textAnchor="middle"
                fontFamily="Georgia, 'Times New Roman', Times, serif"
                fontSize="46"
                letterSpacing="3.5"
                fill="currentColor"
            >
                DAPPER
            </text>
        </svg>
    )
}

/**
 * The monogram — the wordmark's D on its own.
 *
 * A wordmark cannot be read at 30px, which is all the room a collapsed sidebar
 * rail or an avatar has. So the mark reduces to its first letter in the SAME
 * serif face, which keeps it recognisably the same identity rather than a
 * second, unrelated logo.
 *
 * `letter` exists because the avatar is per-PERSON: the shop owner reduces to
 * the brand's D, and the next employee hired reduces to theirs. Rendering the
 * brand mark for every user would say every sale was rung up by the company.
 */
export function BrandMark({ size = 30, letter = 'D', className, title }: {
    size?: number
    letter?: string
    className?: string
    title?: string
}) {
    return (
        <svg
            className={className}
            viewBox="0 0 100 100"
            width={size}
            height={size}
            role={title ? 'img' : 'presentation'}
            aria-label={title}
            aria-hidden={title ? undefined : true}
            style={{ display: 'block' }}
        >
            <text
                x="50"
                y="50"
                textAnchor="middle"
                dominantBaseline="central"
                fontFamily="Georgia, 'Times New Roman', Times, serif"
                fontSize="66"
                fill="currentColor"
            >
                {(letter || '?').charAt(0).toUpperCase()}
            </text>
        </svg>
    )
}
