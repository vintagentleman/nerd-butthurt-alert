# Tooling and Conventions (v0)

## What this document is

A companion to the other sub-documents. It covers the **developer-
side toolchain** — formatters, linters, type checkers, test runner,
package manager, Git hooks, commit conventions, push policy —
distinct from `ARCHITECTURE.md`, which covers the runtime stack.

The pitch: declare every tool and convention up-front so future
work (by the user or any agent) inherits a consistent
environment without per-file rediscovery.

## Stack at a glance

| Concern | Pick |
|---|---|
| Runtime (reference) | Node.js 26 |
| Package manager | pnpm |
| TypeScript | latest stable, strict |
| Editor settings | EditorConfig |
| Linter (TS/JS) | ESLint 10+ flat config + `typescript-eslint` |
| Formatter | Prettier |
| Markdown linter | `markdownlint-cli2` |
| Type checker | `tsc --noEmit` |
| Test runner | Vitest |
| Commit linter | `commitlint` + `@commitlint/config-conventional` |
| Git hooks | Native via `core.hooksPath` + `.githooks/` + `prepare` script |
| CI | none |
| Dependency updates | manual |
| Spellcheck | none |

## EditorConfig

A committed `.editorconfig` at the repo root locks the basics
across editors:

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
indent_style = tab
indent_size = 4              # display width for tabs in editors
insert_final_newline = true
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false   # preserve double-space line breaks
```

Prettier respects EditorConfig settings (`useTabs`, `tabWidth`,
`endOfLine`), so tab character and width propagate automatically
without restating in `.prettierrc`.

## Package manager: pnpm

`pnpm` over npm/yarn/bun because:

- Stricter dependency graph — no phantom-dep imports of transitive
  packages.
- Content-addressable store — smaller disk footprint, faster
  installs once warm.
- Mature workspace support, should we ever need it.

Pin in `package.json`:

```json
{
  "packageManager": "pnpm@<latest>",
  "engines": {
    "node": ">=26.0.0"
  }
}
```

The `packageManager` field enforces the chosen manager via Corepack;
contributors using a different one get a clear error.

## TypeScript

Latest stable. A standalone `tsconfig.json` (no framework to extend):

```jsonc
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "isolatedModules": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "module": "nodenext",
    "target": "esnext"
  }
}
```

`strict` + `noUncheckedIndexedAccess` together are the meaningful
upgrade over a casual setup; they catch the bulk of common bugs.
`erasableSyntaxOnly` exists because `node src/index.ts` runs on Node's
native type stripping, which rejects enums, namespaces and parameter
properties at runtime — `tsc` rejects them first.

## ESLint

ESLint 10+ flat config (`eslint.config.js`). Required plugin:

- **`typescript-eslint`** (v8+) for TS rules
- **`eslint-plugin-simple-import-sort`** — imports and exports sorted,
  autofixable (`eslint --fix`)

ESLint's job is **lint** (correctness, smells, bug patterns), not
**format**. Formatting is Prettier's job; stylistic rules in ESLint
(quotes, spacing, etc.) are explicitly disabled where they'd
overlap.

Flat config sketch:

```js
import js from "@eslint/js";
import ts from "typescript-eslint";

export default [
  js.configs.recommended,
  ...ts.configs.strict,
  {
    rules: {
      // project-specific rules
    },
  },
];
```

## Prettier

Prettier (latest). Tab character and width come from `.editorconfig`
— no need to repeat. Prettier's defaults are the point; no
`.prettierrc` beyond defaults is needed, and any later addition stays
minimal.

## markdownlint-cli2

Markdown linting for `*.md` files (spec docs in this repo are
non-trivial). Project config (`.markdownlint-cli2.jsonc`):

```jsonc
{
  "config": {
    "default": true,
    "MD013": false         // line-length: disabled (let editor wrap)
  },
  "globs": ["**/*.md"],
  "ignores": ["node_modules"]
}
```

## Type checking (`tsc`)

`tsc --noEmit` is the type checker — there's no `svelte-check` (no
Svelte, no templates). Run it across the whole project in the
pre-commit hook (fast at this size) and in the dev loop via
`tsc --noEmit --watch`.

## Vitest

Vitest as the test runner. Picked over Node's built-in `node --test`
because:

- Handles TypeScript and ESM transforms out of the box, so test
  imports resolve identically to runtime imports without extra
  config.
- DX gains (UI mode, watch mode, snapshots) that `node --test`
  doesn't match yet.

(`node --test` is a fine fallback if Vitest ever feels heavy for a
backend-only project; not worth switching for v0.)

Layout convention: tests colocated next to source as `*.test.ts`.
Coverage via `@vitest/coverage-v8`.

## Browser support

Not applicable. The application is a backend service plus a
Prometheus `/metrics` endpoint; there is no shipped browser code (see
`ARCHITECTURE.md`). Grafana — the only browser-facing surface — is a
third-party app the user runs and keeps current; its own browser
support is out of this project's hands. The earlier `browserslist`
Baseline policy and its linters (`stylelint-plugin-use-baseline`,
`eslint-plugin-compat`) are removed along with the custom frontend.

## Commit conventions

Strict **Conventional Commits**, enforced via `commitlint` in the
`commit-msg` Git hook. Plain rules:

- **Subject format:** `type(scope): description`
- **Allowed types** (subset of CC spec):
  `feat`, `fix`, `refactor`, `docs`, `test`, `perf`, `chore`,
  `build`
- **Allowed scopes** (project-specific, extensible):
  `probe`, `signals`, `metrics`, `storage`, `config`, `path`,
  `grafana`, `tooling`, `docs`, `deps`
- **Subject length:** ≤ 72 chars, no trailing period.
- **Body:** optional and **terse**. Required only when the *why*
  is non-obvious from the diff or subject. Bodies that just
  re-state the diff are noise; omit them.
- **No `Co-Authored-By:` trailers.** Whether the commit was
  authored by hand or with agent assistance, the trailer is not
  used in this project.
- **No `Signed-off-by:` either** (we don't run a DCO process).

`commitlint.config.js` — overrides on top of `config-conventional`
(everything else inherits from the upstream config):

```js
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Narrow the upstream type list (drops "ci", "revert", "style").
    "type-enum": [2, "always", [
      "feat", "fix", "refactor", "docs", "test", "perf", "chore", "build",
    ]],
    // config-conventional has no scope-enum; we add one.
    "scope-enum": [2, "always", [
      "probe", "signals", "metrics", "storage", "config",
      "path", "grafana", "tooling", "docs", "deps",
    ]],
    // config-conventional makes scope optional; we require it.
    "scope-empty": [2, "never"],
    // config-conventional defaults to 100; we cut to 72.
    "subject-max-length": [2, "always", 72],
  },
};
```

## Git hooks

Git's native hooks via `core.hooksPath`, **not** lefthook or husky.
For a single-developer project with our scope, the third-party
tools add a dep without buying anything we need.

### Bootstrap

A single `prepare` script in `package.json` configures the hooks
directory on first install:

```json
{
  "scripts": {
    "prepare": "git config core.hooksPath .githooks && chmod -R +x .githooks"
  }
}
```

`pnpm install` runs `prepare` automatically. A fresh clone is
ready to commit after one install.

### `.githooks/pre-commit`

Runs `pnpm check`, the single whole-project gate: `tsc --noEmit`,
ESLint (`--max-warnings 0`), Prettier check, markdownlint, Vitest.
Whole-project, not staged-only: at this size the full run takes
seconds, and staged-only filtering misses cross-file breakage.

```sh
#!/bin/sh
set -e
pnpm check
```

### `.githooks/commit-msg`

Rejects `Co-Authored-By:` trailers, then runs `commitlint`:

```bash
#!/usr/bin/env bash
set -euo pipefail

if grep -iq '^Co-Authored-By:' "$1"; then
  echo "Co-Authored-By: trailer is not permitted in this project." >&2
  exit 1
fi

pnpm commitlint --edit "$1"
```

Both files committed to the repo, executable bit set by the
`prepare` script's `chmod -R +x .githooks`.

## Push policy

**Agents never autopush.** Any `git push` (or `git push --force`,
or any push variant) requires explicit human approval at the
prompt before execution. Enforced via `.claude/settings.json`
permissions — push commands are not in any auto-allow list and
trip the user-approval prompt by default.

This document records the policy; the enforcement lives in
settings.

## What's intentionally out of scope (v0)

- **CI / GitHub Actions / GitLab CI.** Pre-commit hooks are
  enough for a single-developer personal project. Re-evaluate if
  the project grows to multi-contributor or the user starts
  pushing from machines that haven't run `pnpm install`.
- **Renovate / Dependabot.** Default-noisy for a personal
  project. Manual `pnpm outdated` review when the user feels like
  it.
- **Spellcheck (`typos`, `cspell`).** Not worth the friction at
  this size.
- **`CLAUDE.md`.** Deferred until implementation begins — it'll
  consolidate the durable conventions for future agents (this push
  policy, the commit policy, the project structure, etc.) in one
  place. All substance specs are now drafted; CLAUDE.md follows.

## Deferred / open

- **`CLAUDE.md`** once spec docs are complete. Will reference and
  summarise this document.
- **CI workflow** if cross-machine consistency ever matters.

---

*Status: v0 draft.*
