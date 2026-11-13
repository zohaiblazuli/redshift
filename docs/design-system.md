# SPHEREx reference design system

Taken from the hero reference image (1672×941 capture: "A New 3D Map of the Universe"). Measurements are in reference pixels at 1672 px wide; the `clamp()` values scale them for other viewports.

## Character
Quiet, editorial, cinematic. The photo does the work, and the UI sits on top of it as thin white type and line-art controls. Apart from the logo there is no colour in the chrome. The only warmth comes from the sun in the image. The page has no cards, panels, shadows or gradients behind the text.

## Typography
- **Family:** a neo-grotesque sans, Inter (or Inter Display for headlines). It matches the HUD's existing `Inter`. Fallback: `system-ui, sans-serif`.
- Light weights are used at large sizes and medium/semibold at small sizes. That inversion is the main signature.

| Role | Size (ref px) | Weight | Tracking | Line-height | Case / colour |
|---|---|---|---|---|---|
| Display H1 | ~80 | 300 (Light) | -0.02em | 1.08 | Sentence case, #fff |
| Lead / body | ~24 | 400 | -0.005em | 1.4 | rgba(255,255,255,.88), max ~30ch per line |
| Eyebrow | ~15 | 500 | **0.22em** | 1 | UPPERCASE, #fff, preceded by a 46×1 px rule + 22 px gap |
| Nav link | ~17 | 400 | 0 | 1 | #fff, about 56 px between items |
| Button label | ~19 (hero), ~17 (header) | 600 primary / 500 secondary | 0 | 1 | #fff or #000 |
| Wordmark | ~28 | 600 | -0.01em | 1 | "SPHEREx", lower-case x |

## Colour
| Token | Value | Use |
|---|---|---|
| `--bg` | `#05070b` | Space black page background |
| `--fg` | `#ffffff` | Headlines, nav, outlines |
| `--fg-2` | `rgba(255,255,255,.88)` | Body / lead copy |
| `--line` | `rgba(255,255,255,.85)` | Outline buttons and eyebrow rule |
| `--sun` | `#ffb35c` → `#f08a2a` | Imagery only (sun glow, city lights). Never a UI fill |
| Logo | Spectral dot ring: red, orange, yellow, green, cyan, blue, violet | The only multicolour element (it stands for the 102 bands) |

## Buttons (all full pills, `border-radius: 999px`)
- **Primary (filled):** white background, black text, weight 600, followed by a → arrow icon (1.5 px stroke, 10 px gap). Hero size: 56 px tall, 36 px horizontal padding (~246 px wide).
- **Secondary (ghost):** transparent background, 1.5 px white border, white text, weight 500, no icon. Same height as primary, padding about 46 px. Sits 32 px to the right of the primary.
- **Header CTA ("Get Started →"):** ghost pill with an arrow, 48 px tall, 30 px padding.
- Hover (inferred, not shown in the reference): primary goes to `rgba(255,255,255,.9)`, ghost gets a `rgba(255,255,255,.08)` fill, and the arrow moves 3 px to the right. Use about 200 ms ease-out.

## Layout
- Side gutter about 84 px (5% of the width). The header sits in a row about 130 px tall, with logo and nav centred near y≈66.
- Nav is right-aligned and ends about 84 px before the header CTA. The CTA sits on the right gutter.
- The hero text block is left-aligned and starts about 27% down the viewport, roughly in the left 40% of the width. The subject (the satellite) fills the right half.
- Vertical rhythm: eyebrow → 40 px → H1 → 24 px → lead → 44 px → buttons.

## Tokens
```css
:root {
  --bg: #05070b;
  --fg: #fff;
  --fg-2: rgba(255,255,255,.88);
  --line: rgba(255,255,255,.85);
  --font: "Inter", system-ui, sans-serif;
  --gutter: clamp(16px, 5vw, 84px);
  --fs-display: clamp(40px, 4.8vw, 80px);
  --fs-lead: clamp(17px, 1.45vw, 24px);
  --fs-eyebrow: clamp(12px, .9vw, 15px);
  --fs-nav: clamp(14px, 1vw, 17px);
  --pill: 999px;
  --btn-h: 56px;
  --btn-h-sm: 48px;
  --border: 1.5px;
}
.eyebrow { font: 500 var(--fs-eyebrow)/1 var(--font); letter-spacing: .22em; text-transform: uppercase; display: flex; align-items: center; gap: 22px; }
.eyebrow::before { content: ""; width: 46px; height: 1px; background: var(--line); }
.display { font: 300 var(--fs-display)/1.08 var(--font); letter-spacing: -.02em; margin: 0; }
.lead { font: 400 var(--fs-lead)/1.4 var(--font); color: var(--fg-2); max-width: 30ch; }
.btn { display: inline-flex; align-items: center; gap: 10px; height: var(--btn-h); padding: 0 36px; border-radius: var(--pill); font: 600 19px/1 var(--font); text-decoration: none; transition: background .2s ease-out; }
.btn--primary { background: #fff; color: #000; }
.btn--ghost { background: transparent; color: var(--fg); border: var(--border) solid var(--line); font-weight: 500; padding: 0 46px; }
.btn--ghost:hover { background: rgba(255,255,255,.08); }
.btn svg { transition: transform .2s ease-out; }
.btn:hover svg { transform: translateX(3px); }
```
