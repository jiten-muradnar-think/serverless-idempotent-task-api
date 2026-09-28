import { z } from 'zod';

/**
 * Explicit limits on every field.
 *
 * Without them an oversized title passes application validation and then fails
 * at the DynamoDB 400KB item limit, which surfaces to the caller as a 500 for
 * what is really a client error.
 */
export const LIMITS = {
  idempotencyKeyMax: 128,
  titleMax: 500,
  assigneeIdMax: 128,
  bodyBytesMax: 32 * 1024,
} as const;

/** RFC-ish: printable ASCII without whitespace, so keys stay log and URL safe. */
export const idempotencyKeySchema = z
  .string()
  .min(1, 'Idempotency-Key must not be empty')
  .max(
    LIMITS.idempotencyKeyMax,
    `Idempotency-Key must be at most ${LIMITS.idempotencyKeyMax} characters`,
  )
  .regex(/^[A-Za-z0-9._:-]+$/, 'Idempotency-Key may contain only A-Z a-z 0-9 . _ : -');

export const createTaskSchema = z
  .object({
    title: z.string().trim().min(1, 'title is required').max(LIMITS.titleMax),
    dueAt: z.string().datetime({ offset: true }).optional(),
    assigneeId: z.string().trim().min(1).max(LIMITS.assigneeIdMax).optional(),
  })
  // Reject unknown fields rather than silently dropping them. A client sending
  // tenantId or createdBy should be told it is ignored, not left believing it
  // took effect.
  .strict();

export type CreateTaskBody = z.infer<typeof createTaskSchema>;

export function formatIssues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}
