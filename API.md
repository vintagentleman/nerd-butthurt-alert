# HTTP and WebSocket API (v0)

## What this document is

A companion to the other sub-documents. It specifies the application's
external interface, used by the SvelteKit dashboard and (if ever
needed) by programmatic consumers:

- **HTTP JSON API** under `/api/v1/` for state queries and target
  mutations.
- **WebSocket channel** at `/api/v1/events` carrying live updates
  (probe insertions, signal transitions, target changes).
- **Shared schema source of truth** in Zod v4 — same types both
  ends, no code generation step.

The HTTP and WebSocket surfaces are two views of the same API: REST
for snapshot reads and mutations, WS for push deltas. Both live
under `/api/v1/` so future API changes can bump the version cleanly
in a single place.

## Overview

| Concern | Surface |
|---|---|
| Read initial state | HTTP `GET /api/v1/dashboard/snapshot` |
| Read paginated history | HTTP `GET /api/v1/probes`, `/signals` |
| Read full probe payload | HTTP `GET /api/v1/probes/:id` |
| Mutate targets | HTTP `POST` / `PATCH` / `DELETE /api/v1/targets[/:id]` |
| Live updates | WebSocket `/api/v1/events` |

Why both: HTTP handles request-response well (initial load,
drill-ins, mutations); WS handles server-push streams well (live
delta events). The two compose — the WS channel pushes deltas, and
HTTP fills in details when the dashboard drills into a specific
probe.

## Schema source of truth

All request and response shapes are defined as **Zod v4 schemas** in
a shared `src/api/schemas/` directory (TypeScript). The same schemas
serve three jobs:

- **Server runtime validation** of inbound requests — validation
  failures map to the `validation_failed` error envelope.
- **Server return-type checking** at the endpoint boundary.
- **Client type inference** via `z.infer<typeof Schema>` — the
  SvelteKit dashboard imports the schemas, gets fully-typed client
  code without a code-generation step.

Zod v4 (over valibot, ajv, hand-rolled types) because: more
established ecosystem, larger pool of examples and integrations,
first-class TypeScript inference, and v4's DX is substantially
better than prior versions. If external consumers ever need an
OpenAPI document, `zod-to-openapi` derives it from the existing
schemas — but the Zod schemas remain the source of truth.

### Example schema declarations

```ts
import { z } from "zod";

// The Target entity (used in responses).
export const Target = z.object({
  id: z.number().int(),
  url: z.string().url(),
  label: z.string().min(1),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  enabled: z.boolean(),
  cadence_override_seconds: z.number().int().positive().nullable(),
  probe_config_overrides: z.record(z.unknown()).nullable(),
});
export type Target = z.infer<typeof Target>;

// Input for POST /targets.
export const TargetCreate = Target.pick({
  url: true,
  label: true,
}).extend({
  enabled: z.boolean().default(true),
  cadence_override_seconds: z.number().int().positive().nullable().optional(),
  probe_config_overrides: z.record(z.unknown()).nullable().optional(),
});

// Input for PATCH /targets/:id. URL is immutable; everything else
// optional.
export const TargetUpdate = Target.pick({
  label: true,
  enabled: true,
  cadence_override_seconds: true,
  probe_config_overrides: true,
}).partial();

// Generic paginated envelope — the single list-response shape used
// by every list endpoint in the API.
export const Paginated = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    total: z.number().int(),    // total rows matching the filters
    limit: z.number().int(),    // page size actually applied
    offset: z.number().int(),   // offset actually applied
  });
```

The schema directory mirrors the endpoint layout —
`schemas/targets.ts`, `schemas/probes.ts`, `schemas/signals.ts`,
`schemas/events.ts` (for WS messages), `schemas/common.ts` (for
shared envelopes and the error shape).

## HTTP API conventions

### Versioning

All endpoints live under `/api/v1/`. Breaking changes to wire
formats bump to `/api/v2/`. Non-breaking additions (new endpoints,
new optional fields) stay on `v1`.

### Content type

- Requests with a body MUST send `Content-Type: application/json`.
- Responses are `application/json; charset=utf-8`.
- UTF-8 everywhere. Field names are `snake_case` to match the
  storage schema and probe-payload conventions.

### Datetimes

ISO 8601 UTC strings with millisecond precision
(`"2026-05-15T10:15:00.000Z"`). Same as the storage and probe-
payload specs.

### Error response

Uniform envelope:

```jsonc
{
  "error": {
    "code": "validation_failed",          // machine-readable enum
    "message": "url is not a valid URL",  // human-readable
    "field": "url",                        // optional; for validation errors
    "details": { /* optional, structured */ }
  }
}
```

Standard codes (extensible):

- `validation_failed` — 400; request body or query params failed Zod validation
- `not_found` — 404; resource doesn't exist
- `conflict` — 409; uniqueness or state conflict (e.g. duplicate target URL)
- `internal_error` — 500; unexpected server failure
- `unsupported_media_type` — 415; non-JSON body where JSON required

### Pagination

**Offset pagination, one model for the whole API.** Cursor
pagination was considered and rejected: it pays off only for
sequential traversal of a large, append-stable list ordered by a
unique monotonic key (the infinite-scroll pattern), and no list
endpoint here exercises that. Probes are read window-filtered or
by-id, never scrolled end-to-end; signals are browsed with
arbitrary sort on mutable columns (`confidence`, `last_seen_at`)
where a cursor would be unstable. Offset composes with any sort,
yields a `total` for page-of-pages UI, and its deep-scan cost never
bites because nothing pages deep. (A future bulk-export crawler
would want streaming, not offset *or* cursor — deferred.)

Universal query params on every list endpoint:

- `?limit=<n>` — page size; caps at 1000 (silently clamped),
  defaults to 100.
- `?offset=<n>` — rows to skip; defaults to 0.

Optional, where an endpoint supports sorting:

- `?sort=<field>` — allowed fields are endpoint-specific (listed
  per endpoint).
- `?order=asc|desc` — defaults to `desc`.

Filters are endpoint-specific and documented per endpoint. The
`limit` / `offset` / `sort` / `order` **names** are identical
everywhere, so client code and the generic `Paginated<T>` DTO are
uniform across the API.

### Common response envelope

Single-resource responses: the resource object directly.

List responses: the generic `Paginated<T>` envelope —
`{ items, total, limit, offset }` — for **every** list endpoint,
without exception. Bounded lists (`targets`, `paths`) carry no
real pagination logic: they always return their full set in a
single page (`offset: 0`, `total === items.length`, `limit` the
applied default), but they use the identical envelope so client
code never branches on endpoint identity. One DTO, one generic
type, zero special cases.

## Endpoint reference

### Targets

#### `GET /api/v1/targets`

List all targets. The list is bounded by design (the user's
appetite for adding targets), so this endpoint applies no real
pagination — it always returns the full set in one page. It still
uses the uniform envelope.

Query params: `enabled` (`true` / `false`, optional filter).
`limit` / `offset` are accepted but the full set is returned
regardless.

Response: `Paginated<Target>` (`total === items.length`,
`offset: 0`).

#### `POST /api/v1/targets`

Create a target.

Request: `TargetCreate` (see schemas section).

Response: 201 Created with the created `Target`.

Errors:

- `validation_failed` — `url` malformed, `label` empty, etc.
- `conflict` — a target with this `url` already exists.

#### `GET /api/v1/targets/:id`

Read one target. 404 if not found.

Response: `Target`.

#### `PATCH /api/v1/targets/:id`

Update a target. Request: `TargetUpdate`.

`url` is **not** mutable — changing it would orphan historical
probe records' implicit association. Workaround: delete + create.
`id` and `created_at` are immutable. `updated_at` is auto-stamped
server-side.

Response: 200 OK with the updated `Target`.

#### `DELETE /api/v1/targets/:id`

Delete a target. Cascades to its probes and signals via FK (per
`STORAGE_SCHEMA.md`).

Response: 204 No Content.

### Paths

#### `GET /api/v1/paths`

List all configured paths (from the config file, not the database).
Bounded by design (the TOML file's contents), so no real pagination
— always returns the full set in one page, using the uniform
envelope.

Query params: `limit` / `offset` accepted but the full set is
returned regardless.

Response: `Paginated<Path>` (`total === items.length`, `offset: 0`).
The `Path` schema:

```ts
export const Path = z.object({
  name: z.string(),
  proxy_url: z.string().nullable(),    // null for direct baseline
  role: z.enum(["direct", "vantage", "obfuscation"]),
  tags: z.array(z.string()),
  description: z.string().optional(),
});
```

`proxy_url` is `null` for the direct baseline (TOML's
omitted-key becomes JSON's explicit `null` at this boundary).

### Probes

#### `GET /api/v1/probes`

List probes. Returns hot columns only — the JSON payload field is
omitted from list results.

Filters (all optional): `target_id`, `path_name`, `check_type`,
`failed` (boolean), `since`, `until`. Pagination: `limit` /
`offset`. Ordering is fixed at `started_at desc` (a time-series has
one sane order); no `sort` param.

Response: `Paginated<ProbeHotColumns>`. Schema:

```ts
export const ProbeHotColumns = z.object({
  id: z.number().int(),
  target_id: z.number().int(),
  path_name: z.string(),
  path_role: z.enum(["direct", "vantage", "obfuscation"]),
  check_type: z.enum(["http_get", "dns_lookup", "tcp_connect"]),
  started_at: z.string().datetime(),
  runtime_ms: z.number().int(),
  reached_stage: z.string(),
  first_failure_code: z.string().nullable(),
  final_status_code: z.number().int().nullable(),
  impersonation_profile: z.string().nullable(),
});
```

#### `GET /api/v1/probes/:id`

Full probe record including parsed payload. Used by dashboard
drill-in views.

Response: `ProbeHotColumns` extended with `payload: ProbePayload`
(structure per `PROBE_PAYLOAD.md`).

### Signals

#### `GET /api/v1/signals`

List signals. Backs both the signals sidebar (filtered to
`status=active`, fed a single full page, then patched live from the
WebSocket stream) and the signals browse page (full filter / sort /
page control, snapshot-on-query).

Filters (all optional): `target_id`, `rule_name`, `status`
(`active` / `cleared`), `min_confidence` (float), `since`, `until`
(against `fired_at`). Pagination: `limit` / `offset`. Sorting:
`sort` ∈ `fired_at | last_seen_at | confidence | rule_name`
(default `fired_at`), `order` ∈ `asc | desc` (default `desc`).

Response: `Paginated<Signal>`. Schema:

```ts
export const Signal = z.object({
  id: z.number().int(),
  target_id: z.number().int(),
  rule_name: z.string(),
  status: z.enum(["active", "cleared"]),
  confidence: z.number().min(0).max(1),
  fired_at: z.string().datetime(),
  last_seen_at: z.string().datetime(),
  cleared_at: z.string().datetime().nullable(),
  evidence: z.record(z.unknown()),
});
```

#### `GET /api/v1/signals/:id`

Single signal record. Same shape as a list item.

### Dashboard snapshot

#### `GET /api/v1/dashboard/snapshot`

Convenience endpoint for the dashboard's first paint and for
resync after WebSocket reconnect.

Response:

```ts
export const DashboardSnapshot = z.object({
  targets: z.array(Target),
  paths: z.array(Path),
  latest_probes: z.array(ProbeHotColumns),  // one per (target, path, check_type) cell
  active_signals: z.array(Signal),
});
```

Server computes the four arrays in a single transaction so they're
mutually consistent.

## WebSocket channel

### Why WebSocket and not SSE

The pragmatic reason: HTTP/1.1 limits the browser to 6 concurrent
connections per origin. SvelteKit's `adapter-node` serves HTTP/1.1
by default (no HTTP/2 without a reverse proxy in front), so a
persistent `EventSource` would eat one of those six per dashboard
tab — leaving very little room for concurrent CRUD POSTs, drill-in
fetches, and page navigations, especially across multiple tabs.

WebSocket connections live outside the HTTP-connection budget;
browsers allow 200+ WS connections per origin in practice. Once
upgraded, the WS connection multiplexes all server-push traffic
through a single channel without competing for HTTP slots.

A secondary benefit: WS is bidirectional. We don't use that
capacity in v0 (server-push only), but it costs nothing to keep
optionality for future per-subscription filtering or client-driven
queries.

The cost: client-side reconnect logic is manual (WebSocket's
`onclose` is the trigger; `EventSource` would auto-retry). ~30
lines of well-understood code, same logic the snapshot-re-fetch
resync already requires.

### Connection

```
ws://host:port/api/v1/events       # local
wss://host/api/v1/events            # any non-localhost deployment
```

Standard WebSocket upgrade from `/api/v1/events`. No subprotocol
negotiation in v0.

### Message envelope

Every server-to-client message is a single JSON object:

```jsonc
{
  "type": "probe.inserted",     // event type; mirrors the SSE design we discussed
  "data": { /* event-specific payload */ }
}
```

Schemas defined alongside HTTP schemas in `src/api/schemas/events.ts`.

### Server → client message types

#### `probe.inserted`

A new probe row was written. Hot columns only — fetch full payload
via `GET /api/v1/probes/:id` for drill-in.

```jsonc
{
  "type": "probe.inserted",
  "data": { "probe": { /* ProbeHotColumns */ } }
}
```

#### `signal.fired`

A previously-inactive `(target_id, rule_name)` just transitioned to
`status='active'`.

```jsonc
{
  "type": "signal.fired",
  "data": { "signal": { /* full Signal */ } }
}
```

#### `signal.updated`

An already-active signal got a fresh fire from its rule
(`last_seen_at` updated; confidence / evidence may have changed).

```jsonc
{
  "type": "signal.updated",
  "data": { "signal": { /* full Signal */ } }
}
```

#### `signal.cleared`

An active signal was cleared by its rule.

```jsonc
{
  "type": "signal.cleared",
  "data": { "signal": { /* full Signal, now status='cleared', cleared_at populated */ } }
}
```

#### `target.created` / `target.updated` / `target.deleted`

Broadcast when targets change. Useful for keeping multiple
dashboard tabs in sync.

```jsonc
// target.created and target.updated
{
  "type": "target.updated",
  "data": { "target": { /* full Target */ } }
}

// target.deleted
{
  "type": "target.deleted",
  "data": { "target_id": 5 }
}
```

#### `welcome` (optional first message)

On successful upgrade the server MAY send a welcome message with
debugging metadata:

```jsonc
{
  "type": "welcome",
  "data": {
    "server_started_at": "2026-05-15T09:00:00.000Z",
    "server_time": "2026-05-15T10:15:30.000Z"
  }
}
```

`server_started_at` lets a reconnecting client detect that the
server restarted (e.g., for clock-skew warnings or to force a full
state reset). Not load-bearing; clients that don't care can ignore
it.

### Client → server messages

**v0: none.** The channel is server-push only. The WS connection
upgrade handshake is the only client action.

Future client-to-server messages (subscriptions, filters,
acknowledgements) would extend the same `{type, data}` envelope.

### Heartbeat and connection death

The server sends WebSocket ping frames every 30 seconds; if a pong
is not received within 5 seconds, the server closes the
connection. The `ws` Node library handles ping/pong at the
protocol level — no application-layer keepalive messages.

Either side may close cleanly via the WS close handshake; both
should treat any close (clean or otherwise) as a signal to
reconnect (on the client) or release resources (on the server).

### Reconnection (client-owned)

Client policy:

1. On `onclose` or `onerror`, schedule reconnect with exponential
   backoff: 1s, 2s, 4s, 8s, max 30s.
2. Reset backoff to 1s after a successful `onopen`.
3. After every successful `onopen` (including the very first),
   re-fetch `GET /api/v1/dashboard/snapshot` to resync state. This
   is the same resync flow described in the worked example.

No event replay buffering on the server in v0. The snapshot
endpoint is the source of truth for current state; replay would
add complexity (event buffer, last-event-id semantics) for little
gain at our scale.

## SvelteKit integration notes

The dashboard is a SvelteKit app. SvelteKit-idiomatic patterns
wrapping this API:

- **Initial state** — a `+page.server.ts` load function calls the
  underlying snapshot query (either directly, since the
  SvelteKit server and the API live in the same process, or via
  `GET /api/v1/dashboard/snapshot`). Direct is faster; HTTP keeps
  the surface uniform. Implementation choice.
- **Mutations** — `+page.server.ts` form actions for target CRUD.
  Each form action wraps the same logic the corresponding REST
  endpoint exposes, sharing the Zod schemas for validation. Form
  actions return SvelteKit-friendly results; REST endpoints return
  JSON envelopes. Same persistence and validation code path.
- **Live updates** — the dashboard's root layout opens a
  `WebSocket` to `/api/v1/events`, parses incoming messages via
  the events schemas, and dispatches into Svelte stores.
  Components subscribe to the relevant store and re-render.

Programmatic API consumers (CLI tools, future webhook integrations)
use the REST endpoints and the WS channel directly; SvelteKit form
actions are an internal UI concern.

The WebSocket server attaches to SvelteKit's HTTP server via
`adapter-node`'s hooks — same Node process, same port, separate
upgrade path. Implementation detail beyond this spec.

## Authentication

**v0: none.** The app binds to `127.0.0.1` by default (per
`[server].host` in the config); access control is "whoever has
shell access to the host." If bound to a public interface, the
user is responsible for fronting the app with a reverse proxy
(Caddy, nginx with basic auth, Tailscale, etc.) and arranging
WS upgrade-pass-through.

Auth at the application layer is deferred to a later phase. Likely
shape: a single bearer token in the config file checked against
`Authorization: Bearer <token>` for HTTP and a token query
parameter (`?token=...`) for the WS upgrade. Not in v0 scope.

## Worked example — dashboard lifecycle

End-to-end of how the surfaces compose, from the dashboard's
perspective.

1. **Browser opens the dashboard.** SvelteKit's load function for
   the matrix page fetches the snapshot (`GET /api/v1/dashboard/snapshot`
   or its direct equivalent). Response includes targets, paths,
   latest probe per cell, active signals.
2. **Page renders.** Matrix cells display the latest probe per
   `(target, path, check_type)`, colored by `first_failure_code`
   presence. A sidebar lists active signals.
3. **Client opens WebSocket.** Root layout instantiates
   `new WebSocket("ws://localhost:5173/api/v1/events")`. On
   `onopen` the dashboard re-fetches the snapshot (the same
   query the load function ran) to ensure state is fresh; on
   the very first connection this is redundant but harmless.
4. **Probe engine runs.** At the next scheduler tick the engine
   probes every enabled `(target, path, check_type)` triple. As
   each probe completes and is inserted, the server pushes a
   `probe.inserted` WS message.
5. **Client updates.** The matrix cell for the affected
   `(target, path, check_type)` re-renders with the new probe's
   `reached_stage` / `first_failure_code` / `runtime_ms`.
6. **Signal rules evaluate.** Several rules fire on the new probes;
   one fires for the first time (`signal.fired`), another
   already-active one updates (`signal.updated`), a third no
   longer applies and clears (`signal.cleared`). All three messages
   stream to the client. The signals sidebar updates.
7. **User drills in.** Click on a matrix cell fires
   `GET /api/v1/probes/:id` for the full payload. A drawer renders
   the per-hop breakdown, body shape signals, cert chain, etc.
8. **User adds a target.** A form on the targets management page
   submits to a SvelteKit form action. The action validates
   against the `TargetCreate` schema, persists, and broadcasts
   `target.created` over the WS channel. Other open dashboard
   tabs receive the message and update their target lists.
9. **Network blip.** Browser temporarily loses connectivity. The
   WebSocket's `onclose` fires; the client backs off (1s, 2s, 4s…)
   and reconnects. On `onopen`, snapshot re-fetch resyncs state.

## Deferred / open

- **Auth.** Bearer token sketched above. Pick up when there's a
  concrete deployment story beyond localhost.
- **Rate limiting.** No limits in v0. If the API gets exposed
  beyond localhost, basic per-IP rate limiting becomes table
  stakes.
- **Client → server WS messages.** v0 is server-push only. Future
  features (per-subscription filters, presence, server-driven
  queries) would extend the `{type, data}` envelope with
  client-originated types.
- **Event replay on reconnect.** Currently no buffer; clients
  re-fetch snapshot. If reconnects become visibly disruptive
  (rare for a local app), add a bounded ring buffer keyed by event
  ID and a resume-from-last-id WS handshake parameter.
- **OpenAPI export.** Derivable from the Zod schemas via
  `zod-to-openapi` when an external (non-TS) consumer appears.
  Not produced eagerly.
- **Filtering on signal evidence fields.** Current signal-list
  filters don't peek into `evidence` JSON. If rules grow common
  evidence keys worth filtering on (e.g. `path_name`), expose
  query params that walk the JSON.

---

*Status: v0 draft.*
