/**
 * Narrow port over the persistence layer.
 *
 * Only the operations this service needs, expressed so that the conditional
 * write semantics (the thing correctness depends on) are explicit and can be
 * exercised in tests without AWS.
 */

export interface Item {
  pk: string;
  sk: string;
  [attr: string]: unknown;
}

/** Thrown when a conditional write loses the race. */
export class ConditionFailed extends Error {
  constructor() {
    super('Conditional check failed');
    this.name = 'ConditionFailed';
  }
}

export interface AcquireOptions {
  /** Current time, epoch seconds. Compared against a previous holder's lease. */
  nowEpoch: number;
  /** A stale lease may only be taken over for the identical payload. */
  payloadHash: string;
}

export interface Store {
  /**
   * Claim the reservation slot at (pk, sk).
   *
   * Succeeds when nothing is there, or when a previous holder left an
   * IN_PROGRESS record whose lease has expired and whose payload matches.
   * Throws ConditionFailed in every other case.
   */
  acquireReservation(item: Item, opts: AcquireOptions): Promise<void>;

  get(pk: string, sk: string): Promise<Item | undefined>;

  /**
   * Write several items atomically.
   * @param requestToken deduplicates SDK-level retries of the same transaction.
   */
  transactWrite(items: Item[], requestToken: string): Promise<void>;
}
