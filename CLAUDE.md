# CLAUDE.md

Durable, agent-facing conventions for `nerd-butthurt-alert`. This file is
the quick-reference; the full v0 specs in `docs/specs/` are the source of
truth — when this file and a spec disagree, the spec wins and this file is
stale and should be fixed.

## Spec is source of truth

`docs/specs/` (`ARCHITECTURE`, `OBSERVABILITY`, `PROBE_PAYLOAD`,
`STORAGE_SCHEMA`, `SIGNAL_RULES`, `CONFIG_FILE`, `PATH_DEPLOYMENTS`,
`TOOLING`) is the design. Implementation conforms to the specs, not the
other way round. Plans under `docs/superpowers/plans/` only sequence and
operationalise what the specs already say — they don't introduce new
design decisions.

## Vertical slice, don't chase surface

Milestone 1 builds the thinnest end-to-end path that runs and is
observable (one target, direct path, `http_get` → SQLite → `/metrics` →
Prometheus). Breadth (more check types, proxied paths, the rule
catalogue, Grafana) is layered on afterward, milestone by milestone. This
ordering is deliberate: it's the hedge against the project's standing
failure mode — chasing an unbounded surface (full probe fidelity, the
19-rule catalogue, exhaustive coverage) before anything runs end-to-end.
Don't front-load later-milestone scope into an earlier task because it
seems related; defer it explicitly instead.

## Toolchain

pnpm, TypeScript strict (`nodenext` + `verbatimModuleSyntax` +
`allowImportingTsExtensions` — intra-repo imports use the `.ts`
extension), ESLint 10 flat config + `typescript-eslint`, Prettier,
`markdownlint-cli2`, Vitest, `commitlint`. No CI, no Renovate/Dependabot,
no spellcheck — single-developer personal project, re-evaluate only if
that changes. Full rationale: `docs/specs/TOOLING.md`.

## Git hooks

Native Git hooks via `core.hooksPath`, not lefthook/husky. The `prepare`
script in `package.json` runs `git config core.hooksPath .githooks` on
every `pnpm install`, so a fresh clone is hook-ready after one install.
`.githooks/pre-commit` and `.githooks/commit-msg` must be executable
(`chmod +x .githooks/*`) — re-run that if hooks ever stop firing.

- `pre-commit`: `eslint . --max-warnings 0`, `prettier --check .`,
  `tsc --noEmit`, `vitest run`. All must pass before a commit lands.
- `commit-msg`: rejects any `Co-Authored-By:` trailer, then runs
  `commitlint --edit`.

## Commit policy

Strict Conventional Commits, enforced by `commitlint`:

- Subject: `type(scope): description`, ≤ 72 chars, no trailing period.
- Types: `feat`, `fix`, `refactor`, `docs`, `test`, `perf`, `chore`,
  `build`.
- Scopes (required, one of): `probe`, `signals`, `metrics`, `storage`,
  `config`, `path`, `grafana`, `tooling`, `docs`, `deps`.
- Body optional and terse — only when the _why_ isn't obvious from the
  diff/subject; never a restatement of the diff.
- **No `Co-Authored-By:` trailer, ever** — rejected by the `commit-msg`
  hook regardless of who/what authored the commit. No `Signed-off-by:`
  either (no DCO process here).

## Push policy

**Never push.** No agent runs `git push` (or any push variant,
force or otherwise) without the user explicitly doing it themselves at
the prompt. Commit and stop; pushing is a human action in this project.

## Layered config model

Runtime config is TOML, layered and merged once at startup (no
hot-reload in v0 — restart to apply changes):

1. In-code defaults (e.g. each signal rule's `defaults` block) — safety
   net if `default.toml` is missing or partial.
2. `config/default.toml` — committed canonical baseline.
3. `config/<NODE_ENV>.toml` — optional, only if `NODE_ENV` is set and the
   file exists.
4. `config/local.toml` — gitignored, always wins last.

Tables deep-merge by key; scalars override outright; **arrays replace
entirely** (a later layer's `[[paths]]`/`[[targets]]` does not append —
it replaces the whole list, so example entries in `default.toml` never
leak into a real deployment). Validated once at startup with Zod;
validation failure is fatal (non-zero exit), never a half-started
process.

**What lives in config, not the DB:** targets, paths, per-rule tuning,
shape-detection phrase lists — anything static and operator-authored.
**What lives in the DB, not config:** only `probes` and `signals` rows
(see `docs/specs/STORAGE_SCHEMA.md`). **What lives in neither, ever:**
secrets — path-side credentials come from env vars / `pass` /
`secret-tool` / Docker secrets per `docs/specs/PATH_DEPLOYMENTS.md`,
never written into a TOML file. Full schema: `docs/specs/CONFIG_FILE.md`.

## The `nba_` metric contract

The service's only external interface is `GET /metrics` (Prometheus text
exposition, via `prom-client` + `node:http`, no web framework). Every
metric is prefixed `nba_`.

- **Gauges** (`*_up`, `*_reached_stage`, `*_latency_ms`,
  `*_last_timestamp_seconds`, `signal_active`, `signal_confidence`)
  reflect current state: seeded from SQLite at startup, then updated
  in-process on each probe/signal write. A scrape never queries SQLite.
- **Counters** (`*_total`) accumulate in-process from zero each process
  start; Prometheus's `rate()`/`increase()` are reset-aware so no
  seeding is needed.
- **Allowed labels, full stop:** `target`, `path`, `check_type`, `rule`,
  `outcome`, `code` — all low-cardinality, bounded by config or a fixed
  enum. `target` is the configured target **name**, never its URL.
- **Never a label:** probe id, signal id, timestamps, full URLs, body
  snippets, latency values, IP addresses, free-form evidence — those are
  evidence and live in SQLite (Grafana's SQLite datasource reads them
  directly, read-only). If something tempts a high-cardinality label,
  that's the signal to put it in SQLite instead.

Full inventory and the `reached_stage` ordinal mapping:
`docs/specs/OBSERVABILITY.md`.
