# TRACEFAB Design System — v3.1

> **Simple to understand. Deep to explore. Powerful to operate.**

Canonical stylesheet: **`assets/design-system/tracefab-ds.css`**.
It is the single source of truth. It is inlined into the static surfaces between
`/* TF:DS:BEGIN */` and `/* TF:DS:END */` markers.

```bash
npm run ds:sync    # propagate the canonical file into every registered surface
npm run ds:check   # fail if a surface drifted (wired into `npm run build` and `npm test`)
```

Do not hand-edit the inlined copy. Edit the canonical file, then sync.

**Why inline instead of `<link>`?** `vercel.json` builds `api/index.ts` plus `**/*.html`. A
`<link>` to a stylesheet is one more render-blocking request and one more thing deployment can
break. Inlining keeps each surface self-contained and lets `ds:check` guarantee they cannot drift.

---

## 1. Direction

| | |
|---|---|
| Feel | editorial, premium, technological, architectural, precise |
| Posture | European by construction, global by design |
| Rule | the design must hold up in near-monochrome; colour carries meaning, never decoration |

v2.x leaned on glassmorphism and saturated green. v3.0 removes both. Green is reserved for
*verified / live / primary action*. Everything else is charcoal, off-white and structure.

---

## 2. Colour

**Charcoal / ink** — the neutral spine.

| Token | Hex | Use |
|---|---|---|
| `--tf-ink-900` | `#0a0f0c` | deepest ground |
| `--tf-ink-800` | `#111815` | default body text |
| `--tf-ink-700` | `#1b2420` | |
| `--tf-ink-600` | `#2b3732` | |
| `--tf-ink-500` | `#46544d` | |
| `--tf-ink-400` | `#5a6860` | muted body text — **tuned to ≥4.5:1 on paper** |
| `--tf-ink-300` | `#97a49d` | decorative only — **never as text** |

**Deep forest** — institutional anchor. `#06120d → #0a1f16 → #0f2e20 → #16402d → #1c5a3e → #2a7a55`.

**Paper** — `--tf-paper #fafaf7`, `--tf-paper-2 #f3f3ee`, `--tf-paper-3 #ebeae3`, line `#e0dfd6`.

**Emerald** (sparing) — `#07523e / #0b7656 / #10b981 / #34d399`, tint `#d9f3e8`.

---

## 3. The trust scale

TRACEFAB does not use stars or arbitrary scores. Six provable levels, each with its own
badge — and each colour pair verified to pass WCAG AA at 4.5:1:

| Level | Meaning | Ratio |
|---|---|---|
| `certified` | Valid third-party certificate attached (GOTS, GRS, OEKO-TEX, Bluesign) | 4.63:1 |
| `verified` | Data and evidence inspected and validated | 4.82:1 |
| `documented` | Evidence uploaded, not yet audited | 6.48:1 |
| `declared` | Supplier declaration, no attachment | 4.74:1 |
| `review` | Needs review | 5.35:1 |
| `missing` | Required data absent or certificate expired | 5.38:1 |

Ratios are re-measured on every run by `npm run check:landing`.

---

## 4. Typography

- **Plus Jakarta Sans** — display and body.
- **JetBrains Mono** — SKUs, GTINs, hashes, technical labels.

Editorial scale, deliberately extreme at both ends:

| Role | Size |
|---|---|
| `--tf-text-display-1` | `clamp(52px, 8.4vw, 124px)` |
| `--tf-text-display-2` | `clamp(40px, 6.2vw, 86px)` |
| `--tf-text-display-3` | `clamp(32px, 4.4vw, 58px)` |
| `--tf-text-lead` | `clamp(16px, 1.35vw, 20px)` |
| `--tf-text-body` | `15px` |
| `--tf-text-label` | `11px`, mono, uppercase, tracking `0.14em` |
| `--tf-text-metric-xl` | `clamp(46px, 6.6vw, 92px)` |

Metrics are `tabular-nums` so dashboards never jitter.

The signature rhythm: **tiny technical label → monumental number**.

---

## 5. Surface contexts

Components read **only** context variables, so identical markup works on light and dark grounds.

```css
.tf-surface            /* defaults to light */
.tf-surface--light
.tf-surface--dark      /* overrides --tf-sf-* for dark grounds */
```

Available in both: `--tf-sf-bg`, `--tf-sf-bg-alt`, `--tf-sf-raised`, `--tf-sf-line`,
`--tf-sf-line-soft`, `--tf-sf-text`, `--tf-sf-text-mute`, `--tf-sf-text-dim`,
`--tf-sf-accent`, `--tf-sf-accent-hi`, `--tf-sf-shadow`.

> **Never** use `--tf-sf-text-dim` as body text on a light surface — it is 2.48:1.
> Use `--tf-sf-text-mute`.

---

## 6. Components

Buttons `tf-btn` (`--primary --dark --ghost --quiet`, sizes `--sm --lg`) · Cards `tf-card`
(`--hover --flush --accent`) · Badges `tf-badge` per trust level (`--plain` drops the dot) ·
`tf-metric` / `tf-metric-block` · `tf-chip` · `tf-capsule` · `tf-label` · `tf-code` ·
`tf-demo-mark` · `tf-visually-hidden`.

**`tf-demo-mark` is not optional.** Any surface showing non-production values must carry it.
Demonstration data must never be mistaken for a customer dataset.

---

## 7. Layout

`tf-shell` (1320px) / `tf-shell--wide` (1520px) · `tf-section` (`--tf-section-y: clamp(72px,10vw,148px)`) ·
`tf-stack-{2..7}` · `tf-row` (`--between --wrap --gap-3/4`) · `tf-grid--{2,3,4}` · `tf-rule` ·
`tf-heading` (`--center`).

---

## 8. Textile textures

The textile world is *felt*, not photographed. No mannequin stock imagery. Four inline-SVG
weaves at very low opacity — technology stays dominant:

`tf-tex--weave` (plain weave) · `tf-tex--twill` (denim diagonal) · `tf-tex--jersey` (knit columns) ·
`tf-tex--warp` (vertical fibre field).

---

## 9. Motion

Every animation must explain something. No decoration.

| Class | Explains |
|---|---|
| `tf-flow` | data moving along a supply-chain connector |
| `tf-reveal` / `.is-in` | progressive disclosure on scroll |
| `--tf-dur-flow: 3600ms` | a transmission you can watch without it nagging |

`@media (prefers-reduced-motion: reduce)` neutralises all of it, un-hides `tf-reveal` content,
and stops `tf-flow`.

---

## 10. The seven layers

The architecture is the visual spine of the product, not a marketing afterthought.

| | | |
|---|---|---|
| 01 | **Supply chain** | Who makes what? — Suppliers, Factories, Sites, Materials, Processes |
| 02 | **Product data** | What is the product? — Products, Composition, Materials, Components, Identifiers |
| 03 | **Evidence** | Can we prove it? — Documents, Certificates, Declarations, Audits, Tests, Evidence |
| 04 | **Data quality** | Can we trust it? — the six trust levels above |
| 05 | **Traceability** | Where did it come from? — Fiber → Material → Processing → Manufacturing → Product |
| 06 | **Intelligence** | What does the data tell us? — Risk, Gaps, Quality, Supplier performance, Readiness |
| 07 | **DPP** | What can we publish? — Readiness, Passport, Public data, Consumer experience |

---

## 11. Verification

```bash
npm run ds:check        # surfaces match the canonical stylesheet
npm run check:landing   # contrast, anchors, duplicate attrs, token leaks, cascade, routes
npm run test:landing        # landing: 95 behavioural assertions on the real page JS
npm run test:quality-center # Quality Center: 69 assertions incl. the full CAP loop
```

`check:landing` measures WCAG contrast for **both** surface contexts separately. Measuring them
through one merged token map silently scores light-section text against dark values and reports
passes that are not real — that mistake is how the v2 `#why` section shipped at 1.08:1.

## 12. The application layer (v3.1)

The marketing system above is editorial: monumental type, generous air, one idea per screen.
A console is the opposite — dense, scannable, keyboard-fast. Same tokens, different density.
Everything lives in `5b. APPLICATION LAYER` of `assets/design-system/tracefab-ds.css`, so
Brand Console, Supplier Portal, Quality Center and Operations cannot drift apart.

| Concern | Class |
| --- | --- |
| Shell | `.tf-app`, `.tf-app__side`, `.tf-app__main`, `.tf-app__topbar`, `.tf-app__body` |
| Navigation | `.tf-sidenav`, `.tf-sidenav__group`, `.tf-sidenav__link` (`.is-on`), `.tf-sidenav__count` |
| Metrics | `.tf-tilegrid`, `.tf-tile`, `.tf-tile__v`, `.tf-tile--alert`, `.tf-tile--warn` |
| Data | `.tf-tablewrap`, `.tf-table`, `.tf-table .tf-sub`, `.tf-table .tf-num` |
| Controls | `.tf-toolbar`, `.tf-field-inline`, `.tf-select`, `.tf-input`, `.tf-textarea` |
| Lifecycle | `.tf-status--requested` / `--submitted` / `--approved` / `--rejected` / `--closed` |
| Progress | `.tf-bar`, `.tf-bar__track`, `.tf-bar__fill` (`.is-low`, `.is-critical`), `.tf-bar__v` |
| Feedback | `.tf-notice` (`.tf-notice--ok`, `.tf-notice--err`), `.tf-empty` |
| Grouping | `.tf-panel`, `.tf-panel__head` |

**Density rules.** Body copy drops to 13 px inside `.tf-table`; tiles lead with a large
tabular figure over a 11 px technical label, the same "92.4% over DATA QUALITY" hierarchy as
the landing, compressed. The emerald accent stays restricted to the active nav state, primary
actions and healthy values — never decoration.

**Responsive.** At `max-width: 1024px` the 248 px sidebar collapses into a single-column shell
with the nav as a wrapping horizontal strip (group headings hidden). Dense tables are never
re-flowed into cards: `.tf-tablewrap` scrolls horizontally, which preserves column semantics
for screen readers. `.tf-tilegrid` is `auto-fit minmax(158px, 1fr)` and needs no breakpoint.

**Brand mark.** `.tf-wordmark`, `.tf-wordmark__mark` and `.tf-wordmark__name` are shared by the
marketing header and the app chrome. They were promoted out of `index.html` in v3.1 — Quality
Center used them while only the landing defined them, so the mark rendered unstyled there.
