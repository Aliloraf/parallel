import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { defineScenario } from '../packages/sdk/src/index.ts';
import type { Actor, Invariant, Scenario } from '../packages/sdk/src/index.ts';
import { ExecutionError, explore } from '../packages/engine/src/index.ts';
import type { Decision } from '../packages/engine/src/index.ts';
import { ROOT_BRANCH, branchAt, choicePoint, sameChoices } from '../packages/engine/src/history.ts';
import type { ChoicePoint } from '../packages/engine/src/history.ts';
import { inventoryScenario } from '../examples/inventory/src/scenarios.ts';
import counter from '../examples/counter/src/scenario.ts';
import { boundedErrorFixture } from './fixtures/scenarios.ts';

const guard = { timeout: 15_000 };
const never = () => new Promise<never>(() => {});
const passing: Invariant<unknown>[] = [{ name: 'ok', check: () => true }];
const d = (actor: string, checkpoint: string): Decision => ({ actor, checkpoint });

function scenario<State>(name: string, createState: () => State, runs: Record<string, Actor<State>['run']>, invariants: Invariant<State>[] = passing) {
  return defineScenario<State>({ name, createState, actors: Object.entries(runs).map(([id, run]) => ({ id, run })), invariants });
}

// ---------------------------------------------------------------------------
// N1: a forced decision that is no longer eligible.

test('N1: a forced decision that is no longer eligible halts exploration as nondeterministic', guard, async () => {
  let n = 0;
  const summary = await explore(scenario('n1', () => ({}), {
    a: async ({ checkpoint }) => { await checkpoint('a1'); },
    b: async ({ checkpoint }) => { await checkpoint(n++ % 2 ? 'x' : 'y'); },
  }, [{ name: 'always-fails', check: () => false }]));
  assert.equal(summary.haltReason, 'nondeterministic');
  assert.equal(summary.complete, false);
  assert.equal(summary.limitReached, null);
  assert.deepEqual(summary.nondeterminism, {
    afterDecisions: 0,
    prefix: [d('b', 'y')],
    decisions: [],
    expected: [d('a', 'a1'), d('b', 'y')],
    observed: [d('a', 'a1'), d('b', 'x')],
    abandonedWork: false,
  });
  // Results found before the divergence are preserved.
  assert.equal(summary.schedulesExplored, 1);
  assert.equal(summary.failures.length, 1);
  assert.equal(summary.failures[0]?.outcome, 'invariant_failed');
  assert.deepEqual(summary.failures[0]?.decisions, [d('a', 'a1'), d('b', 'y')]);
});

// ---------------------------------------------------------------------------
// N3-N5: the choice point changes although the forced decision stays eligible.

test('N3: a choice point that gains an option during prefix re-execution is detected', guard, async () => {
  let runs = 0;
  const summary = await explore(scenario('n3', () => { runs++; return {}; }, {
    a: async ({ checkpoint }) => { await checkpoint('a1'); },
    b: async ({ checkpoint }) => { await checkpoint('b1'); },
    c: async ({ checkpoint }) => { if (runs > 1) await checkpoint('c1'); },
  }));
  assert.equal(summary.haltReason, 'nondeterministic');
  assert.equal(summary.complete, false);
  assert.equal(summary.nondeterminism?.afterDecisions, 0);
  assert.deepEqual(summary.nondeterminism?.expected, [d('a', 'a1'), d('b', 'b1')]);
  assert.deepEqual(summary.nondeterminism?.observed, [d('a', 'a1'), d('b', 'b1'), d('c', 'c1')]);
  assert.equal(summary.schedulesExplored, 1);
});

test('N4: a choice point that loses an option during prefix re-execution is detected', guard, async () => {
  let runs = 0;
  const summary = await explore(scenario('n4', () => { runs++; return {}; }, {
    a: async ({ checkpoint }) => { await checkpoint('a1'); if (runs === 1) await checkpoint('a2'); },
    b: async ({ checkpoint }) => { await checkpoint('b1'); },
  }));
  assert.equal(summary.haltReason, 'nondeterministic');
  assert.equal(summary.complete, false);
  assert.deepEqual(summary.nondeterminism?.prefix, [d('a', 'a1'), d('b', 'b1')]);
  assert.deepEqual(summary.nondeterminism?.decisions, [d('a', 'a1')]);
  assert.equal(summary.nondeterminism?.afterDecisions, 1);
  assert.deepEqual(summary.nondeterminism?.expected, [d('a', 'a2'), d('b', 'b1')]);
  assert.deepEqual(summary.nondeterminism?.observed, [d('b', 'b1')]);
  assert.equal(summary.schedulesExplored, 2, 'the two schedules before the divergence are kept');
});

test('N5: a run that would end before its forced prefix is consumed is detected, not truncated', guard, async () => {
  // Previously the third schedule silently ended after one decision and was reported as passed.
  let runs = 0;
  const summary = await explore(scenario('n5', () => { runs++; return {}; }, {
    a: async ({ checkpoint }) => { await checkpoint('a1'); if (runs === 1) await checkpoint('a2'); },
    b: async ({ checkpoint }) => { if (runs <= 2) await checkpoint('b1'); },
  }));
  assert.equal(summary.haltReason, 'nondeterministic');
  assert.equal(summary.complete, false);
  // An actor still waiting at a matching step stays eligible, so a vanished
  // prefix shows up as the first choice point that differs.
  assert.equal(summary.nondeterminism?.afterDecisions, 0);
  assert.deepEqual(summary.nondeterminism?.prefix, [d('a', 'a1'), d('b', 'b1')]);
  assert.deepEqual(summary.nondeterminism?.observed, [d('a', 'a1')]);
  assert.ok(!summary.outcomes.some((trace) => trace.decisions.length === 1), 'no truncated schedule is reported');
});

test('N5: a forced step with no eligible actors at all is reported with an empty observation', guard, async () => {
  let runs = 0;
  const summary = await explore(scenario('n5-empty', () => { runs++; return {}; }, {
    a: async ({ checkpoint }) => { if (runs === 1) await checkpoint('a1'); },
    b: async ({ checkpoint }) => { if (runs === 1) await checkpoint('b1'); },
  }));
  assert.equal(summary.haltReason, 'nondeterministic');
  assert.deepEqual(summary.nondeterminism?.expected, [d('a', 'a1'), d('b', 'b1')]);
  assert.deepEqual(summary.nondeterminism?.observed, []);
  assert.equal(summary.schedulesExplored, 1);
});

// ---------------------------------------------------------------------------
// N2: divergence must still measure and report abandoned work.

test('N2: a nondeterministic run with unsettled cleanup reports abandoned work', guard, async () => {
  let n = 0;
  const started = Date.now();
  const summary = await explore(scenario('n2', () => ({}), {
    a: async ({ checkpoint }) => { try { await checkpoint('a1'); await checkpoint('a2'); } catch { await never(); } },
    b: async ({ checkpoint }) => { await checkpoint(n++ % 2 ? 'x' : 'y'); },
  }), { stepTimeoutMs: 50 });
  assert.ok(Date.now() - started < 5_000, 'teardown of the diverged run is bounded');
  assert.equal(summary.haltReason, 'nondeterministic');
  assert.equal(summary.abandonedWork, true);
  assert.equal(summary.nondeterminism?.abandonedWork, true);
  assert.deepEqual(summary.nondeterminism?.teardown, [
    { actor: 'a', status: 'unresponsive', detail: 'did not settle within 50 ms after cancellation' },
  ]);
  assert.equal(summary.outcomes[0]?.outcome, 'passed', 'the schedule before the divergence is kept');
});

// ---------------------------------------------------------------------------
// No false positives on deterministic scenarios.

test('deterministic scenarios never report nondeterminism', guard, async () => {
  // Scenarios with different state types share one table.
  const deterministic: { scenario: Scenario<any>; schedules: number }[] = [
    { scenario: inventoryScenario(), schedules: 6 },
    { scenario: inventoryScenario(true), schedules: 6 },
    { scenario: counter, schedules: 6 },
    { scenario: scenario('three', () => ({}), Object.fromEntries(['a', 'b', 'c'].map((id) => [id, async ({ checkpoint }: { checkpoint: (name: string) => Promise<void> }) => { await checkpoint(`${id}1`); }]))), schedules: 6 },
    { scenario: scenario('slow', () => ({}), {
      a: async ({ checkpoint }) => { await checkpoint('a1'); await sleep(5); await checkpoint('a2'); },
      b: async ({ checkpoint }) => { await checkpoint('b1'); },
    }), schedules: 3 },
    { scenario: scenario('errors', () => ({}), {
      a: async ({ checkpoint }) => { await checkpoint('a1'); throw new Error('boom'); },
      b: async ({ checkpoint }) => { await checkpoint('b1'); },
    }), schedules: 2 },
  ];
  for (const { scenario: subject, schedules } of deterministic) {
    const summary = await explore(subject, { stepTimeoutMs: 2_000 });
    assert.equal(summary.nondeterminism, null, subject.name);
    assert.equal(summary.haltReason, null, subject.name);
    assert.equal(summary.complete, true, subject.name);
    assert.equal(summary.schedulesExplored, schedules, subject.name);
  }
});

test('exploration order and outcomes are identical across repeated runs (FR-009)', guard, async () => {
  const first = await explore(inventoryScenario());
  const second = await explore(inventoryScenario());
  assert.deepEqual(second.outcomes, first.outcomes);
  // Mutating a returned result cannot influence a later exploration.
  for (const trace of first.outcomes) {
    trace.decisions.reverse();
    trace.decisions[0]!.actor = 'tampered';
  }
  assert.deepEqual((await explore(inventoryScenario())).outcomes, second.outcomes);
});

// ---------------------------------------------------------------------------
// Immutable scheduling history.

test('choice points are deep-frozen snapshots independent of their source', () => {
  const eligible = [d('a', 'a1'), d('b', 'b1')];
  const point = choicePoint(eligible);
  eligible.push(d('c', 'c1'));
  eligible[0]!.checkpoint = 'changed';
  assert.deepEqual(point, [d('a', 'a1'), d('b', 'b1')]);
  assert.ok(Object.isFrozen(point) && point.every(Object.isFrozen));
  assert.throws(() => { (point as Decision[]).push(d('x', 'x')); }, TypeError);
  assert.throws(() => { (point[0] as Decision).actor = 'x'; }, TypeError);
});

test('recording further steps cannot alter a branch recorded earlier', () => {
  // Mirrors how a run records its history: choice points and decisions grow as it proceeds.
  const choices: ChoicePoint[] = [choicePoint([d('a', 'a1'), d('b', 'b1')])];
  const decisions: Decision[] = [];
  const first = branchAt(decisions, choices, choices[0]![1]!);
  decisions.push(d('a', 'a1'));
  choices.push(choicePoint([d('a', 'a2'), d('b', 'b1')]));
  const second = branchAt(decisions, choices, choices[1]![1]!);
  decisions.push(d('a', 'a2'));
  choices.push(choicePoint([d('b', 'b1')]));
  decisions[0]!.actor = 'tampered';

  assert.deepEqual(first, { prefix: [d('b', 'b1')], expected: [[d('a', 'a1'), d('b', 'b1')]] });
  assert.deepEqual(second, {
    prefix: [d('a', 'a1'), d('b', 'b1')],
    expected: [[d('a', 'a1'), d('b', 'b1')], [d('a', 'a2'), d('b', 'b1')]],
  });
  for (const branch of [first, second, ROOT_BRANCH]) {
    assert.ok(Object.isFrozen(branch) && Object.isFrozen(branch.prefix) && Object.isFrozen(branch.expected));
    assert.ok(branch.prefix.every(Object.isFrozen));
    assert.throws(() => { (branch.expected as ChoicePoint[]).push([]); }, TypeError);
  }
  assert.deepEqual(ROOT_BRANCH, { prefix: [], expected: [] });
});

test('sameChoices compares actors and checkpoints in order', () => {
  const point = choicePoint([d('a', 'a1'), d('b', 'b1')]);
  assert.equal(sameChoices(point, [d('a', 'a1'), d('b', 'b1')]), true);
  assert.equal(sameChoices(point, [d('a', 'a1')]), false);
  assert.equal(sameChoices(point, [d('a', 'a1'), d('b', 'b2')]), false);
  assert.equal(sameChoices(point, [d('b', 'b1'), d('a', 'a1')]), false);
  assert.equal(sameChoices(point, []), false);
});

// ---------------------------------------------------------------------------
// C1: actor errors are distinct from step-limit exhaustion.

test('C1: an actor error in a step-bounded run is an actor_error, and the bound is still reported', guard, async () => {
  const summary = await explore(boundedErrorFixture, { maxSteps: 3 });
  assert.equal(summary.limitReached, 'maxSteps');
  assert.equal(summary.complete, false);
  assert.ok(summary.outcomes.every((trace) => trace.stepLimitReached === true));
  for (const trace of summary.outcomes) {
    if (trace.errors.length > 0) {
      assert.equal(trace.outcome, 'actor_error');
      assert.deepEqual(trace.errors, [{ actor: 'a', message: 'boom' }]);
    } else {
      assert.equal(trace.outcome, 'incomplete');
    }
  }
  const errored = summary.outcomes.filter((trace) => trace.errors.length > 0);
  assert.equal(errored.length, 3);
  assert.deepEqual(summary.failures, errored, 'bounded actor errors are failures');
});

test('C1: runs that finish naturally carry no stepLimitReached marker', guard, async () => {
  const summary = await explore(scenario('natural', () => ({}), {
    a: async ({ checkpoint }) => { await checkpoint('a1'); throw new Error('boom'); },
    b: async ({ checkpoint }) => { await checkpoint('b1'); },
  }));
  assert.ok(summary.outcomes.every((trace) => trace.outcome === 'actor_error' && !('stepLimitReached' in trace)));
  assert.equal(summary.limitReached, null);
});

// ---------------------------------------------------------------------------
// C2: stopOnFailure is not resource-limit exhaustion.

test('C2: stopOnFailure halts with its own reason instead of reporting maxSchedules', guard, async () => {
  const summary = await explore(inventoryScenario(), { stopOnFailure: true });
  assert.equal(summary.haltReason, 'stop_on_failure');
  assert.equal(summary.limitReached, null);
  assert.equal(summary.complete, false);
  assert.equal(summary.failures.length, 1);
});

test('C2: stopOnFailure on the final schedule leaves exploration complete', guard, async () => {
  const summary = await explore(scenario('last-fails', () => ({ order: [] as string[] }), {
    a: async ({ state, checkpoint }) => { await checkpoint('a1'); state.order.push('a'); },
    b: async ({ state, checkpoint }) => { await checkpoint('b1'); state.order.push('b'); },
  }, [{ name: 'a-first', check: (state) => state.order[0] === 'a' }]), { stopOnFailure: true });
  assert.equal(summary.schedulesExplored, 2);
  assert.equal(summary.failures.length, 1);
  assert.equal(summary.haltReason, null);
  assert.equal(summary.complete, true);
});

test('C2: maxSchedules is still reported when it is the actual limit', guard, async () => {
  const summary = await explore(inventoryScenario(), { maxSchedules: 2 });
  assert.equal(summary.limitReached, 'maxSchedules');
  assert.equal(summary.haltReason, null);
});

// ---------------------------------------------------------------------------
// Unexpected engine failures after actors start.

test('an unexpected failure after actors start surfaces as ExecutionError with abandonment status', guard, async () => {
  let armed = false;
  const base = scenario('broken-invariants', () => ({}), {
    a: async ({ checkpoint }) => { await checkpoint('a1'); },
    b: async ({ checkpoint }) => { await checkpoint('b1'); },
  });
  const broken = Object.defineProperty({ ...base }, 'invariants', {
    get() { if (armed) throw new Error('invariants unavailable'); return base.invariants; },
  });
  armed = true;
  await assert.rejects(explore(broken), (error: unknown) => {
    assert.ok(error instanceof ExecutionError);
    assert.equal(error.abandonedWork, false);
    assert.match(error.message, /invariants unavailable/);
    assert.ok(error.cause instanceof Error);
    return true;
  });
});
