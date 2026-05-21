# Configuration File Format (v0)

## What this document is

A companion to the other sub-documents. It specifies:

- The **format** (TOML) and **on-disk layout** of the application's
  configuration files.
- The **layered loading order** — committed defaults, env-specific
  overrides, gitignored local overrides — following the
  `node-config` pattern translated to TOML.
- **Merge semantics** for combining layers.
- The **schema** of every section the app reads, cross-referencing
  the other sub-documents where applicable.
- **What lives in config vs. what lives in the database** (a
  recurring source of confusion).
- **Reload semantics** (v0: none — restart to apply).

The config-file surface is large because the app has a lot of
tunable knobs (probe defaults, body-shape phrase lists, fifteen
signal rules, paths). The layering scheme exists precisely so the
user only has to write what they want to change.

## Overview

- **Format:** TOML. Comment-friendly, type-aware, less syntax-noisy
  than YAML for our use case.
- **Layered loading:** files merged in a fixed order (see below) so
  committed baselines and user-local overrides cleanly coexist.
- **What lives here:** application defaults, server / storage /
  scheduler settings, the **list of paths**, per-rule config, body-
  shape phrase lists, anything else that's static and operator-
  authored.
- **What lives in the DB instead:** targets (user-managed via
  dashboard, per `STORAGE_SCHEMA.md`), per-target overrides on
  probe config (`probe_config_overrides` JSON on `targets`),
  probe records and signals.
- **What lives nowhere committed:** secrets. Path-side credentials
  (VPN passwords, TOTP seeds, Hysteria auth, …) are pulled from env
  vars / `pass` (or `secret-tool`) / Docker secrets, per the patterns in
  `PATH_DEPLOYMENTS.md` — never written into the config files.

## File layout

```
config/
├── default.toml          # committed; the canonical baseline
├── development.toml      # optional; loaded when NODE_ENV=development
├── production.toml       # optional; loaded when NODE_ENV=production
├── test.toml             # optional; loaded when NODE_ENV=test
└── local.toml            # always loaded last if present; gitignored
```

`default.toml` is shipped with the repo and contains every documented
setting with its baseline value. `local.toml` is where the user puts
their machine-specific overrides (paths, tuning, etc.) — `.gitignore`
should explicitly include `config/local.toml`. Env-specific files
are optional and most personal setups won't need them.

## Loading order and merge semantics

Files are loaded and merged in this fixed order; later files
override earlier ones:

1. **In-code defaults** — every signal rule's `defaults` block
   (per `SIGNAL_RULES.md`), and any other module-level fallbacks.
   Acts as a safety net so the app still boots if `default.toml`
   is missing or partial.
2. **`config/default.toml`** — the canonical, committed baseline.
3. **`config/<NODE_ENV>.toml`** — if `NODE_ENV` is set and the
   matching file exists.
4. **`config/local.toml`** — if present, always wins last.

### Merge rules

- **Tables / nested objects:** deep-merged recursively. A later
  layer's `[rules.tls_handshake_hang].confidence_initial = 0.5`
  overrides only that key; other keys in the same section keep
  their earlier values.
- **Scalars:** override outright.
- **Arrays:** replaced entirely. A later layer's `[[paths]]`
  entries do **not** append to earlier ones — they replace the
  full list. This is intentional: it avoids accidentally inheriting
  example paths from `default.toml` into a production deployment.
- **Missing keys:** absent in a later layer means "no opinion;
  keep the earlier value."

The merge happens once at startup. Implementation may use a library
(`c12` from UnJS, etc.) or roll its own with a TOML parser
(`smol-toml`, `@iarna/toml`); the spec commits only to the
semantics, not the implementation.

## Environment selection

`NODE_ENV` selects which env-specific file (if any) to load. Common
values: `development`, `production`, `test`. If `NODE_ENV` is unset,
no env-specific file is loaded — just `default.toml` → `local.toml`.

A CLI flag may override `NODE_ENV` at startup; implementation
detail not pinned here.

## Validation

The merged config is validated once at startup, after all layers
are combined. Validation is fatal — the app exits with a non-zero
code on validation failure rather than starting in an undefined
state.

Validation sources:

- **Application sections** (`[server]`, `[storage]`, `[scheduler]`,
  `[probes]`, `[[paths]]`): schema lives in app code; the version
  in `default.toml` is the documentation-by-example.
- **Rule sections** (`[rules.<rule_name>]`): each rule's `defaults`
  block (per `SIGNAL_RULES.md`) is the implicit schema for its
  namespace. Keys not in `defaults` are accepted silently — useful
  for rules that take arbitrary user-defined sub-keys (e.g.
  `block_page_hostnames`).

Implementation may use Zod, valibot, or a hand-written validator.
Choice of library is not part of the spec.

## The schema

The sections below describe every section the app reads. Examples
are illustrative TOML fragments; the full annotated `default.toml`
appears at the end of the doc.

### `[server]`

SvelteKit / HTTP server settings.

```toml
[server]
host = "127.0.0.1"          # bind interface
port = 5173                 # listen port
log_level = "info"          # trace | debug | info | warn | error
```

### `[storage]`

SQLite database location and retention.

```toml
[storage]
db_path = "./data/probes.db"
retention_days = 30          # raw probes; signals are retained indefinitely
```

`db_path` is resolved relative to the process working directory if
not absolute. The directory must exist before startup or the
storage layer will create it on first write — TBD by
implementation.

### `[scheduler]`

Default probe cadences, per check type. Per-target overrides live
in `targets.cadence_override_seconds` (DB) and trump these.

```toml
[scheduler]
http_get_cadence_seconds    = 900     # 15 min
dns_lookup_cadence_seconds  = 300     # 5 min
tcp_connect_cadence_seconds = 300     # 5 min
```

The natural pattern is "lighter probes more often than the rich
one" — DNS and TCP confirm reachability cheaply at higher
frequency while `http_get` runs less often. The defaults above
reflect that.

### `[probes]`

Defaults applied per `http_get` probe. Per-target overrides live in
`targets.probe_config_overrides` (DB JSON) per `STORAGE_SCHEMA.md`,
and trump these. Schema mirrors `data.config.*` from
`PROBE_PAYLOAD.md`.

```toml
[probes]
default_timeout_ms                  = 10000
default_body_snippet_cap_bytes      = 32768
default_impersonation_profile       = "chromium-latest"
default_follow_redirects            = true
default_max_redirects               = 5
default_pinned_http_version         = ""    # "" | "1.1" | "2" | "3"
default_response_headers_captured   = [
  "content-type", "content-length", "location",
  "server", "strict-transport-security",
]
```

Empty string for `default_pinned_http_version` means "no pin —
use the browser's natural choice." TOML has no `null` value type;
empty-string is the convention for "absent" on string fields.

### `[probes.shape_detection]`

The body-shape detector's phrase list (see `PROBE_PAYLOAD.md` for
how these surface in `body.shape_signals`).

```toml
[probes.shape_detection]
unavailability_phrases = [
  "unavailable in your region",
  "not available in your country",
  "451",
  "service unavailable",
  "blocked",
  "Access Denied",
]
```

Phrases are matched as case-insensitive substrings against the
body snippet, in `unavailability_phrases_matched`. The list is
user-extensible per host language / target population.

### `[[paths]]` — the path list

Array of tables. Each entry defines one path per the contract in
`PATH_DEPLOYMENTS.md`.

```toml
# The direct baseline. `proxy_url` omitted — the app interprets
# absence as "no proxy; use the host's default routing."
[[paths]]
name        = "direct"
role        = "direct"
tags        = []
description = "Host's default routing"

# A vantage path through a VPN.
[[paths]]
name        = "corp-vantage"
proxy_url   = "socks5h://localhost:10801"
role        = "vantage"
tags        = ["vpn", "openconnect"]
description = "OpenConnect tunnel via corp gateway"

# An obfuscation path running SpoofDPI on localhost.
[[paths]]
name        = "spoofdpi-local"
proxy_url   = "socks5h://localhost:10802"
role        = "obfuscation"
tags        = ["userspace", "tls-fragment"]
description = "SpoofDPI with default fragmentation"
```

Validation rules:

- Exactly one entry SHOULD have `role = "direct"` and omit
  `proxy_url`. Multiple direct paths is permitted but unusual; zero
  direct paths emits a warning at startup.
- A `proxy_url` is required for `role` values `vantage` and
  `obfuscation`. Missing → fatal.
- A `proxy_url` for `role = "direct"` is a contradiction. Present
  on a direct entry → fatal.
- `name` values must be unique within the merged path list.
- `proxy_url` SHOULD use the `socks5h://` scheme per
  `PATH_DEPLOYMENTS.md`. `socks5://` is accepted but warned.

Because path definitions are user-specific and often reference
local ports, `[[paths]]` typically lives in `local.toml` rather
than `default.toml`. `default.toml` ships with no path entries and
relies on `local.toml` to supply them; absent any path entries the
app warns at startup.

### `[rules.<rule_name>]` — per-rule config

One sub-section per signal rule, following `SIGNAL_RULES.md`. Each
rule documents its keys and defaults in its catalogue entry. Two
keys every rule implicitly accepts:

- **`enabled`** (`bool`, default `true`) — set to `false` to skip
  the rule.
- **Confidence keys** — `confidence` or `confidence_initial` /
  `confidence_full`, per the rule's shape.

Example overriding a few rules in `local.toml`:

```toml
[rules.tls_handshake_hang]
min_consecutive    = 5
confidence_initial = 0.5

[rules.tls_close_notify_missing]
enabled = false      # noisy on my network

[rules.dns_private_ip_returned]
private_resolution_expected_hostnames = ["git.internal", "kibana.internal"]
```

`default.toml` ships with every catalogue rule's defaults written
out explicitly — so users see the full surface and can override
any key.

## Secrets handling

**Secrets never go in the TOML files.** Path-side credentials (VPN
passwords, TOTP seeds, Hysteria auth, etc.) follow the patterns in
`PATH_DEPLOYMENTS.md`:

- **Pattern A** (plaintext `.env`) — env vars passed to the proxy
  containers via Docker Compose's `.env` file.
- **Pattern B** (local secret store wrapper) — host-side wrapper
  reads from `pass` (GPG-backed; works headless via `gpg-agent`) or
  `secret-tool` (libsecret-backed; needs an active keyring session),
  exports env vars, then brings containers up.
- **Pattern C** (Docker secrets) — file-mounted secrets at
  `/run/secrets/<name>` inside the container.

The application config knows about path *names* and SOCKS5 URLs;
it does not see the credentials the proxies use. Future
configuration knobs that would otherwise be sensitive (LLM API
keys, webhook tokens) similarly pull from env vars at runtime, not
from config files.

## Reload semantics

**v0: no hot-reload.** Config is loaded once at startup. Changes to
any layer require a process restart to take effect.

Restart-to-apply is annoying for a long-running monitor but trivial
to implement and reason about. Hot-reload introduces a class of
"some changes applied, some didn't" partial-state bugs that aren't
worth dealing with in v0.

Future work — sketched, not committed:

- **SIGHUP-triggered reload** — re-read all layers and apply
  changes. Easy for scalar values (tuning, log level), tricky for
  structural changes (adding a path means spinning up a new probe
  worker; changing cadence means re-arming the scheduler).
- **File-watcher reload** — same as SIGHUP but automatic. Risk of
  reload-on-half-edited-file unless debounced.

When this becomes a concrete need, it'll merit its own design
pass. Until then: edit, restart, done.

## Adding new config keys

When does the config schema grow?

- **A new application module** that needs configuration adds a new
  section to `default.toml` and validates it in app code. Document
  the section in this file.
- **A new signal rule** declares its `defaults` block in code
  (per `SIGNAL_RULES.md`). The implicit schema is automatic; adding
  the section to `default.toml` is documentation-by-example and is
  best-practice but not strictly required (the in-code `defaults`
  cover the safety net).
- **A user-defined sub-key inside an existing rule's section**
  (e.g. `block_page_hostnames`) — already covered by the rule's
  `defaults`; just edit `local.toml`.

## Worked example: full `default.toml`

The file shipped in the repo. Edited to be a runnable example; the
real one may evolve over time.

```toml
# config/default.toml
# Baseline configuration. DO NOT put secrets or machine-specific
# settings here — use config/local.toml (gitignored) for those.

# ───────────────────────────────────────────────────────────────
# Server
# ───────────────────────────────────────────────────────────────
[server]
host      = "127.0.0.1"
port      = 5173
log_level = "info"     # trace | debug | info | warn | error

# ───────────────────────────────────────────────────────────────
# Storage
# ───────────────────────────────────────────────────────────────
[storage]
db_path        = "./data/probes.db"
retention_days = 30    # raw probes; signals indefinite

# ───────────────────────────────────────────────────────────────
# Scheduler
# ───────────────────────────────────────────────────────────────
[scheduler]
http_get_cadence_seconds    = 900   # 15 min
dns_lookup_cadence_seconds  = 300   # 5 min
tcp_connect_cadence_seconds = 300   # 5 min

# ───────────────────────────────────────────────────────────────
# Probe defaults (per-target overrides in DB beat these)
# ───────────────────────────────────────────────────────────────
[probes]
default_timeout_ms                = 10000
default_body_snippet_cap_bytes    = 32768
default_impersonation_profile     = "chromium-latest"
default_follow_redirects          = true
default_max_redirects             = 5
default_pinned_http_version       = ""     # "" | "1.1" | "2" | "3"
default_response_headers_captured = [
  "content-type", "content-length", "location",
  "server", "strict-transport-security",
]

[probes.shape_detection]
unavailability_phrases = [
  "unavailable in your region",
  "not available in your country",
  "451",
  "service unavailable",
  "blocked",
  "Access Denied",
]

# ───────────────────────────────────────────────────────────────
# Paths — define in local.toml; the app warns if this list is empty
# ───────────────────────────────────────────────────────────────
# [[paths]]
# name        = "direct"
# role        = "direct"
# tags        = []
# description = "Host's default routing"

# ───────────────────────────────────────────────────────────────
# Signal rules — see SIGNAL_RULES.md for the catalogue
# ───────────────────────────────────────────────────────────────

[rules.tls_handshake_hang]
min_consecutive    = 3
window_minutes     = 30
confidence_initial = 0.7
confidence_full    = 0.95

[rules.tls_closed_during_handshake]
confidence = 0.95

[rules.tls_cert_invalid]
min_consecutive = 2
confidence      = 0.9

[rules.tls_close_notify_missing]
window_size     = 10
threshold_ratio = 0.7
confidence      = 0.6

[rules.dns_nxdomain_persistent]
min_consecutive = 3
confidence      = 0.9

[rules.dns_private_ip_returned]
private_resolution_expected_hostnames = []
confidence                            = 0.95

[rules.target_returned_4xx]
codes_of_interest = [403, 404, 451]
min_consecutive   = 2
confidence        = 0.85

[rules.target_returned_5xx]
min_consecutive = 2
confidence      = 0.85

[rules.unavailability_phrase_matched]
confidence = 0.75

[rules.js_cul_de_sac]
confidence = 0.7

[rules.target_unreachable_all_paths]
window_minutes = 30
confidence     = 0.9

[rules.path_specific_failure]
window_minutes = 30
confidence     = 0.85

[rules.dns_answers_diverge]
window_minutes = 30
confidence     = 0.7

[rules.tls_cert_fingerprint_diverges]
window_minutes = 30
confidence     = 0.95

[rules.latency_anomaly]
baseline_window_days = 7
k_stddev             = 3
min_consecutive      = 3
confidence           = 0.6
```

## Worked example: a user's `local.toml`

What a real personal-use override file might look like.

```toml
# config/local.toml — machine-specific. NOT committed.

[server]
port = 8080            # I already use 5173 for something else

# ───────────────────────────────────────────────────────────────
# Paths — the canonical list lives here, not in default.toml
# ───────────────────────────────────────────────────────────────

[[paths]]
name        = "direct"
role        = "direct"
tags        = []
description = "Home network, no proxy"

[[paths]]
name        = "corp-vantage"
proxy_url   = "socks5h://localhost:10801"
role        = "vantage"
tags        = ["vpn", "openconnect", "eu-exit"]
description = "Work VPN, EU egress via TOTP-protected AnyConnect"

[[paths]]
name        = "spoofdpi-local"
proxy_url   = "socks5h://localhost:10802"
role        = "obfuscation"
tags        = ["userspace", "tls-fragment"]
description = "SpoofDPI on localhost"

[[paths]]
name        = "tor-random"
proxy_url   = "socks5h://localhost:10804"
role        = "vantage"
tags        = ["tor", "random-exit", "slow"]
description = "Tor with default directory authorities"

# ───────────────────────────────────────────────────────────────
# Rule tuning
# ───────────────────────────────────────────────────────────────

[rules.tls_handshake_hang]
# My ISP has flaky TLS; tolerate a few more failures before firing.
min_consecutive    = 5
confidence_initial = 0.5

[rules.tls_close_notify_missing]
enabled = false        # too noisy on this network

[rules.dns_private_ip_returned]
# Intranet hostnames that resolve to RFC1918 legitimately.
private_resolution_expected_hostnames = ["git.internal", "kibana.internal"]
```

## Deferred / open

- **Hot-reload** (SIGHUP / file watcher) — sketched in "Reload
  semantics" above. Pick up when restart-to-apply becomes an actual
  pain point.
- **CLI overrides** — accepting `--<section>.<key>=<value>` flags
  as a layer above `local.toml`. Useful for ops / scripting but
  not load-bearing for v0.
- **Environment-variable interpolation** — `${VPN_USER}` style
  substitution inside TOML strings. Tempting for path config but
  conflicts with the principle that secrets stay out of config
  files; if needed, narrow it to non-secret values only.
- **Per-target probe-config overrides** stored in the DB
  (`targets.probe_config_overrides` JSON) — already specified in
  `STORAGE_SCHEMA.md`; cross-referenced here only for clarity.
- **Validation library choice** (Zod vs. valibot vs. hand-rolled)
  — implementation detail; pick during build.

---

*Status: v0 draft.*
