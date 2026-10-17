// End-to-end tests of the CLI's public contract: exit codes, the JSON report,
// argument validation, error reporting and trace handling.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { explore } from '@aliloraf/parallel-engine';

const cli = fileURLToPath(new URL('../packages/cli/dist/cli.js', import.meta.url));
let dir: string;

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, ...args], {
    cwd: dir, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  return result;
}
function write(name: string, content: string) {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}
/** stdout must be exactly one JSON document. */
const report = (stdout: string) => JSON.parse(stdout) as Record<string, any>;

// Scenario sources. They are plain objects so they need no imports.
const actors = (a: string, b = `async run({ checkpoint }) { await checkpoint('b1'); }`) =>
  `actors: [{ id: 'a', async run({ checkpoint, signal, state }) { ${a} } }, { id: 'b', ${b} }]`;
const scenario = (name: string, a: string, extra = '', invariant = 'check: () => true', b?: string) => `${extra}
export default { name: '${name}', createState: () => ({}), ${actors(a, b)}, invariants: [{ name: 'inv', ${invariant} }] };
`;
const marker = () => join(dir, 'scenario-was-loaded');
/** Source that records, as a file, that the scenario module was executed. */
const sideEffect = (path: string) => `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(path)}, 'loaded');`;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'parallel-cli-contract-'));
  write('pass.ts', scenario('pass', `await checkpoint('a1');`));
  write('violation.ts', scenario('violation', `await checkpoint('a1');`, '', 'check: () => false'));
  write('actor-error.ts', scenario('actor-error', `await checkpoint('a1'); throw new Error('database connection refused');`));
  write('stall.ts', scenario('stall', `await checkpoint('a1'); await new Promise(() => {});`));
  write('nondeterministic.ts', scenario('nondeterministic', `await checkpoint('a1');`, 'let n = 0;', 'check: () => false',
    `async run({ checkpoint }) { await checkpoint(n++ % 2 ? 'x' : 'y'); }`));
  write('detached-crash.ts', scenario('detached-crash', `await checkpoint('a1'); setTimeout(() => { throw new Error('late callback failed'); }, 5);`, '', 'check: () => true',
    `async run({ checkpoint }) { await checkpoint('b1'); await new Promise((resolve) => setTimeout(resolve, 50)); }`));

  // Traces recorded with the engine directly, shared by the replay tests.
  const load = async (file: string) => (await import(pathToFileURL(join(dir, file)).href)).default;
  const save = (name: string, trace: unknown) => write(name, JSON.stringify(trace));
  const failure = (await explore(await load('violation.ts'))).failures[0];
  save('passing.json', (await explore(await load('pass.ts'))).outcomes[0]);
  save('failing.json', failure);
  save('bounded.json', (await explore(await load('pass.ts'), { maxSteps: 1, maxSchedules: 1 })).outcomes[0]);
  save('diverging.json', { ...failure, outcome: 'passed', violations: [] });
  write('side-effect.ts', scenario('side-effect', `await checkpoint('a1');`, sideEffect(marker())));
});
after(() => rmSync(dir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// Exit codes and results.

test('test: exit code, result and the report agree in both output modes', () => {
  const cases: [string, string[], number, string][] = [
    ['completed without failures', ['pass.ts'], 0, 'passed'],
    ['invariant violation', ['violation.ts'], 1, 'failed'],
    ['actor error', ['actor-error.ts'], 1, 'failed'],
    ['stall', ['stall.ts', '--step-timeout', '50'], 1, 'failed'],
    ['schedule bound', ['pass.ts', '--max-schedules', '1'], 3, 'incomplete'],
    ['step bound', ['pass.ts', '--max-steps', '1'], 3, 'incomplete'],
    ['nondeterminism after failures', ['nondeterministic.ts'], 4, 'nondeterministic'],
    ['uncaught error from scenario code', ['detached-crash.ts'], 5, 'error'],
  ];
  for (const [label, args, exitCode, result] of cases) {
    const json = run(['test', ...args, '--json']);
    assert.equal(json.status, exitCode, `${label}: ${json.stderr}`);
    const parsed = report(json.stdout);
    assert.equal(parsed.reportVersion, 1, label);
    assert.equal(parsed.command, 'test', label);
    assert.equal(parsed.result, result, label);
    assert.equal(parsed.exitCode, exitCode, label);
    if (result === 'passed') assert.ok(parsed.complete && parsed.failureCount === 0, label);
    if (result === 'incomplete') assert.ok(!parsed.complete && parsed.failureCount === 0, label);
    if (result === 'failed') assert.ok(parsed.failureCount > 0, label);
    if (result === 'nondeterministic') assert.ok(parsed.failureCount > 0 && parsed.nondeterminism !== null, `${label}: earlier failures are kept`);

    const human = run(['test', ...args]);
    assert.equal(human.status, exitCode, `${label} (text): ${human.stderr}`);
    if (result !== 'error') assert.match(human.stdout, new RegExp(`Result: ${result}\\n$`), label);
  }
});

test('replay: exit code and result follow the replayed outcome', () => {
  const cases: [string, string, number, string][] = [
    ['passing.json', 'pass.ts', 0, 'passed'],
    ['failing.json', 'violation.ts', 1, 'failed'],
    ['bounded.json', 'pass.ts', 3, 'incomplete'],
    ['diverging.json', 'violation.ts', 4, 'diverged'],
  ];
  for (const [trace, file, exitCode, result] of cases) {
    const json = run(['replay', trace, file, '--json']);
    assert.equal(json.status, exitCode, `${trace}: ${json.stderr}`);
    const parsed = report(json.stdout);
    assert.deepEqual([parsed.reportVersion, parsed.command, parsed.result, parsed.exitCode], [1, 'replay', result, exitCode], trace);
    const human = run(['replay', trace, file]);
    assert.equal(human.status, exitCode, trace);
    assert.match(human.stdout, new RegExp(`Result: ${result}\\n$`), trace);
  }
});

// ---------------------------------------------------------------------------
// Text output.

test('text output shows actor errors, incomplete-exploration hints and trace notes', () => {
  const error = run(['test', 'actor-error.ts']);
  assert.match(error.stdout, /First failure \(actor_error\):/);
  assert.match(error.stdout, /ERROR a: database connection refused/);
  assert.match(error.stdout, /Failures: 2 \(actor_error: 2\)/);

  const schedules = run(['test', 'pass.ts', '--max-schedules', '1']);
  assert.match(schedules.stdout, /Exploration incomplete: stopped at the --max-schedules limit/);
  const steps = run(['test', 'pass.ts', '--max-steps', '1']);
  assert.match(steps.stdout, /Exploration incomplete: a schedule reached the --max-steps limit/);

  const noTrace = run(['test', 'pass.ts', '--trace-out', 'never.json']);
  assert.match(noTrace.stdout, /No failure found; no trace written/);
  assert.ok(!existsSync(join(dir, 'never.json')));
});

test('replay text output explains reproduced and diverged traces', () => {
  const reproduced = run(['replay', 'failing.json', 'violation.ts']);
  assert.match(reproduced.stdout, /Replay reproduced the trace \(invariant_failed\)/);
  assert.match(reproduced.stdout, /VIOLATION inv:/);
  const diverged = run(['replay', 'diverging.json', 'violation.ts']);
  assert.match(diverged.stdout, /Replay diverged: Observed outcome, violations differ from the recorded trace/);
  assert.match(diverged.stdout, /recorded outcome: passed, observed: invariant_failed/);
});

// ---------------------------------------------------------------------------
// Argument validation.

test('invalid arguments are rejected before any scenario code runs', () => {
  const invocations: [string[], string][] = [
    [['test', 'side-effect.ts', '--tracout', 't.json'], 'unknown_option'],
    [['test', 'side-effect.ts', '--max-schedules'], 'missing_value'],
    [['test', 'side-effect.ts', '--trace-out', '--json'], 'missing_value'],
    [['test', 'side-effect.ts', '--max-steps', '1', '--max-steps', '2'], 'duplicate_option'],
    [['test', 'side-effect.ts', 'extra.ts'], 'unexpected_argument'],
    [['test', 'side-effect.ts', '--max-schedules', '0x2'], 'invalid_value'],
    [['test', 'side-effect.ts', '--step-timeout', '0'], 'invalid_value'],
  ];
  for (const [args, code] of invocations) {
    const result = run([...args, '--json']);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
    assert.equal(report(result.stdout).error.code, code, args.join(' '));
    assert.ok(!existsSync(marker()), `${args.join(' ')} loaded the scenario`);
    assert.ok(!existsSync(join(dir, '--json')), 'no file named after an option');
  }
  const help = run(['test', 'side-effect.ts', '--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage:/);
  assert.ok(!existsSync(marker()), '--help does not run the scenario');
});

// ---------------------------------------------------------------------------
// Errors and JSON output.

test('errors in --json mode are a single JSON document on stdout', () => {
  const missing = run(['test', 'missing.ts', '--json']);
  assert.equal(missing.status, 2);
  const parsed = report(missing.stdout);
  assert.deepEqual([parsed.result, parsed.exitCode, parsed.error.code], ['error', 2, 'scenario_not_found']);
  assert.match(parsed.error.message, /Scenario file not found/);
  assert.match(missing.stderr, /Scenario file not found/);
  const traceMissing = run(['replay', 'no-such-trace.json', 'pass.ts', '--json']);
  assert.equal(traceMissing.status, 2);
  assert.equal(report(traceMissing.stdout).error.code, 'trace_not_found');
  assert.match(traceMissing.stderr, /Trace file not found/);
});

test('scenario output goes to stderr in --json mode, also with FORCE_COLOR=1', () => {
  // Logs through console and process.stdout.write; awaiting the write callback must still work.
  const noisy = (name: string, invariant: string) => write(`${name}.ts`, scenario(name,
    `console.log('debug: a starting', { n: 1 }); console.info('info line');
     await new Promise((resolve) => process.stdout.write('raw write\\n', resolve));
     await checkpoint('a1');`, '', invariant));
  for (const [file, exitCode] of [[noisy('noisy-pass', 'check: () => true'), 0], [noisy('noisy-fail', 'check: () => false'), 1]] as const) {
    for (const env of [{}, { FORCE_COLOR: '1' }]) {
      const result = run(['test', file, '--json'], env);
      assert.equal(result.status, exitCode, result.stderr);
      assert.equal(report(result.stdout).exitCode, exitCode);
      assert.match(result.stderr, /debug: a starting/);
      assert.match(result.stderr, /raw write/);
    }
  }
});

// ---------------------------------------------------------------------------
// Crashes.

test('uncaught errors and unhandled rejections from scenario code are runtime errors (exit 5)', () => {
  write('rejection.ts', scenario('rejection', `await checkpoint('a1'); void Promise.reject(new Error('nobody handled this'));`));
  write('abort-listener.ts', scenario('abort-listener', `signal.addEventListener('abort', () => { throw new Error('listener failed'); }); await checkpoint('a1');`));
  for (const [file, message] of [['detached-crash.ts', /late callback failed/], ['rejection.ts', /nobody handled this/], ['abort-listener.ts', /listener failed/]] as const) {
    const json = run(['test', file, '--json']);
    assert.equal(json.status, 5, `${file}: ${json.stderr}`);
    const parsed = report(json.stdout);
    assert.deepEqual([parsed.result, parsed.exitCode, parsed.error.code], ['error', 5, 'runtime_error'], file);
    assert.match(parsed.error.message, message, file);
    const human = run(['test', file]);
    assert.equal(human.status, 5, file);
    assert.match(human.stderr, message, file);
  }
});

test('a crash does not leave the CLI waiting on scenario timers', () => {
  write('crash-with-timer.ts', scenario('crash-with-timer',
    `await checkpoint('a1'); setTimeout(() => {}, 60_000); setTimeout(() => { throw new Error('crashed'); }, 5);`, '', 'check: () => true',
    `async run({ checkpoint }) { await checkpoint('b1'); await new Promise((resolve) => setTimeout(resolve, 50)); }`));
  const started = Date.now();
  const result = run(['test', 'crash-with-timer.ts', '--json']);
  assert.ok(Date.now() - started < 15_000, 'must not wait for the 60 s timer');
  assert.equal(result.status, 5, result.stderr);
});

test('a crash after the report is written exits with 5 without a second report', () => {
  write('late-crash.ts', scenario('late-crash', `await checkpoint('a1'); setTimeout(() => { throw new Error('much later'); }, 300);`));
  const result = run(['test', 'late-crash.ts', '--json']);
  assert.equal(result.status, 5, result.stderr);
  assert.equal(report(result.stdout).result, 'passed', 'the report describes the exploration that completed');
  assert.match(result.stderr, /after the report was written.*much later/s);
});

test('a late crash keeps a higher-precedence exit code of 2', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  write('late-crash-failing.ts', scenario('late-crash-failing', `await checkpoint('a1'); setTimeout(() => { throw new Error('much later'); }, 300);`, '', 'check: () => false'));
  const locked = join(dir, 'locked-late');
  mkdirSync(locked, { recursive: true });
  chmodSync(locked, 0o500);
  try {
    const result = run(['test', 'late-crash-failing.ts', '--trace-out', join('locked-late', 'trace.json'), '--json']);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(report(result.stdout).error.code, 'trace_write_failed');
    assert.match(result.stderr, /after the report was written.*much later/s);
  } finally {
    chmodSync(locked, 0o700);
  }
});

test('without --json, scenario output stays on stdout', () => {
  write('chatty.ts', scenario('chatty', `console.log('chatty log'); process.stdout.write('chatty write\\n'); await checkpoint('a1');`));
  const result = run(['test', 'chatty.ts']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /chatty log/);
  assert.match(result.stdout, /chatty write/);
  assert.doesNotMatch(result.stderr, /chatty/);
});

test('scenario load failures report the location in the scenario file', () => {
  write('syntax.ts', 'export default {\n  name: "broken",\n  createState: () => ({}),,\n};\n');
  write('toplevel.ts', 'throw new Error("config file missing");\n');
  for (const [file, location, message] of [['syntax.ts', /syntax\.ts:3/, /Could not load scenario/], ['toplevel.ts', /toplevel\.ts:1/, /config file missing/]] as const) {
    const json = run(['test', file, '--json']);
    assert.equal(json.status, 2, file);
    const parsed = report(json.stdout);
    assert.equal(parsed.error.code, 'scenario_load_failed', file);
    assert.match(parsed.error.message, message, file);
    assert.match(parsed.error.detail, location, file);
    const human = run(['test', file]);
    assert.equal(human.status, 2, file);
    assert.match(human.stderr, location, file);
  }
});

// ---------------------------------------------------------------------------
// Traces.

test('an unusable --trace-out path is rejected before exploration', () => {
  mkdirSync(join(dir, 'a-directory'), { recursive: true });
  write('a-file.txt', 'not a directory');
  for (const target of ['a-directory', join('a-file.txt', 'trace.json')]) {
    const result = run(['test', 'side-effect.ts', '--trace-out', target, '--json']);
    assert.equal(result.status, 2, `${target}: ${result.stderr}`);
    assert.equal(report(result.stdout).error.code, 'trace_write_failed', target);
    assert.ok(!existsSync(marker()), `${target}: checked before loading the scenario`);
  }
});

test('a trace write that fails after exploration keeps the report', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const locked = join(dir, 'locked');
  mkdirSync(locked, { recursive: true });
  chmodSync(locked, 0o500);
  try {
    const json = run(['test', 'violation.ts', '--trace-out', join('locked', 'trace.json'), '--json']);
    assert.equal(json.status, 2, json.stderr);
    const parsed = report(json.stdout);
    assert.deepEqual([parsed.result, parsed.exitCode, parsed.error.code], ['error', 2, 'trace_write_failed']);
    assert.equal(parsed.failureCount, 2, 'the exploration results are still reported');
    assert.equal(parsed.tracePath, null);
    const human = run(['test', 'violation.ts', '--trace-out', join('locked', 'trace.json')]);
    assert.equal(human.status, 2);
    assert.match(human.stdout, /VIOLATION inv/);
    assert.match(human.stderr, /Could not write trace/);
  } finally {
    chmodSync(locked, 0o700);
  }
});

test('traces saved with a UTF-8 byte order mark replay normally', () => {
  write('bom.json', `﻿${readFileSync(join(dir, 'failing.json'), 'utf8')}`);
  const result = run(['replay', 'bom.json', 'violation.ts', '--json']);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(report(result.stdout).status, 'replayed');
});

test('replaying a custom-scenario trace without its file explains what to pass', () => {
  const result = run(['replay', 'failing.json', '--json']);
  assert.equal(result.status, 2);
  const parsed = report(result.stdout);
  assert.equal(parsed.error.code, 'missing_argument');
  assert.match(parsed.error.message, /trace is for scenario 'violation', which is not a built-in demo; pass its file/i);
});

test('the inventory demos keep working without a scenario file', () => {
  const traced = run(['test', 'inventory-buggy', '--trace-out', 'inventory.json']);
  assert.equal(traced.status, 1);
  assert.equal(run(['replay', 'inventory.json']).status, 1);
  assert.equal(run(['test', 'inventory-fixed']).status, 0);
});
