import { unauthorized } from './errors';

/**
 * Claims as delivered by the API Gateway JWT authorizer.
 * The authorizer has already verified signature, issuer, audience and expiry;
 * by the time a claim reaches here it is trusted.
 */
export interface JwtClaims {
  sub?: string;
  /** Tenant the caller belongs to. Custom claim minted by the IdP. */
  'custom:tenant_id'?: string;
  scope?: string;
}

export interface Principal {
  tenantId: string;
  subject: string;
  scopes: string[];
}

/**
 * Tenant scope is derived ONLY from verified token claims.
 *
 * It is never read from the request body, path or a client-supplied header —
 * doing so would let any authenticated caller write into another tenant by
 * editing the payload.
 */
export function principalFrom(claims: JwtClaims | undefined): Principal {
  const tenantId = claims?.['custom:tenant_id'];
  const subject = claims?.sub;

  if (!tenantId || !subject) {
    throw unauthorized('Token is missing tenant or subject claim');
  }

  return {
    tenantId,
    subject,
    scopes: (claims.scope ?? '').split(' ').filter(Boolean),
  };
}

export function requireScope(principal: Principal, scope: string): void {
  if (!principal.scopes.includes(scope)) {
    throw unauthorized(`Token is missing required scope: ${scope}`);
  }
}
