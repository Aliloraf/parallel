/**
 * A deterministic in-memory record store, standing in for the database an
 * application would use. Application code depends on this module, never on
 * Parallel.
 *
 * ## Atomicity contract
 *
 * Every method models exactly one statement sent to a database:
 *
 * 1. The optional `pause` callback marks the moment the statement is in
 *    flight. An instrumented caller yields there, so other requests may run.
 * 2. Once the call resumes, the rest of the method runs to completion without
 *    pausing again. One call therefore applies atomically with respect to the
 *    other requests.
 *
 * Two calls are never atomic together. Reading a record and writing it back is
 * a read-modify-write that another request can interleave; `updateIf`,
 * `insertIfAbsent` and `compareAndWrite` are the single-statement operations
 * that close that window.
 *
 * Reads return copies and writes store copies, so no caller can change stored
 * data in place.
 *
 * This models application-level interleaving only. It is not a database: there
 * are no transactions, isolation levels, locks, retries or network timing.
 */

/** An optional instrumentation hook. Structurally the SDK's `checkpoint`, declared here so this layer stays Parallel-free. */
export type Pause = (label: string) => Promise<void>;

/** A stored record and the version it is at. The version increases on every write. */
export type Versioned<T> = { readonly value: T; readonly version: number };

const copy = <T>(value: T): T => structuredClone(value);

export class MemoryStore {
  private readonly records = new Map<string, { value: unknown; version: number }>();

  constructor(initial: Readonly<Record<string, unknown>> = {}) {
    for (const [key, value] of Object.entries(initial)) this.records.set(key, { value: copy(value), version: 1 });
  }

  /** One read. `undefined` if the key does not exist. */
  async read<T>(key: string, pause?: Pause): Promise<Versioned<T> | undefined> {
    if (pause) await pause(`read ${key}`);
    const record = this.records.get(key);
    return record === undefined ? undefined : { value: copy(record.value) as T, version: record.version };
  }

  /** One unconditional write, overwriting whatever is there. */
  async write<T>(key: string, value: T, pause?: Pause): Promise<void> {
    if (pause) await pause(`write ${key}`);
    this.put(key, value);
  }

  /** One insert that succeeds only while `key` is absent; `false` if it already exists. Models a unique constraint. */
  async insertIfAbsent<T>(key: string, value: T, pause?: Pause): Promise<boolean> {
    if (pause) await pause(`insert ${key}`);
    if (this.records.has(key)) return false;
    this.put(key, value);
    return true;
  }

  /** One write that succeeds only while `key` is still at `expectedVersion`. Models `UPDATE ... WHERE version = ?`. */
  async compareAndWrite<T>(key: string, expectedVersion: number, value: T, pause?: Pause): Promise<boolean> {
    if (pause) await pause(`compare-and-write ${key}`);
    const record = this.records.get(key);
    if (record === undefined || record.version !== expectedVersion) return false;
    this.put(key, value);
    return true;
  }

  /**
   * One conditional in-place update: `change` receives the stored value and
   * returns its replacement, or `undefined` to leave the record alone. The
   * read and the write are one step, so nothing can come between them. Models
   * `UPDATE ... SET x = ... WHERE <condition>`.
   */
  async updateIf<T>(key: string, change: (value: T) => T | undefined, pause?: Pause): Promise<boolean> {
    if (pause) await pause(`update ${key}`);
    const record = this.records.get(key);
    if (record === undefined) return false;
    const next = change(copy(record.value) as T);
    if (next === undefined) return false;
    this.put(key, next);
    return true;
  }

  /** A synchronous copy of one record, for invariants and assertions. Application code uses `read`. */
  peek<T>(key: string): T | undefined {
    const record = this.records.get(key);
    return record === undefined ? undefined : copy(record.value) as T;
  }

  private put(key: string, value: unknown): void {
    this.records.set(key, { value: copy(value), version: (this.records.get(key)?.version ?? 0) + 1 });
  }
}
