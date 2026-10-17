# Changelog

All notable changes to the published packages (`@aliloraf/parallel-sdk`,
`@aliloraf/parallel-engine`, `@aliloraf/parallel-cli`) are documented here.
The packages share one version and follow semantic versioning; while the
version is 0.x, breaking changes bump the minor version.

## 0.1.0 — unreleased

First packaged release.

### Added

- Three npm packages built from the workspace: the scenario SDK, the
  exploration/replay engine, and the CLI.
- `parallel-sim` command (`@aliloraf/parallel-cli`) with `test`, `replay`,
  `--help` and `--version`; `.mts` scenario files; actionable errors when a
  TypeScript scenario cannot be loaded.
- Compiled JavaScript, type declarations and self-contained source maps.
- Apache License 2.0.

### Changed

- Node.js 22.18.0 or later is required (native TypeScript type stripping).
- The built-in `inventory-buggy` and `inventory-fixed` demos ship with the CLI.

### Removed

- The deprecated, unused `RunResult` type.

### Engine and SDK features included in this release

Deterministic schedule exploration with bounds; invariant checking; versioned
failure traces and replay; actor lifecycle management with stall detection and
cooperative cancellation (`context.signal`); nondeterminism detection; replay
divergence classification; structural trace validation.
