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
- The **v1 catalogue** of 15 rules across 6 categories.
- A **convention for adding new rules** so the engine is genuinely
  extensible — adding a rule means dropping in a new file.

The catalogue is opinionated but small; the project's value
proposition is the *signals* it produces, so the rule set will grow
over time. The contract is designed so that growth is cheap.

## Design summary

A signal rule is a single TypeScript module: one file under
`src/signals/rules/` exporting a `Rule` object. The engine discovers
all rules at startup and runs every enabled rule after every probe
insertion. Each rule returns one of three outcomes — *fire*,
*clear*, or *no-op* — and the engine translates that into a
`signals` row insert / update according to the lifecycle described
in `STORAGE_SCHEMA.md`.

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

  /** Default config values used when the config file omits them. */
  defaults: Record<string, unknown>;

  /** Pure-ish async evaluator. */
  run(input: RuleInput): Promise<RuleOutput>;
}

interface RuleInput {
  /** The probe row just inserted (hot columns + parsed payload). */
  newProbe: ProbeRecord;

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
  target_id: number;
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
  engine flips any active signal for `(target_id, rule_name)` to
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

## Lifecycle integration

When the engine receives a rule's output for `(target_id, rule_name)`:

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
    targetId: number;
    pathName?: string;
    checkType?: "http_get" | "dns_lookup" | "tcp_connect";
    sinceMs?: number;       // probes started_at >= now - sinceMs
    limit?: number;
  }): Promise<ProbeRecordHotColumns[]>;

  /**
   * The latest probe for each (path_name, check_type) tuple for
   * this target. Useful for cross-path comparison rules.
   */
  latestPerCell(targetId: number): Promise<ProbeRecordHotColumns[]>;

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
- **Target-window rules** call `recentProbes({ targetId, sinceMs })`.
- **Cross-path rules** call `latestPerCell(targetId)`.

If a rule needs richer querying than these three methods provide,
that's a sign the rule itself is unusual; raise it as a deferred
concern rather than expanding the interface ad-hoc.

## Confidence values

`confidence` is a `0.0`-to-`1.0` scalar accompanying every fired
signal. **Values are config, not hard-coded.** Every rule declares
its confidence default(s) in `defaults`; the user adjusts them via
the config file. Rules read confidence from their merged `config`
at run time.

Suggested scale (for choosing reasonable defaults and for the
dashboard to render):

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

The dashboard renders confidence as a visual cue (color saturation,
opacity) but does not use it as a hard threshold for display.

## Evidence convention

`evidence` is a free-form JSON object owned by the rule. Conventional
keys:

- **`probe_ids`** (`number[]`) — the probes that contributed to the
  fire. Lets the dashboard link back to source probes.
- **`observation`** (`string`, optional) — short human-readable
  summary, ≤200 chars.
- Rule-specific fields — fingerprints, status codes, IPs, whatever.

Rules SHOULD include `probe_ids` whenever possible; the dashboard's
drill-in flow assumes it. Rules MAY include any other diagnostic
fields. No central schema enforcement — the column is just JSON.

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
config file are in the configuration-file-format sub-document.

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

## The v1 catalogue

Fifteen rules across six categories. Each entry specifies: a
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
  `(target_id, newProbe.path_name)` within `window_minutes` shares
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
- **Fires when:** at least `min_consecutive` consecutive
  `dns_lookup` (or http_get-embedded DNS) results return NXDOMAIN
  for the target's hostname.
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
- **Fires when:** any answer in the new probe's DNS data falls into
  RFC1918 ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`)
  or loopback (`127.0.0.0/8`), AND the target hostname is not in
  `private_resolution_expected_hostnames` (whitelist of intranet
  hostnames that legitimately resolve to private space).
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
in your region," "451," "service unavailable," etc.).

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

#### `js_cul_de_sac`

The target serves a JS redirect to an unavailability notice — HTTP
200 OK but the content is a redirect-to-error pattern.

- **Input scope:** single-probe
- **Fires when:** the new probe's `body.shape_signals.has_js_redirect`
  is true AND either:
  - `js_redirect_target` points to a domain different from the
    original target's domain, OR
  - `body.shape_signals.is_empty_or_minimal_html` is also true.
- **Clears when:** the latest http_get probe shows `has_js_redirect:
  false` and a meaningful body.
- **Evidence:** `{ probe_ids: [newProbe.id], js_redirect_target,
  final_url, path_name }`
- **Defaults:**
  ```toml
  confidence = 0.7
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

### Cross-path comparison

#### `dns_answers_diverge`

DNS resolution returns disjoint IP sets across paths for the same
target — suggests DNS-based interference, geographic CDN routing
differences, or DNS hijacking.

- **Input scope:** cross-path
- **Fires when:** within `window_minutes`, the union of A/AAAA
  answers from two or more paths has zero intersection (no IP appears
  in both sets), modulo IPv4/IPv6 family separation.
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
2. **Default-export a `Rule` object.** Provide `name`, `defaults`,
   and an async `run` function.
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

  defaults: {
    /** Hostnames known to host ISP-level block pages. */
    block_page_hostnames: ["block.example-isp.net"],
    confidence: 0.9,
  },

  async run({ newProbe, config }) {
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
how the config sub-doc settles reload semantics), and the rule is
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
  the config sub-doc to expose a reload trigger and the engine to
  re-evaluate the enable set per probe.
- **Backtesting.** Replaying historical probes against a new rule
  to see how many signals it would have produced retroactively.
  Useful for tuning. Out of v0 scope.

---

*Status: v0 draft.*
