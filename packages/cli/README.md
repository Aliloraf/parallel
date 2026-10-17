# @aliloraf/parallel-cli

`parallel-sim`, the command-line runner for [Parallel](https://github.com/Aliloraf/parallel) scenarios.

> Not published yet. Version 0.1.0 is ready but not on npm; until it is, [install it from a local build](https://github.com/Aliloraf/parallel#installation). After the release: `npm install --save-dev @aliloraf/parallel-cli @aliloraf/parallel-sdk`.

With the CLI installed in your project:

```bash
npx --no parallel-sim test scenarios/last-item.ts
npx --no parallel-sim test scenarios/last-item.ts --trace-out traces/last-item.json
npx --no parallel-sim replay traces/last-item.json scenarios/last-item.ts
```

## Usage

```text
parallel-sim test <scenario> [--json] [--max-schedules N] [--step-timeout MS] [--trace-out PATH]
parallel-sim replay <trace> [scenario] [--step-timeout MS]
parallel-sim --help | --version
```

`<scenario>` is a `.ts`, `.mts`, `.js` or `.mjs` file whose default export (or `scenario` export) is a scenario, or one of the built-in demos `inventory-buggy` and `inventory-fixed`. `--trace-out` writes the first failing schedule, if there is one. `replay` needs the scenario file again unless the trace comes from a built-in demo.

| Exit status | Meaning |
|---|---|
| 0 | Exploration completed without failures, or a replayed trace passed. |
| 1 | Failures found, exploration incomplete (a bound, a stall, nondeterminism or abandoned work), or a replay reproduced a failure or diverged. |
| 2 | Usage error, invalid scenario or trace, or an engine failure. |

`npx --no` runs the CLI installed in the current project and fails instead of installing anything when it isn't there; without `--no`, npx would offer to install an unrelated `parallel-sim` package from the registry. With `--no`, options that come before a subcommand need a `--`: `npx --no parallel-sim -- --help`.

## TypeScript scenarios

Scenarios run on Node.js's built-in type stripping (Node.js 22.18 or later), so there is no build step. That means erasable syntax only (no `enum`, `namespace` or constructor parameter properties), `import type` for type-only imports, and `.ts` extensions in relative imports. Otherwise, write the scenario in JavaScript or bring your own loader, for example `NODE_OPTIONS=--import=tsx npx --no parallel-sim test ...`. See [writing scenarios](https://github.com/Aliloraf/parallel/blob/main/docs/06-writing-scenarios.md).

Scenario files run as trusted code, without a sandbox. Traces may contain application data.

Apache License 2.0.
