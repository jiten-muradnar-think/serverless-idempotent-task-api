import { loadConfig } from '../src/lib/config';

describe('fail-fast configuration', () => {
  const saved = { ...process.env };
  afterEach(() => (process.env = { ...saved }));

  it('throws a named error when TABLE_NAME is absent', () => {
    delete process.env['TABLE_NAME'];
    expect(() => loadConfig()).toThrow(/TABLE_NAME/);
  });

  it('rejects a non-numeric lease', () => {
    process.env['TABLE_NAME'] = 't';
    process.env['LEASE_SECONDS'] = 'soon';
    expect(() => loadConfig()).toThrow(/positive integer/);
  });

  it('applies defaults when optional variables are absent', () => {
    process.env['TABLE_NAME'] = 't';
    delete process.env['LEASE_SECONDS'];
    expect(loadConfig()).toMatchObject({ tableName: 't', leaseSeconds: 60 });
  });
});
