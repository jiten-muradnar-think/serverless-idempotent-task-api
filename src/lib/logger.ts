/**
 * Structured JSON logging.
 *
 * This service handles healthcare task data, so the logger never accepts a raw
 * error object or request payload. Callers pass explicit, non-identifying
 * fields; errors are reduced to name, message and stack. Anything that could
 * carry patient data has to be deliberately extracted, not accidentally spread.
 */
export type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogContext {
  requestId?: string;
  tenantId?: string;
  subject?: string;
  route?: string;
}

/** Only primitives, so a payload object can never be logged by accident. */
export type LogFields = Record<string, string | number | boolean | undefined>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, err?: unknown, fields?: LogFields): void;
  child(extra: LogContext): Logger;
}

export function safeError(err: unknown): LogFields {
  if (err instanceof Error) {
    return {
      errorName: err.name,
      errorMessage: err.message,
      // Stack frames are code paths, not user data.
      stack: err.stack?.split('\n').slice(0, 8).join(' | '),
    };
  }
  return { errorName: 'NonError', errorMessage: typeof err };
}

export function createLogger(
  level: Level = 'info',
  context: LogContext = {},
  sink: (line: string) => void = (line) => process.stdout.write(line + '\n'),
): Logger {
  const emit = (lvl: Level, msg: string, fields: LogFields = {}) => {
    if (ORDER[lvl] < ORDER[level]) return;
    sink(JSON.stringify({ level: lvl, msg, ts: new Date().toISOString(), ...context, ...fields }));
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, err, f) => emit('error', m, { ...safeError(err), ...f }),
    child: (extra) => createLogger(level, { ...context, ...extra }, sink),
  };
}
