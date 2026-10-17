# Contributing to Parallel

## Setup

You need Node.js 22.18 or later and npm.

```bash
git clone https://github.com/Aliloraf/parallel.git
cd parallel
npm ci
npm test
```

## Commands

| Command | What it does |
|---|---|
| `npm run build` | Builds the three packages into `packages/*/dist` with `tsc -b`. Incremental. |
| `npm test` | Builds, then runs the unit and CLI tests in `tests/*.test.ts`. |
| `npm run typecheck` | Builds, then type-checks the tests and examples against the built packages. |
| `npm run test:integration` | Packs the packages into tarballs, installs them into a temporary project outside the repository, and tests them from there. Takes about 15 seconds. |
| `npm run demo` | Runs the buggy inventory demo. Exits with 1, because it finds the bug. |
| `npm run demo:fixed` | Runs the fixed inventory demo. Exits with 0. |
| `npm run cli -- <args>` | Builds and runs the repository's `parallel-sim`, e.g. `npm run cli -- test examples/counter/src/scenario.ts`. |
| `npm run clean` | Removes the build output. |

CI runs `typecheck`, `test` and `test:integration` on Ubuntu and Windows with Node.js 22.18.0, the latest 22.x and 24.x. All of them must pass before a change is merged.

## Repository layout

```text
packages/sdk/        @aliloraf/parallel-sdk: defineScenario, SimulationCancelledError, scenario types
packages/engine/     @aliloraf/parallel-engine: scheduling, exploration, traces, validation, replay
packages/cli/        @aliloraf/parallel-cli: the parallel-sim command and its built-in inventory demos
examples/counter/    A scenario written the way an external project would write it
tests/               Unit and CLI tests
tests/integration/   Tests of the packed npm tarballs
tests/fixtures/      Scenarios and fixed traces recorded by earlier versions
docs/                Design and user documentation
```

Most of the engine is in `packages/engine/src/index.ts`. `Run` manages one schedule and its actors' lifecycle, `execute` runs one schedule, and `explore` and `replay` build on it. `history.ts` holds the frozen scheduling history used to detect nondeterminism. [Execution lifecycle](docs/03-execution-lifecycle.md) and [nondeterminism and replay](docs/04-nondeterminism-and-replay.md) describe the semantics the code implements.

## How the build and tests fit together

Packages import each other by name (`@aliloraf/parallel-sdk`), and so do the tests and examples. Inside the repository those names resolve through npm workspace links to the built `dist/` directories, which is why `npm test` builds first: the tests run against the same compiled code that gets published. Engine internals that aren't exported, such as `history.js`, are imported by path in tests.

Source files are TypeScript that Node.js can run with type stripping. `erasableSyntaxOnly` in `tsconfig.base.json` makes `tsc` reject syntax Node.js can't strip, such as enums and constructor parameter properties.

## Writing tests

- Add or change a test first, check that it fails for the reason you expect, then change the code.
- Tests that wait on timers or child processes should pass a `{ timeout }` option to `test()`, so a regression fails instead of hanging the run. Keep wall-clock budgets in tests small (tens of milliseconds) and assertions about elapsed time generous.
- Child processes whose output a test compares should print strings or JSON (`console.log(JSON.stringify(value))`). When `node --test` runs in a terminal it sets `FORCE_COLOR`, and `console.log` then colors numbers and objects.
- Run the suites from a terminal at least once, not only with piped output. Some problems, like the coloring above, only show up there.
- The traces in `tests/fixtures/traces/` were recorded by an older engine to test compatibility. Don't regenerate them; add new fixtures instead.
- Code examples in the READMEs are executed by the integration tests. If you change an example, run `npm run test:integration`.

## Changes and pull requests

- Work on a branch named after the change (`feat/…`, `fix/…`, `docs/…`).
- Commit messages follow the style of the existing history: `feat(engine): …`, `fix(test): …`, `docs: …`.
- Keep pull requests to one change, and update the documentation in the same pull request when behavior changes.
- Changes to public APIs, CLI output, exit codes or the trace format need a note in `CHANGELOG.md`. Traces are versioned; changes to them must stay readable by older traces or be detected explicitly (see the requirements, FR-020).

Releases are not automated yet; the [packaging guide](docs/05-packaging.md) has the publishing checklist.

## License

By contributing, you agree that your contributions are licensed under the Apache License 2.0.
