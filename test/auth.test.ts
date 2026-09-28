import { principalFrom, requireScope } from '../src/lib/auth';
import { HttpError } from '../src/lib/errors';

describe('identity-derived tenancy', () => {
  it('reads tenant and subject from verified claims', () => {
    const p = principalFrom({
      sub: 'user-1',
      'custom:tenant_id': 'tenant-a',
      scope: 'tasks:read tasks:write',
    });
    expect(p).toEqual({
      tenantId: 'tenant-a',
      subject: 'user-1',
      scopes: ['tasks:read', 'tasks:write'],
    });
  });

  it('rejects a token with no tenant claim', () => {
    expect(() => principalFrom({ sub: 'user-1' })).toThrow(HttpError);
    expect(() => principalFrom(undefined)).toThrow(HttpError);
  });

  it('rejects a caller missing the required scope', () => {
    const p = principalFrom({ sub: 'u', 'custom:tenant_id': 't', scope: 'tasks:read' });
    expect(() => requireScope(p, 'tasks:write')).toThrow(HttpError);
  });
});
