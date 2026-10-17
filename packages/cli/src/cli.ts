#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ExecutionError, InvalidTraceError, explore, replay, validateTrace } from '@aliloraf/parallel-engine';
import type { Trace } from '@aliloraf/parallel-engine';
import { defineScenario } from '@aliloraf/parallel-sdk';
import type { Scenario } from '@aliloraf/parallel-sdk';
import { commandOf, parseCliArgs } from './args.ts';
import type { ReplayInvocation, TestInvocation } from './args.ts';
import { inventoryScenario } from './demos/inventory.ts';
import { CliError } from './errors.ts';
import { flushOutput, reserveStdoutForReport, writeStdout } from './output.ts';
import { errorReport, formatReplay, formatTest, replayReport, testReport } from './report.ts';

const usage = `Usage:
  parallel-sim test <scenario> [--json] [--max-schedules N] [--max-steps N] [--step-timeout MS] [--trace-out PATH]
  parallel-sim replay <trace> [scenario] [--json] [--step-timeout MS]
  parallel-sim --help | --version

<scenario> is a path to a .ts, .mts, .js or .mjs module that exports a scenario
(as its default export or as 'scenario'), or a built-in demo: inventory-buggy,
inventory-fixed. Scenario modules are executed as trusted code.

Exit status: 0 passed, 1 failures found (or a failing trace reproduced),
2 invalid usage or input, 3 exploration incomplete, 4 nondeterminism or
replay divergence, 5 runtime error.`;
const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const cliDirectory = dirname(fileURLToPath(import.meta.url));
const builtInDemos = new Set(['inventory-buggy', 'inventory-fixed']);

const argv = process.argv.slice(2);
const command = commandOf(argv);
/** Whether the report is JSON; known for sure only once the arguments have been parsed. */
let json = argv.includes('--json');
/** Set once stdout has received the report, so that nothing writes a second one. */
let reported = false;
let abandonedWork = false;
let crashed = false;

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const firstLine = (text: string) => text.split('\n')[0]!;
/** The stack of an error raised from user code, without Node.js internals and the CLI's own frames. */
function userStack(cause: unknown): string | undefined {
  if (!(cause instanceof Error) || !cause.stack) return undefined;
  const lines = cause.stack.split('\n').filter((line) => !line.includes('node:internal') && !line.includes(cliDirectory));
  const text = lines.join('\n').trim();
  return text || undefined;
}

async function emit(text: string, exitCode: number): Promise<void> {
  if (reported) return;
  reported = true;
  process.exitCode = exitCode;
  await writeStdout(text);
}

/** Reports an error: a message on stderr, plus the JSON error report on stdout in `--json` mode. */
async function fail(error: CliError, report?: object, text?: string): Promise<void> {
  console.error(error.detail ? `${error.message}\n${error.detail}` : error.message);
  if (json) await emit(`${JSON.stringify(errorReport(command, error, report), null, 2)}\n`, error.exitCode);
  else if (text !== undefined) await emit(text, error.exitCode);
  else if (!reported) {
    reported = true;
    process.exitCode = error.exitCode;
  }
}

/**
 * Explicit termination boundary. Used when scenario work the engine could not
 * settle may still be running, or after a crash: the report has been written,
 * both streams are flushed, and the process ends with the exit status it
 * already determined.
 */
async function terminate(notice?: string): Promise<void> {
  if (notice) console.error(notice);
  await flushOutput();
  process.exit();
}

function onUncaught(cause: unknown): void {
  if (crashed) return;
  crashed = true;
  const detail = userStack(cause);
  void (async () => {
    if (reported) {
      // The report is already on stdout and is not repeated. Only a usage or
      // input error (2) outranks the runtime error (5).
      const exitCode = process.exitCode === 2 ? 2 : 5;
      console.error(`Uncaught error from scenario code after the report was written; exiting with status ${exitCode}: ${messageOf(cause)}${detail ? `\n${detail}` : ''}`);
      process.exitCode = exitCode;
    } else {
      await fail(new CliError('runtime_error', `Uncaught error, most likely from scenario code outside a controlled step: ${messageOf(cause)}`,
        { ...(detail === undefined ? {} : { detail }), cause }));
    }
    await terminate();
  })();
}

function toCliError(cause: unknown): CliError {
  if (cause instanceof CliError) return cause;
  if (cause instanceof InvalidTraceError) return new CliError('invalid_trace', cause.message, { cause });
  if (cause instanceof ExecutionError) {
    if (cause.abandonedWork) abandonedWork = true;
    return new CliError('runtime_error', cause.message, { ...(userStack(cause) === undefined ? {} : { detail: userStack(cause)! }), cause });
  }
  return new CliError('runtime_error', `Unexpected error: ${messageOf(cause)}`, { ...(userStack(cause) === undefined ? {} : { detail: userStack(cause)! }), cause });
}

/** Turns a failure to import a scenario module into an actionable error with its location. */
function loadFailure(cause: unknown, path: string): CliError {
  const code = typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined;
  const detail = userStack(cause);
  const options = { ...(detail === undefined ? {} : { detail }), cause };
  if (code === 'ERR_UNKNOWN_FILE_EXTENSION' && /\.m?ts$/.test(path)) {
    return new CliError('scenario_load_failed', `Cannot load TypeScript scenario ${path}: Node.js type stripping is not available in this process. `
      + 'Use Node.js >=22.18.0 without --no-experimental-strip-types, write the scenario as .js/.mjs, '
      + 'or register a TypeScript loader (for example NODE_OPTIONS=--import=<loader>).', options);
  }
  if (code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') {
    return new CliError('scenario_load_failed', `Cannot load scenario ${path}: it, or a module it imports, uses TypeScript syntax that cannot be stripped `
      + `(such as enum, namespace or constructor parameter properties). ${firstLine(messageOf(cause))} `
      + 'Use erasable syntax only, or register a TypeScript loader.', options);
  }
  if (code === 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING') {
    return new CliError('scenario_load_failed', `Cannot load scenario ${path}: it imports TypeScript source from node_modules, which Node.js does not strip. ${firstLine(messageOf(cause))}`, options);
  }
  return new CliError('scenario_load_failed', `Could not load scenario ${path}: ${firstLine(messageOf(cause))}`, options);
}

/**
 * Loads a built-in demo or a trusted local scenario module. Modules are
 * executable code; never load untrusted files.
 */
async function loadScenario(input: string): Promise<Scenario<any>> {
  if (input === 'inventory-buggy') return inventoryScenario(false);
  if (input === 'inventory-fixed') return inventoryScenario(true);
  if (!/\.(?:ts|mts|js|mjs)$/.test(input)) {
    throw new CliError('scenario_not_found', `Unknown scenario '${input}': not a built-in demo (inventory-buggy, inventory-fixed) or a .ts/.mts/.js/.mjs file`);
  }
  const fullPath = resolve(input);
  if (!existsSync(fullPath)) throw new CliError('scenario_not_found', `Scenario file not found: ${fullPath}`);
  let module: { default?: unknown; scenario?: unknown };
  try {
    module = await import(pathToFileURL(fullPath).href);
  } catch (cause) {
    throw loadFailure(cause, fullPath);
  }
  const candidate: unknown = module.default ?? module.scenario;
  if (candidate === null || typeof candidate !== 'object') {
    throw new CliError('invalid_scenario', `Scenario file must export a Scenario as default (or named 'scenario'): ${fullPath}`);
  }
  const scenario = candidate as Partial<Scenario<unknown>>;
  if (typeof scenario.name !== 'string' || typeof scenario.createState !== 'function'
      || !Array.isArray(scenario.actors) || !Array.isArray(scenario.invariants)
      || !scenario.actors.every((actor) => typeof actor.id === 'string' && typeof actor.run === 'function')
      || !scenario.invariants.every((invariant) => typeof invariant.name === 'string' && typeof invariant.check === 'function')) {
    throw new CliError('invalid_scenario', `Invalid scenario exported by ${fullPath}: expected name, createState, actors, and invariants.`);
  }
  try {
    return defineScenario(scenario as Scenario<unknown>);
  } catch (cause) {
    throw new CliError('invalid_scenario', `Invalid scenario exported by ${fullPath}: ${messageOf(cause)}`, { cause });
  }
}

/** Rejects a --trace-out path that can't be written, before any scenario code runs. */
function checkTraceTarget(path: string): void {
  if (existsSync(path) && statSync(path).isDirectory()) {
    throw new CliError('trace_write_failed', `Could not write trace to ${path}: it is a directory`);
  }
  let parent = dirname(path);
  while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
  if (existsSync(parent) && !statSync(parent).isDirectory()) {
    throw new CliError('trace_write_failed', `Could not write trace to ${path}: ${parent} is not a directory`);
  }
}

async function runTest(invocation: TestInvocation): Promise<void> {
  const tracePath = invocation.traceOut === undefined ? undefined : resolve(invocation.traceOut);
  if (tracePath !== undefined) checkTraceTarget(tracePath);
  const scenario = await loadScenario(invocation.scenario);
  const summary = await explore(scenario, { maxSchedules: invocation.maxSchedules, maxSteps: invocation.maxSteps, stepTimeoutMs: invocation.stepTimeoutMs });
  abandonedWork = summary.abandonedWork;
  const firstFailure = summary.failures[0];
  let written = false;
  if (firstFailure && tracePath !== undefined) {
    try {
      mkdirSync(dirname(tracePath), { recursive: true });
      writeFileSync(tracePath, `${JSON.stringify(firstFailure, null, 2)}\n`);
      written = true;
    } catch (cause) {
      const error = new CliError('trace_write_failed', `Could not write trace to ${tracePath}: ${messageOf(cause)}`, { cause });
      await fail(error, testReport(summary, null), formatTest(summary, { tracePath, traceWritten: false, result: 'error' }));
      return;
    }
  }
  const report = testReport(summary, written ? tracePath! : null);
  const options = tracePath === undefined ? { traceWritten: written } : { tracePath, traceWritten: written };
  await emit(json ? `${JSON.stringify(report, null, 2)}\n` : formatTest(summary, options), report.exitCode);
}

async function runReplay(invocation: ReplayInvocation): Promise<void> {
  const tracePath = resolve(invocation.trace);
  let text: string;
  try {
    text = readFileSync(tracePath, 'utf8');
  } catch (cause) {
    const code = (cause as { code?: unknown }).code;
    throw code === 'ENOENT'
      ? new CliError('trace_not_found', `Trace file not found: ${tracePath}`, { cause })
      : new CliError('invalid_trace', `Could not read trace file ${tracePath}: ${messageOf(cause)}`, { cause });
  }
  // Editors on Windows often save JSON with a byte order mark.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (cause) {
    throw new CliError('invalid_trace', `Trace file ${tracePath} is not valid JSON: ${messageOf(cause)}`, { cause });
  }
  // Validate before reading any field. Well-formed traces of other schema
  // versions are left to replay(), which reports them as unsupported.
  const schemaVersion = typeof input === 'object' && input !== null ? (input as { schemaVersion?: unknown }).schemaVersion : undefined;
  if (typeof schemaVersion !== 'number' || schemaVersion === 1) validateTrace(input);
  const trace = input as Trace;
  const recordedName = typeof trace.scenario === 'string' ? trace.scenario : undefined;
  if (invocation.scenario === undefined && recordedName === undefined) {
    throw new CliError('missing_argument', 'The trace does not name a scenario; pass the scenario file: parallel-sim replay <trace> <scenario>');
  }
  if (invocation.scenario === undefined && !builtInDemos.has(recordedName!)) {
    throw new CliError('missing_argument', `This trace is for scenario '${recordedName}', which is not a built-in demo; pass its file: parallel-sim replay <trace> <scenario>`);
  }
  const scenario = await loadScenario(invocation.scenario ?? recordedName!);
  const result = await replay(scenario, trace, { stepTimeoutMs: invocation.stepTimeoutMs });
  abandonedWork = result.abandonedWork;
  const report = replayReport(result);
  await emit(json ? `${JSON.stringify(report, null, 2)}\n` : formatReplay(result, trace, tracePath), report.exitCode);
}

// Errors that escape from scenario code outside a controlled step (detached
// callbacks, unhandled rejections, throwing abort listeners) end the run with
// a runtime error instead of an unstructured crash.
process.on('uncaughtException', onUncaught);
process.on('unhandledRejection', onUncaught);

try {
  const invocation = parseCliArgs(argv);
  if (invocation.command === 'help') await emit(`${usage}\n`, 0);
  else if (invocation.command === 'version') await emit(`${version}\n`, 0);
  else {
    json = invocation.json;
    if (json) reserveStdoutForReport();
    if (invocation.command === 'test') await runTest(invocation);
    else await runReplay(invocation);
  }
} catch (cause) {
  await fail(toCliError(cause));
}
if (abandonedWork && !crashed) {
  await terminate('Abandoned actor work may still be running; Parallel cannot cancel it, so the process is being terminated.');
}
