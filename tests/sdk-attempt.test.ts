// The SDK's `attempt` helper: what it captures, what it must never capture,
// and how it behaves inside the engine's actor lifecycle.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SimulationCancelledError, attempt, defineScenario } from '@aliloraf/parallel-sdk';
import type { Attempt } from '@aliloraf/parallel-sdk';
import { explore } from '@aliloraf/parallel-engine';

const guard = { timeout: 15_000 };

class Declined extends Error {
  override name = 'Declined';
}
const isDeclined = (error: Error) => error instanceof Declined;

/** Runs `operation` and returns whatever it threw, so identity can be compared. */
async function thrownBy(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (cause) {
    return cause;
  }
  throw new Error('expected the operation to throw');
}

// ---------------------------------------------------------------------------
// Values and expected errors.

test('a resolved operation returns its value', async () => {
  const result: Attempt<number> = await attempt(async () => 42, isDeclined);
  assert.deepEqual(result, { ok: true, value: 42 });
});

test('an operation resolving to undefined still reports success', async () => {
  const result = await attempt(async () => undefined, isDeclined);
  assert.deepEqual(result, { ok: true, value: undefined });
  assert.ok('value' in result, 'the value property must be present, not merely absent');
});

test('an operation resolving to a falsy value reports success', async () => {
  assert.deepEqual(await attempt(async () => 0, isDeclined), { ok: true, value: 0 });
  assert.deepEqual(await attempt(async () => null, isDeclined), { ok: true, value: null });
  assert.deepEqual(await attempt(async () => false, isDeclined), { ok: true, value: false });
});

test('an expected error is captured instead of thrown', async () => {
  const result = await attempt(async () => { throw new Declined('card declined'); }, isDeclined);
  assert.equal(result.ok, false);
  assert.ok(result.ok === false && result.error instanceof Declined);
});

test('the captured error is the original instance', async () => {
  const expected = new Declined('card declined');
  const result = await attempt(async () => { throw expected; }, isDeclined);
  assert.ok(result.ok === false && result.error === expected, 'attempt must not copy or wrap the error');
});

test('a synchronous throw inside the operation is handled like a rejection', async () => {
  const expected = new Declined('thrown synchronously');
  const captured = await attempt((): Promise<never> => { throw expected; }, isDeclined);
  assert.ok(captured.ok === false && captured.error === expected);
  const unexpected = new RangeError('thrown synchronously');
  assert.equal(await thrownBy(() => attempt((): Promise<never> => { throw unexpected; }, isDeclined)), unexpected);
});

// ---------------------------------------------------------------------------
// What must never be captured.

test('an unexpected error propagates as the original instance', async () => {
  const unexpected = new RangeError('not an application outcome');
  assert.equal(await thrownBy(() => attempt(async () => { throw unexpected; }, isDeclined)), unexpected);
});

test('a thrown value that is not an Error propagates unchanged', async () => {
  // Wrapping these in an Error would lose their identity, so they are never captured.
  for (const value of ['a string', 42, { code: 'ENOENT' }, null, undefined, Symbol('nope')]) {
    assert.equal(await thrownBy(() => attempt(async () => { throw value; }, () => true)), value,
      `attempt must rethrow ${String(value)} unchanged, even when the predicate accepts everything`);
  }
});

test('SimulationCancelledError propagates even when the predicate accepts everything', async () => {
  const cancellation = new SimulationCancelledError('Run closed: test');
  let consulted = false;
  const thrown = await thrownBy(() => attempt(async () => { throw cancellation; }, () => { consulted = true; return true; }));
  assert.equal(thrown, cancellation, 'the original cancellation instance must be rethrown');
  assert.equal(consulted, false, 'the predicate must not be consulted for cancellation');
});

test('a subclass of SimulationCancelledError is also never captured', async () => {
  class Derived extends SimulationCancelledError {}
  const cancellation = new Derived('Run closed: test');
  assert.equal(await thrownBy(() => attempt(async () => { throw cancellation; }, () => true)), cancellation);
});

test('a throwing predicate propagates its own failure', async () => {
  const predicateFailure = new TypeError('predicate is broken');
  const thrown = await thrownBy(() => attempt(async () => { throw new Declined('declined'); }, () => { throw predicateFailure; }));
  assert.equal(thrown, predicateFailure, 'the predicate failure must not be reported as an expected result');
});

test('the predicate is consulted exactly once, and only for a non-cancellation Error', async () => {
  const seen: Error[] = [];
  const expected = new Declined('declined');
  await attempt(async () => { throw expected; }, (error) => { seen.push(error); return true; });
  assert.deepEqual(seen, [expected]);
  await attempt(async () => 'fine', (error) => { seen.push(error); return true; });
  assert.deepEqual(seen, [expected], 'the predicate must not be consulted when the operation resolves');
});

// ---------------------------------------------------------------------------
// Inside the engine.

test('invariants are still evaluated after expected application errors', guard, async () => {
  const scenario = defineScenario<{ declined: number }>({
    name: 'attempt-expected-errors',
    createState: () => ({ declined: 0 }),
    actors: ['a', 'b'].map((id) => ({
      id,
      async run({ state, checkpoint }) {
        const result = await attempt(async () => { await checkpoint('charge'); throw new Declined('declined'); }, isDeclined);
        if (!result.ok) state.declined++;
      },
    })),
    invariants: [{
      name: 'nothing-declined',
      check: ({ declined }) => declined === 0,
      describeFailure: ({ declined }) => `${declined} request(s) were declined`,
    }],
  });
  const summary = await explore(scenario);
  assert.equal(summary.complete, true);
  assert.equal(summary.schedulesExplored, 2);
  // The expected errors became data, so the schedule kept a normal outcome and
  // the invariant was evaluated instead of being skipped.
  assert.ok(summary.outcomes.every((trace) => trace.outcome === 'invariant_failed'));
  assert.deepEqual(summary.outcomes.flatMap((trace) => trace.errors), []);
  assert.ok(summary.outcomes.every((trace) => trace.violations[0]?.name === 'nothing-declined'));
  assert.equal(summary.abandonedWork, false);
  assert.ok(summary.outcomes.every((trace) => trace.teardown === undefined));
});

test('an unexpected error inside attempt is still an actor_error', guard, async () => {
  const scenario = defineScenario<Record<string, never>>({
    name: 'attempt-unexpected-error',
    createState: () => ({}),
    actors: ['a', 'b'].map((id) => ({
      id,
      async run({ checkpoint }) {
        await attempt(async () => { await checkpoint('work'); throw new RangeError('boom'); }, isDeclined);
      },
    })),
    invariants: [{ name: 'ok', check: () => true }],
  });
  const summary = await explore(scenario);
  assert.equal(summary.complete, true);
  assert.ok(summary.outcomes.every((trace) => trace.outcome === 'actor_error'));
  assert.ok(summary.outcomes.every((trace) => trace.errors.some(({ message }) => message === 'boom')));
  assert.equal(summary.abandonedWork, false);
});

test('a retry loop around attempt cannot ignore cancellation at teardown', guard, async () => {
  // Application retry loops are exactly where a captured cancellation would
  // show: the actor would keep checkpointing after the run closed, which the
  // engine reports as ignored-cancellation and then unresponsive.
  const scenario = defineScenario<{ done: number }>({
    name: 'attempt-retry-loop',
    createState: () => ({ done: 0 }),
    actors: ['a', 'b'].map((id) => ({
      id,
      async run({ state, checkpoint }) {
        for (let i = 0; i < 3; i++) {
          // The predicate accepts everything, so only attempt's own rule keeps
          // cancellation from being swallowed here.
          const result = await attempt(async () => { await checkpoint(`try-${i}`); }, () => true);
          if (result.ok) { state.done++; return; }
        }
      },
    })),
    invariants: [{ name: 'ok', check: () => true }],
  });
  // The step bound closes the run while the second actor is still waiting.
  const summary = await explore(scenario, { maxSteps: 1, maxSchedules: 1, stepTimeoutMs: 2_000 });
  assert.equal(summary.outcomes.length, 1);
  const trace = summary.outcomes[0]!;
  assert.equal(trace.outcome, 'incomplete');
  assert.equal(trace.stepLimitReached, true);
  assert.equal(trace.teardown, undefined, 'cancellation must reach the actor instead of being retried');
  assert.equal(summary.abandonedWork, false);
});
