# Styling Architecture (v0)

## What this document is

A companion to `DASHBOARD.md` and `TOOLING.md`. It defines the CSS
**methodology** for the frontend — cascade organisation, design
tokens, theming, responsive strategy, and where styles live. It is
cross-cutting: it governs every component, not just the dashboard's
views.

It is deliberately **architecture, not appearance.** Exact colours,
spacing values, and the visual look are iterated in the visual
medium (per `DASHBOARD.md`); this document fixes the *scaffolding*
those decisions hang on so they stay consistent and swappable.

## Principles

- **No component library, no CSS framework.** Every interactive
  primitive the app needs is a native element (`<dialog>`,
  `<details>`, `<select>`, Popover API). There is no Shoelace, no
  Bits UI, no Tailwind. Styling is plain CSS over native elements
  and Svelte components.
- **No naming methodology** (BEM, SUIT, CSS-modules). Svelte's
  scoped `<style>` blocks provide component scope *structurally*, so
  the convention-based scope manufacturing those methodologies exist
  for is unnecessary.
- **Baseline-newly target, tooling-enforced.** Everything here sits
  within the `baseline newly available` policy (see `TOOLING.md`);
  `stylelint-plugin-use-baseline` mechanically flags anything
  out-of-tier, so the methodology can lean on modern CSS confidently
  without hand-auditing each feature.
- **Logical properties as the default** (`margin-inline`,
  `padding-block`, `inset`, `*-block`/`*-inline`). Correct modern
  default, and it pairs with the `flip-block` / `flip-inline`
  anchor-positioning fallbacks the tooltip uses.

## Cascade layers

A single global stylesheet declares the layer order up front;
everything slots into a named layer. This gives a predictable
cascade with no specificity wars and no `!important` creep.

```css
@layer reset, tokens, base, components, utilities;
```

- **reset** — a minimal modern reset (box-sizing, margin zeroing,
  media defaults, form-control font inheritance).
- **tokens** — design tokens (Open Props + our semantic layer; see
  below).
- **base** — element-level defaults: typography, link styling, body
  background/colour from semantic tokens.
- **components** — anything not component-scoped by Svelte that still
  needs a global home (rare).
- **utilities** — a deliberately tiny set (see "Where styles live").

Component-local styles live in Svelte's scoped `<style>` blocks,
which sit *outside* these layers (unlayered styles win over layered
ones, which is what we want — a component's own styles should
override the global base without specificity fights).

## Design tokens

**Two-tier model.** Primitive tokens are raw scales; semantic tokens
map roles onto primitives. Components reference **only** semantic
tokens — never raw values, never primitives directly.

### Primitive tier — Open Props

[Open Props](https://open-props.style/) supplies the primitive layer:
curated scales for colour, size/spacing, typography, radii, shadows,
easings, z-index, etc. It is MIT-licensed, **zero-runtime** (nothing
but CSS custom properties — no JS, no build step, no framework), so
adopting it is not bloat in any runtime sense. The point is borrowed
expertise on scale design rather than hand-rolling colour ramps and
spacing scales.

```css
/* Import into the tokens layer. Granular imports
   (open-props/colors, open-props/sizes, …) can trim later if the
   full set ever feels heavy; for a personal tool the whole set is
   fine — unused custom properties cost effectively nothing. */
@import "open-props/style" layer(tokens);
```

### Semantic tier — ours

Mapped onto Open Props primitives, in the `tokens` layer. This is the
indirection that makes theming and tuning a one-file change.

```css
@layer tokens {
  :root {
    /* surfaces */
    --surface:        light-dark(var(--gray-0),  var(--gray-12));
    --surface-raised: light-dark(var(--gray-1),  var(--gray-11));
    --border:         light-dark(var(--gray-3),  var(--gray-9));

    /* text */
    --text:           light-dark(var(--gray-12), var(--gray-1));
    --text-muted:     light-dark(var(--gray-7),  var(--gray-5));

    /* probe / signal status — the product's core vocabulary */
    --status-up:       var(--green-6);
    --status-degraded: var(--yellow-6);
    --status-down:     var(--red-6);
    --status-unknown:  var(--gray-6);

    /* rhythm (alias Open Props sizes to intent) */
    --space-inline: var(--size-3);
    --space-block:  var(--size-3);
  }
}
```

(Exact hue/step choices are provisional — set in the visual medium.
The *structure* — semantic names mapping to Open Props steps — is
what's fixed here.)

## Theming

Light/dark via the native `light-dark()` function, gated by
`color-scheme`. The swap happens **only** at the semantic-token
tier (as above); no component restates a `prefers-color-scheme`
block.

```css
@layer base {
  :root {
    /* Honour the OS preference by default; a manual toggle can
       override by setting color-scheme: light | dark on :root. */
    color-scheme: light dark;
  }
}
```

A monitoring dashboard is stared at for long stretches, so dark mode
is a first-class concern, not an afterthought — but it costs almost
nothing here because it's purely a token-tier swap.

## Responsive strategy

**Container queries for components; media queries reserved for
viewport-level layout and user-preference queries.** A signal card or
a matrix cell responds to *its container*, not the viewport, so the
same component works in the sidebar and on the full page without
rewriting breakpoints.

```css
.signal-card-host {
  container-type: inline-size;
}
@container (min-width: 28rem) {
  .signal-card { /* roomier layout */ }
}
```

Media queries are for:

- **Viewport-level layout** — the overall page shell, and the
  matrix's desktop-grid ↔ mobile-card-list shift (see below).
- **Preference queries** — `prefers-color-scheme`,
  `prefers-reduced-motion` (gate all non-essential animation behind
  `@media (prefers-reduced-motion: no-preference)`).

Base styles are **mobile-first**; larger layouts are progressive
enhancement via `min-width`. Mobile (Firefox Android) is a
first-class target, not an afterthought.

### The matrix reflow — an open structural question

The matrix is the one component with a genuine desktop↔mobile
divergence: a targets × paths grid on wide screens, a per-target
card list on narrow ones. Two ways to express it:

1. **Pure CSS reflow** — one DOM, the grid restructures via a
   media/container query. Preferred when achievable.
2. **DOM swap** — two layouts behind an `{#if}` on a media-query
   store. Heavier; only if a true table→cards transform can't be
   expressed in CSS alone.

This is empirical — resolve it when building the matrix in the
visual medium, not in the abstract. Flagged here so the decision
isn't forgotten.

## Where styles live

- **Global stylesheet** (one file): the `@layer` declaration, the
  Open Props import, the semantic token tier, the reset, base
  element styles, and a *tiny* utility set. Nothing component-specific.
- **Svelte scoped `<style>`** per component: everything else. This is
  the default home for styles; the global sheet is the exception, not
  the rule.
- **Utilities** — kept deliberately minimal because Svelte scoping
  removes most of the need. Expected members: `.visually-hidden`
  (a11y), and perhaps one or two layout primitives (a `.stack` /
  `.cluster`-style flow helper). Not a utility framework; a handful
  of genuinely-global helpers in the `utilities` layer.

## Reset

A minimal modern reset in the `reset` layer — box-sizing border-box,
zero default margins, `max-inline-size` on media, form controls
inheriting font, sensible line-height. Hand-rolled and small (resets
are opinionated and personal enough to own).

`open-props/normalize` is the consistent batteries-option if a
hand-rolled reset later feels like wheel-reinvention — but a reset is
small and worth keeping under direct control, unlike the token
scales.

## Relationship to other docs

- `DASHBOARD.md` — component decomposition and which native element
  backs each view; this doc says *how they're styled*.
- `TOOLING.md` — the `baseline newly available` policy and the
  Stylelint Baseline rule that enforces it; Stylelint also lints
  these stylesheets (with the Svelte parser for `<style>` blocks).
- `ARCHITECTURE.md` — names the frontend stack at a high level.

## Deferred / open

- **Concrete token values** — colour ramps, spacing rhythm, type
  scale steps. Set in the visual medium; only the token *structure*
  is fixed here.
- **Matrix reflow mechanism** — CSS reflow vs. DOM swap (above).
- **Manual theme toggle** — whether to offer light/dark override
  beyond the OS preference. Trivial to add (set `color-scheme` on
  `:root`); decide when building.
- **Utility set final membership** — grows empirically; starts at
  `.visually-hidden` plus maybe a layout primitive or two.

---

*Status: v0 draft. Architecture is firm; concrete visual values are
provisional and set during visual exploration.*
