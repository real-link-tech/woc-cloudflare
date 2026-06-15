import { createRemoteJWKSet, jwtVerify } from 'jose';

export function isAllowedIssuer(tokenIssuer: string, configuredIssuer: string): boolean {
  return tokenIssuer === configuredIssuer;
}

export interface ClerkUser { userId: string; }

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function jwks(issuer: string) {
  let set = jwksCache.get(issuer);
  if (!set) {
    set = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
    jwksCache.set(issuer, set);
  }
  return set;
}

export async function verifyClerkJwt(token: string, issuer: string): Promise<ClerkUser | null> {
  try {
    const { payload } = await jwtVerify(token, jwks(issuer), { issuer });
    if (!payload.sub) return null;
    return { userId: String(payload.sub) };
  } catch {
    return null;
  }
}

export async function requireClerkUser(authHeader: string | null, issuer: string): Promise<ClerkUser | null> {
  const m = /^Bearer (.+)$/.exec(authHeader ?? '');
  if (!m) return null;
  return verifyClerkJwt(m[1], issuer);
}
