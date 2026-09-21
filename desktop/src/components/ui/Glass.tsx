import { forwardRef } from 'react'
import type { HTMLAttributes } from 'react'

export type GlassVariant = 'ultrathin' | 'thin' | 'regular' | 'thick' | 'chrome'

export interface GlassProps extends HTMLAttributes<HTMLDivElement> {
  /** Material thickness — how much it separates from the backdrop. Default 'regular'. */
  variant?: GlassVariant
  /** Adds card padding + radius. */
  card?: boolean
  /** Hover lift + press spring (use for tappable surfaces). */
  interactive?: boolean
  /** Specular highlight on the top edge. */
  sheen?: boolean
}

/**
 * Liquid Glass material primitive. Renders a translucent, blurred surface that
 * lenses the content behind it, with an edge highlight and float shadow.
 * Falls back to a solid surface where backdrop-filter / reduced-transparency apply.
 * See docs/DESIGN_SYSTEM.md.
 */
export const Glass = forwardRef<HTMLDivElement, GlassProps>(function Glass(
  { variant = 'regular', card = false, interactive = false, sheen = false, className = '', children, ...rest },
  ref,
) {
  const classes = [
    'glass',
    `glass--${variant}`,
    card && 'glass-card',
    interactive && 'glass-interactive',
    sheen && 'glass-sheen',
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div ref={ref} className={classes} {...rest}>
      {children}
    </div>
  )
})
