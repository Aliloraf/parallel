import { attempt, defineScenario } from '@aliloraf/parallel-sdk';
import type { Attempt, Scenario } from '@aliloraf/parallel-sdk';
import { MemoryStore } from '../src/store.ts';
import { ReservationConflictError, SlotTakenError, holdSlot, holdSlotUnsafe, slotKey } from '../src/reservations.ts';
import type { Slot } from '../src/reservations.ts';

const SLOT = 'room-1';

type State = { store: MemoryStore; attempts: Attempt<Slot>[] };

const expected = (error: Error) => error instanceof SlotTakenError || error instanceof ReservationConflictError;
const holders = (attempts: readonly Attempt<Slot>[]) =>
  attempts.flatMap((result) => (result.ok ? [result.value.heldBy] : []));

/** Two requests reserve the same exclusive slot at the same time. */
export function doubleReservationScenario(
  { safe, name = safe ? 'shop-double-reservation-fixed' : 'shop-double-reservation' }: { safe: boolean; name?: string },
): Scenario<State> {
  const hold = safe ? holdSlot : holdSlotUnsafe;
  return defineScenario<State>({
    name,
    createState: () => ({
      store: new MemoryStore({ [slotKey(SLOT)]: { slotId: SLOT, heldBy: null } satisfies Slot }),
      attempts: [],
    }),
    actors: ['booking-a', 'booking-b'].map((id) => ({
      id,
      async run({ state, checkpoint }) {
        const result = await attempt(() => hold(state.store, SLOT, id, checkpoint), expected);
        state.attempts.push(result);
      },
    })),
    invariants: [{
      // Every request told that it holds the slot must really hold it, so at
      // most one request can have been told so.
      name: 'at-most-one-holder',
      check: ({ store, attempts }) => {
        const stored = store.peek<Slot>(slotKey(SLOT))?.heldBy ?? null;
        const granted = holders(attempts);
        return granted.length <= 1 && granted.every((holder) => holder === stored);
      },
      describeFailure: ({ store, attempts }) =>
        `slot ${SLOT} is held by ${store.peek<Slot>(slotKey(SLOT))?.heldBy ?? 'nobody'}, but it was granted to ${holders(attempts).join(' and ') || 'nobody'}`,
    }],
  });
}

export default doubleReservationScenario({ safe: false });
