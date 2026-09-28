/**
 * Configuration is read and validated once, at module load.
 *
 * A missing variable then kills the cold start with a clear message instead of
 * turning every request into a 500 with a cryptic stack.
 */
export interface Config {
  tableName: string;
  leaseSeconds: number;
  idempotencyTtlSeconds: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function intVar(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got: ${raw}`);
  }
  return parsed;
}

export function loadConfig(): Config {
  return {
    tableName: required('TABLE_NAME'),
    // Must comfortably exceed the Lambda timeout, so a lease can only expire
    // once the holder is genuinely dead rather than merely slow.
    leaseSeconds: intVar('LEASE_SECONDS', 60),
    idempotencyTtlSeconds: intVar('IDEMPOTENCY_TTL_SECONDS', 24 * 60 * 60),
    logLevel: (process.env.LOG_LEVEL as Config['logLevel']) ?? 'info',
  };
}
