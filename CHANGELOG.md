# Changelog

Changes to the published packages (`@aliloraf/parallel-sdk`, `@aliloraf/parallel-engine` and `@aliloraf/parallel-cli`). The three packages share one version number and follow semantic versioning; while the version is 0.x, breaking changes increase the minor version.

## 0.1.0 (unreleased)

The first release. Nothing has been published to npm yet.

### Features

- Scenario SDK: `defineScenario`, checkpoints, invariants, and a per-run `AbortSignal` for cooperative cancellation.
- Depth-first exploration of checkpoint interleavings, bounded by `maxSchedules` and `maxSteps`, with an optional `stopOnFailure`.
- Versioned failure traces (schema 1), deterministic replay, and structured reports when a replay diverges.
- Structural trace validation (`validateTrace`, `InvalidTraceError`).
- Stall detection with a per-step timeout, bounded teardown, and reporting of actor work that could not be settled.
- Detection of scenarios that behave differently when a schedule is re-run.
- The `parallel-sim` command, with `test`, `replay`, `--json`, `--trace-out`, `--help` and `--version`, `.ts`, `.mts`, `.js` and `.mjs` scenarios, and explanations when a TypeScript scenario can't be loaded.
- Built-in demo scenarios `inventory-buggy` and `inventory-fixed`.

### Packaging

- Compiled JavaScript, type declarations and self-contained source maps; ES modules that can also be loaded with `require()`.
- Requires Node.js 22.18.0 or later, for its built-in TypeScript type stripping.
- Licensed under the Apache License 2.0.
- The deprecated, unused `RunResult` type was removed before the release.

### Documentation

- Guides for writing scenarios and for contributing, alongside the design documents on execution, nondeterminism, replay and packaging.
