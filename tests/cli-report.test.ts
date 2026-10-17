import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineScenario } from '@aliloraf/parallel-sdk';
import type { Actor } from '@aliloraf/parallel-sdk';
import { explore, replay } from '@aliloraf/parallel-engine';
import type { ExploreResult } from '@aliloraf/parallel-engine';
import { classifyExploration, classifyReplay, errorReport, replayReport, testReport, REPORT_VERSION } from '../packages/cli/dist/report.js';
import { CliError } from '../packages/cli/dist/errors.js';

const guard = { timeout: 15_000 };
const ok = [{ name: 'ok', check: () => true }];
const scenario = (name: string, a: Actor<{ n: number }>['run'], invariants: { name: string; check: (s: { n: number }) => boolean }[] = ok) =>
  defineScenario<{ n: number }>({ name, createState: () => ({ n: 0 }), actors: [{ id: 'a', run: a }, { id: 'b', async run({ checkpoint }) { await checkpoint('b1'); } }], invariants });

/** The report fields that must agree with each other for every result. */
function assertConsistent(report: Record<string, unknown>) {
  assert.equal(report.reportVersion, REPORT_VERSION);
  const { result, exitCode, complete, failureCount } = report;
  const expectedExit = { passed: 0, failed: 1, incomplete: 3, nondeterministic: 4 }[result as string];
  assert.equal(exitCode, expectedExit, `exit code for ${String(result)}`);
  if (result === 'passed') assert.ok(complete === true && failureCount === 0);
  if (result === 'failed') assert.ok((failureCount as number) > 0);
  if (result === 'incomplete') assert.ok(complete === false && failureCount === 0);
  if (result === 'nondeterministic') assert.equal(complete, false);
}

test('exploration results map to exit codes with the agreed precedence', guard, async () => {
  let n = 0;
  const cases: [string, Promise<ExploreResult>, string, number][] = [
    ['complete, no failures', explore(scenario('pass', async ({ checkpoint }) => { await checkpoint('a1'); })), 'passed', 0],
    ['invariant violation', explore(scenario('violation', async ({ checkpoint }) => { await checkpoint('a1'); }, [{ name: 'never', check: () => false }])), 'failed', 1],
    ['actor error', explore(scenario('error', async ({ checkpoint }) => { await checkpoint('a1'); throw new Error('boom'); })), 'failed', 1],
    ['stall', explore(scenario('stall', async ({ checkpoint }) => { await checkpoint('a1'); await new Promise(() => {}); }), { stepTimeoutMs: 30 }), 'failed', 1],
    ['schedule bound', explore(scenario('bounded', async ({ checkpoint }) => { await checkpoint('a1'); }), { maxSchedules: 1 }), 'incomplete', 3],
    ['step bound', explore(scenario('steps', async ({ checkpoint }) => { await checkpoint('a1'); }), { maxSteps: 1 }), 'incomplete', 3],
    ['failures plus a bound', explore(scenario('fail-bounded', async ({ checkpoint }) => { await checkpoint('a1'); }, [{ name: 'never', check: () => false }]), { maxSchedules: 1 }), 'failed', 1],
    ['nondeterminism after failures', explore(defineScenario<{ n: number }>({
      name: 'nondet', createState: () => ({ n: 0 }),
      actors: [{ id: 'a', async run({ checkpoint }) { await checkpoint('a1'); } }, { id: 'b', async run({ checkpoint }) { await checkpoint(n++ % 2 ? 'x' : 'y'); } }],
      invariants: [{ name: 'never', check: () => false }],
    })), 'nondeterministic', 4],
  ];
  for (const [label, pending, result, exitCode] of cases) {
    const summary = await pending;
    assert.deepEqual(classifyExploration(summary), { result, exitCode }, label);
    const report = testReport(summary, null);
    assert.equal(report.result, result, label);
    assertConsistent(report);
  }
});

test('nondeterminism outranks failures but keeps their details', guard, async () => {
  let n = 0;
  const summary = await explore(defineScenario<{ n: number }>({
    name: 'nondet-failures', createState: () => ({ n: 0 }),
    actors: [{ id: 'a', async run({ checkpoint }) { await checkpoint('a1'); } }, { id: 'b', async run({ checkpoint }) { await checkpoint(n++ % 2 ? 'x' : 'y'); } }],
    invariants: [{ name: 'never', check: () => false }],
  }));
  const report = testReport(summary, null);
  assert.equal(report.result, 'nondeterministic');
  assert.equal(report.exitCode, 4);
  assert.equal(report.failureCount, 1);
  assert.deepEqual(report.failuresByOutcome, { invariant_failed: 1, actor_error: 0, stalled: 0 });
  assert.notEqual(report.firstFailure, null);
  assert.notEqual(report.nondeterminism, null);
});

test('the test report keeps every earlier field and adds the versioned header', guard, async () => {
  const summary = await explore(scenario('fields', async ({ checkpoint }) => { await checkpoint('a1'); throw new Error('boom'); }));
  const report = testReport(summary, '/tmp/trace.json');
  assert.deepEqual(Object.keys(report), [
    'reportVersion', 'command', 'result', 'exitCode',
    'scenario', 'schedulesExplored', 'failureCount', 'failuresByOutcome', 'complete', 'limitReached', 'haltReason',
    'abandonedWork', 'haltTrace', 'nondeterminism', 'firstFailure', 'tracePath',
  ]);
  assert.equal(report.command, 'test');
  assert.deepEqual(report.failuresByOutcome, { invariant_failed: 0, actor_error: 2, stalled: 0 });
  assert.equal(report.tracePath, '/tmp/trace.json');
});

test('replay results map to exit codes', guard, async () => {
  const failing = scenario('replay-failing', async ({ checkpoint }) => { await checkpoint('a1'); }, [{ name: 'never', check: () => false }]);
  const passing = scenario('replay-passing', async ({ checkpoint }) => { await checkpoint('a1'); });
  const failure = (await explore(failing)).failures[0]!;
  const pass = (await explore(passing)).outcomes[0]!;
  const bounded = (await explore(passing, { maxSteps: 1, maxSchedules: 1 })).outcomes[0]!;
  const cases: [string, Awaited<ReturnType<typeof replay>>, string, number][] = [
    ['reproduced passing trace', await replay(passing, pass), 'passed', 0],
    ['reproduced failing trace', await replay(failing, failure), 'failed', 1],
    ['reproduced bounded trace', await replay(passing, bounded), 'incomplete', 3],
    ['diverged', await replay(passing, { ...failure, scenario: 'replay-passing' }), 'diverged', 4],
  ];
  for (const [label, result, expected, exitCode] of cases) {
    assert.deepEqual(classifyReplay(result), { result: expected, exitCode }, label);
    const report = replayReport(result);
    assert.equal(report.reportVersion, REPORT_VERSION);
    assert.equal(report.command, 'replay');
    assert.equal(report.result, expected);
    assert.equal(report.exitCode, exitCode);
    assert.equal(report.status, result.status, 'the earlier replay fields are kept');
    assert.equal(report.abandonedWork, result.abandonedWork);
  }
});

test('error reports carry a stable code and the exit code of their category', () => {
  const usage = errorReport('test', new CliError('unknown_option', 'Unknown option --x'));
  assert.deepEqual(usage, { reportVersion: REPORT_VERSION, command: 'test', result: 'error', exitCode: 2, error: { code: 'unknown_option', message: 'Unknown option --x' } });
  const runtime = errorReport(null, new CliError('runtime_error', 'boom', { detail: 'at x (file.ts:1:1)' }));
  assert.equal(runtime.exitCode, 5);
  assert.deepEqual(runtime.error, { code: 'runtime_error', message: 'boom', detail: 'at x (file.ts:1:1)' });
});
