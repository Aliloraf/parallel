# @aliloraf/parallel-cli

`parallel-sim`, the command-line runner for [Parallel](https://github.com/Aliloraf/parallel) scenarios.

```bash
npm install --save-dev @aliloraf/parallel-cli @aliloraf/parallel-sdk
npx --no parallel-sim test scenarios/last-item.ts
npx --no parallel-sim test scenarios/last-item.ts --trace-out traces/last-item.json
npx --no parallel-sim replay traces/last-item.json scenarios/last-item.ts
```

## Usage

```text
parallel-sim test <scenario> [--json] [--max-schedules N] [--max-steps N] [--step-timeout MS] [--trace-out PATH]
parallel-sim replay <trace> [scenario] [--json] [--step-timeout MS]
parallel-sim --help | --version
```

`<scenario>` is a `.ts`, `.mts`, `.js` or `.mjs` file whose default export (or `scenario` export) is a scenario, or one of the built-in demos `inventory-buggy` and `inventory-fixed`.

| Option | Command | Meaning |
|---|---|---|
| `--json` | both | Print a JSON report instead of text. |
| `--max-schedules N` | `test` | Stop after N schedules (default 1000). |
| `--max-steps N` | `test` | Allow at most N scheduling decisions per schedule (default 100). |
| `--step-timeout MS` | both | Time an actor may take to reach its next checkpoint before it counts as stalled (default 10000). |
| `--trace-out PATH` | `test` | Write the first failing schedule to PATH, creating directories as needed. |

All arguments are checked before the scenario is loaded. Unknown options, options the command doesn't support, repeated options, missing values, numbers that aren't positive decimal integers, and extra arguments are errors (exit status 2). An option's value can't start with `-` unless it's given as `--option=value`. `--help` and `--version` work anywhere on the command line.

`replay` needs the scenario file again unless the trace is from a built-in demo. A trace that a text editor saved with a byte order mark is accepted.

## Exit status

| Status | `test` | `replay` |
|---|---|---|
| 0 | Exploration completed without failures. | The trace was reproduced and passes. |
| 1 | At least one schedule failed: an invariant violation, an actor error or a stall. | The trace was reproduced and still fails. |
| 2 | Invalid usage or input: arguments, a missing or invalid scenario, an unwritable `--trace-out` path. | The same, or a missing or invalid trace file. |
| 3 | Exploration stopped at `--max-schedules` or `--max-steps`, or because of abandoned work, without finding failures. | The trace was reproduced and stopped at its step limit. |
| 4 | The scenario behaved nondeterministically. Failures found before that are still reported. | The replay diverged from the trace. |
| 5 | Runtime error: an uncaught exception or unhandled rejection from scenario code outside a controlled step, or an engine failure. | The same. |

When several conditions apply, the first in this order wins: 2, 5, 4, 1, 3, 0.

## JSON output

With `--json`, stdout carries exactly one JSON document. Whatever scenario code writes to stdout (`console.log`, `process.stdout.write`) goes to stderr instead, together with the CLI's own diagnostics.

Every report starts with the same four fields:

```json
{ "reportVersion": 1, "command": "test", "result": "failed", "exitCode": 1 }
```

`result` is `passed`, `failed`, `incomplete`, `nondeterministic` (`test`), `diverged` (`replay`) or `error`, and `exitCode` is the process exit status. `reportVersion` changes only for incompatible changes to the format.

A `test` report then has `scenario`, `schedulesExplored`, `failureCount`, `failuresByOutcome` (counts of `invariant_failed`, `actor_error` and `stalled`), `complete`, `limitReached`, `haltReason`, `abandonedWork`, `haltTrace`, `nondeterminism`, `firstFailure` (a trace) and `tracePath`. A `replay` report has the fields of the engine's replay result: `status` (`replayed` or `replay_diverged`), `trace`, or `reason`, `divergence` and `observed`, and `abandonedWork`.

Errors use the same header with `result: "error"` and an `error` object:

```json
{
  "reportVersion": 1,
  "command": "test",
  "result": "error",
  "exitCode": 2,
  "error": { "code": "unknown_option", "message": "Unknown option --tracout" }
}
```

The error codes are `missing_argument`, `unexpected_argument`, `unknown_command`, `unknown_option`, `unsupported_option`, `missing_value`, `invalid_value`, `duplicate_option`, `scenario_not_found`, `scenario_load_failed`, `invalid_scenario`, `trace_not_found`, `invalid_trace`, `trace_write_failed` (all exit status 2) and `runtime_error` (5). Scenario load failures and runtime errors add `error.detail` with the relevant stack, including the file and line in the scenario. If exploration finished but the trace couldn't be written, the error report also contains the `test` report's fields.

These guarantees cover everything the CLI can catch. They can't hold when scenario code calls `process.exit()`, writes to file descriptor 1 directly, crashes Node.js itself, or blocks the event loop with a synchronous infinite loop. An uncaught error from scenario code that happens after the report has been written doesn't produce a second report: it ends the process with status 5 (or keeps status 2, which ranks higher) and a message on stderr. The report on stdout then describes the exploration, not the crash, so its `exitCode` can differ from the actual exit status in this one case.

## TypeScript scenarios

Scenarios run on Node.js's built-in type stripping (Node.js 22.18 or later), so there is no build step. That means erasable syntax only (no `enum`, `namespace` or constructor parameter properties), `import type` for type-only imports, and `.ts` extensions in relative imports. Otherwise, write the scenario in JavaScript or bring your own loader, for example `NODE_OPTIONS=--import=tsx npx --no parallel-sim test ...`. When a scenario can't be loaded, the CLI says why and where. In a project without `"type": "module"` in its `package.json`, Node.js warns when a `.ts` scenario uses `import`/`export`; name the file `.mts` or set `"type": "module"` to avoid the warning. See [writing scenarios](https://github.com/Aliloraf/parallel/blob/main/docs/06-writing-scenarios.md).

`npx --no` runs the CLI installed in the current project and fails instead of installing anything when it isn't there; without `--no`, npx would offer to install an unrelated `parallel-sim` package from the registry. With `--no`, options that come before a subcommand need a `--`: `npx --no parallel-sim -- --help`.

Scenario files run as trusted code, without a sandbox. Traces may contain application data.

Apache License 2.0.
