# Changelog

Changes to the published packages (`@aliloraf/parallel-sdk`, `@aliloraf/parallel-engine` and `@aliloraf/parallel-cli`). The three packages share one version number and follow semantic versioning; while the version is 0.x, breaking changes increase the minor version.

## 0.2.0

Application-level concurrency testing: using Parallel on business logic you already have, rather than on scenarios written from scratch.

### Added

- `@aliloraf/parallel-sdk`: `attempt(operation, isExpected)` and the `Attempt<T>` type. An expected application rejection becomes scenario data, so the schedule keeps a normal outcome and its invariants are still evaluated instead of being skipped as an `actor_error`. The predicate is required; `SimulationCancelledError`, non-`Error` thrown values and anything the predicate rejects are always re-thrown as the original value. This is the only change to any published package, and it is purely additive.
- `examples/shop/`: a worked order service with three concurrency bugs — inventory overselling, duplicate payment processing, double reservation — each with a corrected implementation, and a deterministic in-memory store with an explicit atomicity contract. Its application layer imports no Parallel package; instrumentation is an optional, guarded checkpoint callback.
- [Testing application code](docs/07-testing-application-code.md): the practical guide to instrumenting existing functions, capturing expected errors, and the detect, replay, fix and validate workflow.

### Changed

- [Writing scenarios](docs/06-writing-scenarios.md) recommends a guarded optional callback (`pause?: Pause`) over a no-op default, so an uninstrumented call awaits nothing extra.
- The README's limitations are stated more precisely: concurrent branches within one actor are unsupported, real external side effects are repeated once per schedule, and deadlocks surface as stalls.

### Upgrading from 0.1.0

0.1.0 keeps working and is not withdrawn; upgrade when you want `attempt()`.

- **No application code changes are required.** The update is additive: two new SDK exports, with nothing removed and no signature changed. Existing scenarios, traces and CLI invocations behave exactly as before.
- **Update the versions you declare.** Raise the Parallel entries in your `package.json` (or your dependency ranges, for example from `^0.1.0` to `^0.2.0`) and reinstall; an unchanged `^0.1.0` range resolves to 0.1.x, which does not contain `attempt()`.
- **Keep the three packages on compatible 0.2.x versions.** They share one version number, and the engine and CLI both declare the SDK as a peer at `^0.2.0`, so a mixed 0.1.x/0.2.x installation is not supported. The CLI depends on engine `0.2.0` exactly.
- `attempt` and `Attempt` are new names in `@aliloraf/parallel-sdk`. Nothing is imported automatically, so existing code is unaffected, but a module that already defines its own `attempt` or `Attempt` and wants the SDK's as well needs to alias one of them, as in `import { attempt as attemptStep } from '@aliloraf/parallel-sdk'`.

No engine, CLI, trace-schema (version 1) or JSON report (`reportVersion` 1) change.

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
