# Storage Schema Specification (v0)

## What this document is

A companion to `ARCHITECTURE.md` and `PROBE_PAYLOAD.md`. It specifies
the SQLite schema that persists probe records, user-managed targets,
and rule-produced signals. Every scheduler tick writes one row to
`probes`; every rule evaluation may insert or update a row in
`signals`; targets are added / edited / removed via the dashboard's
management forms.

Backed by **`node:sqlite`** (per `ARCHITECTURE.md`). The schema keeps a
small set of hot columns for query speed and indexing, with the full
probe record preserved as a JSON blob in the `probes.payload` column
— this lets the payload schema evolve (new check-types, new per-op
fields) without storage migrations in most cases.

## Tables

Three core tables plus one convention sidecar:

| Table | Purpose | Source of writes |
|---|---|---|
| `targets` | User-managed monitoring targets | Dashboard management forms |
| `probes` | One row per `(target, path, check_type)` probe execution | Probe engine |
| `signals` | Rule-produced observations | Signals engine |
| `schema_migrations` | Applied migration versions | Startup migration runner |

Paths are **not** stored in the DB — they live in the configuration
file, per `ARCHITECTURE.md`. Each probe denormalises its chosen
path's `name` and `role` into `probes.path_name` / `probes.path_role`
for query speed; the full path record (including `tags`) stays in
the payload envelope.

## `schema_migrations` (convention)

```sql
CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL          -- ISO 8601 UTC
);
```

Migrations are numbered ascending integers. Each migration is a
single SQL script applied atomically at startup; the version is
recorded here after success. Startup is a no-op when the highest
version in the table equals the highest migration shipped in the
binary.

## `targets`

User-managed.

```sql
CREATE TABLE targets (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  url                      TEXT    NOT NULL UNIQUE,
  label                    TEXT    NOT NULL,
  created_at               TEXT    NOT NULL,            -- ISO 8601 UTC
  updated_at               TEXT    NOT NULL,            -- ISO 8601 UTC
  enabled                  INTEGER NOT NULL DEFAULT 1,  -- 0/1 boolean
  cadence_override_seconds INTEGER,                      -- NULL = use global default
  probe_config_overrides   TEXT                          -- JSON blob, nullable
);

CREATE INDEX idx_targets_enabled ON targets (enabled);
```

### `probe_config_overrides`

JSON blob (stored as TEXT; read via SQLite's JSON1 functions). Holds
per-target overrides for any `http_get.config.*` fields — typically
`timeout_ms`, `body_snippet_cap_bytes`, `impersonation_profile`,
`pinned_http_version`, `response_headers_captured`. Example:

```json
{
  "timeout_ms": 30000,
  "impersonation_profile": "firefox-125"
}
```

The probe engine merges these over the global defaults at dispatch
time. JSON rather than individual columns by design: overrides aren't
queried, they're read once per probe; flexibility wins.

## `probes`

The central table. One row per probe execution.

```sql
CREATE TABLE probes (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id             INTEGER NOT NULL
                          REFERENCES targets(id) ON DELETE CASCADE,
  path_name             TEXT    NOT NULL,       -- denormalised from payload.path.name
  path_role             TEXT    NOT NULL        -- denormalised from payload.path.role
                          CHECK (path_role IN ('direct','vantage','obfuscation')),
  check_type            TEXT    NOT NULL
                          CHECK (check_type IN ('http_get','dns_lookup','tcp_connect')),
  started_at            TEXT    NOT NULL,       -- ISO 8601 UTC; mirrors payload.started_at
  runtime_ms            INTEGER NOT NULL,       -- mirrors payload.runtime_ms
  reached_stage         TEXT    NOT NULL,       -- enum from payload.data.reached_stage
  first_failure_code    TEXT,                    -- derived; NULL on full success
  final_status_code     INTEGER,                 -- http_get only; else NULL
  impersonation_profile TEXT,                    -- http_get only; else NULL
  payload               TEXT    NOT NULL        -- full JSON per PROBE_PAYLOAD.md
);

CREATE INDEX idx_probes_target_path_time
  ON probes (target_id, path_name, started_at DESC);

CREATE INDEX idx_probes_time
  ON probes (started_at DESC);

CREATE INDEX idx_probes_failure
  ON probes (first_failure_code)
  WHERE first_failure_code IS NOT NULL;
```

### Hot columns vs. JSON blob

Every hot column is a duplicate of something present in the payload.
The duplication buys query speed:

- Matrix-view "latest probe per `(target, path_name)`" uses
  `idx_probes_target_path_time` without touching JSON.
- Signal-rule windows over recent probes use `idx_probes_time`
  without JSON.
- Failure-code filters use partial `idx_probes_failure`.

Any query needing richer fields (`peer_certificates`, body snippet,
specific hop details, body `shape_signals`, etc.) reads the JSON
column via SQLite's JSON1 functions (`json_extract`, `->`, `->>`).

### `first_failure_code` derivation

At probe-insert time, the engine walks the payload's per-operation
records in execution order and extracts the first non-null `failure`
string. For `http_get`, the walk is:

```
for hop in data.hops:
  for op in [dns, tcp, tls, http.request, http.response, body]:
    if op.failure is not null: return op.failure
return null
```

For `dns_lookup`, over `data.queries[].failure`. For `tcp_connect`,
over `data.queries[].failure` first, then
`data.tcp_connect[].status.failure`.

`reached_stage` and `first_failure_code` are always consistent:
`reached_stage == "complete"` implies `first_failure_code IS NULL`
and vice versa.

### `final_status_code` and `impersonation_profile`

Both are http_get-specific and `NULL` for other check types. The
column types accept NULL without constraint; semantics are enforced
at the application layer.

- `final_status_code` extracts `payload.data.rollup.final_status_code`.
- `impersonation_profile` extracts `payload.data.config.impersonation_profile`.

### `payload` storage

Stored as `TEXT` — SQLite's JSON1 functions operate on TEXT. On
SQLite ≥3.45, switching to `BLOB` with the JSONB binary format yields
~30% storage savings and faster JSON-path lookups. Not adopted in
v0 because:

1. **Raw-SQL readability.** `sqlite3 probes.db`, DB Browser, and
   other SQLite clients display TEXT JSON as human-readable strings;
   JSONB columns show as binary unless every read wraps in
   `json(payload)`. The "ssh in, run sqlite3, grep around" debugging
   path matters on a home server (same rationale that drove TEXT
   ISO 8601 datetimes).
2. **SQLite version requirement.** JSONB landed in SQLite 3.45.
   Node 26's bundled SQLite is recent enough, but any external
   tooling that opens the file (system `sqlite3`, backup scripts,
   future ORM utilities) needs ≥3.45.
3. **Unidirectional migration.** TEXT → JSONB requires a one-shot
   column rewrite, and so does the reverse. Not catastrophic at our
   row counts, just friction.

Revisit when DB file size becomes a concrete problem.

## `signals`

Rule outputs. Each row is one named rule's judgment about a target.

```sql
CREATE TABLE signals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id     INTEGER NOT NULL
                  REFERENCES targets(id) ON DELETE CASCADE,
  rule_name     TEXT    NOT NULL,
  status        TEXT    NOT NULL
                  CHECK (status IN ('active','cleared'))
                  DEFAULT 'active',
  confidence    REAL    NOT NULL
                  CHECK (confidence >= 0.0 AND confidence <= 1.0),
  fired_at      TEXT    NOT NULL,    -- first firing
  last_seen_at  TEXT    NOT NULL,    -- most recent firing or clearing observation
  cleared_at    TEXT,                 -- NULL while active
  evidence      TEXT    NOT NULL     -- JSON; rule-defined shape
);

-- At most one ACTIVE signal per (target, rule).
CREATE UNIQUE INDEX idx_signals_active_unique
  ON signals (target_id, rule_name)
  WHERE status = 'active';

CREATE INDEX idx_signals_target_status
  ON signals (target_id, status);

CREATE INDEX idx_signals_active_fired_at
  ON signals (fired_at DESC)
  WHERE status = 'active';
```

### Lifecycle

A rule evaluating a target produces one of three outcomes:

1. **Fire, new.** No active signal exists for `(target_id, rule_name)`.
   Insert a new row with `status='active'`, `fired_at=now`,
   `last_seen_at=now`.
2. **Fire, continuing.** An active signal already exists. Update
   `last_seen_at=now` (don't touch `fired_at`). Optionally refresh
   `confidence` and `evidence`.
3. **Clear.** An active signal exists and the rule no longer matches.
   Update `status='cleared'`, `cleared_at=now`.

Cleared signals are retained for history. Auto-expiry is deliberately
not supported — if a rule's condition is still true, the signal
should stay active; if a rule never clears when it should, that's a
rule bug to fix, not something the storage layer should mask.

### `evidence` JSON

Free-form, owned by the rule. Common shape:

```json
{
  "probe_ids": [42817, 42823, 42831],
  "observation": "Response size truncated at 18 KB across 3 probes."
}
```

The `probe_ids` key is a convention, not a schema requirement —
rules may reference probes however they like, or omit them for
aggregation rules (e.g. time-series statistics).

## Datetime convention

All datetime columns are `TEXT`, storing UTC ISO 8601 with
millisecond precision: `"2026-04-20T12:34:56.789Z"`. Always
fixed-width, so lexicographic ordering equals chronological ordering.

SQLite does not enforce the format; the application layer does.
`ORDER BY started_at` works correctly as string comparison.

## Retention

Default policy (v1):

- **`probes`**: retained for **30 days**. A daily cleanup job deletes
  rows where `started_at < datetime('now', '-30 days')` (SQLite
  datetime functions work on ISO 8601 strings). Retention is
  configurable via the global config file (`retention_days`).
- **`signals`**: retained **indefinitely**. Row volume is tiny; the
  history is informative.
- **`targets`**: no retention (user-managed).

### Why 30 days raw and no rollups in v1

Napkin: 15-min cadence × 5 paths × 10 targets × 3 check types ≈
14,400 probes/day. Thirty days ≈ 430,000 rows. Row size ~2-10 KB
average (dominated by body snippet). Total: 1-4 GB. Fine for SQLite,
fine for a home server.

If a deployment ever pushes well past these parameters and hits
DB-size pain, the v2 addition is a rollup strategy (hourly / daily
summary tables, payloads dropped, aggregated stats kept). Not in v0
scope.

## Query patterns the schema is optimised for

The index set targets these dashboard and signal-engine workloads:

**Matrix view** — latest probe for a `(target, path_name, check_type)`
triple:

```sql
SELECT * FROM probes
WHERE target_id = ? AND path_name = ? AND check_type = ?
ORDER BY started_at DESC LIMIT 1;
```

Covered by `idx_probes_target_path_time`.

**Per-target recent history** — all probes for target X in the last N
minutes:

```sql
SELECT * FROM probes
WHERE target_id = ? AND started_at > ?
ORDER BY started_at DESC;
```

Covered by `idx_probes_target_path_time` (prefix match).

**Recent failures across all targets**:

```sql
SELECT * FROM probes
WHERE first_failure_code IS NOT NULL
  AND started_at > ?
ORDER BY started_at DESC;
```

Covered by `idx_probes_failure` + `idx_probes_time`.

**Active signals for a target**:

```sql
SELECT * FROM signals
WHERE target_id = ? AND status = 'active';
```

Covered by `idx_signals_target_status`.

**Global active-signals feed** — dashboard live view:

```sql
SELECT * FROM signals
WHERE status = 'active'
ORDER BY fired_at DESC;
```

Covered by `idx_signals_active_fired_at`.

## What this schema does NOT optimise

Acknowledged to set expectations; these become v2+ concerns:

- **Full-text search on body snippets.** Not indexed. Dashboard body
  drill-ins read the JSON column directly; fine at human scale but
  doesn't scale to "find every probe where the body contains X."
  Candidate for SQLite FTS5 virtual table in a later iteration.
- **Cross-target aggregations.** No rollup tables. Queries like "what
  percentage of my targets were reachable in the last 24 hours" scan
  a day of `probes`; fine at 14k rows/day, would suffer at higher
  cadences / more targets.
- **Cross-path comparisons within a single scheduler tick.** A signal
  rule wanting "direct vs. vantage for target X at the same tick"
  does it in application code after fetching both rows. No
  query-side join that understands the "tick" concept.

## Deferred / open

- **Rollups and summary tables.** v2, if DB size or query time
  become real pains.
- **FTS5 on body snippets.** v2.
- **Configurable per-target retention.** Currently global; may want
  per-target overrides for a "keep forever" flag on specific
  long-term probes.
- **Signal history archive.** `signals` currently holds both active
  and historical rows (status-flagged). If history grows large we
  may archive cleared signals to a side table. Not urgent.
- **Index tuning.** The initial index set is conservative; if
  real workload shows unused indexes or missing coverage, trim or
  add.

---

*Status: v0 draft.*
