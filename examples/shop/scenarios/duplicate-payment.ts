import { attempt, defineScenario } from '@aliloraf/parallel-sdk';
import type { Attempt, Scenario } from '@aliloraf/parallel-sdk';
import { RecordingGateway, chargeOrder, chargeOrderUnsafe } from '../src/payments.ts';
import type { PaymentResult } from '../src/payments.ts';
import { MemoryStore } from '../src/store.ts';

const ORDER = 'order-1';
const AMOUNT = 4_900;
const IDEMPOTENCY_KEY = 'payment-1';

type State = { store: MemoryStore; gateway: RecordingGateway; attempts: Attempt<PaymentResult>[] };

const charged = (attempts: readonly Attempt<PaymentResult>[]) =>
  attempts.filter((result) => result.ok && result.value.status === 'charged').length;

/** Receipts the requests reported to their callers, whether they charged or found an existing charge. */
const reported = (attempts: readonly Attempt<PaymentResult>[]) =>
  attempts.flatMap((result) => (result.ok && result.value.status !== 'duplicate-request' ? [result.value.receipt] : []));

/**
 * The same payment arrives twice, for example because the client retried after
 * a timeout. Both requests carry the same idempotency key, so the order must
 * be charged exactly once.
 *
 * Charging has no expected rejection here, so any error is unexpected and is
 * left to surface as an actor error.
 */
export function duplicatePaymentScenario(
  { safe, name = safe ? 'shop-duplicate-payment-fixed' : 'shop-duplicate-payment' }: { safe: boolean; name?: string },
): Scenario<State> {
  const charge = safe ? chargeOrder : chargeOrderUnsafe;
  return defineScenario<State>({
    name,
    createState: () => ({ store: new MemoryStore(), gateway: new RecordingGateway(), attempts: [] }),
    actors: ['request-1', 'request-2'].map((id) => ({
      id,
      async run({ state, checkpoint }) {
        const result = await attempt(
          () => charge(state.store, state.gateway, ORDER, AMOUNT, IDEMPOTENCY_KEY, checkpoint),
          () => false,
        );
        state.attempts.push(result);
      },
    })),
    invariants: [{
      name: 'charged-at-most-once',
      check: ({ gateway, attempts }) => gateway.captured.length <= 1 && charged(attempts) === gateway.captured.length,
      describeFailure: ({ gateway, attempts }) =>
        `the provider was called ${gateway.captured.length} time(s) and ${charged(attempts)} request(s) reported a charge for ${ORDER}`,
    }, {
      // A request may only report a receipt the provider actually issued. This
      // is what stops a correction from looking right by telling a caller the
      // order is paid when it is only claimed.
      name: 'reported-receipts-were-issued',
      check: ({ gateway, attempts }) =>
        reported(attempts).every((receipt) => gateway.captured.some((call) => call.receipt === receipt)),
      describeFailure: ({ gateway, attempts }) =>
        `receipt(s) ${reported(attempts).join(', ')} were reported, but the provider issued ${gateway.captured.map(({ receipt }) => receipt).join(', ') || 'none'}`,
    }],
  });
}

export default duplicatePaymentScenario({ safe: false });
