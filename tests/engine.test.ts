import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineScenario } from '../packages/sdk/src/index.ts';
import { explore, replay } from '../packages/engine/src/index.ts';
import { inventoryScenario } from '../examples/inventory/src/scenarios.ts';

test('enumerates exactly six distinct two-actor, two-checkpoint schedules', async () => {
  const summary = await explore(inventoryScenario());
  assert.equal(summary.schedulesExplored, 6);
  assert.equal(summary.complete, true);
  const distinct = new Set(summary.outcomes.map(({ decisions }) => decisions.map((d) => d.actor).join(',')));
  assert.equal(distinct.size, 6);
  for (const trace of summary.outcomes) {
    assert.deepEqual(trace.decisions.filter((d) => d.actor === 'customer-a').map((d) => d.checkpoint), ['read-stock', 'commit-purchase']);
  }
});

test('buggy inventory is oversold on four of six interleavings', async () => {
  const summary = await explore(inventoryScenario());
  assert.equal(summary.failures.length, 4);
  assert.ok(summary.failures.every((trace) => trace.outcome === 'invariant_failed'));
});

test('fixed inventory passes all six schedules', async () => {
  const summary = await explore(inventoryScenario(true));
  assert.equal(summary.complete, true);
  assert.equal(summary.schedulesExplored, 6);
  assert.equal(summary.failures.length, 0);
});

test('replay consistently reproduces the same failure', async () => {
  const failure = (await explore(inventoryScenario())).failures[0]!;
  for (let i = 0; i < 10; i++) {
    const result = await replay(inventoryScenario(), failure);
    assert.equal(result.status, 'replayed');
    if (result.status === 'replayed') assert.deepEqual(result.trace, failure);
  }
});

test('replay detects diverging checkpoints', async () => {
  const scenario = inventoryScenario();
  const failure = (await explore(scenario)).failures[0]!;
  const renamed = defineScenario<ReturnType<typeof scenario.createState>>({
    ...scenario,
    actors: scenario.actors.map((actor) => ({
      ...actor,
      async run({ state, checkpoint }) {
        await checkpoint('renamed-read');
        await checkpoint('commit-purchase');
        if (state.stock > 0) state.stock--;
      },
    })),
  });
  const result = await replay(renamed, failure);
  assert.equal(result.status, 'replay_diverged');
});

test('bounds never count incomplete exploration as exhaustive success', async () => {
  const limited = await explore(inventoryScenario(), { maxSchedules: 2 });
  assert.equal(limited.schedulesExplored, 2);
  assert.equal(limited.complete, false);
  assert.equal(limited.limitReached, 'maxSchedules');
  const stepLimited = await explore(inventoryScenario(), { maxSteps: 2 });
  assert.equal(stepLimited.complete, false);
  assert.equal(stepLimited.limitReached, 'maxSteps');
  assert.ok(stepLimited.outcomes.every((trace) => trace.outcome === 'incomplete'));
});

test('invalid scenarios and bounds produce actionable errors', async () => {
  assert.throws(() => defineScenario({ name: 'bad', createState: () => ({}), actors: [{ id: 'A', run() {} }, { id: 'A', run() {} }], invariants: [{ name: 'ok', check: () => true }] }), /unique/);
  await assert.rejects(explore(inventoryScenario(), { maxSchedules: -1 }), /positive integer/);
});

test('actor errors are distinct from invariant failures', async () => {
  const scenario = defineScenario({
    name: 'actor-error', createState: () => ({ n: 0 }),
    actors: [
      { id: 'a', async run({ checkpoint }) { await checkpoint('begin'); throw Error('boom'); } },
      { id: 'b', async run({ checkpoint }) { await checkpoint('begin'); } },
    ],
    invariants: [{ name: 'ok', check: () => true }],
  });
  const summary = await explore(scenario);
  assert.ok(summary.failures.length > 0);
  assert.ok(summary.failures.every((trace) => trace.outcome === 'actor_error'));
  assert.ok(summary.failures.some((trace) => trace.errors.some((err) => err.message === 'boom')));
});

test('scenario initial state is fresh for each schedule', async () => {
  let factoryCalls = 0;
  const base = inventoryScenario();
  const scenario = defineScenario({ ...base, createState: () => { factoryCalls++; return base.createState(); } });
  const summary = await explore(scenario);
  assert.equal(factoryCalls, summary.schedulesExplored);
});
