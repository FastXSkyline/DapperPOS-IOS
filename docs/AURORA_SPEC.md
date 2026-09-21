# Aurora Spatial — restyle contract

The design system lives in `desktop/src/styles/tokens.css` + `glass.css` (the
shell in `App.css`). Every screen must consume those tokens — never hardcode.

## Identity
- **Accent / brand:** orchid-violet `var(--accent)` (gradient `var(--accent-grad)`). The electric highlight for primary actions, active states, focus.
- **Money / positive:** emerald `var(--success)` / `var(--money)`. Totals, paid, profit, confirm.
- **Destructive:** `var(--error)` (rose). **Warning:** `var(--warning)` (amber).
- **ZERO blue anywhere.** No `#2563eb`, `#3b82f6`, `#1d4ed8`, `#60a5fa`, navy `#0f172a`/`#1e293b`, slate `#94a3b8`, royalblue, indigo `#4f46e5`/`#6366f1`. Replace each with the nearest token below.

## Token mapping (replace hardcoded values)
| Hardcoded → | Use token |
|---|---|
| blue/indigo/primary buttons, links, active, focus | `var(--accent)` or `var(--accent-grad)` |
| green/teal money/success | `var(--success)` |
| red destructive | `var(--error)` |
| amber warnings | `var(--warning)` |
| page/app background | transparent (let the aurora show) or `var(--bg-main)` |
| cards / panels / modals | glass: `var(--lg-regular-bg)` + `backdrop-filter: blur(var(--lg-blur)) saturate(var(--lg-saturate))` + `border:1px solid var(--lg-border)` + `box-shadow: var(--lg-highlight), var(--shadow-lg)` |
| solid surfaces | `var(--surface)` / `var(--surface-2)` |
| text | `var(--text-main)` / `var(--text-muted)` / `var(--text-tertiary)` |
| borders/dividers | `var(--border-light)` / `var(--separator)` |
| white text on accent | `var(--text-on-accent)` |

## Shape, depth, motion
- Radii: `--r-xs 10`, `--r-sm 14`, `--r-md 18`, `--r-lg 24`, `--r-xl 30`, `--r-2xl 38`, `--r-full`. Cards use `--r-lg`/`--r-2xl`; pills/badges `--r-full`. No sharp corners on cards.
- Elevation: `--shadow-sm/md/lg/float`; accent glow `--shadow-accent`.
- Motion: transitions use `var(--ease-spring)` for press/hover lifts; `var(--ease-out)` otherwise. Tappable tiles: lift on hover (`translateY(-3px)`), scale 0.96–0.98 on active.
- Spacing: 4-pt grid tokens `--space-1..12`. Generous padding (cards ≥ `--space-5`).

## Typography
- Display/hero numerals (the money) big + bold + `font-variant-numeric: tabular-nums` + `letter-spacing: var(--tracking-tight)`. Use `--fs-display`/`--fs-large-title` for the cart total / key figures.
- Headings tight tracking. Body `--fs-body`.

## Materials
- Floating panels read as frosted glass over the aurora. Prefer the `.glass`, `.glass-card`, `.glass--thick`, `.elev-*`, `.squircle`, `.pressable`, `.lift`, `.skeleton`, `.empty-state`, `.accent-text`, `.rise-in` utilities from glass.css when convenient.
- Always keep the `@supports not (backdrop-filter)` + `prefers-reduced-transparency` + `prefers-reduced-motion` fallbacks intact (they're global in glass.css — don't fight them).

## Hard rules for restyle agents
1. Edit ONLY the assigned screen's files. NEVER touch `index.css`, `App.css`, `styles/tokens.css`, `styles/glass.css`, or another screen's files.
2. Do NOT change component logic, props, state, exports, IPC calls, or class *names* the TSX relies on — restyle values, add glass/tokens, refine layout spacing/hierarchy only.
3. Do NOT alter printed-document HTML (receipt/invoice/PO output lives in `electron/*Service.ts`, not these files) — only the on-screen preview chrome.
4. Keep light AND dark correct by using tokens (never theme-specific hex).
5. Remove the word "GestionPOS"/"Gestion POS" if present (white-label).
6. The result must compile (`tsc -b`) and build (`vite build`) cleanly.
