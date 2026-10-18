# Changelog

Changes to the published packages (`@aliloraf/parallel-sdk`, `@aliloraf/parallel-engine` and `@aliloraf/parallel-cli`). The three packages share one version number and follow semantic versioning; while the version is 0.x, breaking changes increase the minor version.

## 0.1.0

The first release.

### Features

- Scenario SDK: `defineScenario`, checkpoints, invariants, and a per-run `AbortSignal` for cooperative cancellation.
- Depth-first exploration of checkpoint interleavings, bounded by `maxSchedules` and `maxSteps`, with an optional `stopOnFailure`.
- Versioned failure traces (schema 1), deterministic replay, and structured reports when a replay diverges.
- Structural trace validation (`validateTrace`, `InvalidTraceError`).
- Stall detection with a per-step timeout, bounded teardown, and reporting of actor work that could not be settled.
- Detection of scenarios that behave differently when a schedule is re-run.
- The `parallel-sim` command, with `test`, `replay`, `--json`, `--max-schedules`, `--max-steps`, `--step-timeout`, `--trace-out`, `--help` and `--version`, and `.ts`, `.mts`, `.js` and `.mjs` scenarios.
- Strict argument parsing: unknown, unsupported, repeated or malformed options and extra arguments are rejected before any scenario code runs.
- Exit statuses that distinguish passing (0), failures (1), invalid usage or input (2), incomplete exploration (3), nondeterminism or replay divergence (4) and runtime errors (5).
- A versioned JSON report (`reportVersion` 1) with `result` and `exitCode` for both commands, structured error reports with stable error codes, and scenario output redirected to stderr so that stdout holds only the report.
- Text output that shows actor errors, explains incomplete exploration, and summarizes replays; scenario load errors that point to the file and line.
- Uncaught errors and unhandled rejections from scenario code are reported as runtime errors instead of crashing the CLI.
- Built-in demo scenarios `inventory-buggy` and `inventory-fixed`.

### Packaging

- Compiled JavaScript, type declarations and self-contained source maps; ES modules that can also be loaded with `require()`.
- Requires Node.js 22.18.0 or later, for its built-in TypeScript type stripping.
- Licensed under the Apache License 2.0.
- The deprecated, unused `RunResult` type was removed.

### Changes since the development versions

These affect anyone who used the CLI from the repository before 0.1.0:

- Incomplete exploration now exits with 3 instead of 1, nondeterminism and replay divergence with 4 instead of 1, and engine failures with 5 instead of 2.
- `replay` prints text by default; use `--json` for the JSON result.
- Unknown and repeated options are errors instead of being ignored.

### Documentation

- Guides for writing scenarios and for contributing, alongside the design documents on execution, nondeterminism, replay and packaging.
