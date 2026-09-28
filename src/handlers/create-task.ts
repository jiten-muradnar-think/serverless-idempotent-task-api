import { principalFrom, requireScope } from '../lib/auth';
import { loadConfig } from '../lib/config';
import { createTask } from '../lib/create-task-service';
import { dynamoStore } from '../lib/dynamo-store';
import { HttpError } from '../lib/errors';
import { Logger, createLogger } from '../lib/logger';
import { LIMITS } from '../lib/schema';
import { Store } from '../lib/store';

interface ApiGatewayEvent {
  headers?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: {
    requestId?: string;
    authorizer?: { jwt?: { claims?: Record<string, string> } };
  };
}

interface ApiGatewayResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

// Loaded at module scope so a misconfigured function fails its cold start with
// a clear message instead of returning 500 on every request.
const config = loadConfig();
const baseLogger = createLogger(config.logLevel, { route: 'POST /v1/tasks' });
const defaultStore: Store = dynamoStore(config.tableName);

/** Header lookup that tolerates the casing API Gateway happens to deliver. */
const header = (event: ApiGatewayEvent, name: string): string | undefined => {
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(event.headers ?? {})) {
    if (k.toLowerCase() === target) return v;
  }
  return undefined;
};

export async function handler(
  event: ApiGatewayEvent,
  _ctx?: unknown,
  deps: { store?: Store; logger?: Logger } = {},
): Promise<ApiGatewayResult> {
  const requestId = event.requestContext?.requestId ?? 'local';
  let log = (deps.logger ?? baseLogger).child({ requestId });

  try {
    const principal = principalFrom(event.requestContext?.authorizer?.jwt?.claims);
    requireScope(principal, 'tasks:write');
    log = log.child({ tenantId: principal.tenantId, subject: principal.subject });

    const raw = event.isBase64Encoded
      ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
      : (event.body ?? '');

    // Reject oversized bodies before parsing, so a large payload costs a length
    // check rather than a full JSON parse.
    if (Buffer.byteLength(raw, 'utf8') > LIMITS.bodyBytesMax) {
      throw new HttpError(
        413,
        'payload_too_large',
        `Request body exceeds ${LIMITS.bodyBytesMax} bytes`,
      );
    }

    let payload: unknown;
    try {
      payload = raw.trim() === '' ? {} : JSON.parse(raw);
    } catch {
      throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON');
    }

    const result = await createTask(principal, header(event, 'idempotency-key') ?? '', payload, {
      store: deps.store ?? defaultStore,
      logger: log,
      leaseSeconds: config.leaseSeconds,
      idempotencyTtlSeconds: config.idempotencyTtlSeconds,
    });

    return json(result.status, result.body, {
      ...(result.status === 201 ? { location: `/v1/tasks/${result.body.id}` } : {}),
      'idempotency-replayed': String(result.status === 200),
    });
  } catch (err) {
    if (err instanceof HttpError) {
      log.warn('request_rejected', { status: err.status, code: err.code });
      const retryAfter = err.detail?.['retryAfterSeconds'];
      return json(
        err.status,
        { code: err.code, message: err.message, requestId },
        typeof retryAfter === 'number' ? { 'retry-after': String(retryAfter) } : {},
      );
    }
    // Details go to the log, never to the caller. The logger strips everything
    // but the error name, message and stack.
    log.error('unhandled_error', err);
    return json(500, { code: 'internal_error', message: 'Internal server error', requestId });
  }
}

const json = (
  statusCode: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): ApiGatewayResult => ({
  statusCode,
  headers: {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  },
  body: JSON.stringify(body),
});
