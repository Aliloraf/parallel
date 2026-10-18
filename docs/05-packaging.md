# Packaging and publishing

This document explains how the three packages are put together, how that is verified, and how to publish them. Users install them from npm or, for unreleased versions, from locally built tarballs, as the [README](../README.md#installation) describes.

## Packages

| Package | Depends on | Exports |
|---|---|---|
| `@aliloraf/parallel-sdk` | nothing | `defineScenario`, `SimulationCancelledError`, and the types `Scenario`, `Actor`, `Invariant`, `StepContext` |
| `@aliloraf/parallel-engine` | peer: sdk `^0.1.0` | `explore`, `replay`, `validateTrace`, `leavesAbandonedWork`, `InvalidTraceError`, `ExecutionError`, `DEFAULT_STEP_TIMEOUT_MS`, and the trace and result types |
| `@aliloraf/parallel-cli` | engine `0.1.0`; peer: sdk `^0.1.0` | the `parallel-sim` command; nothing importable |

The engine and the CLI take the SDK as a peer dependency so that scenarios, engine and CLI share a single copy of it; with regular dependencies, a version mismatch could install two copies, and `instanceof SimulationCancelledError` would then fail in user code. npm installs missing peers automatically. All three packages share one version, and the CLI pins the engine exactly.

Each package's `exports` map contains only its entry point (`.`, for the two libraries) and `./package.json`. Everything else, including the engine's `history.js` and all `dist/` paths, fails to import with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

The published files are `package.json`, `README.md`, `LICENSE` and `dist/` (JavaScript, type declarations, and source maps with their sources inlined, so they don't reference files outside the package). Exports only use the `types` and `default` conditions, and every target exists in the tarball. The packages have no runtime dependencies besides each other and no install scripts. They are ES modules; CommonJS code can `require()` them, because they don't use top-level `await`.

How the workspace builds and how tests use the built packages is described in [CONTRIBUTING.md](../CONTRIBUTING.md#how-the-build-and-tests-fit-together).

## Loading TypeScript scenarios

The CLI imports scenario files with Node.js's own module loader. Since Node.js 22.18.0, the loader strips TypeScript types by default, but only for files outside `node_modules`. That is why the packages ship compiled JavaScript, and why user scenarios need no build step and no TypeScript dependency, as long as they follow the rules listed in [writing scenarios](06-writing-scenarios.md#typescript).

When loading fails, the CLI replaces Node.js's error with an explanation for three cases: type stripping unavailable (`ERR_UNKNOWN_FILE_EXTENSION` for a `.ts` file), syntax that can't be stripped (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`), and TypeScript files inside `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`).

## Verification

`npm run test:integration` runs in CI on Ubuntu and Windows. It packs the real tarballs with `npm pack --workspaces`, installs them offline into a new project outside the repository, so no workspace links are involved, and then checks, using only what was installed:

- The tarball contents, against an allowlist (`package.json`, `README.md`, `LICENSE`, `dist/**/*.js`, `*.d.ts`, `*.js.map`).
- That every `exports`, `types` and `bin` target exists and no other export conditions are used.
- The manifests: license, Node.js version, no scripts, no external dependencies, a single installed copy of the SDK.
- The `parallel-sim` command, run through npm's bin resolution (the `.cmd` shim on Windows): `--version`, `--help`, `.ts`, `.mts` and `.mjs` scenarios, scenarios importing application TypeScript, trace export and replay, the built-in demos, the two loading errors, and the exit-code and JSON-report contract, including `--json` output that stays parseable with a noisy scenario and `FORCE_COLOR=1`.
- ESM and CommonJS consumers, and that internal modules can't be imported.
- A strict `tsc` check of a consumer project against the shipped declarations, including that a type error is rejected.
- The code examples from the READMEs and from [writing scenarios](06-writing-scenarios.md), extracted and run.

## Compatibility

- Node.js 22.18.0 or later; every package declares it in `engines`. CI tests 22.18.0, the latest 22.x and 24.x.
- The trace format is schema version 1 and stays readable; see [nondeterminism and replay](04-nondeterminism-and-replay.md#validation-and-compatibility).
- Removed before the first release: the unused, deprecated `RunResult` type.

## Security

- Scenario files are executed as trusted code, with the full privileges of the process and no sandbox.
- Traces can contain application data from checkpoint names, invariant messages and errors.
- `npx parallel-sim` runs the locally installed CLI. In a project without it, npx would offer to install an unscoped package named `parallel-sim` from the registry, a name this project doesn't own. The documentation therefore uses `npx --no parallel-sim`, which fails instead of installing (it may still look the name up on the registry), and reserving the name is part of the checklist below.
- The tarball allowlist in the integration tests keeps tests, fixtures and local configuration files out of published packages.

## Publishing checklist

1. Check that `npm whoami` prints `aliloraf`, or that an npm organization named `aliloraf` exists and you can publish to it. Only the owner of a scope can publish packages in it.
2. Enable two-factor authentication for publishing on the npm account.
3. Decide whether to reserve the unscoped name `parallel-sim`, for example with a minimal package that points to `@aliloraf/parallel-cli`.
4. Run `npm ci`, `npm test` and `npm run test:integration`, then `npm publish --workspaces --dry-run`, and review the file lists. The dry run must not report corrections to any `package.json`.
5. Publish in dependency order, sdk, engine, cli, with `npm publish --workspace <name>`. The CLI pins the exact engine version, so it can't be installed until that engine version is on npm. Publishing from CI with `--provenance` (GitHub Actions OIDC) is preferable to publishing from a laptop.
6. In a new project, install the published packages and run the README example.
7. Tag the release (for example `v0.1.0`) and add the release date to its changelog entry.

Versions follow semantic versioning; while the version is 0.x, breaking changes increase the minor version.
