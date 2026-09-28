import { createLogger, safeError } from '../src/lib/logger';

describe('PHI-safe logging', () => {
  const lines: string[] = [];
  const log = () => createLogger('info', { requestId: 'r1' }, (l) => lines.push(l));

  beforeEach(() => (lines.length = 0));

  it('emits structured JSON with the bound context', () => {
    log().info('task_created', { taskId: 't1' });
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({
      level: 'info',
      msg: 'task_created',
      requestId: 'r1',
      taskId: 't1',
    });
    expect(typeof entry.ts).toBe('string');
  });

  it('reduces an error to name, message and a bounded stack', () => {
    const fields = safeError(new Error('boom'));
    expect(fields['errorName']).toBe('Error');
    expect(fields['errorMessage']).toBe('boom');
    expect(String(fields['stack']).split(' | ').length).toBeLessThanOrEqual(8);
  });

  it('carries no payload object through the error path', () => {
    const err = Object.assign(new Error('write failed'), {
      requestPayload: { title: 'patient name and condition' },
    });
    log().error('unhandled_error', err);
    expect(lines[0]).not.toContain('patient name');
  });

  it('honours the level threshold', () => {
    createLogger('warn', {}, (l) => lines.push(l)).info('quiet');
    expect(lines).toHaveLength(0);
  });

  it('child loggers inherit and extend context', () => {
    log().child({ tenantId: 'tenant-a' }).info('x');
    expect(JSON.parse(lines[0]!)).toMatchObject({ requestId: 'r1', tenantId: 'tenant-a' });
  });
});
