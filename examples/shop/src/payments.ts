import type { MemoryStore, Pause } from './store.ts';

/**
 * A claim on one idempotency key. The order and amount are fixed when the
 * claim is inserted; `receipt` is filled in once the provider has answered, so
 * `receipt: null` means the charge is still in flight or never completed.
 */
export type Charge = { orderId: string; amount: number; receipt: string | null };

export type PaymentResult =
  /** This request reached the provider and holds its receipt. */
  | { status: 'charged'; receipt: string }
  /** A completed charge for this key was found; the receipt is the one it recorded. */
  | { status: 'already-charged'; receipt: string }
  /**
   * Another request holds the claim for this key and had not finished. This
   * request did not reach the provider and cannot tell whether the other one
   * succeeded, failed or is still running.
   */
  | { status: 'duplicate-request' };

/** The same idempotency key was used for a different order or amount. */
export class IdempotencyKeyReuseError extends Error {
  override name = 'IdempotencyKeyReuseError';
  constructor(idempotencyKey: string) {
    super(`Idempotency key ${idempotencyKey} was already used for a different payment`);
  }
}

/** The part of a payment provider the order service uses. */
export type PaymentGateway = {
  authorize(orderId: string, amount: number, pause?: Pause): Promise<string>;
};

/**
 * Stands in for a payment provider. Nothing leaves the process: the gateway
 * only records the calls it received, so a scenario can assert how often the
 * provider would have been reached. Receipts are a counter rather than a
 * random id, so that runs stay reproducible and traces keep replaying.
 */
export class RecordingGateway implements PaymentGateway {
  readonly captured: { orderId: string; amount: number; receipt: string }[] = [];

  /** One call to the provider. */
  async authorize(orderId: string, amount: number, pause?: Pause): Promise<string> {
    if (pause) await pause(`authorize ${orderId}`);
    const receipt = `receipt-${this.captured.length + 1}`;
    this.captured.push({ orderId, amount, receipt });
    return receipt;
  }
}

export const chargeKey = (idempotencyKey: string) => `charge:${idempotencyKey}`;

/**
 * Charges an order after checking whether a charge is already recorded. The
 * check and the insert are two statements, so two retries of the same payment
 * can both find nothing recorded and both reach the provider: the customer is
 * charged twice.
 */
export async function chargeOrderUnsafe(
  store: MemoryStore, gateway: PaymentGateway, orderId: string, amount: number, idempotencyKey: string, pause?: Pause,
): Promise<PaymentResult> {
  const existing = await store.read<Charge>(chargeKey(idempotencyKey), pause);
  if (existing !== undefined) {
    return existing.value.receipt === null
      ? { status: 'duplicate-request' }
      : { status: 'already-charged', receipt: existing.value.receipt };
  }
  const receipt = await gateway.authorize(orderId, amount, pause);
  await store.write<Charge>(chargeKey(idempotencyKey), { orderId, amount, receipt }, pause);
  return { status: 'charged', receipt };
}

/**
 * Claims the idempotency key with a single insert that fails if the key
 * already exists, the model of `INSERT ... ON CONFLICT DO NOTHING` against a
 * unique index. Exactly one caller wins the claim, so **at most one request
 * reaches the provider** however many retries arrive concurrently.
 *
 * It is the uniqueness of the insert that provides that guarantee. Reading the
 * key first and inserting only when it is absent would not: both callers could
 * pass that check, which is the bug in `chargeOrderUnsafe`.
 *
 * What this does *not* guarantee:
 *
 * - **Not exactly-once.** If the provider rejects, the claim stays behind with
 *   `receipt: null` and no later call will retry it, because the key is taken.
 *   The payment then never happens. Releasing the claim on failure is not a
 *   fix: a provider call that fails after charging would then be retried and
 *   charge twice. Resolving that needs provider-side reconciliation, which is
 *   outside this example.
 * - **No knowledge of the other request's outcome.** A caller that loses the
 *   claim is told `duplicate-request`, not that the order is paid, unless the
 *   winner had already recorded a receipt.
 */
export async function chargeOrder(
  store: MemoryStore, gateway: PaymentGateway, orderId: string, amount: number, idempotencyKey: string, pause?: Pause,
): Promise<PaymentResult> {
  const claimed = await store.insertIfAbsent<Charge>(chargeKey(idempotencyKey), { orderId, amount, receipt: null }, pause);
  if (!claimed) {
    const existing = await store.read<Charge>(chargeKey(idempotencyKey), pause);
    if (existing === undefined) throw new Error(`Idempotency claim ${idempotencyKey} disappeared`);
    // The order and amount of a claim never change, so this comparison is not racy.
    if (existing.value.orderId !== orderId || existing.value.amount !== amount) throw new IdempotencyKeyReuseError(idempotencyKey);
    return existing.value.receipt === null
      ? { status: 'duplicate-request' }
      : { status: 'already-charged', receipt: existing.value.receipt };
  }
  const receipt = await gateway.authorize(orderId, amount, pause);
  await store.write<Charge>(chargeKey(idempotencyKey), { orderId, amount, receipt }, pause);
  return { status: 'charged', receipt };
}
