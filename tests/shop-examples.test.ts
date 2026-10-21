// Exercises the examples/shop application example end to end: every scenario's
// exploration result, the replayability of each failure, the behavior of the
// application code without Parallel instrumentation, and the rule that
// expected rejections become data while unexpected ones stay actor errors.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { attempt } from '@aliloraf/parallel-sdk';
import type { Scenario } from '@aliloraf/parallel-sdk';
import { explore, replay } from '@aliloraf/parallel-engine';
import { OutOfStockError, sellOneUnit, sellOneUnitUnsafe, stockKey } from '../examples/shop/src/inventory.ts';
import type { StockItem } from '../examples/shop/src/inventory.ts';
import { IdempotencyKeyReuseError, RecordingGateway, chargeKey, chargeOrder, chargeOrderUnsafe } from '../examples/shop/src/payments.ts';
import type { Charge, PaymentGateway } from '../examples/shop/src/payments.ts';
import { MemoryStore } from '../examples/shop/src/store.ts';
import type { Pause } from '../examples/shop/src/store.ts';
import { ReservationConflictError, SlotTakenError, holdSlot, holdSlotUnsafe, slotKey } from '../examples/shop/src/reservations.ts';
import type { Slot } from '../examples/shop/src/reservations.ts';
import { doubleReservationScenario } from '../examples/shop/scenarios/double-reservation.ts';
import { duplicatePaymentScenario } from '../examples/shop/scenarios/duplicate-payment.ts';
import { oversellScenario } from '../examples/shop/scenarios/oversell.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(new URL('../packages/cli/dist/cli.js', import.meta.url));

/** Every scenario shipped with the example, with the result it must produce under the default bounds. */
const scenarios = [
  { file: 'oversell', scenario: oversellScenario({ safe: false }), name: 'shop-oversell', schedules: 6, failures: 4, invariant: 'stock-matches-sales' },
  { file: 'oversell-fixed', scenario: oversellScenario({ safe: true }), name: 'shop-oversell-fixed', schedules: 2, failures: 0, invariant: null },
  { file: 'duplicate-payment', scenario: duplicatePaymentScenario({ safe: false }), name: 'shop-duplicate-payment', schedules: 20, failures: 18, invariant: 'charged-at-most-once' },
  { file: 'duplicate-payment-fixed', scenario: duplicatePaymentScenario({ safe: true }), name: 'shop-duplicate-payment-fixed', schedules: 12, failures: 0, invariant: null },
  { file: 'double-reservation', scenario: doubleReservationScenario({ safe: false }), name: 'shop-double-reservation', schedules: 6, failures: 4, invariant: 'at-most-one-holder' },
  { file: 'double-reservation-fixed', scenario: doubleReservationScenario({ safe: true }), name: 'shop-double-reservation-fixed', schedules: 6, failures: 0, invariant: null },
] as const;

/** The buggy scenarios paired with the same scenario name built on the corrected code, as a developer would have after the fix. */
const corrections = [
  { file: 'oversell', buggy: oversellScenario({ safe: false }), fixed: oversellScenario({ safe: true, name: 'shop-oversell' }), afterDecisions: 0 },
  { file: 'duplicate-payment', buggy: duplicatePaymentScenario({ safe: false }), fixed: duplicatePaymentScenario({ safe: true, name: 'shop-duplicate-payment' }), afterDecisions: 0 },
  { file: 'double-reservation', buggy: doubleReservationScenario({ safe: false }), fixed: doubleReservationScenario({ safe: true, name: 'shop-double-reservation' }), afterDecisions: 2 },
] as const;

// ---------------------------------------------------------------------------
// Exploration, detection and replay.

for (const { file, scenario, name, schedules, failures, invariant } of scenarios) {
  test(`${file}: exploration is complete within the default bounds`, async () => {
    const summary = await explore(scenario as Scenario<unknown>);
    assert.equal(summary.scenario, name);
    assert.equal(summary.schedulesExplored, schedules);
    assert.equal(summary.complete, true);
    assert.equal(summary.limitReached, null);
    assert.equal(summary.haltReason, null);
    assert.equal(summary.abandonedWork, false);
    assert.equal(summary.nondeterminism, null);
  });

  test(`${file}: reports ${failures} failure(s) and no actor errors`, async () => {
    const summary = await explore(scenario as Scenario<unknown>);
    assert.equal(summary.failures.length, failures);
    // Expected application rejections must be data, never actor errors, and no
    // unexpected error may hide inside the state.
    assert.deepEqual(summary.outcomes.flatMap((trace) => trace.errors), []);
    const outcomes = new Set(summary.outcomes.map((trace) => trace.outcome));
    assert.deepEqual([...outcomes].sort(), invariant === null ? ['passed'] : ['invariant_failed', 'passed']);
    for (const trace of summary.failures) {
      assert.deepEqual(trace.violations.map(({ name: violated }) => violated), [invariant]);
      assert.ok(trace.violations[0]!.detail.length > 0);
    }
  });
}

for (const { file, scenario, invariant } of scenarios.filter((entry) => entry.invariant !== null)) {
  test(`${file}: every failing schedule replays exactly`, async () => {
    const summary = await explore(scenario as Scenario<unknown>);
    assert.ok(summary.failures.length > 0, 'expected at least one failure to replay');
    for (const failure of summary.failures) {
      const result = await replay(scenario as Scenario<unknown>, failure);
      assert.equal(result.status, 'replayed', `${file}: ${'reason' in result ? result.reason : ''}`);
      assert.equal(result.abandonedWork, false);
      assert.deepEqual(result.status === 'replayed' ? result.trace : null, failure);
      assert.equal(failure.violations[0]!.name, invariant);
    }
  });
}

for (const { file, buggy, fixed, afterDecisions } of corrections) {
  test(`${file}: the recorded failure no longer replays against the corrected code`, async () => {
    const failure = (await explore(buggy as Scenario<unknown>)).failures[0]!;
    const result = await replay(fixed as Scenario<unknown>, failure);
    assert.equal(result.status, 'replay_diverged');
    assert.equal(result.abandonedWork, false);
    // The correction replaces the two statements the trace recorded with one
    // atomic statement, so the recorded decision is no longer available.
    assert.equal(result.divergence.kind, 'decision_not_eligible');
    assert.equal(result.divergence.kind === 'decision_not_eligible' && result.divergence.afterDecisions, afterDecisions);
  });

  test(`${file}: the corrected code finds no failure under the buggy scenario's name`, async () => {
    const summary = await explore(fixed as Scenario<unknown>);
    assert.equal(summary.complete, true);
    assert.equal(summary.failures.length, 0);
  });
}

// ---------------------------------------------------------------------------
// The application code on its own, with no Parallel instrumentation.

test('application code has no runtime dependency on Parallel', () => {
  for (const module of ['store.ts', 'inventory.ts', 'payments.ts', 'reservations.ts']) {
    const source = readFileSync(new URL(`../examples/shop/src/${module}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from '@aliloraf\/parallel/, `${module} must not import a Parallel package`);
  }
});

test('an uninstrumented store call never pauses, and an instrumented one pauses exactly once', async () => {
  const store = new MemoryStore({ 'k': { n: 1 } });
  const labels: string[] = [];
  const pause = async (label: string) => { labels.push(label); };
  await store.read('k');
  await store.write('k', { n: 2 });
  await store.insertIfAbsent('other', { n: 0 });
  await store.compareAndWrite('k', 2, { n: 3 });
  await store.updateIf<{ n: number }>('k', (value) => ({ n: value.n + 1 }));
  assert.deepEqual(labels, []);
  await store.read('k', pause);
  await store.write('k', { n: 9 }, pause);
  await store.insertIfAbsent('third', { n: 0 }, pause);
  await store.compareAndWrite('k', 99, { n: 0 }, pause);
  await store.updateIf<{ n: number }>('k', () => undefined, pause);
  assert.deepEqual(labels, ['read k', 'write k', 'insert third', 'compare-and-write k', 'update k']);
});

test('the store keeps callers from changing stored data in place', async () => {
  const store = new MemoryStore({ 'k': { n: 1 } });
  const first = await store.read<{ n: number }>('k');
  first!.value.n = 42;
  assert.equal((await store.read<{ n: number }>('k'))!.value.n, 1);
  assert.equal(store.peek<{ n: number }>('k')!.n, 1);
  assert.equal(store.peek('missing'), undefined);
});

test('selling stock works uninstrumented, in both implementations', async () => {
  for (const sell of [sellOneUnitUnsafe, sellOneUnit]) {
    const store = new MemoryStore({ [stockKey('sku-1')]: { sku: 'sku-1', quantity: 2 } satisfies StockItem });
    await sell(store, 'sku-1');
    await sell(store, 'sku-1');
    assert.equal(store.peek<StockItem>(stockKey('sku-1'))!.quantity, 0);
    await assert.rejects(() => sell(store, 'sku-1'), OutOfStockError);
    // An unknown SKU is not the same thing as an empty one, in either implementation.
    await assert.rejects(() => sell(store, 'missing'), { message: 'Unknown SKU missing' });
  }
});

test('charging an order works uninstrumented, and a retry reports the recorded receipt', async () => {
  for (const charge of [chargeOrderUnsafe, chargeOrder]) {
    const store = new MemoryStore();
    const gateway = new RecordingGateway();
    assert.deepEqual(await charge(store, gateway, 'order-1', 100, 'key-1'), { status: 'charged', receipt: 'receipt-1' });
    assert.deepEqual(await charge(store, gateway, 'order-1', 100, 'key-1'), { status: 'already-charged', receipt: 'receipt-1' });
    assert.equal(gateway.captured.length, 1);
    assert.equal(store.peek<Charge>(chargeKey('key-1'))!.receipt, 'receipt-1');
  }
});

// ---------------------------------------------------------------------------
// What the corrected payment does and does not guarantee.

/** A provider that rejects instead of charging, for the failure paths. */
const failingGateway = (): PaymentGateway & { calls: number } => {
  const gateway = {
    calls: 0,
    async authorize(_orderId: string, _amount: number, pause?: Pause) {
      if (pause) await pause('authorize failing');
      gateway.calls++;
      throw new Error('provider declined');
    },
  };
  return gateway;
};

test('a request that loses the claim is told duplicate-request, not that the order is paid', async () => {
  const store = new MemoryStore();
  const gateway = new RecordingGateway();
  // The winner has claimed the key and is still waiting on the provider.
  await store.insertIfAbsent<Charge>(chargeKey('key-1'), { orderId: 'order-1', amount: 100, receipt: null });
  assert.deepEqual(await chargeOrder(store, gateway, 'order-1', 100, 'key-1'), { status: 'duplicate-request' });
  // The loser must not have reached the provider, and must not claim a receipt.
  assert.equal(gateway.captured.length, 0);
});

test('all three payment statuses are reachable in the corrected scenario', async () => {
  const base = duplicatePaymentScenario({ safe: true });
  const states: ReturnType<typeof base.createState>[] = [];
  const observed = { ...base, createState: () => { const state = base.createState(); states.push(state); return state; } };
  const summary = await explore(observed);
  assert.equal(summary.complete, true);
  assert.equal(summary.failures.length, 0);
  const statuses = new Set(states.flatMap((state) => state.attempts.flatMap((a) => (a.ok ? [a.value.status] : []))));
  // A loser that arrives while the winner is still charging sees duplicate-request;
  // one that arrives after it finished sees the recorded receipt.
  assert.deepEqual([...statuses].sort(), ['already-charged', 'charged', 'duplicate-request']);
});

test('a provider rejection leaves the claim incomplete and the payment never happens', async () => {
  const store = new MemoryStore();
  const gateway = failingGateway();
  await assert.rejects(() => chargeOrder(store, gateway, 'order-1', 100, 'key-1'), { message: 'provider declined' });
  assert.equal(gateway.calls, 1);
  // The claim stays behind with no receipt, so no later call retries it: this
  // correction prevents concurrent duplicate charges, it is not exactly-once.
  assert.deepEqual(store.peek<Charge>(chargeKey('key-1')), { orderId: 'order-1', amount: 100, receipt: null });
  assert.deepEqual(await chargeOrder(store, gateway, 'order-1', 100, 'key-1'), { status: 'duplicate-request' });
  assert.equal(gateway.calls, 1, 'the key is spent; the provider is never reached again');
});

test('reusing an idempotency key for a different payment is rejected, not silently dropped', async () => {
  const store = new MemoryStore();
  const gateway = new RecordingGateway();
  await chargeOrder(store, gateway, 'order-1', 100, 'key-1');
  await assert.rejects(() => chargeOrder(store, gateway, 'order-2', 100, 'key-1'), IdempotencyKeyReuseError);
  await assert.rejects(() => chargeOrder(store, gateway, 'order-1', 250, 'key-1'), IdempotencyKeyReuseError);
  assert.equal(gateway.captured.length, 1);
});

test('the corrected payment reaches the provider at most once under every ordering', async () => {
  const base = duplicatePaymentScenario({ safe: true });
  const gateways: RecordingGateway[] = [];
  const observed = { ...base, createState: () => { const state = base.createState(); gateways.push(state.gateway); return state; } };
  await explore(observed);
  assert.equal(gateways.length, 12);
  assert.ok(gateways.every(({ captured }) => captured.length === 1), 'every schedule must charge exactly once');
});

test('the corrected payment scenario checks reported receipts as well as the charge count', () => {
  assert.deepEqual(
    duplicatePaymentScenario({ safe: true }).invariants.map(({ name }) => name),
    ['charged-at-most-once', 'reported-receipts-were-issued'],
  );
});

test('holding a slot works uninstrumented, and a second request is rejected', async () => {
  for (const hold of [holdSlotUnsafe, holdSlot]) {
    const store = new MemoryStore({ [slotKey('room-1')]: { slotId: 'room-1', heldBy: null } satisfies Slot });
    assert.deepEqual(await hold(store, 'room-1', 'booking-a'), { slotId: 'room-1', heldBy: 'booking-a' });
    await assert.rejects(() => hold(store, 'room-1', 'booking-b'), SlotTakenError);
    assert.equal(store.peek<Slot>(slotKey('room-1'))!.heldBy, 'booking-a');
    await assert.rejects(() => hold(store, 'nowhere', 'booking-b'), /Unknown slot nowhere/);
  }
});

test('the corrected reservation rejects the request that loses the race', async () => {
  const store = new MemoryStore({ [slotKey('room-1')]: { slotId: 'room-1', heldBy: null } satisfies Slot });
  // Both requests read version 1; the second write is refused instead of overwriting the first.
  const seen = await store.read<Slot>(slotKey('room-1'));
  await holdSlot(store, 'room-1', 'booking-a');
  assert.equal(await store.compareAndWrite(slotKey('room-1'), seen!.version, { slotId: 'room-1', heldBy: 'booking-b' }), false);
  assert.equal(store.peek<Slot>(slotKey('room-1'))!.heldBy, 'booking-a');
});

// ---------------------------------------------------------------------------
// Expected versus unexpected rejections.

test('the shop scenarios classify their own expected errors through the SDK helper', async () => {
  const outOfStock = await attempt(async () => { throw new OutOfStockError('sku-1'); }, (error) => error instanceof OutOfStockError);
  assert.ok(outOfStock.ok === false && outOfStock.error instanceof OutOfStockError);
  const slotExpected = (error: Error) => error instanceof SlotTakenError || error instanceof ReservationConflictError;
  const conflict = await attempt(async () => { throw new ReservationConflictError('room-1'); }, slotExpected);
  assert.ok(conflict.ok === false && conflict.error instanceof ReservationConflictError);
  // An error a scenario does not expect still escapes to the engine.
  await assert.rejects(
    () => attempt(async () => { throw new ReservationConflictError('room-1'); }, (error) => error instanceof OutOfStockError),
    ReservationConflictError,
  );
});

test('an unexpected rejection inside a scenario surfaces as an actor error', async () => {
  // The same shape as the shipped scenarios, but the operation rejects with
  // something the scenario does not expect.
  const scenario = doubleReservationScenario({ safe: false, name: 'shop-double-reservation-unexpected' });
  const broken = {
    ...scenario,
    actors: scenario.actors.map((actor) => ({ id: actor.id, run: async ({ checkpoint }: { checkpoint: (name: string) => Promise<void> }) => {
      await checkpoint('boom');
      throw new TypeError('unexpected application failure');
    } })),
  };
  const summary = await explore(broken as typeof scenario);
  assert.ok(summary.failures.every((trace) => trace.outcome === 'actor_error'));
  assert.ok(summary.outcomes.flatMap((trace) => trace.errors).some(({ message }) => message === 'unexpected application failure'));
});

// ---------------------------------------------------------------------------
// The example through the CLI, the way the README documents it.

test('the CLI finds the oversell and passes the corrected scenario', () => {
  const run = (file: string) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, 'test', `examples/shop/scenarios/${file}.ts`, '--json'],
    { cwd: root, encoding: 'utf8', timeout: 60_000 });

  const buggy = run('oversell');
  assert.equal(buggy.status, 1, buggy.stderr);
  const failed = JSON.parse(buggy.stdout);
  assert.equal(failed.scenario, 'shop-oversell');
  assert.equal(failed.result, 'failed');
  assert.equal(failed.schedulesExplored, 6);
  assert.equal(failed.failureCount, 4);
  assert.equal(failed.complete, true);
  assert.equal(failed.firstFailure.violations[0].name, 'stock-matches-sales');

  const fixed = run('oversell-fixed');
  assert.equal(fixed.status, 0, fixed.stderr);
  const passed = JSON.parse(fixed.stdout);
  assert.equal(passed.result, 'passed');
  assert.equal(passed.scenario, 'shop-oversell-fixed');
  assert.equal(passed.failureCount, 0);
  assert.equal(passed.complete, true);
});
