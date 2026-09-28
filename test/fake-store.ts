import { AcquireOptions, ConditionFailed, Item, Store } from '../src/lib/store';

/**
 * In-memory Store mirroring the DynamoDB conditional-write semantics exactly,
 * so the concurrency tests exercise the real decision logic without AWS.
 */
export class FakeStore implements Store {
  readonly items = new Map<string, Item>();
  /** Hook to interleave concurrent callers deterministically. */
  beforeWrite: (() => Promise<void>) | undefined;
  /** Force a transport-level failure, to test crash paths. */
  failTransactWrite = false;
  transactTokens: string[] = [];

  private key = (pk: string, sk: string) => `${pk}|${sk}`;

  async acquireReservation(item: Item, opts: AcquireOptions): Promise<void> {
    if (this.beforeWrite) await this.beforeWrite();

    const k = this.key(item.pk, item.sk);
    const existing = this.items.get(k);

    if (existing) {
      const leaseLive = Number(existing['leaseExpiresAt']) >= opts.nowEpoch;
      const sameHash = existing['payloadHash'] === opts.payloadHash;
      const inProgress = existing['status'] === 'IN_PROGRESS';
      // Mirrors: attribute_not_exists(pk) OR (status=IN_PROGRESS AND lease<now AND hash=:hash)
      if (!(inProgress && !leaseLive && sameHash)) throw new ConditionFailed();
    }

    this.items.set(k, { ...item });
  }

  async get(pk: string, sk: string): Promise<Item | undefined> {
    const found = this.items.get(this.key(pk, sk));
    return found ? { ...found } : undefined;
  }

  async transactWrite(items: Item[], requestToken: string): Promise<void> {
    this.transactTokens.push(requestToken);
    if (this.failTransactWrite) throw new Error('simulated transport failure');
    for (const item of items) this.items.set(this.key(item.pk, item.sk), { ...item });
  }

  tasks(): Item[] {
    return [...this.items.values()].filter((i) => String(i.sk).startsWith('TASK#'));
  }
}
