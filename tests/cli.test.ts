import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
// The built CLI, exactly as the package's `parallel-sim` bin runs it.
const cli = fileURLToPath(new URL('../packages/cli/dist/cli.js', import.meta.url));
const example = fileURLToPath(new URL('../examples/counter/src/scenario.ts', import.meta.url));
// Type stripping is on by default in supported Node.js versions; only silence its experimental warning.
const nodeArgs = ['--disable-warning=ExperimentalWarning', cli];

function runCli(args: string[]) {
  return spawnSync(process.execPath, [...nodeArgs, ...args], { cwd: root, encoding: 'utf8', timeout: 30_000 });
}

test('CLI loads a custom TypeScript scenario with a default export', () => {
  const result = runCli(['test', example, '--json']);
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.scenario, 'counter-lost-update');
  assert.equal(report.schedulesExplored, 6);
  assert.equal(report.failureCount, 4);
  assert.equal(report.complete, true);
});

test('CLI saves and replays a failure from an external TypeScript scenario', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parallel-cli-'));
  try {
    const path = join(dir, 'failure.json');
    const first = runCli(['test', example, '--trace-out', path]);
    assert.equal(first.status, 1, first.stderr);
    const trace = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(trace.scenario, 'counter-lost-update');
    const replay = runCli(['replay', path, example, '--json']);
    assert.equal(replay.status, 1, replay.stderr); // Known failure returns status 1.
    const output = JSON.parse(replay.stdout);
    assert.equal(output.status, 'replayed');
    assert.deepEqual(output.trace, trace);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI reports invalid or missing scenario exports clearly', () => {
  const missing = runCli(['test', './examples/does-not-exist.ts']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /Scenario file not found/);
  const badExtension = runCli(['test', './package.json']);
  assert.equal(badExtension.status, 2);
  assert.match(badExtension.stderr, /Unknown scenario/);
  const dir = mkdtempSync(join(tmpdir(), 'parallel-invalid-'));
  try {
    const invalidFile = join(dir, 'invalid.ts');
    writeFileSync(invalidFile, 'export default { name: "invalid" };\n');
    const invalidExport = runCli(['test', invalidFile]);
    assert.equal(invalidExport.status, 2);
    assert.match(invalidExport.stderr, /Invalid scenario exported/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('CLI accepts a named scenario export from a trusted local module', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parallel-named-'));
  try {
    const file = join(dir, 'named.ts');
    writeFileSync(file, `export const scenario = {
      name: 'named-example',
      createState: () => ({ count: 0 }),
      actors: [
        { id: 'a', async run({ state, checkpoint }) { await checkpoint('increment'); state.count++; } },
        { id: 'b', async run({ state, checkpoint }) { await checkpoint('increment'); state.count++; } },
      ],
      invariants: [{ name: 'two-increments', check: (state) => state.count === 2 }],
    };`);
    const result = runCli(['test', file, '--json']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.scenario, 'named-example');
    assert.equal(report.failureCount, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function withScenarioFile(source: string, use: (file: string, dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'parallel-lifecycle-'));
  try {
    const file = join(dir, 'scenario.ts');
    writeFileSync(file, source);
    use(file, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Actor `a` waits on a live 60 s timer, so the process has an open handle the engine cannot cancel.
const stalledWithLiveTimer = `export default {
  name: 'live-timer-stall',
  createState: () => ({}),
  actors: [
    { id: 'a', async run({ checkpoint }) { await checkpoint('fetch'); await new Promise((resolve) => setTimeout(resolve, 60_000)); } },
    { id: 'b', async run({ checkpoint }) { await checkpoint('b1'); } },
  ],
  invariants: [{ name: 'ok', check: () => true }],
};`;

test('CLI reports a stall and terminates despite abandoned work holding the process open', () => {
  withScenarioFile(stalledWithLiveTimer, (file) => {
    const started = Date.now();
    const result = runCli(['test', file, '--step-timeout', '100', '--json']);
    assert.ok(Date.now() - started < 15_000, 'CLI must not wait for the abandoned 60 s timer');
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.complete, false);
    assert.equal(report.haltReason, 'stalled');
    assert.equal(report.abandonedWork, true);
    assert.equal(report.firstFailure.outcome, 'stalled');
    assert.deepEqual(report.firstFailure.stall.actors, [{ actor: 'a', lastCheckpoint: 'fetch', settledAfterAbort: false }]);
    assert.match(result.stderr, /abandoned/i);
  });
});

test('CLI human-readable output identifies the stalled actor and checkpoint', () => {
  withScenarioFile(stalledWithLiveTimer, (file) => {
    const result = runCli(['test', file, '--step-timeout', '100']);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /Exploration halted: stalled/);
    assert.match(result.stdout, /STALLED after 1 decision/);
    assert.match(result.stdout, /a \(last checkpoint: fetch\)/);
  });
});

test('CLI replays a stalled trace using its recorded timeout', () => {
  withScenarioFile(stalledWithLiveTimer, (file, dir) => {
    const path = join(dir, 'stall.json');
    assert.equal(runCli(['test', file, '--step-timeout', '100', '--trace-out', path]).status, 1);
    const started = Date.now();
    const result = runCli(['replay', path, file, '--json']);
    assert.ok(Date.now() - started < 15_000);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'replayed');
  });
});

test('CLI exits normally when a stalled actor honors context.signal', () => {
  withScenarioFile(`export default {
    name: 'cooperative-stall',
    createState: () => ({}),
    actors: [
      { id: 'a', async run({ checkpoint, signal }) {
        await checkpoint('fetch');
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 60_000);
          signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); });
        });
      } },
      { id: 'b', async run({ checkpoint }) { await checkpoint('b1'); } },
    ],
    invariants: [{ name: 'ok', check: () => true }],
  };`, (file) => {
    const result = runCli(['test', file, '--step-timeout', '100', '--json']);
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.firstFailure.outcome, 'stalled');
    assert.equal(report.abandonedWork, false);
    assert.doesNotMatch(result.stderr, /abandoned/i);
  });
});

test('CLI rejects invalid or missing --step-timeout values', () => {
  const invalid = runCli(['test', 'inventory-fixed', '--step-timeout', '0']);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /--step-timeout must be an integer/);
  const missing = runCli(['test', 'inventory-fixed', '--step-timeout']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /Missing --step-timeout value/);
});

test('CLI terminates a diverged replay whose actor ignores cancellation', () => {
  withScenarioFile(`export default {
    name: 'diverged-cleanup',
    createState: () => ({}),
    actors: [
      { id: 'a', async run({ checkpoint }) { try { await checkpoint('a1'); } finally { await new Promise((resolve) => setTimeout(resolve, 60_000)); } } },
      { id: 'b', async run({ checkpoint }) { await checkpoint('b1'); } },
    ],
    invariants: [{ name: 'ok', check: () => true }],
  };`, (file, dir) => {
    const path = join(dir, 'diverged.json');
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, scenario: 'diverged-cleanup', decisions: [{ actor: 'nobody', checkpoint: 'x' }], outcome: 'passed', violations: [], errors: [] }));
    const started = Date.now();
    const result = runCli(['replay', path, file, '--step-timeout', '100', '--json']);
    assert.ok(Date.now() - started < 15_000, 'CLI must not wait for the abandoned cleanup timer');
    assert.equal(result.status, 4, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'replay_diverged');
    assert.equal(output.abandonedWork, true);
    assert.match(result.stderr, /abandoned/i);
  });
});

test('CLI rejects a missing option value before running any scenario code', () => {
  withScenarioFile(stalledWithLiveTimer, (file) => {
    const started = Date.now();
    const result = runCli(['test', file, '--step-timeout', '100', '--trace-out']);
    assert.ok(Date.now() - started < 15_000);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Missing --trace-out value/);
    assert.doesNotMatch(result.stderr, /abandoned/i, 'nothing ran, so nothing was abandoned');
  });
});

test('CLI reports which actor left abandoned work when exploration halts without a failure', () => {
  withScenarioFile(`export default {
    name: 'swallow-cli',
    createState: () => ({}),
    actors: [
      // Unbounded checkpoints hit the default maxSteps; the actor then swallows cancellation.
      { id: 'a', async run({ checkpoint }) { for (;;) { try { await checkpoint('loop'); } catch {} } } },
      { id: 'b', async run({ checkpoint }) { await checkpoint('b1'); } },
    ],
    invariants: [{ name: 'ok', check: () => true }],
  };`, (file) => {
    const json = runCli(['test', file, '--step-timeout', '100', '--json']);
    assert.equal(json.status, 3, json.stderr);
    const report = JSON.parse(json.stdout);
    assert.equal(report.haltReason, 'abandoned_work');
    assert.equal(report.complete, false);
    assert.deepEqual(report.haltTrace.teardown.map((entry: { status: string }) => entry.status), ['ignored-cancellation', 'unresponsive']);
    const human = runCli(['test', file, '--step-timeout', '100']);
    assert.match(human.stdout, /TEARDOWN a: unresponsive/);
  });
});

// Actor b's checkpoint name changes between runs, so re-executing a prefix diverges.
const nondeterministicScenario = (cleanup: string) => `let n = 0;
export default {
  name: 'cli-nondeterministic',
  createState: () => ({}),
  actors: [
    { id: 'a', async run({ checkpoint }) { try { await checkpoint('a1'); await checkpoint('a2'); } catch { ${cleanup} } } },
    { id: 'b', async run({ checkpoint }) { await checkpoint(n++ % 2 ? 'x' : 'y'); } },
  ],
  invariants: [{ name: 'ok', check: () => true }],
};`;

test('CLI reports nondeterministic exploration as structured data with exit status 4', () => {
  withScenarioFile(nondeterministicScenario(''), (file) => {
    const json = runCli(['test', file, '--json']);
    assert.equal(json.status, 4, json.stderr);
    const report = JSON.parse(json.stdout);
    assert.equal(report.complete, false);
    assert.equal(report.haltReason, 'nondeterministic');
    assert.equal(report.abandonedWork, false);
    assert.equal(report.schedulesExplored, 1);
    assert.deepEqual(report.nondeterminism.observed, [{ actor: 'a', checkpoint: 'a1' }, { actor: 'b', checkpoint: 'x' }]);
    assert.equal(report.haltTrace, null, 'the diverged run is not an explored schedule');
    assert.equal(report.firstFailure, null);
    const human = runCli(['test', file]);
    assert.equal(human.status, 4, human.stderr);
    assert.match(human.stdout, /Exploration halted: nondeterministic/);
    assert.match(human.stdout, /NONDETERMINISM after 0 decision\(s\) of forced prefix \[b:y\]/);
    assert.match(human.stdout, /expected choices: a:a1, b:y/);
    assert.match(human.stdout, /observed choices: a:a1, b:x/);
    assert.equal(human.stderr, '');
  });
});

test('CLI terminates promptly when nondeterministic exploration leaves abandoned work', () => {
  withScenarioFile(nondeterministicScenario('await new Promise((resolve) => setTimeout(resolve, 60_000));'), (file) => {
    const started = Date.now();
    const result = runCli(['test', file, '--step-timeout', '100', '--json']);
    assert.ok(Date.now() - started < 15_000, 'CLI must not wait for the abandoned cleanup timer');
    assert.equal(result.status, 4, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.haltReason, 'nondeterministic');
    assert.equal(report.abandonedWork, true);
    assert.equal(report.nondeterminism.teardown[0].status, 'unresponsive');
    assert.match(result.stderr, /abandoned/i);
  });
});

test('CLI rejects malformed trace files with exit status 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parallel-bad-trace-'));
  try {
    const notJson = join(dir, 'not-json.json');
    writeFileSync(notJson, '{ "schemaVersion": 1, ');
    const parse = runCli(['replay', notJson]);
    assert.equal(parse.status, 2);
    assert.match(parse.stderr, /is not valid JSON/);

    const badField = join(dir, 'bad-field.json');
    writeFileSync(badField, JSON.stringify({ schemaVersion: 1, scenario: 'inventory-buggy', decisions: [{ actor: 'customer-a' }], outcome: 'passed', violations: [], errors: [] }));
    const field = runCli(['replay', badField]);
    assert.equal(field.status, 2);
    assert.match(field.stderr, /Invalid trace: decisions\[0\]\.checkpoint must be a non-empty string/);

    const noScenario = join(dir, 'no-scenario.json');
    writeFileSync(noScenario, JSON.stringify({ schemaVersion: 1, decisions: [], outcome: 'passed', violations: [], errors: [] }));
    const missing = runCli(['replay', noScenario]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /Invalid trace: scenario must be a non-empty string/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI replay output includes the structured divergence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parallel-divergence-'));
  try {
    const path = join(dir, 'failure.json');
    assert.equal(runCli(['test', 'inventory-buggy', '--trace-out', path]).status, 1);
    const trace = JSON.parse(readFileSync(path, 'utf8'));
    trace.decisions.push({ actor: 'customer-a', checkpoint: 'extra' });
    writeFileSync(path, JSON.stringify(trace));
    const result = runCli(['replay', path, '--json']);
    assert.equal(result.status, 4, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'replay_diverged');
    assert.deepEqual(output.divergence, { kind: 'ended_early', afterDecisions: 4 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
