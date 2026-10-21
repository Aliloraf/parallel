import type { MemoryStore, Pause } from './store.ts';

export type StockItem = { sku: string; quantity: number };

export class OutOfStockError extends Error {
  override name = 'OutOfStockError';
  constructor(sku: string) {
    super(`No stock left for ${sku}`);
  }
}

export const stockKey = (sku: string) => `stock:${sku}`;

/**
 * Sells one unit as a read-modify-write: the quantity is read in one statement
 * and written back in another. Another request can read the same quantity in
 * between, so both pass the check and the item is oversold.
 */
export async function sellOneUnitUnsafe(store: MemoryStore, sku: string, pause?: Pause): Promise<void> {
  const record = await store.read<StockItem>(stockKey(sku), pause);
  if (record === undefined) throw new Error(`Unknown SKU ${sku}`);
  if (record.value.quantity <= 0) throw new OutOfStockError(sku);
  await store.write(stockKey(sku), { ...record.value, quantity: record.value.quantity - 1 }, pause);
}

/**
 * Sells one unit as a single conditional statement, the model of
 * `UPDATE stock SET quantity = quantity - 1 WHERE sku = ? AND quantity > 0`.
 * The check and the decrement are one step, so no other request can come
 * between them, and a request that finds nothing left is rejected.
 */
export async function sellOneUnit(store: MemoryStore, sku: string, pause?: Pause): Promise<void> {
  const sold = await store.updateIf<StockItem>(
    stockKey(sku),
    (item) => (item.quantity > 0 ? { ...item, quantity: item.quantity - 1 } : undefined),
    pause,
  );
  if (sold) return;
  // One conditional statement cannot report *why* it changed nothing, exactly
  // as `UPDATE ... WHERE` only reports how many rows it affected. Reporting
  // "out of stock" for a SKU that does not exist would be wrong, so a second
  // read tells the two apart. It cannot reintroduce the race: by now the
  // decrement has either happened or been declined.
  const record = await store.read<StockItem>(stockKey(sku), pause);
  if (record === undefined) throw new Error(`Unknown SKU ${sku}`);
  throw new OutOfStockError(sku);
}
