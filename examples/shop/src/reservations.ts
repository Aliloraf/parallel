import type { MemoryStore, Pause } from './store.ts';

export type Slot = { slotId: string; heldBy: string | null };

/** The slot was already held when this request read it. */
export class SlotTakenError extends Error {
  override name = 'SlotTakenError';
  constructor(slotId: string) {
    super(`Slot ${slotId} is already held`);
  }
}

/** Another request claimed the slot between this request's read and its write. */
export class ReservationConflictError extends Error {
  override name = 'ReservationConflictError';
  constructor(slotId: string) {
    super(`Slot ${slotId} changed while it was being reserved`);
  }
}

export const slotKey = (slotId: string) => `slot:${slotId}`;

/**
 * Reads the slot, then writes the holder in a second statement. Two requests
 * can both read a free slot and both write, so the second silently overwrites
 * the first and both are told they hold the slot.
 */
export async function holdSlotUnsafe(store: MemoryStore, slotId: string, requester: string, pause?: Pause): Promise<Slot> {
  const record = await store.read<Slot>(slotKey(slotId), pause);
  if (record === undefined) throw new Error(`Unknown slot ${slotId}`);
  if (record.value.heldBy !== null) throw new SlotTakenError(slotId);
  const held: Slot = { ...record.value, heldBy: requester };
  await store.write(slotKey(slotId), held, pause);
  return held;
}

/**
 * Writes the holder only while the slot is still at the version that was read,
 * the model of `UPDATE slots SET held_by = ? WHERE id = ? AND version = ?`
 * (optimistic concurrency control). The request that loses the race is told it
 * conflicted instead of overwriting the winner.
 */
export async function holdSlot(store: MemoryStore, slotId: string, requester: string, pause?: Pause): Promise<Slot> {
  const record = await store.read<Slot>(slotKey(slotId), pause);
  if (record === undefined) throw new Error(`Unknown slot ${slotId}`);
  if (record.value.heldBy !== null) throw new SlotTakenError(slotId);
  const held: Slot = { ...record.value, heldBy: requester };
  // `compareAndWrite` also returns false for a missing record, but the read
  // above found this one and nothing in this example deletes slots, so here a
  // refusal can only mean the version moved: another request got there first.
  if (!await store.compareAndWrite(slotKey(slotId), record.version, held, pause)) throw new ReservationConflictError(slotId);
  // The write succeeded, so this is the slot as stored. Nothing releases a
  // slot in this example; a service that did could not treat it as current.
  return held;
}
