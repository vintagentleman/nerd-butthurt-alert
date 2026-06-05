# Dashboard (v0)

## What this document is

A companion to the other sub-documents, and the last of the design
specs. It covers the **structural** layer of the dashboard:

- View inventory and routes.
- Component decomposition — which components exist, which are shared.
- Per-view data dependencies — what each view fetches, and which
  views update live versus snapshot-on-query.
- Client state management — the store model fed by the WebSocket
  stream.
- Responsive strategy — as structural breakpoints, not pixel
  layouts.
- Component primitives — all native, no library (styling
  methodology lives in `STYLING.md`).

### What this document deliberately does NOT cover

The **visual** layer — exact layouts, spacing, colour, cell
rendering, typography, the drill-in panel's arrangement — is out of
scope here, by intent. Visual design is iterated in a real medium
(running code, or a visual design tool), not specified in prose.
Everything below that touches appearance is **provisional** and
labelled as such; expect it to change once the visuals are explored.
The structural decisions (routes, component boundaries, data flow,
state model) are the durable part.

## MVP scope

The MVP is five views plus the persistent app shell:

1. **Matrix home** (`/`)
2. **Probe drill-in** (`/probes/:id`, also openable as an overlay)
3. **Signals** — a persistent **sidebar** (active only, live) plus a
   **browse page** (`/signals`, full filter/sort/page)
4. **Targets management** (`/targets`)
5. **Paths overview** (`/paths`)

**Post-MVP:** the per-target time-series view (latency / success
over time). It's the one view that needs a charting library and the
one most improved by having real data to look at first, so it waits.

## View inventory and routes

SvelteKit file-based routing. The root layout holds the app shell.

| Route | View | First-paint source | Live? |
|---|---|---|---|
| `/` | Matrix home | `dashboard/snapshot` | Yes (WS) |
| `/probes/:id` | Probe drill-in | `GET /probes/:id` | No (immutable) |
| `/signals` | Signals browse | `GET /signals?…` | No (snapshot-on-query) |
| `/targets` | Targets management | `GET /targets` | Partial (WS `target.*`) |
| `/paths` | Paths overview | `GET /paths` | No (config-static) |

The app shell (persistent across all routes) provides navigation
and the **active-signals sidebar**.

### Probe drill-in: route + overlay

`/probes/:id` is a real route — drill-ins are deep-linkable and
shareable, and a probe is immutable so the page is fully cacheable.

From the matrix, clicking a cell should open the drill-in **as an
overlay** (a drawer over the matrix) without a full navigation,
using SvelteKit **shallow routing** (`preloadData` + `pushState`).
Direct navigation or refresh to `/probes/:id` falls back to the
full-page render. One component (`ProbeDetail`) serves both;
the wrapper differs (drawer vs. page).

## Component decomposition

Leaf and shared components, grouped by view. Components marked
**[shared]** are used by more than one view.

### App shell

- `AppShell` — nav chrome + slot for the routed view + the sidebar.
- `SignalSidebar` — the persistent active-signals panel. Renders
  `SignalList` in `variant="sidebar"`. **[shared presentation via
  `SignalList`]**

### Matrix

- `MatrixGrid` — the targets × paths grid. Hand-rolled (bespoke
  layout, performance-sensitive, not expressible as a native
  primitive).
- `MatrixCell` — one cell = the latest probe for a
  `(target, path, check_type)` triple. Communicates, at minimum,
  reached-stage/outcome, latency, and age. *(Exact visual encoding
  — colour, glyph, number density — provisional.)*
- `MatrixAxisHeader` — target row labels / path column headers.

### Signals

- `SignalList` **[shared]** — renders a list of signals. Props:
  `signals: Signal[]`, `variant: "sidebar" | "page"`. The same
  component backs both the sidebar (compact, active-only, live) and
  the browse page (full rows, mixed status, static). This is the
  "embed the same component" requirement made concrete: presentation
  is shared, the **container** decides data and liveness.
- `SignalRow` — one signal (used by `SignalList`).
- `SignalFilters` — filter/sort controls for the browse page only
  (target, rule, status, min-confidence, sort field + order).

### Probe drill-in

`ProbeDetail` composes sections that mirror the payload structure
(`PROBE_PAYLOAD.md`):

- `TimingBreakdown` — the `rollup.timing_ms` split.
- `HopList` → `HopDetail` — per-hop DNS / TCP / TLS / HTTP.
- `CertChain` — `peer_certificates`.
- `BodyShapePanel` — `body.shape_signals` + snippet.
- `RawPayload` — a collapsible "show raw JSON" fallback (tree or
  pretty-printed), so nothing in the payload is ever unreachable
  even before a bespoke renderer exists for it.

*(Which sections render expanded by default, and their arrangement,
is provisional.)*

### Targets

- `TargetTable` — the management list.
- `TargetForm` — create / edit, inside a native `<dialog>`.
  Backed by SvelteKit form actions sharing the Zod schemas
  (`TargetCreate` / `TargetUpdate`) with the REST endpoints.

### Paths

- `PathList` — read-only list of configured paths with role and
  tags. Static.

## State management

Svelte stores, seeded from the snapshot and patched by the
WebSocket stream. A single WS client module owns the socket,
validates inbound messages against the events Zod schemas, and
applies them to stores.

### Stores

- `paths` — static list, from the snapshot. Never patched at runtime
  (config-driven).
- `targets` — `Map<id, Target>`. Seeded from snapshot; patched by
  `target.created` / `target.updated` / `target.deleted`.
- `latestProbes` — `Map<"{target_id}:{path_name}:{check_type}", ProbeHotColumns>`.
  Seeded from `snapshot.latest_probes`; each `probe.inserted` event
  replaces the entry for its cell key.
- `activeSignals` — `Map<"{target_id}:{rule_name}", Signal>`,
  active-status only. Seeded from `snapshot.active_signals`;
  `signal.fired` / `signal.updated` upsert, `signal.cleared`
  removes.

### Derived views

- The matrix's cells are **derived** from `targets` × `paths` ×
  `latestProbes` — no separate matrix store; it's a pure projection,
  so any store patch reactively updates exactly the affected cells.
- The sidebar is derived from `activeSignals`.

### What is and isn't live

| Surface | Live mechanism |
|---|---|
| Matrix cells | `probe.inserted` → `latestProbes` patch → cell re-renders |
| Sidebar | `signal.*` → `activeSignals` patch → list re-renders |
| Targets list | `target.*` → `targets` patch |
| Signals browse page | **Not auto-patched.** Snapshot-on-query. |
| Probe drill-in | Static (immutable record) |
| Paths overview | Static |

The signals **browse page** is deliberately not live: auto-mutating
a table the user is actively sorting, filtering, and paging is
disorienting. Instead, WS `signal.*` events while the page is open
drive a passive **"N new signal events — refresh"** affordance; the
user re-queries when ready. The sidebar carries the live view; the
page is the investigative one.

### WebSocket lifecycle (client)

Owned by the root layout. On `open` (first connect and every
reconnect), re-fetch `dashboard/snapshot` and replace the live
stores wholesale — the snapshot is the source of truth, the stream
is deltas on top. Reconnect with exponential backoff per `API.md`.

## Responsive strategy

A structural baseline, not pixel layout (provisional throughout).

The matrix is the hard case — a targets × paths grid does not
transpose cleanly to a narrow screen. The structural commitment:

- **Wide:** the full grid.
- **Narrow (phone):** collapse to a **per-target card list** — one
  card per target, the path cells stacked or wrapped inside it. Not
  a horizontally-scrolled grid (horizontal scroll on a status
  surface is a usability trap).

The **sidebar** becomes a toggleable drawer / bottom sheet on narrow
screens rather than a persistent column.

Exact breakpoints, card layout, and cell arrangement are decided in
the visual medium.

## Component primitives — native, no library

There is **no component library** (no Shoelace, no Bits UI, no
Tailwind). Every interactive primitive the dashboard needs is a
native element, styled per `STYLING.md`. This is the resolution of
the earlier component-library question, not a compromise — the
research showed the platform covers our entire inventory.

Mapping each need to its native primitive:

- **Drill-in overlay, target form** → `<dialog>` opened with
  `showModal()`. Native focus trap, ESC handling, top-layer,
  `::backdrop`. `closedby="any"` for click-outside dismiss (with a
  ~10-line JS fallback where unsupported). Styled as a side panel or
  centred modal in the visual layer — "drawer" is a look, not a
  separate primitive.
- **Drill-in sections** → `<details>`/`<summary>`, one per section.
  Accordion behaviour and a11y for free; chosen over tabs (no native
  tabs element) and better suited to a scannable diagnostic payload.
- **Status / signal chips** → styled elements (a chip is a styled
  `<span>`); semantic status tokens from `STYLING.md`.
- **Forms, filter controls** → native `<input>` / `<select>`.
  Adequate for enumerated filters and the target form; no custom
  picker needed. (`appearance: base-select` is Chromium-only and
  out of the Baseline-newly policy — not used.)
- **Collapsible raw payload** → `<details>`.
- **Cell hover detail (desktop progressive enhancement)** → see the
  tooltip note below.
- **Hand-rolled:** `MatrixGrid` / `MatrixCell` — the product's
  signature surface, bespoke by nature — and any future charting
  (uPlot, per the time-series deferral).

### Cell-hover tooltip — desktop-only progressive enhancement

The matrix cell already shows its key facts inline (status, latency,
age — required for the touch/mobile case regardless), and tap/click
opens the full drill-in. On top of that, **desktop** gets a hover
tooltip with fuller detail, built natively: a `popover` element
positioned with CSS anchor positioning (both Baseline, in policy),
shown on hover/focus via ~15 lines of JS that satisfy WCAG 1.4.13
(dismissible / hoverable / persistent). It deliberately does **not**
use `interestfor` or anchored container queries (Chromium-only, out
of policy).

It is a pure progressive enhancement: absent on touch (there is no
hover, and Firefox Android is a first-class target), where the
drill-in already delivers the same detail on tap. Skippable for the
MVP; cheap to add later since the platform supports it cleanly.

### SSR is a free choice

With native elements (no custom-element hydration), there is no
flash-of-undefined-custom-elements problem, so the earlier
"disable SSR to dodge web-component FOUC" decision is **rescinded**.
SvelteKit's default SSR works fine. SSR-vs-CSR is now an ordinary,
low-stakes choice for a localhost single-user tool — keep the
default unless a concrete reason to change it appears.

## Deferred / open

- **Per-target time-series view** (post-MVP). Charting via **uPlot**
  (MIT, tiny, streaming-friendly) — decoupled from any component
  library. Wire it up against real data.
- **All visual specifics** — layouts, colour, density, cell
  encoding, drill-in arrangement, breakpoints. Iterated in the
  visual medium; this doc is the structural skeleton they hang on.
- **Empty / first-run states** (no targets yet, no probes yet, WS
  disconnected banner). Real but visual; deferred to building.
- **Keyboard navigation / accessibility pass** beyond what the
  native elements (`<dialog>`, `<details>`, native form controls)
  give for free. The matrix grid is the main hand-rolled surface
  needing explicit ARIA / roving-tabindex attention. Deferred, not
  forgotten.
- **Bulk target operations** (enable/disable many, import/export).
  Out of MVP.

---

*Status: v0 draft. The structural decisions here are firm; anything
touching appearance is provisional and expected to change once the
visual layer is explored.*
