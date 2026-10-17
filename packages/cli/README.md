# @aliloraf/parallel-cli

`parallel-sim`, the command-line runner for **Parallel** concurrency
scenarios.

> **Not yet published.** This package is prepared for its first npm release (0.1.0) but is not on npm yet. Until then, install it from a local build: see [Install from a local build](https://github.com/Aliloraf/parallel#install-from-a-local-build-until-the-first-npm-release).

Once published:

```bash
npm install --save-dev @aliloraf/parallel-cli @aliloraf/parallel-sdk
npx parallel-sim test scenarios/last-item.ts
npx parallel-sim test scenarios/last-item.ts --trace-out traces/last-item.json
npx parallel-sim replay traces/last-item.json scenarios/last-item.ts
```

## Commands

```text
parallel-sim test <scenario> [--json] [--max-schedules N] [--step-timeout MS] [--trace-out PATH]
parallel-sim replay <trace> [scenario] [--step-timeout MS]
parallel-sim --help | --version
```

`<scenario>` is a `.ts`, `.mts`, `.js` or `.mjs` module that exports a scenario
(default export, or a named `scenario` export), or one of the built-in demos
`inventory-buggy` and `inventory-fixed`.

| Exit status | Meaning |
|---|---|
| 0 | Exploration complete with no failures, or a replay reproduced a passing trace. |
| 1 | Failures found, exploration incomplete (bound, stall, nondeterminism, abandoned work), or a replay reproduced a failure or diverged. |
| 2 | Usage error, invalid scenario or trace, or an engine failure. |

## TypeScript scenarios

Scenarios run directly on Node.js's built-in type stripping (Node.js 22.18 or
later), with no build step and no extra dependencies. That requires:

- erasable syntax only: no `enum`, `namespace` or constructor parameter properties;
- `import type` for type-only imports;
- explicit `.ts` extensions on relative imports (`import { x } from './app.ts'`).

For code that does not meet these constraints, register your own TypeScript
loader, for example `NODE_OPTIONS=--import=tsx npx parallel-sim test ...`.

Scenario files are executed as **trusted code**; Parallel does not sandbox
them. Traces may contain application data. See the
[project documentation](https://github.com/Aliloraf/parallel#readme).

Licensed under Apache-2.0.
