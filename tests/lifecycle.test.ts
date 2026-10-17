import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { defineScenario, SimulationCancelledError } from '@aliloraf/parallel-sdk';
import type { Actor } from '@aliloraf/parallel-sdk';
import { DEFAULT_STEP_TIMEOUT_MS, explore, leavesAbandonedWork, replay } from '@aliloraf/parallel-engine';
import { inventoryScenario } from '../packages/cli/dist/demos/inventory.js';

// Per-test wall-clock guard so a lifecycle regression fails instead of hanging the suite.
const guard = { timeout: 15_000 };
const never = () => new Promise<never>(() => {});
const passing = [{ name: 'ok', check: () => true }];

function twoActors<State>(
  name: string,
  createState: () => State,
  a: Actor<State>['run'],
  b: Actor<State>['run'] = async ({ checkpoint }) => { await checkpoint('b1'); },
) {
  return defineScenario<State>({ name, createState, actors: [{ id: 'a', run: a }, { id: 'b', run: b }], invariants: passing });
}

test('stepTimeoutMs defaults to 10 seconds', () => {
  assert.equal(DEFAULT_STEP_TIMEOUT_MS, 10_000);
});

test('invalid stepTimeoutMs values are rejected', guard, async () => {
  const scenario = inventoryScenario();
  for (const stepTimeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
    await assert.rejects(explore(scenario, { stepTimeoutMs }), /stepTimeoutMs/);
  }
  const failure = (await explore(scenario)).failures[0]!;
  await assert.rejects(replay(scenario, failure, { stepTimeoutMs: 0 }), /stepTimeoutMs/);
});

test('an actor stalled after a checkpoint is reported and halts exploration', guard, async () => {
  const started = Date.now();
  const summary = await explore(twoActors('stall-after', () => ({}), async ({ checkpoint }) => {
    await checkpoint('a1');
    await never();
  }), { stepTimeoutMs: 50 });
  assert.ok(Date.now() - started < 5_000, 'stall must be detected within a bounded time');
  assert.equal(summary.schedulesExplored, 1, 'no new schedules may run after a stall');
  assert.equal(summary.complete, false);
  assert.equal(summary.haltReason, 'stalled');
  assert.equal(summary.abandonedWork, true);
  const [trace] = summary.failures;
  assert.equal(trace?.outcome, 'stalled');
  assert.deepEqual(trace?.stall, {
    timeoutMs: 50,
    afterDecisions: 1,
    actors: [{ actor: 'a', lastCheckpoint: 'a1', settledAfterAbort: false }],
  });
  assert.deepEqual(trace?.decisions, [{ actor: 'a', checkpoint: 'a1' }]);
});

test('an actor stalled before its first checkpoint is reported', guard, async () => {
  const summary = await explore(twoActors('stall-before', () => ({}), async ({ checkpoint }) => {
    await never();
    await checkpoint('a1');
  }), { stepTimeoutMs: 50 });
  const [trace] = summary.failures;
  assert.equal(trace?.outcome, 'stalled');
  assert.deepEqual(trace?.decisions, []);
  assert.deepEqual(trace?.stall?.actors, [{ actor: 'a', lastCheckpoint: null, settledAfterAbort: false }]);
});

test('a stall in the final schedule is never reported as complete exploration', guard, async () => {
  // Stalls only when b runs before a has finished, which is the second (last) DFS schedule.
  const summary = await explore(twoActors('stall-last', () => ({ aDone: false }),
    async ({ state, checkpoint }) => { await checkpoint('a1'); state.aDone = true; },
    async ({ state, checkpoint }) => { await checkpoint('b1'); if (!state.aDone) await never(); },
  ), { stepTimeoutMs: 50 });
  assert.equal(summary.schedulesExplored, 2);
  assert.deepEqual(summary.outcomes.map((trace) => trace.outcome), ['passed', 'stalled']);
  assert.equal(summary.complete, false);
  assert.equal(summary.limitReached, null);
  assert.equal(summary.haltReason, 'stalled');
});

test('healthy actors awaiting short unmanaged work are not reported as stalled', guard, async () => {
  const summary = await explore(twoActors('slow-but-healthy', () => ({}),
    async ({ checkpoint }) => { await checkpoint('a1'); await sleep(20); await checkpoint('a2'); },
  ), { stepTimeoutMs: 2_000 });
  assert.equal(summary.complete, true);
  assert.equal(summary.haltReason, null);
  assert.equal(summary.abandonedWork, false);
  assert.equal(summary.failures.length, 0);
  assert.equal(summary.schedulesExplored, 3);
});

test('existing outcome traces carry no lifecycle fields', guard, async () => {
  const summary = await explore(inventoryScenario());
  for (const trace of summary.outcomes) {
    assert.ok(!('stall' in trace) && !('teardown' in trace));
  }
  assert.equal(summary.haltReason, null);
  assert.equal(summary.abandonedWork, false);
});

test('an abandoned actor that wakes later cannot alter its trace or later runs', guard, async () => {
  const observed: unknown[] = [];
  const scenario = twoActors('late-wake', () => ({ mutatedLate: false }), async ({ state, checkpoint }) => {
    await checkpoint('a1');
    await sleep(150);
    state.mutatedLate = true;
    try {
      await checkpoint('late');
    } catch (cause) {
      observed.push(cause);
    }
    throw new Error('late error');
  });
  const summary = await explore(scenario, { stepTimeoutMs: 30 });
  const trace = summary.failures[0]!;
  const snapshot = structuredClone(trace);
  await sleep(300);
  assert.deepEqual(trace, snapshot, 'late actor activity must not mutate a returned trace');
  assert.deepEqual(trace.errors, []);
  assert.equal(observed.length, 1);
  assert.ok(observed[0] instanceof SimulationCancelledError, 'late checkpoint receives a cancellation error');
  // A later, unrelated exploration in the same process is unaffected.
  const healthy = await explore(inventoryScenario(true));
  assert.equal(healthy.complete, true);
  assert.equal(healthy.failures.length, 0);
});

test('cancellation is delivered through checkpoint rejection and context.signal', guard, async () => {
  const seen: { rejected: boolean; aborted: boolean; reasonIsCancellation: boolean; abortedEarly: boolean }[] = [];
  await explore(twoActors('cancel-delivery', () => ({}), async ({ checkpoint, signal }) => {
    const abortedEarly = signal.aborted;
    try {
      for (;;) await checkpoint('spin');
    } catch (cause) {
      seen.push({
        rejected: cause instanceof SimulationCancelledError,
        aborted: signal.aborted,
        reasonIsCancellation: signal.reason instanceof SimulationCancelledError,
        abortedEarly,
      });
      throw cause;
    }
  }), { maxSteps: 2, maxSchedules: 1 });
  assert.deepEqual(seen, [{ rejected: true, aborted: true, reasonIsCancellation: true, abortedEarly: false }]);
});

test('each schedule receives a fresh, unaborted signal and it is aborted after the run', guard, async () => {
  const signals: AbortSignal[] = [];
  const summary = await explore(twoActors('fresh-signal', () => ({}), async ({ checkpoint, signal }) => {
    assert.equal(signal.aborted, false);
    signals.push(signal);
    await checkpoint('a1');
  }));
  assert.equal(signals.length, summary.schedulesExplored);
  assert.equal(new Set(signals).size, signals.length);
  assert.ok(signals.every((signal) => signal.aborted));
});

test('a cooperative actor that honors context.signal settles after a stall', guard, async () => {
  const summary = await explore(twoActors('cooperative', () => ({}), async ({ checkpoint, signal }) => {
    await checkpoint('a1');
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  }), { stepTimeoutMs: 50 });
  const trace = summary.failures[0]!;
  assert.equal(trace.outcome, 'stalled');
  assert.deepEqual(trace.stall?.actors, [{ actor: 'a', lastCheckpoint: 'a1', settledAfterAbort: true }]);
  assert.equal(summary.haltReason, 'stalled', 'a stall still halts exploration');
  assert.equal(summary.abandonedWork, false, 'no work remains once the actor settled');
});

test('an actor that swallows cancellation and checkpoints again cannot hang teardown', guard, async () => {
  const started = Date.now();
  const summary = await explore(twoActors('swallow', () => ({}), async ({ checkpoint }) => {
    for (;;) {
      try { await checkpoint('loop'); } catch { /* deliberately ignore cancellation */ }
    }
  }), { maxSteps: 1, stepTimeoutMs: 100 });
  assert.ok(Date.now() - started < 5_000, 'teardown is bounded by the step budget');
  assert.equal(summary.schedulesExplored, 1, 'an unsettled parked actor halts exploration');
  assert.equal(summary.complete, false);
  assert.equal(summary.haltReason, 'abandoned_work');
  assert.equal(summary.abandonedWork, true);
  const trace = summary.outcomes[0]!;
  assert.equal(trace.outcome, 'incomplete');
  assert.deepEqual(trace.teardown?.map((entry) => entry.status), ['ignored-cancellation', 'unresponsive']);
  assert.ok(trace.teardown?.every((entry) => entry.actor === 'a'));
});

test('a parked actor still running via Promise.race prevents the next schedule from starting', guard, async () => {
  // The parked checkpoint never settles, but racing it against a timer keeps the actor active.
  let runs = 0;
  let stop = false;
  const activity: { run: number; latestRun: number }[] = [];
  const scenario = twoActors('parked-but-active', () => ({ run: ++runs }), async ({ state, checkpoint }) => {
    let cancelled = false;
    for (;;) {
      try {
        await (cancelled ? Promise.race([checkpoint('loop'), sleep(5)]) : checkpoint('loop'));
      } catch {
        cancelled = true;
      }
      if (cancelled) {
        activity.push({ run: state.run, latestRun: runs });
        if (stop) return;
      }
    }
  }, async ({ checkpoint }) => { await checkpoint('b1'); await sleep(40); });
  try {
    const summary = await explore(scenario, { maxSteps: 1, stepTimeoutMs: 100 });
    assert.equal(summary.schedulesExplored, 1, 'no schedule may start while the parked actor is active');
    assert.equal(summary.haltReason, 'abandoned_work');
    assert.equal(summary.abandonedWork, true);
    assert.equal(summary.complete, false);
    assert.equal(runs, 1);
    assert.ok(activity.length > 0, 'the parked actor really was still running');
  } finally {
    stop = true;
    await sleep(30);
  }
});

test('a parked actor that settles within the teardown budget does not leave abandoned work', guard, async () => {
  const summary = await explore(twoActors('parked-then-settles', () => ({}), async ({ checkpoint }) => {
    try { await checkpoint('a1'); await checkpoint('a2'); } catch { /* ignore cancellation */ }
    await Promise.race([checkpoint('retry'), sleep(10)]);
  }), { maxSteps: 1, maxSchedules: 1, stepTimeoutMs: 1_000 });
  const trace = summary.outcomes[0]!;
  assert.deepEqual(trace.teardown?.map((entry) => entry.status), ['ignored-cancellation']);
  assert.equal(summary.abandonedWork, false);
  assert.equal(summary.haltReason, null);
});

test('abandonedWork matches leavesAbandonedWork for every outcome trace', guard, async () => {
  const scenarios = [
    twoActors('m-ok', () => ({}), async ({ checkpoint }) => { await checkpoint('a1'); }),
    twoActors('m-swallow', () => ({}), async ({ checkpoint }) => { for (;;) { try { await checkpoint('l'); } catch { /* ignore */ } } }),
    twoActors('m-stall', () => ({}), async ({ checkpoint }) => { await checkpoint('a1'); await never(); }),
    twoActors('m-cleanup', () => ({}), async ({ checkpoint }) => { try { await checkpoint('a1'); await checkpoint('a2'); } catch { throw new Error('x'); } }),
  ];
  for (const scenario of scenarios) {
    const summary = await explore(scenario, { maxSteps: 1, stepTimeoutMs: 50 });
    assert.equal(summary.abandonedWork, summary.outcomes.some(leavesAbandonedWork), scenario.name);
    assert.equal(summary.abandonedWork && summary.haltReason === null, false, `${scenario.name}: abandoned work always halts`);
  }
});

test('an actor that never finishes cleanup after cancellation is reported as unresponsive', guard, async () => {
  const summary = await explore(twoActors('unresponsive', () => ({}), async ({ checkpoint }) => {
    try { await checkpoint('a1'); await checkpoint('a2'); } finally { await never(); }
  }), { maxSteps: 1, stepTimeoutMs: 50 });
  assert.equal(summary.schedulesExplored, 1, 'exploration halts once work is abandoned');
  assert.equal(summary.complete, false);
  assert.equal(summary.haltReason, 'abandoned_work');
  assert.equal(summary.abandonedWork, true);
  const trace = summary.outcomes[0]!;
  assert.equal(trace.outcome, 'incomplete');
  assert.ok(trace.teardown?.some((entry) => entry.actor === 'a' && entry.status === 'unresponsive'));
});

test('cleanup that fails after the teardown budget cannot alter the finalized trace', guard, async () => {
  const summary = await explore(twoActors('late-cleanup', () => ({}), async ({ checkpoint }) => {
    try { await checkpoint('a1'); await checkpoint('a2'); } finally { await sleep(150); throw new Error('late cleanup'); }
  }), { maxSteps: 1, maxSchedules: 1, stepTimeoutMs: 30 });
  const trace = summary.outcomes[0]!;
  const snapshot = structuredClone(trace);
  await sleep(300);
  assert.deepEqual(trace, snapshot);
  assert.deepEqual(trace.teardown?.map((entry) => entry.status), ['unresponsive']);
});

test('no engine timers remain after exploration', guard, async () => {
  const timers = () => process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;
  const baseline = timers();
  await explore(inventoryScenario());
  await explore(twoActors('cooperative-timers', () => ({}), async ({ checkpoint, signal }) => {
    await checkpoint('a1');
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  }), { stepTimeoutMs: 50 });
  await explore(twoActors('swallow-timers', () => ({}), async ({ checkpoint }) => {
    for (;;) { try { await checkpoint('l'); } catch { /* ignore */ } }
  }), { maxSteps: 1, stepTimeoutMs: 50 });
  assert.equal(timers(), baseline);
});

test('a replay that diverges while an actor ignores cancellation reports abandoned work', guard, async () => {
  const scenario = twoActors('replay-abandoned', () => ({}), async ({ checkpoint }) => {
    try { await checkpoint('a1'); } finally { await never(); }
  });
  const trace = { schemaVersion: 1 as const, scenario: 'replay-abandoned', decisions: [{ actor: 'nobody', checkpoint: 'x' }], outcome: 'passed' as const, violations: [], errors: [] };
  const result = await replay(scenario, trace, { stepTimeoutMs: 50 });
  assert.equal(result.status, 'replay_diverged');
  assert.equal(result.abandonedWork, true);
  const clean = await replay(inventoryScenario(), (await explore(inventoryScenario())).failures[0]!);
  assert.equal(clean.status, 'replayed');
  assert.equal(clean.abandonedWork, false);
});

test('errors raised during cancellation cleanup are reported as teardown diagnostics', guard, async () => {
  const summary = await explore(twoActors('cleanup-error', () => ({}), async ({ checkpoint }) => {
    try { await checkpoint('a1'); await checkpoint('a2'); } catch { throw new Error('cleanup failed'); }
  }), { maxSteps: 1, maxSchedules: 1 });
  const trace = summary.outcomes[0]!;
  assert.equal(trace.outcome, 'incomplete');
  assert.deepEqual(trace.errors, []);
  assert.deepEqual(trace.teardown, [{ actor: 'a', status: 'cleanup-error', detail: 'cleanup failed' }]);
});

test('an un-awaited checkpoint after a resume is an actor error, not a scheduled step', guard, async () => {
  const summary = await explore(twoActors('orphan-after', () => ({}), async ({ checkpoint }) => {
    await checkpoint('a1');
    void checkpoint('a2');
  }));
  assert.equal(summary.complete, true);
  assert.ok(summary.outcomes.length > 0);
  for (const trace of summary.outcomes) {
    assert.equal(trace.outcome, 'actor_error');
    assert.ok(!trace.decisions.some((decision) => decision.checkpoint === 'a2'), 'orphaned checkpoint must not be scheduled');
    assert.match(trace.errors[0]?.message ?? '', /a2.*missing await/);
  }
});

test('an un-awaited first checkpoint is an actor error, not a scheduled step', guard, async () => {
  const summary = await explore(twoActors('orphan-first', () => ({}), async ({ checkpoint }) => {
    void checkpoint('a1');
  }));
  assert.ok(summary.outcomes.length > 0);
  for (const trace of summary.outcomes) {
    assert.equal(trace.outcome, 'actor_error');
    assert.deepEqual(trace.decisions, [{ actor: 'b', checkpoint: 'b1' }]);
    assert.equal(trace.errors[0]?.actor, 'a');
  }
});

test('overlapping checkpoints remain an actor error', guard, async () => {
  const summary = await explore(twoActors('overlap', () => ({}), async ({ checkpoint }) => {
    await Promise.all([checkpoint('x'), checkpoint('y')]);
  }));
  assert.ok(summary.outcomes.length > 0);
  for (const trace of summary.outcomes) {
    assert.equal(trace.outcome, 'actor_error');
    assert.ok(trace.errors.some((error) => /overlapping checkpoints/.test(error.message)));
    assert.ok(!trace.decisions.some((decision) => decision.actor === 'a'), 'an orphaned checkpoint must not be scheduled');
  }
});

test('a checkpoint called through a context after its actor finished is an actor error', guard, async () => {
  type State = { leaked?: (name: string) => Promise<void> };
  const summary = await explore(twoActors<State>('escaped-context', () => ({}),
    async ({ state, checkpoint }) => { state.leaked = checkpoint; },
    async ({ state, checkpoint }) => { await checkpoint('b1'); await state.leaked?.('ghost').catch(() => {}); },
  ));
  assert.ok(summary.outcomes.length > 0);
  for (const trace of summary.outcomes) {
    assert.equal(trace.outcome, 'actor_error');
    assert.ok(trace.errors.some((error) => error.actor === 'a' && /after it finished/.test(error.message)));
  }
});

test('a stalled trace replays with its recorded timeout and same stall', guard, async () => {
  const scenario = twoActors('replay-stall', () => ({}), async ({ checkpoint }) => {
    await checkpoint('a1');
    await never();
  });
  const failure = (await explore(scenario, { stepTimeoutMs: 40 })).failures[0]!;
  const started = Date.now();
  const result = await replay(scenario, failure);
  assert.ok(Date.now() - started < 5_000, 'replay uses the trace timeout rather than the 10 s default');
  assert.equal(result.status, 'replayed');
  if (result.status === 'replayed') assert.deepEqual(result.trace.stall, failure.stall);
  const fixed = twoActors('replay-stall', () => ({}), async ({ checkpoint }) => { await checkpoint('a1'); });
  assert.equal((await replay(fixed, failure)).status, 'replay_diverged');
});

test('the programmatic API reports a stall instead of exiting silently', guard, () => {
  const script = `
    const { explore } = await import('@aliloraf/parallel-engine');
    const { defineScenario } = await import('@aliloraf/parallel-sdk');
    const summary = await explore(defineScenario({
      name: 'api-stall', createState: () => ({}),
      actors: [
        { id: 'a', async run({ checkpoint }) { await checkpoint('a1'); await new Promise(() => {}); } },
        { id: 'b', async run({ checkpoint }) { await checkpoint('b1'); } },
      ],
      invariants: [{ name: 'ok', check: () => true }],
    }), { stepTimeoutMs: 50 });
    console.log(JSON.stringify({ outcome: summary.failures[0]?.outcome, complete: summary.complete }));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { outcome: 'stalled', complete: false });
});
