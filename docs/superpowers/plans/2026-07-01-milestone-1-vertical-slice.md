# Milestone 1 — Vertical Slice

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development
>
> Execute this plan task-by-task with SDD. Each task is a closed TDD loop:
> write the failing test, run it and watch it fail for the right reason,
> implement the minimum to pass, run it green, typecheck + lint, commit. Do
> not start a task before its predecessor is committed. Do not push.

**Source of truth:** the v0 specs in `docs/specs/` (ARCHITECTURE,
OBSERVABILITY, PROBE_PAYLOAD, STORAGE_SCHEMA, CONFIG_FILE, PATH_DEPLOYMENTS,
TOOLING). Where this plan and a spec disagree, the spec wins — stop and
reconcile before coding.

---

## Goal

A running service that, on a schedule, probes one configured target over the
**direct** network path with `http_get`, persists each probe to SQLite,
exposes Prometheus `/metrics`, and is scraped by a local Prometheus you can
open in a browser. The thinnest end-to-end spine: config → scheduler → probe
→ storage → metrics → scrape.

## Architecture (this slice)

```
config/*.toml ──▶ loadConfig ──▶ AppConfig (Zod-validated)
                                     │
                 ┌───────────────────┼───────────────────┐
                 ▼                   ▼                   ▼
          openDatabase         buildRegistry        startScheduler
          + runMigrations      + seedMetrics         (croner)
                 │                   │                   │
                 │                   │                   │ every N s
                 │                   ▼                   ▼
                 │            startExporter        buildSweep(deps)
                 │            (node:http /metrics)   for each target × path:
                 │                                     runHttpGet (Playwright)
                 │                                       │
                 │                                       ▼
                 │                              deriveProbeColumns
                 ▼                                       │
            insertProbe ◀──────────────────────────────┘
                 │
                 ▼
        applyProbeToMetrics (gauges + counters)
```

`buildSweep` is the testable seam — the integration test drives it directly
with a tiny in-process target and the direct path, asserting a DB row landed
and metrics moved.

## Tech stack

- **Runtime:** Node.js ≥ 26 (native TS execution, stable `node:sqlite`).
- **Lang:** TypeScript 5.7+, strict, ESM, `nodenext` resolution.
- **Deps:** `croner` ^9, `playwright` ^1.50, `prom-client` ^15, `smol-toml`
  ^1.4, `zod` ^4.
- **Dev:** `typescript` ^5.7, `typescript-eslint` ^8, `eslint` ^10,
  `@eslint/js`, `prettier` ^3, `vitest` ^3, `@vitest/coverage-v8`,
  `@types/node`, `@commitlint/cli` + `@commitlint/config-conventional` ^19,
  `markdownlint-cli2`.
- **Storage:** `node:sqlite` `DatabaseSync`, WAL.
- **Pkg mgr:** pnpm 11.9.0.

## Global constraints (apply to every task)

- **Node ≥ 26.** The dev machine must be on Node 26 before any test runs
  (`node:sqlite` is unstable/absent earlier and native TS execution is
  required). `engines.node` enforces it; CI/local must match.
- **pnpm 11.9.0**, pinned via `packageManager`.
- **No `Co-Authored-By:` trailers** in commit messages. The project forbids
  them and the `commit-msg` hook rejects them. This overrides any default
  trailer behaviour.
- **Never `git push`.** Agents commit only; pushing is a human action.
- **No secrets in TOML config.** Proxy credentials / tokens come from env
  vars only. v0 paths are no-auth SOCKS5, so this is mostly a forward rule.
- **Metric prefix `nba_`** on every series. Label set is fixed and low
  cardinality: `target`, `path`, `check_type`, `rule`, `outcome`, `code`.
  Never label with a raw URL, hop, or timestamp.
- **Allowed commit scopes:** `probe`, `signals`, `metrics`, `storage`,
  `config`, `path`, `grafana`, `tooling`, `docs`, `deps`. `scope-empty` is
  forbidden — every commit names a scope.
- **`/metrics` default bind:** `127.0.0.1:9974`, path `/metrics`.

## File structure (end state of M1)

```
.
├── .editorconfig
├── .gitignore
├── .githooks/
│   ├── pre-commit
│   └── commit-msg
├── .markdownlint-cli2.jsonc
├── .prettierrc.json
├── CLAUDE.md
├── commitlint.config.js
├── docker-compose.yml
├── eslint.config.js
├── package.json
├── prometheus.yml
├── tsconfig.json
├── vitest.config.ts
├── config/
│   ├── default.toml          # config/local.toml is gitignored
│   └── local.toml.example    # copy to local.toml for the demo
└── src/
    ├── index.ts              # entry: main()
    ├── app.ts                # buildSweep(deps), main()
    ├── app.test.ts           # integration smoke
    ├── smoke.test.ts         # T1 sanity
    ├── config/
    │   ├── defaults.ts       # DEFAULT_CONFIG
    │   ├── merge.ts          # deepMerge
    │   ├── schema.ts         # Zod schemas
    │   ├── load.ts           # loadConfig, finalizeConfig
    │   └── *.test.ts
    ├── storage/
    │   ├── db.ts             # openDatabase + pragmas
    │   ├── migrate.ts        # runMigrations
    │   ├── migrations/001_init_probes.ts
    │   ├── derive.ts         # deriveFirstFailureCode, deriveProbeColumns
    │   ├── probes.ts         # insertProbe, latestProbesPerCell
    │   └── *.test.ts
    ├── probe/
    │   ├── types.ts          # CheckType, ProbePayload (http_get subset)...
    │   ├── failure.ts        # mapNetError
    │   ├── shape.ts          # detectShapeSignals
    │   ├── http_get.ts       # runHttpGet
    │   ├── probeConfig.ts    # mergeProbeConfig
    │   ├── testServer.ts     # node:http fixture
    │   └── *.test.ts
    ├── scheduler/
    │   ├── scheduler.ts      # secondsToCronPattern, startScheduler
    │   └── scheduler.test.ts
    └── metrics/
        ├── registry.ts       # buildRegistry
        ├── update.ts         # setProbeGauges, applyProbeToMetrics
        ├── seed.ts           # seedMetrics
        ├── exporter.ts       # startExporter
        └── *.test.ts
```

---

## Task 1 — Scaffold + toolchain

**Why first:** nothing runs until the toolchain, TS config, and hooks exist.
This task ends with `pnpm test` green on a trivial smoke test and the hooks
live.

**TDD loop:** write `src/smoke.test.ts` → `pnpm test` fails (no vitest yet
installed / no config) → add the config files + install → `pnpm test` green.

### Files

`package.json`:

```json
{
  "name": "nerd-butthurt-alert",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.9.0",
  "engines": { "node": ">=26" },
  "scripts": {
    "start": "node src/index.ts",
    "dev": "node --watch src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "md:lint": "markdownlint-cli2 \"**/*.md\"",
    "prepare": "git config core.hooksPath .githooks"
  },
  "dependencies": {
    "croner": "^9.0.0",
    "playwright": "^1.50.0",
    "prom-client": "^15.1.3",
    "smol-toml": "^1.4.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@commitlint/cli": "^19.0.0",
    "@commitlint/config-conventional": "^19.0.0",
    "@eslint/js": "^10.0.0",
    "@types/node": "^22.0.0",
    "@vitest/coverage-v8": "^3.0.0",
    "eslint": "^10.0.0",
    "markdownlint-cli2": "^0.18.0",
    "prettier": "^3.4.0",
    "typescript": "^5.7.0",
    "typescript-eslint": "^8.0.0",
    "vitest": "^3.0.0"
  }
}
```

> `@types/node` major may lag Node 26; pin to the newest published major at
> implementation time. The `prepare` script wires `core.hooksPath` on every
> `pnpm install` so hooks are live without manual setup.

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "esnext",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "lib": ["esnext"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "esModuleInterop": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts", "*.config.ts", "*.config.js"]
}
```

`eslint.config.js`:

```js
import js from '@eslint/js';
import ts from 'typescript-eslint';

export default ts.config(
  { ignores: ['node_modules', 'data', 'coverage'] },
  js.configs.recommended,
  ...ts.configs.strict,
  ...ts.configs.stylistic,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
);
```

`.editorconfig`:

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
trim_trailing_whitespace = true
indent_style = tab
indent_size = 4

[*.{json,yml,yaml,toml,md}]
indent_style = space
indent_size = 2
```

`.prettierrc.json`:

```json
{
  "useTabs": true,
  "tabWidth": 4,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "overrides": [
    {
      "files": ["*.json", "*.yml", "*.yaml", "*.toml", "*.md"],
      "options": { "useTabs": false, "tabWidth": 2 }
    }
  ]
}
```

`.markdownlint-cli2.jsonc`:

```jsonc
{
  "config": {
    "default": true,
    "MD013": false,
    "MD024": { "siblings_only": true },
    "MD033": false,
  },
  "globs": ["**/*.md"],
  "ignores": ["node_modules", "docs/superpowers"],
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    coverage: { provider: 'v8', include: ['src/**/*.ts'], exclude: ['src/**/*.test.ts'] },
  },
});
```

`commitlint.config.js`:

```js
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-empty': [2, 'never'],
    'scope-enum': [
      2,
      'always',
      [
        'probe',
        'signals',
        'metrics',
        'storage',
        'config',
        'path',
        'grafana',
        'tooling',
        'docs',
        'deps',
      ],
    ],
    'subject-max-length': [2, 'always', 72],
  },
};
```

`.githooks/pre-commit` (mode `0755`):

```sh
#!/bin/sh
set -e
pnpm exec eslint . --max-warnings 0
pnpm exec prettier --check .
pnpm exec tsc --noEmit
pnpm exec vitest run
```

`.githooks/commit-msg` (mode `0755`):

```sh
#!/bin/sh
set -e
if grep -qiE '^\s*Co-authored-by:' "$1"; then
  echo "commit-msg: Co-Authored-By trailers are forbidden in this project." >&2
  exit 1
fi
pnpm exec commitlint --edit "$1"
```

`.gitignore`:

```gitignore
node_modules/
/data/
config/local.toml
coverage/
*.log
.superpowers/
```

`src/smoke.test.ts`:

```ts
import { expect, test } from 'vitest';

test('toolchain runs typescript tests', () => {
  const xs: readonly number[] = [1, 2, 3];
  expect(xs.reduce((a, b) => a + b, 0)).toBe(6);
});
```

`CLAUDE.md` — durable agent-facing conventions distilled from `TOOLING.md`:
push policy (never push), commit policy (Conventional Commits, the scope
enum, no `Co-Authored-By`), the `core.hooksPath` setup, the layered-config
model, the `nba_` metric contract, the spec-is-source-of-truth rule, and the
"vertical slice, don't chase surface" principle from the roadmap.

### Steps

1. Write `src/smoke.test.ts`. Run `pnpm test` → fails (no vitest).
2. Create every config file above. `pnpm install`. `chmod +x .githooks/*`.
   Confirm `git config core.hooksPath` reads `.githooks`.
3. `pnpm test` → green. `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
   `pnpm md:lint` → all clean.
4. Commit: `chore(tooling): scaffold project, toolchain, and git hooks`.
   (Verify the `pre-commit` hook actually ran.)

---

## Task 2 — Config loader

**Why:** every other component takes config. Build the layered TOML loader +
Zod validation now, covering `[metrics] [storage] [scheduler] [probes]
[probes.shape_detection] [[paths]] [[targets]]`. **Field names match
`CONFIG_FILE.md` exactly.** This is the M1 *subset*: schemas type only the
keys M1 consumes and are LENIENT (loose objects) so the spec's other
documented keys still load; the full typed surface + a complete `default.toml`
land in a later milestone. Unknown top-level sections (`[rules.*]`, future) are
stripped before validation, not consumed in M1.

**TDD loop:** `src/config/*.test.ts` first.

### `src/config/defaults.ts`

A complete in-code `DEFAULT_CONFIG` object — the merge base. This sidesteps
the Zod-v4 nested-default gotcha (we merge a full object, then validate;
schema defaults are belt-and-suspenders only).

```ts
export const DEFAULT_CONFIG = {
  metrics: { host: '127.0.0.1', port: 9974, path: '/metrics' },
  storage: { db_path: './data/probes.db', retention_days: 30 },
  scheduler: {
    http_get_cadence_seconds: 900,
    dns_lookup_cadence_seconds: 300,
    tcp_connect_cadence_seconds: 300,
  },
  probes: {
    default_timeout_ms: 10000,
    default_impersonation_profile: 'chromium-latest',
    default_body_snippet_cap_bytes: 32768,
    shape_detection: {
      unavailability_phrases: [],
    },
  },
  paths: [{ name: 'direct', role: 'direct' }],
  targets: [],
} as const;
```

### `src/config/merge.ts`

```ts
type Plain = Record<string, unknown>;

const isPlainObject = (v: unknown): v is Plain =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Objects deep-merge; arrays and scalars REPLACE (node-config array semantics). */
export function deepMerge<T extends Plain>(base: T, override: Plain): T {
  const out: Plain = { ...base };
  for (const [k, v] of Object.entries(override)) {
    const cur = out[k];
    out[k] = isPlainObject(cur) && isPlainObject(v) ? deepMerge(cur, v) : v;
  }
  return out as T;
}
```

Tests: nested objects merge; arrays replace wholesale (not concatenated);
scalars override; missing keys fall through to base.

### `src/config/schema.ts`

Zod v4 schemas. Field names match `CONFIG_FILE.md` exactly. Section schemas
are **lenient** (loose objects): they validate the M1-consumed keys and
tolerate the spec's other documented keys (e.g. `[metrics].log_level`;
`[probes].default_follow_redirects`/`default_max_redirects`/
`default_pinned_http_version`/`default_response_headers_captured`;
`[[paths]].tags`/`description`; `[[targets]].label`/`cadence_override_seconds`)
so a spec-compliant `default.toml`/`local.toml` loads without error. M1 code
reads only the typed subset below.

- `metricsSchema`: host string, port int 1–65535, path starts with `/`. Loose.
- `storageSchema`: db_path non-empty, retention_days int ≥ 1. Loose.
  (`busy_timeout` is a hardcoded pragma in `db.ts`, not a config key.)
- `schedulerSchema`: http_get_cadence_seconds / dns_lookup_cadence_seconds /
  tcp_connect_cadence_seconds each int ≥ 1. Loose. (M1 consumes only
  http_get_cadence_seconds.)
- `shapeDetectionSchema`: unavailability_phrases `z.array(z.string())`. Loose.
- `probesSchema`: default_timeout_ms int ≥ 1, default_impersonation_profile
  non-empty string, default_body_snippet_cap_bytes int ≥ 0, shape_detection.
  Loose.
- `pathSchema`: name non-empty, role `z.enum(['direct','vantage','obfuscation'])`,
  optional `proxy_url`. `.superRefine`: `direct` MUST NOT set `proxy_url`;
  `vantage`/`obfuscation` MUST set it. Loose.
- `targetSchema`: name non-empty, `url: z.url()`, `enabled` default true,
  `check_types` default `['http_get']` (enum array), optional
  `probe_overrides` as a loose record of un-prefixed keys (e.g. `timeout_ms`,
  `impersonation_profile`, `body_snippet_cap_bytes`). Loose.
- `appConfigSchema`: object of the above + `paths` array (falls back to the
  in-code direct path), `targets` array. Validates only known sections; the
  loader strips unknown top-level sections (`[rules]`, future) before parse.

### `src/config/load.ts`

```ts
// pseudocode shape — implementer fills in I/O
export function loadConfig(opts?: { configDir?: string; env?: string }): AppConfig {
  const dir = opts?.configDir ?? './config';
  const env = opts?.env ?? process.env.NODE_ENV ?? 'development';

  let merged: Record<string, unknown> = structuredClone(DEFAULT_CONFIG);
  for (const file of ['default.toml', `${env}.toml`, 'local.toml']) {
    const text = tryRead(join(dir, file)); // missing file → skip
    if (text) merged = deepMerge(merged, parseToml(text));
  }

  const known = pick(merged, KNOWN_SECTIONS); // metrics..targets
  const config = appConfigSchema.parse(known); // throws → fatal
  return finalizeConfig(config);
}
```

`finalizeConfig`: fatal on duplicate path names or duplicate target names
(uniqueness); `console.warn` on an empty paths list, a path list with no
`role: 'direct'` entry (per `CONFIG_FILE.md` — distinct from the empty check),
zero enabled targets, or a target with an empty `check_types`. Returns the
validated `AppConfig`.

### Steps

1. Tests for `deepMerge`, each schema's accept/reject cases (esp. the path
   `superRefine` matrix), and `loadConfig` layering with temp dirs. Run →
   fail.
2. Implement `defaults.ts`, `merge.ts`, `schema.ts`, `load.ts`. Run → green.
3. `pnpm typecheck` + `pnpm lint`.
4. Commit: `feat(config): layered TOML loader with Zod validation`.

---

## Task 3 — Storage: open + migrate

**TDD loop:** `src/storage/*.test.ts` against an in-memory / temp-file DB.

### `src/storage/db.ts`

```ts
import { DatabaseSync } from 'node:sqlite';

export function openDatabase(path: string, busyTimeoutMs = 5000): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;'); // load-bearing: concurrent Grafana reads
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs)};`);
  return db;
}
```

### `src/storage/migrate.ts`

```ts
export interface Migration {
  version: number;
  name: string; // for logging only — not stored (schema_migrations has no name column)
  up(db: DatabaseSync): void;
}

export function runMigrations(db: DatabaseSync, migrations: Migration[]): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL          -- ISO 8601 UTC
  );`);
  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((r) => r.version as number),
  );
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue;
    m.up(db);
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
      m.version,
      new Date().toISOString(),
    );
  }
}
```

### `src/storage/migrations/001_init_probes.ts`

The `probes` table + indexes exactly per `STORAGE_SCHEMA.md` (migration
`version = 1`, name `init_probes`):

```sql
CREATE TABLE probes (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  target_name           TEXT    NOT NULL,       -- denormalised; the config target's name
  path_name             TEXT    NOT NULL,       -- from payload.path.name
  path_role             TEXT    NOT NULL        -- from payload.path.role
                          CHECK (path_role IN ('direct','vantage','obfuscation')),
  check_type            TEXT    NOT NULL
                          CHECK (check_type IN ('http_get','dns_lookup','tcp_connect')),
  started_at            TEXT    NOT NULL,       -- ISO 8601 UTC; mirrors payload.started_at
  runtime_ms            INTEGER NOT NULL,       -- mirrors payload.runtime_ms
  reached_stage         TEXT    NOT NULL,       -- payload.data.reached_stage
  first_failure_code    TEXT,                    -- derived; NULL on full success
  final_status_code     INTEGER,                 -- http_get only; else NULL
  impersonation_profile TEXT,                    -- http_get only; else NULL
  payload               TEXT    NOT NULL         -- full JSON per PROBE_PAYLOAD.md
);

CREATE INDEX idx_probes_target_path_time
  ON probes (target_name, path_name, check_type, started_at DESC);
CREATE INDEX idx_probes_time
  ON probes (started_at DESC);
CREATE INDEX idx_probes_failure
  ON probes (first_failure_code)
  WHERE first_failure_code IS NOT NULL;
```

> Copied from `STORAGE_SCHEMA.md` — treat that spec as authoritative if
> anything drifts. `termination_mode`, `final_url`, DNS answers, cert chains,
> etc. live inside the `payload` JSON, **not** as hot columns.

### Steps

1. Tests: opening sets `journal_mode=wal` (query `PRAGMA journal_mode`);
   `runMigrations` is idempotent (run twice, one row in `schema_migrations`);
   table + indexes exist after migrate. Run → fail.
2. Implement. Run → green.
3. Commit: `feat(storage): database open, pragmas, and migration runner`.

---

## Task 4 — Probe types + write/read

### `src/probe/types.ts`

The M1 subset of the `nba-v0` payload — enough for `http_get` direct. Union
literals: `CheckType = 'http_get' | 'dns_lookup' | 'tcp_connect'`;
`PathRole = 'direct' | 'vantage' | 'obfuscation'`; `ReachedStage = 'dns' |
'tcp_connect' | 'tls_handshake' | 'http_request' | 'http_response' |
'body_transfer' | 'complete'`; `TerminationMode = 'clean_fin' | 'rst' |
'timeout' | 'tls_close_notify_missing' | 'body_incomplete'` (all per
`PROBE_PAYLOAD.md`). `ProbePayload` is the `nba-v0` envelope (`schema_version`,
`check_type`, `started_at`, `runtime_ms`, `url`, `path{name,role,tags}`,
`data{config, reached_stage, termination_mode, hops[], rollup, ...}`) — M1
fills the http_get-relevant fields; CDP-only fields are `null`/empty.
`ProbeInsert` is the flat `probes`-row column set from `STORAGE_SCHEMA.md`
(`target_name, path_name, path_role, check_type, started_at, runtime_ms,
reached_stage, first_failure_code, final_status_code, impersonation_profile,
payload`). `ProbeMetricInput` is the subset seeding + `applyProbeToMetrics`
read: `target_name, path_name, check_type, reached_stage, first_failure_code,
runtime_ms, started_at`.

### `src/storage/derive.ts`

```ts
/** First non-null per-op `failure`, walked per STORAGE_SCHEMA.md. For
 *  http_get: for each hop in data.hops, in order [dns, tcp.status, tls,
 *  http.request, http.response, body], return the first `failure`; else null.
 *  Invariant: reached_stage === 'complete' ⇔ first_failure_code IS NULL. */
export function deriveFirstFailureCode(payload: ProbePayload): string | null {
  /* ... */
}

/** Flatten a payload + the target name into the insertable `probes` row.
 *  target_name from the sweep; path_name/path_role from payload.path;
 *  started_at/runtime_ms/check_type from the envelope; reached_stage from
 *  data.reached_stage; first_failure_code via deriveFirstFailureCode;
 *  final_status_code from data.rollup.final_status_code;
 *  impersonation_profile from data.config.impersonation_profile;
 *  payload = JSON.stringify(payload). */
export function deriveProbeColumns(args: { targetName: string; payload: ProbePayload }): ProbeInsert {
  /* ... */
}
```

### `src/storage/probes.ts`

```ts
export function insertProbe(db: DatabaseSync, row: ProbeInsert): void {
  /* prepared INSERT into probes (target_name, path_name, path_role, check_type,
     started_at, runtime_ms, reached_stage, first_failure_code,
     final_status_code, impersonation_profile, payload) */
}

/** Latest probe per (target_name, path_name, check_type) — the exporter's
 *  gauge seed; uses idx_probes_target_path_time. EXACTLY one ProbeMetricInput
 *  per cell at MAX(started_at); ties on started_at are broken deterministically
 *  by MAX(id) (a plain MAX-join would return duplicate rows on a tie). */
export function latestProbesPerCell(db: DatabaseSync): ProbeMetricInput[] {
  // e.g. ROW_NUMBER() OVER (PARTITION BY target_name, path_name, check_type
  //   ORDER BY started_at DESC, id DESC) = 1
}
```

### Steps

1. Tests: `deriveFirstFailureCode` over a clean payload (→ null) and a
   payload with a failing op (→ that code, earliest wins); `deriveProbeColumns`
   maps every column (incl. path_name/path_role from payload.path,
   impersonation_profile/final_status_code from data); `insertProbe`
   round-trips; `latestProbesPerCell` returns one row per cell at the max
   started_at. Run → fail.
2. Implement. Run → green.
3. Commit: `feat(storage): probe insert, latest-per-cell reader, derivations`.

---

## Task 5 — Failure mapping

### `src/probe/failure.ts`

```ts
export interface MappedFailure {
  first_failure_code: string;
  reached_stage: ReachedStage;
}

/** Map a Chromium net::ERR_* string (or Playwright error text) to our
 *  failure code + the stage we reached. Table per PROBE_PAYLOAD.md. */
export function mapNetError(errorText: string): MappedFailure {
  /* ... */
}
```

Reproduce the `net::ERR_*` mapping table from `PROBE_PAYLOAD.md` ("Deriving the
taxonomy from CDP") **exactly**:

| `net::ERR_*` | `first_failure_code` | `reached_stage` |
|---|---|---|
| `ERR_PROXY_CONNECTION_FAILED` | `proxy_connection_failed` | `dns` (pre-connect) |
| `ERR_NAME_NOT_RESOLVED` | `dns_nxdomain` | `dns` |
| `ERR_CONNECTION_REFUSED` | `connection_refused` | `tcp_connect` |
| `ERR_CONNECTION_TIMED_OUT` / `ERR_TIMED_OUT` | `connection_timeout` | `tcp_connect` |
| `ERR_CONNECTION_RESET` | `tls_closed_during_handshake` | `tls_handshake` |
| `ERR_SSL_PROTOCOL_ERROR` | `tls_handshake_failed` | `tls_handshake` |
| `ERR_CERT_DATE_INVALID` | `tls_cert_expired` | `tls_handshake` |
| `ERR_CERT_AUTHORITY_INVALID` | `tls_cert_unknown_ca` | `tls_handshake` |
| `ERR_CERT_COMMON_NAME_INVALID` | `tls_cert_hostname_mismatch` | `tls_handshake` |
| `ERR_EMPTY_RESPONSE` | `http_body_truncated` | `body_transfer` |
| anything else | `unknown_failure` | best-effort (`http_response` floor) |

Notes: `ERR_CONNECTION_RESET` is ambiguous (pre-response →
`tls_closed_during_handshake`; post-headers → `http_body_truncated`). Under M1's
`waitUntil: 'commit'` we can't tell reliably — map bare `ERR_CONNECTION_RESET` →
`tls_closed_during_handshake` / `tls_handshake` and treat it as suggestive.
Playwright's navigation `TimeoutError` (not a `net::ERR_`) → `http_response_timeout`
/ `http_request` (commit timed out before response headers). `ERR_UNSAFE_PORT`
distinct handling and body-stall detection are **M2** — in M1 both fall through
to `unknown_failure`. Match `errorText` on the `net::ERR_*` token (it appears
inside a longer Playwright message), and preserve the raw text on
`unknown_failure`.

### Steps

1. Table-driven test: every documented `ERR_*` → expected
   `{first_failure_code, reached_stage}`; `TimeoutError` text → coarse
   timeout; unknown → generic bucket. Run → fail.
2. Implement. Run → green.
3. Commit: `feat(probe): net::ERR_ failure-code mapping`.

---

## Task 6 — `http_get` via Playwright (direct path)

### `src/probe/shape.ts`

```ts
export interface ShapeSignals {
  is_empty_or_minimal_html: boolean; // <~500 bytes of text after tag-stripping (constant, not config)
  has_meta_refresh: boolean;
  meta_refresh_target: string | null;
  has_js_redirect: boolean;
  js_redirect_target: string | null;
  has_noscript_tag: boolean;
  noscript_text_snippet: string | null; // up to ~200 chars, tag-stripped
  unavailability_phrases_matched: string[];
}

export function detectShapeSignals(
  html: string,
  byteLen: number,
  cfg: ShapeDetectionConfig,
): ShapeSignals {
  /* threshold + regex scans; deterministic, no network. Full shape_signals
     shape per PROBE_PAYLOAD.md; unavailability match is case-insensitive
     substring over cfg.unavailability_phrases. */
}
```

### `src/probe/http_get.ts`

```ts
import { chromium } from 'playwright';

export interface HttpGetArgs {
  url: string;
  timeoutMs: number;
  impersonationProfile: string; // recorded into the payload; M1 always launches Chromium
  bodySnippetCapBytes: number; // cap on the stored body snippet
  proxyUrl: string | null; // null on direct path
  path: { name: string; role: 'direct' | 'vantage' | 'obfuscation'; tags: string[] }; // echoed into the envelope
  shape: ShapeDetectionConfig;
}

export async function runHttpGet(args: HttpGetArgs): Promise<ProbePayload> {
  const browser = await chromium.launch({
    headless: true,
    ...(args.proxyUrl ? { proxy: { server: args.proxyUrl } } : {}),
  });
  try {
    const ctx = await browser.newContext(); // the browser IS the browser — no UA spoofing
    const page = await ctx.newPage();
    try {
      const resp = await page.goto(args.url, { timeout: args.timeoutMs, waitUntil: 'commit' });
      // success path: pull status, final url, body (capped to bodySnippetCapBytes),
      //   securityDetails(), request().timing(), redirectedFrom() chain → ProbePayload;
      //   reached_stage 'complete', termination_mode 'clean_fin';
      //   run detectShapeSignals over the body; record impersonationProfile in the config block.
      return buildSuccessPayload(/* ... */);
    } catch (err) {
      // failure path: mapNetError(String(err)) → reached_stage + first op failure
      return buildFailurePayload(mapNetError(errorTextOf(err)));
    } finally {
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
}
```

M1 uses Playwright's **high-level API only** — no CDP. Per-hop dns/tcp blocks,
full DER cert chains, `network_events`, body-stall byte counting, subresource
health, and engine selection wired to impersonation are all **M2**. M1 always
launches Chromium; `impersonationProfile` is recorded into the payload's config
block but the profile → engine (Chromium/Firefox/WebKit) mapping is M2.

### `src/probe/testServer.ts`

A `node:http` fixture returning, by path: `200` with a small HTML body; `302`
redirect to a second route; and a route that resets/refuses (close socket).
Exposes `start()` → `{ url, close }` on an ephemeral port. Drives both
`http_get.test.ts` and the integration test in T10.

### Steps

1. **Install browser:** `pnpm exec playwright install chromium`.
2. Tests: `detectShapeSignals` unit cases (minimal HTML, meta-refresh,
   js-redirect, phrase match). `runHttpGet` against `testServer`: 200 → status
   200, reached_stage complete, no failure code; 302 → redirect captured;
   refused route → failure payload with the expected `first_failure_code`. Run
   → fail.
3. Implement `shape.ts`, `http_get.ts`, `testServer.ts`. Run → green.
4. Commit: `feat(probe): http_get via Playwright over the direct path`.

---

## Task 7 — Metrics registry + update + seed

### `src/metrics/registry.ts`

```ts
import { Registry, Gauge, Counter, Histogram } from 'prom-client';

export interface Metrics {
  registry: Registry;
  probeUp: Gauge;
  probeReachedStage: Gauge;
  probeLatency: Gauge;
  probeDuration: Histogram;
  probeLastTimestamp: Gauge;
  probesTotal: Counter;
  probeErrors: Counter;
  buildInfo: Gauge;
}

export function buildRegistry(opts: { version: string; nodeVersion: string }): Metrics {
  const registry = new Registry();
  const cell = ['target', 'path', 'check_type'] as const;
  // nba_probe_up{...cell}                gauge 0/1
  // nba_probe_reached_stage{...cell}     gauge (STAGE_ORDINAL)
  // nba_probe_latency_ms{...cell}        gauge
  // nba_probe_duration_ms{...cell}       histogram (buckets per OBSERVABILITY.md)
  // nba_probe_last_timestamp_seconds{...cell} gauge
  // nba_probes_total{...cell, outcome}   counter
  // nba_probe_errors_total{...cell, code} counter
  // nba_build_info{version, node_version} gauge set to 1
  // ...register all to `registry`, set buildInfo.
  return { registry /* ... */ };
}
```

Metric names, types, and labels come from `OBSERVABILITY.md` — reproduce them
exactly (the seven probe series + `nba_build_info{version,node_version}`).
`OBSERVABILITY.md` leaves histogram buckets open ("generic latency set, tune
later"), so use an explicit ms-latency set, e.g.
`[10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000]`.

### `src/metrics/update.ts`

```ts
export const STAGE_ORDINAL: Record<ReachedStage, number> = {
  dns: 0,
  tcp_connect: 1,
  tls_handshake: 2,
  http_request: 3,
  http_response: 4,
  body_transfer: 5,
  complete: 6,
}; // ordinal mapping per OBSERVABILITY.md

/** Gauges only — used both for seeding and within applyProbeToMetrics.
 *  Labels: {target: target_name, path: path_name, check_type}. Sets:
 *  probe_up = reached_stage==='complete' && !first_failure_code ? 1 : 0;
 *  probe_reached_stage = STAGE_ORDINAL[reached_stage];
 *  probe_latency_ms = runtime_ms;
 *  probe_last_timestamp_seconds = Date.parse(started_at) / 1000. */
export function setProbeGauges(m: Metrics, p: ProbeMetricInput): void {
  /* ... */
}

/** Full update on a fresh probe: gauges + counters. */
export function applyProbeToMetrics(m: Metrics, p: ProbeMetricInput): void {
  setProbeGauges(m, p);
  const labels = { target: p.target_name, path: p.path_name, check_type: p.check_type };
  const outcome = p.first_failure_code ? 'failure' : 'success';
  m.probesTotal.inc({ ...labels, outcome });
  if (p.first_failure_code) m.probeErrors.inc({ ...labels, code: p.first_failure_code });
  m.probeDuration.observe(labels, p.runtime_ms);
}
```

### `src/metrics/seed.ts`

```ts
/** Replay the latest probe per cell into the gauges at startup, so
 *  /metrics reflects last-known state before the first new sweep. Gauges
 *  only — counters are in-process lifetime and start at zero. */
export function seedMetrics(m: Metrics, db: DatabaseSync): void {
  for (const p of latestProbesPerCell(db)) setProbeGauges(m, p);
}
```

### Steps

1. Tests: `buildRegistry` exposes every `nba_*` series with the right labels
   (scrape `registry.metrics()` text, assert names); `applyProbeToMetrics`
   sets up=1/0, increments `probes_total{outcome}` and `probe_errors_total{code}`
   correctly; `seedMetrics` replays gauges from a seeded DB without touching
   counters. Run → fail.
2. Implement. Run → green.
3. Commit: `feat(metrics): registry, in-process updates, startup seeding`.

---

## Task 8 — Exporter

### `src/metrics/exporter.ts`

```ts
import { createServer, type Server } from 'node:http';

export function startExporter(
  m: Metrics,
  opts: { host: string; port: number; path: string },
): Server {
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === opts.path) {
      res.writeHead(200, { 'Content-Type': m.registry.contentType });
      res.end(await m.registry.metrics());
      return;
    }
    res.writeHead(404).end('not found');
  });
  server.listen(opts.port, opts.host);
  return server;
}
```

### Steps

1. Test: start on an ephemeral port, `fetch` the metrics path → 200, body
   contains `nba_build_info`; a wrong path → 404. Close the server in
   teardown. Run → fail.
2. Implement. Run → green.
3. Commit: `feat(metrics): node:http /metrics exporter`.

---

## Task 9 — Scheduler

### `src/scheduler/scheduler.ts`

```ts
import { Cron } from 'croner';

/** interval_seconds → a 6-field cron pattern.
 *  <60: must evenly divide 60 (else throw) → `*\/N * * * * *`
 *  ≥60: must be whole minutes (else throw)  → `0 *\/M * * * *` */
export function secondsToCronPattern(seconds: number): string {
  /* ... */
}

/** Wrap a job so overlapping ticks are skipped (belt; croner `protect` is the braces). */
export function makeGuarded(job: () => Promise<void>): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await job();
    } finally {
      running = false;
    }
  };
}

export function startScheduler(intervalSeconds: number, job: () => Promise<void>): Cron {
  const guarded = makeGuarded(job);
  return new Cron(secondsToCronPattern(intervalSeconds), { protect: true }, guarded);
}
```

### Steps

1. Tests: `secondsToCronPattern(30)` → `*/30 * * * * *`; `(60)` →
   `0 */1 * * * *`; `(300)` → `0 */5 * * * *`; non-divisor < 60 (e.g. 7) and
   non-whole-minute ≥ 60 (e.g. 90) throw. `makeGuarded` skips a re-entrant
   call while the first is in flight (drive with a deferred promise). Run →
   fail.
2. Implement. Run → green.
3. Commit: `feat(probe): croner scheduling with no-overlap guard`. (There is
   no `scheduler` scope in the enum; the scheduler drives probe sweeps, so it
   takes the `probe` scope — consistent with T10's wiring commit.)

---

## Task 10 — Wiring + provisioning

### `src/probe/probeConfig.ts`

```ts
/** Resolve the effective probe settings for one target: start from
 *  [probes] defaults (strip the `default_` prefix), overlay the target's
 *  probe_overrides (un-prefixed keys). */
export function mergeProbeConfig(
  probes: ProbesConfig,
  overrides: Record<string, unknown> | undefined,
): { timeoutMs: number; impersonationProfile: string; bodySnippetCapBytes: number } {
  /* ... */
}
```

### `src/app.ts`

```ts
export interface SweepDeps {
  config: AppConfig;
  db: DatabaseSync;
  metrics: Metrics;
  httpGet: (args: HttpGetArgs) => Promise<ProbePayload>; // injectable for tests
}

/** One full sweep: every enabled target × every path it should run on,
 *  http_get only in M1. Each probe is isolated — a throw is caught, logged,
 *  and turned into a failure payload so one bad cell can't sink the sweep. */
export function buildSweep(deps: SweepDeps): () => Promise<void> {
  return async () => {
    for (const target of deps.config.targets) {
      if (!target.enabled) continue;
      if (!target.check_types.includes('http_get')) continue; // M1: http_get is the only check
      for (const path of deps.config.paths) {
        if (path.role !== 'direct') continue; // M1: direct only
        const pc = mergeProbeConfig(deps.config.probes, target.probe_overrides);
        try {
          const payload = await deps.httpGet({
            url: target.url,
            timeoutMs: pc.timeoutMs,
            impersonationProfile: pc.impersonationProfile,
            bodySnippetCapBytes: pc.bodySnippetCapBytes,
            proxyUrl: null,
            path: { name: path.name, role: path.role, tags: path.tags ?? [] },
            shape: deps.config.probes.shape_detection,
          });
          const row = deriveProbeColumns({ targetName: target.name, payload });
          insertProbe(deps.db, row);
          applyProbeToMetrics(deps.metrics, toMetricInput(row));
        } catch (err) {
          // log; insert a synthetic failure probe so the cell still moves
        }
      }
    }
  };
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.storage.db_path);
  runMigrations(db, MIGRATIONS);
  const metrics = buildRegistry({ version: VERSION, nodeVersion: process.version });
  seedMetrics(metrics, db);
  startExporter(metrics, config.metrics);
  const sweep = buildSweep({ config, db, metrics, httpGet: runHttpGet });
  startScheduler(config.scheduler.http_get_cadence_seconds, sweep);
  await sweep(); // run once immediately so /metrics is populated before the first tick
}
```

### `src/index.ts`

```ts
import { main } from './app.ts';

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
```

### `config/default.toml`

Spec field names per `CONFIG_FILE.md`. The M1-subset of the app-level sections;
`[[paths]]`/`[[targets]]` are commented (they live in `local.toml`, and the app
warns when the merged lists are empty). The in-code `DEFAULT_CONFIG` supplies
the `direct` path as a safety net.

```toml
[metrics]
host      = "127.0.0.1"
port      = 9974
path      = "/metrics"
log_level = "info"     # trace | debug | info | warn | error (accepted; not wired in M1)

[storage]
db_path        = "./data/probes.db"
retention_days = 30    # raw probes; signals indefinite (cleanup job is M2)

[scheduler]
http_get_cadence_seconds    = 900   # 15 min (M1 consumes this one)
dns_lookup_cadence_seconds  = 300   # 5 min (consumed from M2)
tcp_connect_cadence_seconds = 300   # 5 min (consumed from M2)

[probes]
default_timeout_ms             = 10000
default_impersonation_profile  = "chromium-latest"   # M1 always launches Chromium
default_body_snippet_cap_bytes = 32768

[probes.shape_detection]
unavailability_phrases = [
  "unavailable in your region",
  "not available in your country",
  "unavailable for legal reasons",
  "service unavailable",
  "blocked",
  "Access Denied",
]

# Paths and targets live in config/local.toml (see config/local.toml.example).
# default.toml ships none; the app warns if the merged lists are empty.
# [[paths]]
# name = "direct"
# role = "direct"

# [[targets]]
# name        = "example"
# url         = "https://example.com/"
# check_types = ["http_get"]
```

### `config/local.toml.example`

Committed (only `config/local.toml` is gitignored) so the demo is one copy
away — `cp config/local.toml.example config/local.toml`:

```toml
[[paths]]
name = "direct"
role = "direct"

[[targets]]
name        = "example"
url         = "https://example.com/"
label       = "Example"
check_types = ["http_get"]
```

### `prometheus.yml`

```yaml
global:
  scrape_interval: 30s
scrape_configs:
  - job_name: nerd-butthurt-alert
    static_configs:
      - targets: ['host.docker.internal:9974']
```

### `docker-compose.yml` (M1: Prometheus only; full stack is M5)

```yaml
services:
  prometheus:
    image: prom/prometheus:latest
    ports:
      - '9090:9090'
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml:ro
    extra_hosts:
      - 'host.docker.internal:host-gateway' # Linux: reach the host service
```

### `src/app.test.ts` — integration smoke

Wire a tiny `AppConfig` (in-memory or temp-file DB, one target pointing at
`testServer`'s 200 route, the single direct path), build the registry, build
the sweep with the **real** `runHttpGet`, run one sweep, then assert: (a) one
row exists in `probes` for that cell with no `first_failure_code`; (b)
`registry.metrics()` text shows `nba_probe_up{...}=1` and
`nba_probes_total{...outcome="success"}` incremented. This exercises the whole
spine end-to-end.

### Steps

1. Write `src/app.test.ts`. Run → fail.
2. Implement `probeConfig.ts`, `app.ts`, `index.ts`; add `config/default.toml`,
   `config/local.toml.example`, `prometheus.yml`, `docker-compose.yml`. Run →
   green.
3. Manual demo: `cp config/local.toml.example config/local.toml`, `pnpm start`,
   then `docker compose up -d`, open `http://localhost:9090`, graph
   `nba_probe_up`. Confirm a data point.
4. `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm md:lint`.
5. Commit: `feat(probe): wire sweep, entrypoint, and Prometheus provisioning`.

---

## Milestone exit criteria

- `pnpm start` runs a sweep on schedule, writes probes to SQLite, and serves
  `/metrics` on `127.0.0.1:9974`.
- `docker compose up` brings up Prometheus, which scrapes the host service;
  `nba_probe_up` / `nba_probe_latency_ms` are graphable for the configured
  target.
- All of `pnpm test`, `typecheck`, `lint`, `format:check`, `md:lint` pass;
  hooks enforce them.
- Every commit used an allowed scope and carries no `Co-Authored-By` trailer.

## Verification pass (milestone boundary)

Before declaring M1 done, run a spec↔implementation conformance audit:
the `probes` DDL matches `STORAGE_SCHEMA.md`; metric names/labels/buckets
match `OBSERVABILITY.md`; the failure-code table matches `PROBE_PAYLOAD.md`;
config sections match `CONFIG_FILE.md`. Then an adversarial code-review of the
full diff. Anything that drifts from a spec is a bug, not a new decision.
