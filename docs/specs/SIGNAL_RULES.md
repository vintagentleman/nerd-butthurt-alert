# Signal Rule Catalogue (v0)

## What this document is

A companion to `ARCHITECTURE.md`, `PROBE_PAYLOAD.md`, and
`STORAGE_SCHEMA.md`. It defines:

- The **rule contract** — what a signal rule looks like as a piece of
  TypeScript.
- How rules **integrate with the lifecycle** described in
  `STORAGE_SCHEMA.md` (active / cleared).
- The **storage reader API** rules use to query probe history.
- The **per-rule config namespace** — including enable flags and
  confidence values — which lives in the global configuration file,
  not in code.
- The **v0 catalogue** of 19 rules across 8 categories.
- A **convention for adding new rules** so the engine is genuinely
  extensible — adding a rule means dropping in a new file.

The catalogue is opinionated but small; the project's value
proposition is the *signals* it produces, so the rule set will grow
over time. The contract is designed so that growth is cheap.

## Design summary

A signal rule is a single TypeScript module: one file under
`src/signals/rules/` exporting a `Rule` object. The engine discovers
all rules at startup and runs each enabled rule on the trigger that
matches its input scope: single-probe and target-window rules run on
every probe insertion; cross-path rules run once per target at a
**sweep barrier**, after that target's probes for the tick have settled
(see "Evaluation triggers" below). Each rule returns one of three
outcomes — *fire*, *clear*, or *no-op* — and the engine translates that
into a `signals` row insert / update according to the lifecycle
described in `STORAGE_SCHEMA.md`.

Rules are **pure-ish async functions** of the new probe plus
queryable history. All knobs — thresholds, time windows, phrase
lists, confidence values, and the `enabled` flag itself — live in
the configuration file under `rules.<rule_name>.*`. The rule
module's `defaults` provide implicit-schema fallback values; the
user does the tuning in config, not by editing TypeScript. Errors
thrown by rules are caught by the engine and logged — a buggy rule
never crashes the signals layer.

## The rule contract

```ts
interface Rule {
  /** Unique identifier; matches signals.rule_name in storage. */
  name: string;

  /**
   * Input scope — also selects the evaluation trigger:
   *   "single-probe" / "target-window" → run on each probe insertion
   *   "cross-path"                      → run once per target at the
   *                                       sweep barrier (see "Evaluation
   *                                       triggers").
   */
  scope: "single-probe" | "target-window" | "cross-path";

  /** Default config values used when the config file omits them. */
  defaults: Record<string, unknown>;

  /** Pure-ish async evaluator. */
  run(input: RuleInput): Promise<RuleOutput>;
}

interface RuleInput {
  /**
   * The probe row just inserted (hot columns + parsed payload), for
   * single-probe / target-window rules. `null` for cross-path rules,
   * which run at the sweep barrier with no single triggering probe —
   * they read the target's cells via `storage` instead.
   */
  newProbe: ProbeRecord | null;

  /** The target under evaluation (always set, both triggers). */
  targetName: string;

  /** Read-only interface over the probes table. */
  storage: StorageReader;

  /**
   * This rule's config — config-file overrides merged onto the
   * rule's `defaults`. The engine guarantees the merged object
   * has at least every key the rule's `defaults` declared.
   */
  config: Record<string, unknown>;
}

type RuleOutput =
  | { action: "fire"; confidence: number; evidence: object }
  | { action: "clear" }
  | { action: "no-op" };

/**
 * Hot columns from the probes table, plus the parsed payload.
 * Payload is parsed once per insertion and shared across all rules
 * for that insertion — rules don't pay repeated parse cost.
 */
interface ProbeRecord {
  id: number;
  target_name: string;
  path_name: string;
  path_role: "direct" | "vantage" | "obfuscation";
  check_type: "http_get" | "dns_lookup" | "tcp_connect";
  started_at: string;            // ISO 8601
  runtime_ms: number;
  reached_stage: string;
  first_failure_code: string | null;
  final_status_code: number | null;
  impersonation_profile: string | null;
  payload: ProbePayload;          // parsed; see PROBE_PAYLOAD.md
}
```

A rule's `run()` is expected to be quick — typically a few hot-column
checks and at most one or two storage queries. The engine runs rules
in parallel and aggregates results.

### Three-outcome model

- **`fire`** — the rule's predicate matched. The engine writes (or
  updates) an active signal row. Confidence (read from config) and
  evidence are part of the output.
- **`clear`** — the rule's predicate did not match, *and* the rule
  wants to assert "this signal should no longer be active." The
  engine flips any active signal for `(target_name, rule_name)` to
  `cleared`.
- **`no-op`** — the rule has nothing to say (predicate didn't match,
  but the rule also doesn't want to clear). Most rules short-circuit
  to no-op when the new probe isn't relevant (wrong check type,
  etc.). The engine does nothing.

The distinction between `clear` and `no-op` matters: a rule that
only fires on `http_get` should return `no-op` for a `dns_lookup`
probe, **not** `clear` — otherwise any unrelated probe would clear
the signal. Rules clear only when they affirmatively know the
condition no longer holds.

## Evaluation triggers

A rule's `scope` selects when the engine runs it:

- **`single-probe` and `target-window`** rules run **on every probe
  insertion**, immediately, with `newProbe` set to the row just
  written. They're cheap (a few hot-column checks, at most one or two
  storage queries) and benefit from firing the instant evidence lands.
- **`cross-path`** rules run at a **sweep barrier**: once per target,
  after all of that target's probes for the scheduler tick have
  settled. They are invoked with `newProbe: null` and read the target's
  per-path state via `storage.latestPerCell(targetName)`.

### Why cross-path rules can't run per-probe

A cross-path rule asks "what does the latest probe on *every* path show
for this target?" Within a sweep, a target's probes land one path at a
time. If such a rule ran on each insertion, the first path's fresh
probe would be compared against the *previous* tick's results for the
others — so the rule would fire, then flip, then fire again as each
remaining path reported, emitting a burst of signal fire/clear churn
that only resolves once the last path lands. It would also recompute
the same cross-path picture once per path (N× the work). The barrier
evaluates the comparison exactly once, on a consistent snapshot.

The barrier fires per target as soon as that target's tick is complete;
it does not wait for other targets. A probe that fails or times out
still counts as "settled" for its cell (the rule sees its
`first_failure_code`), so a hung path can't stall the barrier beyond
the probe's own timeout.

## Lifecycle integration

When the engine receives a rule's output for `(target_name, rule_name)`:

| Output | Existing active signal? | Action |
|---|---|---|
| `fire` | No | INSERT new active signal row |
| `fire` | Yes | UPDATE `last_seen_at`, optionally refresh `confidence` / `evidence` |
| `clear` | Yes | UPDATE `status='cleared'`, `cleared_at=now` |
| `clear` | No | (no-op) |
| `no-op` | Any | (no-op) |

This matches the `STORAGE_SCHEMA.md` "Lifecycle" section verbatim;
re-stated here so rule authors don't have to context-switch.

## Storage reader API

Rules query probe history via a small read-only interface:

```ts
interface StorageReader {
  /**
   * Recent probes filtered by target and optionally by path /
   * check_type / time window. Returns hot columns only — payload
   * is NOT parsed for these results. Call `payload(id)` for the
   * ones you actually need to inspect.
   */
  recentProbes(opts: {
    targetName: string;
    pathName?: string;
    checkType?: "http_get" | "dns_lookup" | "tcp_connect";
    sinceMs?: number;       // probes started_at >= now - sinceMs
    limit?: number;
  }): Promise<ProbeRecordHotColumns[]>;

  /**
   * The latest probe for each (path_name, check_type) tuple for
   * this target. Useful for cross-path comparison rules.
   */
  latestPerCell(targetName: string): Promise<ProbeRecordHotColumns[]>;

  /**
   * Parse and return the JSON payload for one probe.
   */
  payload(probeId: number): Promise<ProbePayload>;
}
```

`ProbeRecordHotColumns` is `ProbeRecord` without the `payload` field
— the field is omitted in query results to avoid unnecessary JSON
parsing of historical rows.

These three methods cover the three input-scope categories rules use:

- **Single-probe rules** read only `newProbe`; no storage calls.
- **Target-window rules** call `recentProbes({ targetName, sinceMs })`.
- **Cross-path rules** call `latestPerCell(targetName)`.

If a rule needs richer querying than these three methods provide,
that's a sign the rule itself is unusual; raise it as a deferred
concern rather than expanding the interface ad-hoc.

## Confidence values

`confidence` is a `0.0`-to-`1.0` scalar accompanying every fired
signal. **Values are config, not hard-coded.** Every rule declares
its confidence default(s) in `defaults`; the user adjusts them via
the config file. Rules read confidence from their merged `config`
at run time.

Suggested scale (for choosing reasonable defaults and for Grafana
to render):

- **1.0** — unmistakable signature (e.g., RST mid-TLS handshake)
- **0.85–0.95** — strong evidence, multiple corroborating signals
- **0.6–0.85** — solid single-signal evidence
- **0.4–0.6** — suggestive; reader should not act without
  corroboration
- **< 0.4** — do not fire; return `no-op` instead

Rules with conditional confidence (different value depending on
observation count, severity, etc.) declare multiple confidence
keys in `defaults` — e.g. `confidence_initial` and
`confidence_full` for step-function rules. The rule's `run()` picks
which one to emit. There is no built-in interpolation framework;
rules that want non-stepwise scaling implement it in code.

Grafana renders confidence as a visual cue (panel thresholds /
colour) but it is not a hard threshold for display.

## Evidence convention

`evidence` is a free-form JSON object owned by the rule. Conventional
keys:

- **`probe_ids`** (`number[]`) — the probes that contributed to the
  fire. Lets a Grafana SQLite panel link back to the source probes.
- **`observation`** (`string`, optional) — short human-readable
  summary, ≤200 chars.
- Rule-specific fields — fingerprints, status codes, IPs, whatever.

Rules SHOULD include `probe_ids` whenever possible; the evidence
drill-in (Grafana's SQLite panel) assumes it. Rules MAY include any
other diagnostic fields. No central schema enforcement — the column
is just JSON.

## Per-rule config

Each rule has a namespace under `rules.<rule_name>` in the
configuration file. The merged values (file overrides on top of
the rule's `defaults`) are passed to `run()` as `config`.

Two conventions every rule supports without declaring them
explicitly in `defaults`:

- **`enabled: boolean`** — defaults to `true`. Set `false` to skip
  the rule without removing its file. The engine checks this
  *before* calling `run()`; disabled rules incur no work per probe.
- **Confidence keys** — `confidence` (single-value rules), or
  `confidence_initial` / `confidence_full` for step-function rules
  like `tls_handshake_hang`. Rules declare which they use in their
  `defaults`; the convention is uniform enough that users tuning
  in config find the keys consistent.

Other config keys are rule-specific — thresholds, time windows,
phrase lists, etc. — and named per rule in the catalogue below.

Example config-file fragment:

```toml
[rules.tls_handshake_hang]
min_consecutive = 5
window_minutes = 60
confidence_initial = 0.5
confidence_full = 0.9

[rules.tls_close_notify_missing]
enabled = false                   # disable; this rule is noisy on my network

[rules.dns_private_ip_returned]
# Whitelist an intranet hostname that legitimately resolves to RFC1918:
private_resolution_expected_hostnames = ["git.internal"]
```

If the config file omits a rule entirely, its `defaults` apply in
full and the rule is enabled. If a rule introduces a new config key
in code, the config schema doesn't need pre-updating — the
`defaults` provide the implicit schema. Reload semantics for the
config file are in `CONFIG_FILE.md`.

## Rule module convention

One rule = one TypeScript file under `src/signals/rules/`. Each
module **default-exports a `Rule`**. The engine auto-discovers
all files in that directory at startup.

```
src/signals/rules/
├── tls_handshake_hang.ts
├── tls_closed_during_handshake.ts
├── tls_cert_invalid.ts
├── ...
└── path_specific_failure.ts
```

No central registry file; no manual list to update when a rule is
added. Removing a rule is similarly trivial — delete the file;
existing active signals for the removed rule remain in the database
(as historical rows) and can be cleared manually or left to age out.

The file name should match the rule's `name` field for sanity, but
the engine actually reads `name` from the exported object.

## The v0 catalogue

Nineteen rules across eight categories. Each entry specifies: a
description, input scope, fires/clears predicates, evidence shape,
and the rule's `defaults` block (which is also the implicit schema
of its config-file namespace, minus the always-implicit `enabled`
key).

### TLS interference

#### `tls_handshake_hang`

TLS handshake never completes within timeout — strong DPI signature
when persistent. Conditional confidence: lower at single occurrence,
higher once threshold-many consecutive failures observed.

- **Input scope:** target-window
- **Fires when:** `newProbe.first_failure_code == "tls_handshake_timeout"`
  AND at least one of the most recent http_get probes for
  `(target_name, newProbe.path_name)` within `window_minutes` shares
  the same failure. Confidence is `confidence_initial` until at
  least `min_consecutive` consecutive failures are observed, then
  `confidence_full`.
- **Clears when:** the latest http_get probe on `newProbe.path_name`
  reaches a stage past `tls_handshake`.
- **Evidence:** `{ probe_ids, path_name, consecutive_count }`
- **Defaults:**
  ```toml
  min_consecutive = 3
  window_minutes = 30
  confidence_initial = 0.7
  confidence_full = 0.95
  ```

#### `tls_closed_during_handshake`

Connection RST mid-handshake — a very strong DPI signature on its
own.

- **Input scope:** single-probe
- **Fires when:** `newProbe.first_failure_code == "tls_closed_during_handshake"`
- **Clears when:** the latest http_get probe on `newProbe.path_name`
  reaches a stage past `tls_handshake`.
- **Evidence:** `{ probe_ids: [newProbe.id], path_name }`
- **Defaults:**
  ```toml
  confidence = 0.95
  ```

#### `tls_cert_invalid`

TLS certificate fails validation persistently — could be expiration,
hostname mismatch, unknown CA, or MITM injection.

- **Input scope:** target-window
- **Fires when:** `newProbe.first_failure_code` is in
  `["tls_cert_invalid", "tls_cert_hostname_mismatch", "tls_cert_expired", "tls_cert_unknown_ca"]`
  for at least `min_consecutive` consecutive probes on the same path.
- **Clears when:** the latest http_get probe on the path completes
  TLS cleanly.
- **Evidence:** `{ probe_ids, path_name, specific_failures, cert_subject_cn? }`
- **Defaults:**
  ```toml
  min_consecutive = 2
  confidence = 0.9
  ```

#### `tls_close_notify_missing`

TLS sessions complete but consistently terminate without
`close_notify` — a weaker but real DPI signature.

- **Input scope:** target-window
- **Fires when:** at least `threshold_ratio` of the last
  `window_size` http_get probes on the same path have
  `termination_mode == "tls_close_notify_missing"`.
- **Clears when:** the latest probes show clean `clean_fin`
  termination.
- **Evidence:** `{ probe_ids, path_name, window_size, matched_count }`
- **Defaults:**
  ```toml
  window_size = 10
  threshold_ratio = 0.7
  confidence = 0.6
  ```

### DNS interference

#### `dns_nxdomain_persistent`

DNS resolution returns NXDOMAIN consistently — could be DNS-level
blocking, or the target genuinely doesn't resolve.

- **Input scope:** target-window
- **Fires when:** at least `min_consecutive` consecutive `dns_lookup`
  results return NXDOMAIN for the target's hostname. (Per-path resolver
  evidence comes only from `dns_lookup`; `http_get` carries no DNS
  answers — see `PROBE_PAYLOAD.md`. A *direct* `http_get` may
  corroborate via `first_failure_code == "dns_nxdomain"`, but doesn't
  substitute for `dns_lookup` on a non-direct path.)
- **Clears when:** the latest DNS resolution succeeds.
- **Evidence:** `{ probe_ids, hostname }`
- **Defaults:**
  ```toml
  min_consecutive = 3
  confidence = 0.9
  ```

#### `dns_private_ip_returned`

DNS returns private or loopback IPs for a public target hostname —
classic DNS hijacking or captive portal signature.

- **Input scope:** single-probe
- **Fires when:** the new probe is a `dns_lookup` (the only check that
  carries resolver answers — `http_get` exposes none, per
  `PROBE_PAYLOAD.md`; no-op on other check types) and any answer in its
  data falls into RFC1918 ranges (`10.0.0.0/8`, `172.16.0.0/12`,
  `192.168.0.0/16`) or loopback (`127.0.0.0/8`), AND the target hostname
  is not in `private_resolution_expected_hostnames` (whitelist of
  intranet hostnames that legitimately resolve to private space).
- **Clears when:** the latest DNS answers fall in public IP space.
- **Evidence:** `{ probe_ids: [newProbe.id], hostname, returned_ip, range }`
- **Defaults:**
  ```toml
  private_resolution_expected_hostnames = []
  confidence = 0.95
  ```

### Target-initiated unavailability

#### `target_returned_4xx`

The target consistently returns refusal-class HTTP status codes
(403, 404, 451) across all paths — distinguishes target-side
refusal from network-side interference.

- **Input scope:** cross-path
- **Fires when:** the latest http_get probe across every path the
  target has shows `final_status_code` in `codes_of_interest`, for
  at least `min_consecutive` consecutive scheduler ticks.
- **Clears when:** the most recent probes return non-listed status
  codes.
- **Evidence:** `{ probe_ids, status_codes_by_path, paths_observed }`
- **Defaults:**
  ```toml
  codes_of_interest = [403, 404, 451]
  min_consecutive = 2
  confidence = 0.85
  ```

#### `target_returned_5xx`

The target consistently returns server errors across paths —
target-side outage rather than network-path issue.

- **Input scope:** cross-path
- **Fires when:** the latest http_get probe across every path
  returns `final_status_code >= 500` for at least `min_consecutive`
  consecutive ticks.
- **Clears when:** the most recent probes return non-5xx.
- **Evidence:** `{ probe_ids, status_codes_by_path, paths_observed }`
- **Defaults:**
  ```toml
  min_consecutive = 2
  confidence = 0.85
  ```

#### `unavailability_phrase_matched`

Response body contains known unavailability phrases ("unavailable
in your region," "unavailable for legal reasons," "service
unavailable," etc.).

- **Input scope:** single-probe
- **Fires when:** the new probe's payload has any non-empty
  `body.shape_signals.unavailability_phrases_matched` array.
- **Clears when:** the latest http_get probe has an empty
  `unavailability_phrases_matched` array.
- **Evidence:** `{ probe_ids: [newProbe.id], phrases_matched, path_name }`
- **Defaults:**
  ```toml
  confidence = 0.75
  ```
  (The phrase list itself lives in the probe-engine's body-shape
  detection config, not in this rule's config.)

#### `geoblock_redirect`

The target bounces the request to an unavailability / restriction
dead-end instead of serving the content. Covers all three transports
the bounce can take — an HTTP 3xx, a `<meta refresh>`, or a JS
`window.location` redirect; the mechanism is incidental and recorded in
evidence (this generalises the former `js_cul_de_sac`, which was the JS
transport only).

- **Input scope:** single-probe
- **Fires when:** `newProbe.check_type == "http_get"` and the request
  was redirected to a different final URL by **any** mechanism — an HTTP
  3xx hop in `rollup.redirect_chain`, `body.shape_signals.has_meta_refresh`,
  or `body.shape_signals.has_js_redirect` — **and** the destination
  signals unavailability via any of:
  - the final URL's path/host matches a `block_indicator_patterns`
    entry (catches e.g. a `302 → /restricted`),
  - `body.shape_signals.unavailability_phrases_matched` is non-empty,
  - the landing is `is_empty_or_minimal_html` on a *different*
    registrable domain (the former `js_cul_de_sac` gate).

  The unavailability gate is what keeps benign canonical redirects
  (http→https, `www`, locale, auth) from firing.
- **Clears when:** the latest http_get reaches the requested URL with
  no dead-end redirect and a meaningful body.
- **Evidence:** `{ probe_ids: [newProbe.id], redirect_mechanism,
  requested_url, final_url, matched, path_name }` — `redirect_mechanism`
  ∈ `http_3xx | meta_refresh | js`.
- **Defaults:**
  ```toml
  block_indicator_patterns = ["restricted", "unavailable", "geo", "blocked", "region", "denied", "sorry"]
  confidence               = 0.7
  ```

### Reachability

#### `target_unreachable_all_paths`

Every path's recent probes failed at any stage — either a global
block or the target itself is down.

- **Input scope:** cross-path
- **Fires when:** every path with at least one recent probe within
  `window_minutes` has all recent probes showing non-null
  `first_failure_code`.
- **Clears when:** at least one recent probe within `window_minutes`
  succeeds on any path.
- **Evidence:** `{ probe_ids_by_path, dominant_failure_codes }`
- **Defaults:**
  ```toml
  window_minutes = 30
  confidence = 0.9
  ```

#### `path_specific_failure`

Only one path's probes are failing while others succeed — likely a
path-side issue (proxy down, VPN routing problem), not a target
issue.

- **Input scope:** cross-path
- **Fires when:** exactly one path within the last `window_minutes`
  has all-failing probes, and every other path has at least one
  succeeding probe in the same window.
- **Clears when:** the failing path returns a successful probe.
- **Evidence:** `{ failing_path_name, failure_codes, succeeding_paths }`
- **Defaults:**
  ```toml
  window_minutes = 30
  confidence = 0.85
  ```

### Stream interference

#### `incomplete_body`

The response starts normally — TLS, request, and `200`-class headers
all succeed — but the body never finishes: throughput drops to ~zero
after an initial chunk and the transfer hits the probe's timeout with no
close. A stealthy DPI / throttling signature ("make it look broken, not
blocked"), distinct from a clean target-side close.

- **Input scope:** single-probe
- **Fires when:** `newProbe.check_type == "http_get"` and
  `reached_stage == "body_transfer"` — headers arrived but the transfer
  never reached `complete`, so `first_failure_code` is `http_body_stalled`
  or `http_body_truncated`. When `content_length_header` is known, also
  require `encoded_bytes_received / content_length_header <
  min_completion_ratio` (suppresses near-complete truncations; use the
  **wire**/encoded byte count, since content-encoding makes the decoded
  body exceed `content_length` and would otherwise read >100% and mask a
  stall). When it's absent (chunked), `reached_stage == "body_transfer"`
  alone is sufficient — the idle-stall / truncation already establishes
  incompleteness. Covers the stall (`termination_mode "timeout"`) and
  truncating-close (`"rst"` / `"clean_fin"`) variants alike.
- **Clears when:** a later http_get on the same path completes the body
  (`reached_stage == "complete"`).
- **Evidence:** `{ probe_ids, bytes_received, content_length,
  completion_ratio, termination_mode, final_status_code, path_name }`
- **Defaults:**
  ```toml
  min_completion_ratio = 0.9
  confidence           = 0.8
  ```

**Attribution by composition.** Because a stalled or truncated probe
now carries a non-null `first_failure_code` (`http_body_stalled` or
`http_body_truncated`, per `PROBE_PAYLOAD.md`), it counts as "failing"
to the cross-path rules — so `path_specific_failure` already fires when
the body completes on some paths but stalls on others, giving
DPI-vs-target attribution without a new cross-path rule. `incomplete_body`
characterises the *stage*; `path_specific_failure` attributes it.

#### `first_party_resource_stalled`

The target document loads, but one or more of the site's **own**
(first-party, eTLD+1) subresources are stalled or truncated — the same
interference applied to a critical asset instead of the document. Catches
the small-shell case `incomplete_body` misses: a tiny HTML page completes
(under the body-stall cutoff) while the site's larger `app.js` / CSS
bundle is DPI-stalled over it, leaving the page broken.

- **Input scope:** single-probe
- **Fires when:** `newProbe.check_type == "http_get"` and the payload's
  `subresources` summary (first-party only) reports `stalled > 0` or
  `failed > 0` — i.e. some first-party asset has a non-null
  `first_failure_code` (`http_body_stalled` / `http_body_truncated` / a
  connection-stage failure). Independent of the document's own
  `reached_stage`; third-party subresources are excluded by construction
  (see `PROBE_PAYLOAD.md`).
- **Clears when:** the latest http_get shows all first-party subresources
  `complete`.
- **Evidence:** `{ probe_ids, stalled_resources, worst_first_failure_code,
  path_name }`
- **Defaults:**
  ```toml
  confidence = 0.8
  ```

Composes with reachability: a bare status check would call this target
`up` (the document loaded fine), but the site is functionally broken —
this signal is what surfaces that distinction.

### Cross-path comparison

#### `dns_answers_diverge`

DNS resolution returns disjoint IP sets across paths for the same
target — suggests DNS-based interference, geographic CDN routing
differences, or DNS hijacking. Requires each compared path to run a
`dns_lookup` with a resolver tunnelled through that path (DoT/DoH over
its SOCKS5 — see `PROBE_PAYLOAD.md`); `http_get` carries no answers, so
a path without a `dns_lookup` simply doesn't participate in the
comparison.

- **Input scope:** cross-path
- **Fires when:** within `window_minutes`, the `dns_lookup` answer sets
  (A/AAAA) of two or more paths have zero pairwise intersection (no IP
  appears in both sets), modulo IPv4/IPv6 family separation.
- **Clears when:** the most recent answer sets share at least one
  IP.
- **Evidence:** `{ answers_by_path: { path_name: [ip,...] }, divergence_kind }`
- **Defaults:**
  ```toml
  window_minutes = 30
  confidence = 0.7    # CDN/geo routing can legitimately cause this
  ```

#### `tls_cert_fingerprint_diverges`

Peer leaf-certificate fingerprint differs across paths for the same
target — classic MITM signature.

- **Input scope:** cross-path
- **Fires when:** within `window_minutes`, http_get probes from two
  or more paths observe different leaf-cert `sha256_fingerprint`
  values for the same target hostname.
- **Clears when:** the most recent leaf-cert fingerprints converge
  across paths.
- **Evidence:** `{ fingerprints_by_path, probe_ids_by_path }`
- **Defaults:**
  ```toml
  window_minutes = 30
  confidence = 0.95
  ```

### Client-variant comparison

Same target, same path — but a client-side variable changed: the
impersonation profile (browser fingerprint) or the pinned HTTP
version. When the target answers one variant and not another, the
interference is keyed on *what the client sent*, not on the target or
the network vantage — a distinction the path- and target-level rules
cannot draw and would otherwise mis-attribute as a block. Both rules
require the same target to be probed under more than one variant (the
impersonation-profile → browser-engine wiring lands in M2); a target
probed under a single variant never triggers them.

#### `tls_hang_impersonation_specific`

The target completes under one impersonation profile but hangs at the
TLS handshake under another — the signature of client-fingerprint
interference rather than a target or network block. Motivating case: a
DPI that drops ClientHellos carrying Firefox's ECH GREASE extension, so
the site is reachable under a Chromium profile but times out under
Firefox. Without this rule that Firefox-only hang reads as
`tls_handshake_hang` (and, if Firefox is the only profile on every
path, `target_unreachable_all_paths`) — i.e. "blocked", when the target
is fine and only this client's ClientHello trips the filter.

- **Input scope:** target-window
- **Fires when:** `newProbe.check_type == "http_get"` and
  `newProbe.first_failure_code` is a pre-response failure (e.g.
  `tls_handshake_timeout`, `tls_closed_during_handshake`), AND within
  `window_minutes` at least `min_working_profiles` recent http_get
  probes on the same `(target_name, path_name)` under a *different*
  `impersonation_profile` reached a stage past `tls_handshake`. The
  target answers some ClientHello fingerprints but not this one.
- **Clears when:** the latest http_get on the same `(target, path)`
  under the affected profile reaches past `tls_handshake`.
- **Evidence:** `{ probe_ids, path_name, hanging_profile,
  working_profiles, reached_stage_by_profile, https_rr_has_ech? }` — a
  DNS HTTPS record carrying an ECH config (see `PROBE_PAYLOAD.md`)
  alongside a profile-specific hang is the ECH-GREASE fingerprint,
  recorded as corroboration; the rule itself stays profile-agnostic.
- **Defaults:**
  ```toml
  window_minutes = 30
  min_working_profiles = 1
  confidence = 0.8
  ```

#### `http3_specifically_degraded`

The target completes over HTTP/2 (TCP) but a probe pinned to HTTP/3
hangs, stalls, or is reset — QUIC-specific interference, a DPI lever
that throttles or tears down UDP/443 to a target while leaving TCP
intact. Increasingly relevant when the target's own DNS HTTPS record
advertises `alpn=h3`, steering real browsers onto the degraded
protocol; the actionable signal is "force TCP / disable HTTP/3", not
"target down".

- **Input scope:** target-window
- **Fires when:** `newProbe.check_type == "http_get"`, its pinned HTTP
  version (`payload.data.config.pinned_http_version`) is `"3"`, and it
  failed before `complete` (`quic_handshake_timeout`,
  `quic_connection_closed`, `http_body_stalled`, or a pre-response
  reset), AND within `window_minutes` a recent http_get on the same
  `(target, path)` pinned to `"2"` (or that negotiated `h2`) reached
  `complete`. Each candidate's pinned version is read from its payload —
  it is not a hot column.
- **Clears when:** the latest pinned-`"3"` probe on the same
  `(target, path)` reaches `complete`, or the target stops advertising
  `h3` in its HTTPS record.
- **Evidence:** `{ probe_ids, path_name, h3_failure_code,
  h2_reached_stage, https_rr_alpn? }`
- **Defaults:**
  ```toml
  window_minutes = 30
  confidence = 0.8
  ```

### Performance / degradation

#### `latency_anomaly`

Response time spikes significantly above the historical baseline.

- **Input scope:** target-window (long)
- **Fires when:** `runtime_ms` of the new probe and at least
  `min_consecutive` consecutive prior probes (same target + path +
  check_type) all exceed `mean + k_stddev * stddev` of the rolling
  baseline computed over `baseline_window_days` of history.
- **Clears when:** the latest probes return within the baseline
  window.
- **Evidence:** `{ probe_ids, observed_ms, baseline_mean_ms,
  baseline_stddev_ms, z_score }`
- **Defaults:**
  ```toml
  baseline_window_days = 7
  k_stddev = 3
  min_consecutive = 3
  confidence = 0.6    # latency varies for many reasons; treat as suggestive
  ```

## Adding your own rule

The convention is designed to make this a single-file change.

### The five-step template

1. **Create `src/signals/rules/<name>.ts`.** The filename should
   match the rule's `name` field for sanity.
2. **Default-export a `Rule` object.** Provide `name`, `scope`,
   `defaults`, and an async `run` function.
3. **Short-circuit cheaply on irrelevant probes.** Most rules return
   `no-op` immediately when `newProbe.check_type` doesn't match what
   they care about.
4. **Use the storage reader for history.** Don't read the DB
   directly; the reader's interface is the seam the engine controls.
5. **Return a `RuleOutput`.** `fire` with confidence (read from
   `config`) and evidence, `clear` when you affirmatively know the
   condition no longer holds, or `no-op` otherwise.

### Worked example: `redirect_to_known_block_page`

Scenario: you've noticed a specific external domain
(`block.example-isp.net`) is used by your ISP as a redirect target
for blocked sites. You want a rule that fires whenever any target
ends up redirected there.

```ts
// src/signals/rules/redirect_to_known_block_page.ts
import type { Rule } from "../types";

const rule: Rule = {
  name: "redirect_to_known_block_page",
  scope: "single-probe",

  defaults: {
    /** Hostnames known to host ISP-level block pages. */
    block_page_hostnames: ["block.example-isp.net"],
    confidence: 0.9,
  },

  async run({ newProbe, config }) {
    // Single-probe rules always get a newProbe; the guard also
    // satisfies the `ProbeRecord | null` type.
    if (!newProbe) return { action: "no-op" };
    // Short-circuit: only http_get is relevant.
    if (newProbe.check_type !== "http_get") {
      return { action: "no-op" };
    }
    // Short-circuit: only completed probes have a final URL.
    if (newProbe.reached_stage !== "complete") {
      return { action: "no-op" };
    }

    const finalUrl = newProbe.payload.data.rollup.final_url;
    const blockPageHostnames =
      config.block_page_hostnames as string[];

    const matched = blockPageHostnames.find((host) =>
      finalUrl.includes(host),
    );

    if (matched) {
      return {
        action: "fire",
        confidence: config.confidence as number,
        evidence: {
          probe_ids: [newProbe.id],
          final_url: finalUrl,
          matched_hostname: matched,
          path_name: newProbe.path_name,
          observation: `Target redirected to known block page ${matched}.`,
        },
      };
    }

    // The condition affirmatively does NOT hold — clear any active
    // signal for this rule on this target.
    return { action: "clear" };
  },
};

export default rule;
```

Configure in the global config file:

```toml
[rules.redirect_to_known_block_page]
block_page_hostnames = [
  "block.example-isp.net",
  "blocked.notice.gov.example",
]
confidence = 0.85   # tweak down; I think this signal is slightly
                    # weaker than the default in my environment
```

That's all. Restart the engine (or wait for hot-reload, depending on
how `CONFIG_FILE.md` settles reload semantics), and the rule is
live.

### Patterns worth reusing

- **Short-circuit on `check_type`** before any storage call. Most
  rules only care about one check type.
- **Short-circuit on `reached_stage`** when the rule needs probe
  outputs deeper than where the probe got to (e.g., a body-shape
  rule needs `reached_stage == "complete"`).
- **Use `recentProbes` with `sinceMs`** for target-window rules,
  not `latestPerCell` — `latestPerCell` gives you just one probe per
  cell, not a window.
- **Return `clear` only when you're sure.** A rule that's seen
  inconclusive data should return `no-op`, not `clear`. Clearing
  prematurely closes a signal that might still be true.
- **Read confidence from `config`, not from constants.** Hard-coded
  confidence numbers in rule code defeat the user's ability to tune
  thresholds without editing TypeScript.

## Deferred / open

- **Rule severity / priority taxonomy.** Currently a flat
  confidence number. May want to separate "how certain we are this
  fired" (confidence) from "how alarming this is" (severity).
- **LLM-assisted interpretation layer.** When the signal output is
  contradictory across rules ("`target_returned_5xx` fires but so
  does `path_specific_failure`"), a user-driven LLM helper that
  consults the raw probe data and external context (status pages,
  outage trackers) is on the roadmap. See
  `memory/project_open_questions.md`.
- **Cross-rule aggregations.** Rules that depend on other rules'
  outputs (meta-rules). Not in v0; the catalogue currently treats
  rules as orthogonal.
- **Runtime rule enable/disable** without restart — currently the
  `enabled` config flag is read at startup. Hot-reload would require
  `CONFIG_FILE.md` to expose a reload trigger and the engine to
  re-evaluate the enable set per probe.
- **Backtesting.** Replaying historical probes against a new rule
  to see how many signals it would have produced retroactively.
  Useful for tuning. Out of v0 scope.

---

*Status: v0 draft.*
