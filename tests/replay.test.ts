import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { defineScenario } from '@aliloraf/parallel-sdk';
import type { Scenario } from '@aliloraf/parallel-sdk';
import { InvalidTraceError, explore, replay, validateTrace } from '@aliloraf/parallel-engine';
import type { Trace } from '@aliloraf/parallel-engine';
import { inventoryScenario } from '../packages/cli/dist/demos/inventory.js';
import counter from '../examples/counter/src/scenario.ts';
import { boundedErrorFixture, cleanupErrorFixture, stallFixture } from './fixtures/scenarios.ts';

const guard = { timeout: 15_000 };
const fixture = (name: string): Trace => JSON.parse(readFileSync(new URL(`./fixtures/traces/${name}`, import.meta.url), 'utf8'));
const clone = <T>(value: T): T => structuredClone(value);

function erroring(message: string) {
  return defineScenario<Record<string, never>>({
    name: 'replay-errors',
    createState: () => ({}),
    actors: [
      { id: 'a', async run({ checkpoint }) { await checkpoint('a1'); throw new Error(message); } },
      { id: 'b', async run({ checkpoint }) { await checkpoint('b1'); } },
    ],
    invariants: [{ name: 'ok', check: () => true }],
  });
}

// ---------------------------------------------------------------------------
// R1: step-bounded traces.

test('R1: a step-bounded incomplete trace replays and records the bound', guard, async () => {
  const scenario = inventoryScenario();
  const [trace] = (await explore(scenario, { maxSteps: 2, maxSchedules: 1 })).outcomes;
  assert.equal(trace?.outcome, 'incomplete');
  assert.equal(trace?.stepLimitReached, true);
  const result = await replay(scenario, trace!);
  assert.equal(result.status, 'replayed');
  if (result.status === 'replayed') assert.deepEqual(result.trace, trace);
});

test('R1: a step-bounded actor_error trace replays', guard, async () => {
  const failure = (await explore(boundedErrorFixture, { maxSteps: 3 })).failures[0]!;
  assert.equal(failure.outcome, 'actor_error');
  assert.equal(failure.stepLimitReached, true);
  const result = await replay(boundedErrorFixture, failure);
  assert.equal(result.status, 'replayed');
});

test('R1: a bounded trace replayed against a scenario that now finishes is ended_early', guard, async () => {
  const trace = (await explore(inventoryScenario(), { maxSteps: 3, maxSchedules: 1 })).outcomes[0]!;
  const shorter = defineScenario({ ...inventoryScenario(), actors: inventoryScenario().actors.map((actor) => ({
    ...actor,
    async run({ checkpoint }) { await checkpoint('read-stock'); if (actor.id === 'customer-a') await checkpoint('commit-purchase'); },
  })) });
  const result = await replay(shorter, trace);
  assert.equal(result.status, 'replay_diverged');
  if (result.status === 'replay_diverged') assert.deepEqual(result.divergence, { kind: 'ended_early', afterDecisions: 3 });
});

// ---------------------------------------------------------------------------
// R2: actor errors are compared.

test('R2: replay detects a different actor error', guard, async () => {
  const failure = (await explore(erroring('original'))).failures[0]!;
  const result = await replay(erroring('different'), failure);
  assert.equal(result.status, 'replay_diverged');
  if (result.status === 'replay_diverged') {
    assert.deepEqual(result.divergence, { kind: 'result_mismatch', fields: ['errors'] });
    assert.deepEqual(result.observed?.errors, [{ actor: 'a', message: 'different' }]);
  }
  assert.equal((await replay(erroring('original'), failure)).status, 'replayed');
});

// ---------------------------------------------------------------------------
// R4: machine-readable divergence.

test('R4: an ineligible recorded decision is decision_not_eligible', guard, async () => {
  const failure = (await explore(inventoryScenario())).failures[0]!;
  const renamed = defineScenario({ ...inventoryScenario(), actors: inventoryScenario().actors.map((actor) => ({
    ...actor,
    async run({ checkpoint }) { await checkpoint('renamed-read'); await checkpoint('commit-purchase'); },
  })) });
  const result = await replay(renamed, failure);
  assert.equal(result.status, 'replay_diverged');
  if (result.status === 'replay_diverged') {
    assert.deepEqual(result.divergence, {
      kind: 'decision_not_eligible',
      afterDecisions: 0,
      expected: failure.decisions[0],
      eligible: [{ actor: 'customer-a', checkpoint: 'renamed-read' }, { actor: 'customer-b', checkpoint: 'renamed-read' }],
    });
    assert.match(result.reason, /not eligible/);
  }
});

test('R4: a recorded decision after the scenario finished is ended_early', guard, async () => {
  const failure = clone((await explore(inventoryScenario())).failures[0]!);
  failure.decisions.push({ actor: 'customer-a', checkpoint: 'extra' });
  const result = await replay(inventoryScenario(), failure);
  assert.equal(result.status, 'replay_diverged');
  if (result.status === 'replay_diverged') assert.deepEqual(result.divergence, { kind: 'ended_early', afterDecisions: 4 });
});

test('R4: a scenario that continues past a naturally finished trace is continued', guard, async () => {
  const passed = clone((await explore(inventoryScenario(true))).outcomes[0]!);
  const last = passed.decisions.pop()!;
  const result = await replay(inventoryScenario(true), passed);
  assert.equal(result.status, 'replay_diverged');
  if (result.status === 'replay_diverged') {
    assert.deepEqual(result.divergence, { kind: 'continued', afterDecisions: 3, eligible: [last] });
    assert.equal(result.observed?.stepLimitReached, true);
  }
});

test('R4: a different result is result_mismatch naming the differing fields', guard, async () => {
  const failure = (await explore(counter)).failures[0]!;
  const lenient = defineScenario({ ...counter, invariants: [{ name: 'anything', check: () => true }] });
  const result = await replay(lenient, failure);
  assert.equal(result.status, 'replay_diverged');
  if (result.status === 'replay_diverged') {
    assert.deepEqual(result.divergence, { kind: 'result_mismatch', fields: ['outcome', 'violations'] });
    assert.equal(result.observed?.outcome, 'passed');
  }
});

test('R4: unsupported schema versions and scenario mismatches keep their diverged results', guard, async () => {
  const failure = (await explore(inventoryScenario())).failures[0]!;
  const future = await replay(inventoryScenario(), { ...clone(failure), schemaVersion: 2 } as unknown as Trace);
  assert.deepEqual(future, {
    status: 'replay_diverged', reason: 'Unsupported trace schema version 2', divergence: { kind: 'unsupported_schema', schemaVersion: 2 }, abandonedWork: false,
  });
  const other = await replay(counter, failure);
  assert.equal(other.status, 'replay_diverged');
  if (other.status === 'replay_diverged') {
    assert.deepEqual(other.divergence, { kind: 'scenario_mismatch', expected: 'inventory-buggy', observed: 'counter-lost-update' });
  }
});

// ---------------------------------------------------------------------------
// R3: structural trace validation.

test('R3: malformed traces are rejected with InvalidTraceError naming the field', guard, async () => {
  const valid = (await explore(inventoryScenario())).failures[0]!;
  const cases: [string, unknown, RegExp][] = [
    ['null', null, /trace must be an object/],
    ['array', [], /trace must be an object/],
    ['string', 'trace', /trace must be an object/],
    ['missing schemaVersion', { ...clone(valid), schemaVersion: undefined }, /schemaVersion must be a positive integer/],
    ['string schemaVersion', { ...clone(valid), schemaVersion: '1' }, /schemaVersion must be a positive integer/],
    ['missing scenario', { ...clone(valid), scenario: undefined }, /scenario must be a non-empty string/],
    ['empty scenario', { ...clone(valid), scenario: '' }, /scenario must be a non-empty string/],
    ['decisions not array', { ...clone(valid), decisions: {} }, /decisions must be an array/],
    ['decision missing checkpoint', { ...clone(valid), decisions: [{ actor: 'customer-a' }] }, /decisions\[0\]\.checkpoint must be a non-empty string/],
    ['decision empty actor', { ...clone(valid), decisions: [...valid.decisions, { actor: '', checkpoint: 'x' }] }, /decisions\[4\]\.actor must be a non-empty string/],
    ['unknown outcome', { ...clone(valid), outcome: 'exploded' }, /outcome must be one of/],
    ['violations wrong shape', { ...clone(valid), violations: [{ name: 'x' }] }, /violations\[0\]\.detail must be a string/],
    ['errors missing', { ...clone(valid), errors: undefined }, /errors must be an array/],
    ['error wrong shape', { ...clone(valid), errors: [{ actor: 'a', message: 1 }] }, /errors\[0\]\.message must be a string/],
    ['stall on a non-stalled trace', { ...clone(valid), stall: { timeoutMs: 50, afterDecisions: 4, actors: [] } }, /stall is only allowed when outcome is "stalled"/],
    ['stalled without stall', { ...clone(valid), outcome: 'stalled' }, /stall is required when outcome is "stalled"/],
    ['stall bad timeout', { ...clone(fixture('stall.json')), stall: { ...fixture('stall.json').stall!, timeoutMs: 0 } }, /stall\.timeoutMs must be an integer/],
    ['stall bad actor', { ...clone(fixture('stall.json')), stall: { ...fixture('stall.json').stall!, actors: [{ actor: 'a', lastCheckpoint: 3, settledAfterAbort: false }] } }, /stall\.actors\[0\]\.lastCheckpoint must be a string or null/],
    ['teardown bad status', { ...clone(valid), teardown: [{ actor: 'a', status: 'vanished', detail: '' }] }, /teardown\[0\]\.status must be one of/],
    ['stepLimitReached false', { ...clone(valid), stepLimitReached: false }, /stepLimitReached must be true when present/],
    ['stepLimitReached on invariant failure', { ...clone(valid), stepLimitReached: true }, /stepLimitReached is only allowed when outcome is "incomplete" or "actor_error"/],
  ];
  for (const [label, input, pattern] of cases) {
    assert.throws(() => validateTrace(input), (error: unknown) => {
      assert.ok(error instanceof InvalidTraceError, label);
      assert.match(error.message, /^Invalid trace: /, label);
      assert.match(error.message, pattern, label);
      return true;
    }, label);
    await assert.rejects(replay(inventoryScenario(), input as Trace), InvalidTraceError, label);
  }
});

test('R3: validation accepts every engine-produced trace shape', guard, async () => {
  const summaries = [
    await explore(inventoryScenario()),
    await explore(inventoryScenario(), { maxSteps: 2 }),
    await explore(boundedErrorFixture, { maxSteps: 3 }),
    await explore(stallFixture, { stepTimeoutMs: 30 }),
    await explore(cleanupErrorFixture, { maxSteps: 1, maxSchedules: 1 }),
  ];
  for (const trace of summaries.flatMap((summary) => summary.outcomes)) {
    assert.equal(validateTrace(JSON.parse(JSON.stringify(trace))).scenario, trace.scenario);
  }
});

// ---------------------------------------------------------------------------
// Compatibility with traces recorded before this milestone.

test('fixed pre-milestone traces validate and replay', guard, async () => {
  const cases: [string, Scenario<any>][] = [
    ['inventory-invariant-failed.json', inventoryScenario()],
    ['counter-invariant-failed.json', counter],
    ['inventory-incomplete.json', inventoryScenario()],
    ['stall.json', stallFixture],
    ['cleanup-error-incomplete.json', cleanupErrorFixture],
  ];
  for (const [file, scenario] of cases) {
    const trace = fixture(file);
    assert.ok(!('stepLimitReached' in trace), `${file} predates stepLimitReached`);
    validateTrace(trace);
    const result = await replay(scenario, trace);
    assert.equal(result.status, 'replayed', file);
    if (result.status === 'replayed') {
      assert.equal(result.trace.outcome, trace.outcome, file);
      assert.deepEqual(result.trace.decisions, trace.decisions, file);
    }
  }
});

test('an old incomplete trace that hid an actor error diverges explicitly instead of being reinterpreted', guard, async () => {
  // The old engine labelled this bounded run "incomplete" although actor a threw.
  // The trace is not rewritten: replay reports the outcome difference.
  const trace = fixture('bounded-error-incomplete.json');
  assert.equal(trace.outcome, 'incomplete');
  assert.deepEqual(trace.errors, [{ actor: 'a', message: 'boom' }]);
  const result = await replay(boundedErrorFixture, trace);
  assert.equal(result.status, 'replay_diverged');
  if (result.status === 'replay_diverged') {
    assert.deepEqual(result.divergence, { kind: 'result_mismatch', fields: ['outcome'] });
    assert.equal(result.observed?.outcome, 'actor_error');
  }
});
