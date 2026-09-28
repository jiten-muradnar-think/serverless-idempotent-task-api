import { createHash } from 'node:crypto';

/**
 * Canonical JSON: object keys sorted recursively so that two payloads which
 * differ only in key order hash identically. Without this, a retry that
 * serialises keys in a different order would look like a conflicting payload.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);

  return `{${entries.join(',')}}`;
}

export function payloadHash(payload: unknown): string {
  return createHash('sha256').update(canonicalize(payload)).digest('hex');
}

export const tenantPk = (tenantId: string) => `TENANT#${tenantId}`;
export const idempotencySk = (key: string) => `IDEMPOTENCY#${key}`;
export const taskSk = (taskId: string) => `TASK#${taskId}`;

export type IdempotencyStatus = 'IN_PROGRESS' | 'COMPLETED';

export interface IdempotencyRecord {
  /** Index signature keeps the record assignable to the generic Item shape. */
  [attr: string]: unknown;
  pk: string;
  sk: string;
  status: IdempotencyStatus;
  payloadHash: string;
  taskId: string;
  response?: unknown;
  /**
   * Epoch seconds until which the holder is presumed alive.
   *
   * Set well beyond the Lambda timeout. Once it passes, the holder cannot
   * still be running, so another caller may take the reservation over. Without
   * this a handler killed mid-flight would lock its idempotency key until the
   * record's full TTL elapsed, rejecting every legitimate retry in between.
   */
  leaseExpiresAt: number;
  /** DynamoDB TTL attribute. Only ever set on idempotency records. */
  expiresAt: number;
}
