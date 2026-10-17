# Parallel — Packaging, External Usage and Publishing

**Status:** Packages for version 0.1.0 are built, tested and prepared for publication. **Nothing has been published to npm yet**; until the first release, install from local tarballs as described in the README.

## 1. Package architecture

The repository is an npm workspace. Its private root package holds development
tooling only. It contains three published packages:

| Package | Depends on | Exports |
|---|---|---|
| `@aliloraf/parallel-sdk` | — | `.`: `defineScenario`, `SimulationCancelledError`, `Scenario`, `Actor`, `Invariant`, `StepContext` |
| `@aliloraf/parallel-engine` | peer: sdk `^0.1.0` | `.`: `explore`, `replay`, `validateTrace`, `leavesAbandonedWork`, `InvalidTraceError`, `ExecutionError`, `DEFAULT_STEP_TIMEOUT_MS`, all trace and result types |
| `@aliloraf/parallel-cli` | engine `0.1.0`; peer: sdk `^0.1.0` | bin `parallel-sim`; no importable modules |

Design rules:

- **One SDK copy.** Engine and CLI take the SDK as a *peer* dependency, so
  scenarios, the engine and the CLI share one copy (npm installs missing peers
  automatically). This keeps `instanceof SimulationCancelledError` reliable in
  user code. A regular dependency could install two copies when versions
  differ.
- **Lockstep versions.** All packages share one version. The CLI pins the
  engine exactly.
- **Explicit public surface.** Each `exports` map lists only `.` (libraries)
  and `./package.json`. Internal modules such as the engine's scheduling
  history, and `dist/` paths in general, cannot be imported
  (`ERR_PACKAGE_PATH_NOT_EXPORTED`).
- **Self-contained tarballs.** Exports use only the `types` and `default`
  conditions, and every target is in the tarball. There is no
  development-only condition pointing at unpublished sources. Source maps embed
  their sources (`inlineSources`), so they reference nothing outside the
  package.
- **No runtime dependencies, no install scripts.** Packages ship as ES
  modules. CommonJS callers can `require()` them on Node.js 22.12 and later,
  since nothing uses top-level `await`.

## 2. Build and development

- `tsconfig.base.json` holds the shared compiler options. Two of them enforce
  the runtime model:
  - `erasableSyntaxOnly` rejects syntax that Node.js cannot strip.
  - `rewriteRelativeImportExtensions` turns source imports such as `./x.ts`
    into `./x.js` in the build output.
- Each package has a composite `tsconfig.json` with project references.
  `npm run build` (`tsc -b packages/cli`) builds all three into `dist/`:
  JavaScript, declarations and source maps.
- Tests and examples import packages **by name**, exactly as consumers do.
  Inside the repository, those imports resolve through workspace links to the
  built `dist/`. `npm test`, `npm run typecheck` and the demo scripts therefore
  build first. Incremental builds keep this quick.
- Package internals are tested by path (for example
  `packages/engine/dist/history.js`). That is possible only inside the
  repository.

## 3. External usage

After the first release (until then, install the three local tarballs as
described in the README):

```bash
npm install --save-dev @aliloraf/parallel-cli @aliloraf/parallel-sdk
npx parallel-sim test scenarios/last-item.ts --trace-out traces/last-item.json
npx parallel-sim replay traces/last-item.json scenarios/last-item.ts
```

For programmatic use, also install `@aliloraf/parallel-engine`. The README
has complete examples, and the integration tests run them from the installed
packages.

### TypeScript scenarios

The CLI imports the scenario module with Node.js's own loader. Type stripping
is enabled by default from Node.js 22.18.0, and it applies to files outside
`node_modules`. That gives no build step and no TypeScript dependency, but
imposes Node.js's rules:

- erasable syntax only: no `enum`, `namespace` or constructor parameter
  properties;
- `import type` for type-only imports;
- explicit `.ts` extensions on relative imports.

The CLI translates the relevant loader errors into actionable messages:

- type stripping unavailable (`ERR_UNKNOWN_FILE_EXTENSION`);
- unsupported syntax (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`);
- TypeScript inside `node_modules`.

Escape hatches:

- `.js` and `.mjs` scenarios;
- a user-supplied loader, e.g. `NODE_OPTIONS=--import=tsx`;
- calling the engine from a test runner that compiles TypeScript itself
  (Vitest, Jest).

## 4. Verification

`npm run test:integration` (in CI on Ubuntu and Windows) does the following:

1. builds and packs the real tarballs (`npm pack --workspaces`);
2. installs them **offline** into a fresh project outside the repository, so
   no workspace links are involved;
3. checks, through the installed packages only:
   - tarball contents, against an allowlist of `package.json`, `README.md`,
     `LICENSE` and `dist/**/*.{js,d.ts,js.map}`;
   - that every export, `types` and `bin` target exists, with no other export
     conditions;
   - manifest fields: license, engines, no scripts, no external dependencies;
   - a single SDK copy;
   - the `parallel-sim` bin, run through npm's bin resolution (the `.cmd` shim
     on Windows): `--version`, `--help`, `.ts`/`.mts`/`.mjs` scenarios,
     application TypeScript imports, trace export and replay, and the
     built-in demos;
   - the stripping-unavailable and unsupported-syntax errors;
   - ESM and CommonJS consumers;
   - blocked deep imports;
   - a strict `tsc` check of a consumer project against the shipped
     declarations, including that misuse is rejected;
   - the README examples, extracted and executed.

## 5. Compatibility

- Node.js `>=22.18.0` (`engines` in every package). CI runs 22.18.0, the
  latest 22.x and 24.x.
- The trace format is unchanged: schema version 1. Earlier traces replay as
  before (`tests/fixtures/traces`).
- Repository commands (`npm test`, `npm run demo`, `npm run demo:fixed`) keep
  working. Running `node packages/cli/src/cli.ts` directly is replaced by
  `npm run cli -- …` inside the repository, and by `parallel-sim` elsewhere.
- Removed before the first release: the unused, deprecated `RunResult` type.

## 6. Security

- **Scenario files execute as trusted code.** The CLI imports them with full
  process privileges and no sandbox.
- Traces can contain application data, so keep them out of version control
  where that matters.
- **`npx` name resolution.** `npx parallel-sim` runs the locally installed
  CLI. In a project without it, npx would offer to download an unscoped
  package named `parallel-sim` from the registry, a name Parallel does not
  own. Use `npx --no parallel-sim` in CI. Reserving the unscoped name is on the
  publishing checklist.
- The tarball allowlist test prevents local files (tests, fixtures, editor or
  tool configuration) from being published.

## 7. Publishing checklist (not yet performed)

1. Confirm `npm whoami` is `aliloraf`, or that an npm organization named
   `aliloraf` exists and you can publish to it. Scoped packages can only be
   published by the scope's owner.
2. Enable two-factor authentication for publishing on the npm account.
3. Decide whether to reserve the unscoped name `parallel-sim`, for example
   with a minimal package that only points to `@aliloraf/parallel-cli`.
4. Run `npm ci && npm test && npm run test:integration`, then
   `npm publish --workspaces --dry-run` and review the file lists.
5. Publish in dependency order (sdk, engine, cli) with
   `npm publish --workspace <name>`. Prefer publishing from CI with
   `--provenance` (GitHub Actions OIDC).
6. Remove the "Not yet published" notes from the three package READMEs and
   the README, and change the README install section to npm-first. The
   package READMEs are what npm displays.
7. Tag the release (`v0.1.0`) and update `CHANGELOG.md`.

Versioning follows semver. While the version is 0.x, breaking changes bump the
minor version.
