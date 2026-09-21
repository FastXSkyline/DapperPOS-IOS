# GestionPOS — Design System ("Liquid Glass")

> A premium, Apple-grade visual language for desktop (Electron/React) **and** mobile (Expo/React Native). The goal: a POS that feels like it shipped from Cupertino — deferential glass chrome, content-first layouts, fluid spring motion, and impeccable bilingual (FR/AR) typography. Implementation is phased in [MASTER_PLAN.md](MASTER_PLAN.md) → "Redesign track".

## 1. Philosophy (Apple HIG + Liquid Glass)

Three principles drive every decision:

- **Deference** — the UI gets out of the way. Chrome is translucent *glass* that floats above content; the products, the cart, the numbers are the heroes. No heavy borders, no flat slabs of color competing with data.
- **Clarity** — legibility first. Generous spacing, a strict type scale, high contrast text, and one decisive accent. Glass never costs readability (we tint vibrant text/icons and provide opaque fallbacks).
- **Depth** — a believable z-axis. Layers blur and *lens* what's behind them, edges carry a specular highlight, and motion is physical (spring, not linear). Elevation communicates hierarchy.

**Liquid Glass** specifically means: translucent materials that **blur + saturate** the backdrop, a subtle **edge highlight** (light catching the rim), **soft ambient shadows** for float, **continuous (squircle) corners**, and **dynamic adaptation** to light/dark and to the content behind them.

## 2. Materials

A small ladder of glass materials, chosen by how much separation a surface needs from its backdrop:

| Material | Use | Light | Dark |
|---|---|---|---|
| `ultraThin` | inline chips, hovering hints | bg `rgba(255,255,255,.45)`, blur 12, saturate 150% | `rgba(28,28,30,.40)`, blur 12 |
| `thin` | toolbars, secondary panels | `rgba(255,255,255,.55)`, blur 16, sat 160% | `rgba(28,28,30,.48)`, blur 16 |
| `regular` | cards, modals, sheets (default) | `rgba(255,255,255,.62)`, blur 20, sat 180% | `rgba(28,28,30,.55)`, blur 20, sat 160% |
| `thick` | sidebars, nav, large chrome | `rgba(247,247,250,.72)`, blur 28, sat 180% | `rgba(18,18,20,.62)`, blur 28 |
| `chrome` | window title bar / status bar | near-opaque + blur 30 | near-opaque + blur 30 |

Every glass surface gets: a 1px **edge highlight** (`inset 0 1px 0 rgba(255,255,255,.5)` light / `.08` dark), a hairline **border** (`rgba(0,0,0,.06)` / `rgba(255,255,255,.10)`), and a **float shadow** (`var(--shadow-float)`). See tokens in §6 and the CSS in `desktop/src/styles/`.

**Rule:** never stack glass on glass more than 2 deep (perf + muddiness). A glass modal sits over the *content*, not over the glass sidebar's region.

## 3. Color

Neutral, near-monochrome canvas + one decisive accent (Apple system blue). DZD/financial states use the standard semantic trio.

**Light:** canvas `#F2F3F7` (with a faint ambient mesh), text `#1D1D1F` / muted `#6E6E73` / tertiary `#8E8E93`, accent `#007AFF`, separators `rgba(0,0,0,.08)`.
**Dark:** canvas `#0A0A0C` (elevated surfaces `#1C1C1E`), text `#F5F5F7` / muted `#98989D` / tertiary `#636366`, accent `#0A84FF`, separators `rgba(255,255,255,.10)`.
**Semantic:** success `#30D158`/`#34C759`, warning `#FF9F0A`/`#FF9500`, danger `#FF453A`/`#FF3B30`, info = accent.

An **ambient background** (a soft multi-stop radial "mesh" of barely-there accent tints) sits behind everything so glass has something beautiful to refract. Keep it ≤ 4% opacity — it should read as light, not decoration.

## 4. Typography

- **Latin:** `Inter` (the closest free analog to SF) → falls back to the real SF stack on Apple devices and Segoe UI on Windows: `-apple-system, BlinkMacSystemFont, 'SF Pro Text', Inter, 'Segoe UI', system-ui, sans-serif`.
- **Arabic:** `IBM Plex Sans Arabic` (or `SF Arabic` where present) — applied via `:lang(ar)` / `[dir="rtl"]`. Never let Arabic fall back to a Latin font (it breaks shaping).
- **Scale** (HIG-derived, see `--fs-*` tokens): Large Title 34, Title1 28, Title2 22, Title3 20, Headline 17/600, Body 17/400, Callout 16, Subhead 15, Footnote 13, Caption 12. Tight tracking on large sizes (`-0.02em`), neutral on body.
- **Numerals:** use `font-variant-numeric: tabular-nums` for all money/quantities so columns align.

## 5. Shape, spacing, motion

- **Corners (continuous / squircle feel):** `--r-xs 8 · sm 12 · md 16 · lg 22 · xl 28 · full`. Concentric nesting: child radius = parent − padding. (True squircle via `paint`/SVG mask is an optional Phase R5 enhancement.)
- **Spacing:** 4-pt grid — `--space-1..-10` (4,8,12,16,20,24,32,40,48,64). Layouts breathe.
- **Motion:** physical and quick. Tokens: `--dur-fast 150ms`, `--dur 240ms`, `--dur-slow 400ms`; `--ease-out: cubic-bezier(.22,1,.36,1)`, `--ease-in-out: cubic-bezier(.65,0,.35,1)`. For interactive elements use **springs** via `framer-motion` (desktop, already a dep) and `react-native-reanimated` (mobile, to add). Press = scale `0.97`; sheets slide+fade; nav transitions cross-dissolve with depth. Always honor `prefers-reduced-motion`.

## 6. Tokens (shared contract)

Tokens are the contract between platforms: identical names/values, two renderers.
- **Desktop:** CSS custom properties in `desktop/src/styles/tokens.css` (under `:root` and `:root[data-theme='dark']`, matching the existing `ThemeContext` `data-theme` switch). Glass utilities + ambient bg + a11y fallbacks in `desktop/src/styles/glass.css`. React primitive `<Glass>` in `desktop/src/components/ui/Glass.tsx`.
- **Mobile:** a TS token module mirroring the same values (extends `mobile/constants/theme.ts`), a `<Glass>` component wrapping `expo-blur`'s `BlurView` + gradient overlays, springs via reanimated.

## 7. Components (catalogue)

Each is specified once, built per platform from tokens. Priority order follows the redesign phases.

- **Shell:** desktop glass **sidebar** (thick material, floating) + custom **window chrome**; mobile glass **tab bar** (thick, floating, safe-area aware) + large-title headers.
- **Surfaces:** `GlassCard`, `Sheet`/`Modal` (regular glass, slides up on mobile / scales in on desktop), `Popover`, `Toast` (glass, top-center).
- **Controls:** `Button` (filled / tinted / plain / destructive), `SegmentedControl`, `Switch`, `Stepper`, `TextField` (inset, focus ring = accent), `Select`, `Slider`.
- **POS-specific:** **product tile** (image-forward, price + stock pill, press-spring), **cart row** (swipe-to-remove on mobile), **payment sheet** (the money moment — big numerals, method segmented control, keypad), **numeric keypad** (PIN + cash), **debtor/aging cards**, **document preview** (receipt/facture in a glass viewer).
- **States:** skeleton shimmer, empty states (friendly illustration + one action), inline errors, loading (subtle), success checkmark animation.

## 8. Platform specifics

**Desktop (Chromium):** `backdrop-filter: blur() saturate()` is fully supported — real glass. Use `@supports` to fall back to a solid tinted surface where unavailable. Frameless window option for custom chrome (Phase R2). Respect `prefers-reduced-transparency` / `prefers-reduced-motion`.

**Mobile (RN/Expo):** glass = `expo-blur` `BlurView` (`tint="light"|"dark"|"systemMaterial"`) with a thin gradient overlay for the highlight. **Blur is GPU-expensive on RN** — cap concurrent blurred surfaces (tab bar + at most one sheet), avoid blur inside scrolling lists (use a solid elevated surface there), and prefer `react-native-reanimated` worklet animations. Provide a "Reduce Transparency" setting that swaps glass for solid surfaces on low-end devices.

## 9. Bilingual & RTL

- All layouts use **logical properties** (`margin-inline`, `padding-inline-start`, `inset-inline`) and flex/grid so they mirror cleanly when `dir="rtl"` (Arabic).
- Icons that imply direction (chevrons, back, progress) mirror in RTL; brand/logo and media do not.
- Numbers and DZD amounts stay LTR within RTL text; offer Eastern-Arabic numerals as an option (ties to the fiscal `montant en lettres` work).
- Arabic font switching is automatic via `:lang(ar)`; verify weight/line-height feel matched to Inter.

## 10. Accessibility

- **Contrast:** body text ≥ 4.5:1 *over the effective (blurred) backdrop*, not just the tint — test over the busiest content. Vibrant secondary text ≥ 3:1.
- **Reduce Transparency / Reduce Motion:** honored on both platforms (solid surfaces, cross-fades instead of slides).
- **Hit targets** ≥ 44×44 pt. **Focus rings** always visible (2px accent halo). Full keyboard nav on desktop. Dynamic type / font scaling respected.

## 11. Performance budget

- Desktop: glass surfaces are cheap in Chromium but not free — don't animate `backdrop-filter`; animate transform/opacity instead. Keep ≤ ~6 large blurred surfaces on screen.
- Mobile: ≤ 2 blurred surfaces active; never blur per-row; lazy-mount sheets; 60fps on a mid-range Android is the bar (the target hardware).
- Ambient mesh is a static gradient (no per-frame work).

## 12. Migration strategy (non-breaking)

The redesign lands incrementally so the app never breaks:
1. **Foundation (R1):** add the token + glass layer *on top of* the existing `index.css` (it overrides values, keeps class names). The app instantly gains the refined palette/typography/shadows; glass utilities become available. ← *first implementation step.*
2. **Shell (R2):** restyle sidebar/nav/window chrome (desktop) and tab bar/headers (mobile) to glass.
3. **Primary flows (R3):** POS, cart, payment sheet, product tiles.
4. **Management screens (R4):** products, customers, debtors, orders, reports, settings (incl. new fiscal settings).
5. **Polish (R5):** micro-interactions, squircles, skeletons, RTL pass, dark-mode tuning, perf + a11y audit.

Each screen migrates from ad-hoc CSS/inline styles to tokens + glass primitives; hardcoded hex values are replaced with semantic tokens as we go.
