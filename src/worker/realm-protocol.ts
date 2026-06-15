export const DEFAULT_REALM = 'Claudemoon';

// A realm name is a short, human display string (à la WoW realms). Anything
// empty, overlong, or with illegal characters falls back to the default rather
// than spinning up a DO under a junk name.
export function resolveRealm(raw: string | undefined): string {
  const r = (raw ?? '').trim();
  return r && r.length <= 24 && /^[A-Za-z0-9][A-Za-z0-9 '_-]*$/.test(r) ? r : DEFAULT_REALM;
}

// The play-token rides in the WS URL query (?token=...) because a WebSocket
// upgrade can't carry an Authorization header.
export function parsePlayTokenFromUrl(url: string): string | null {
  try {
    return new URL(url).searchParams.get('token');
  } catch {
    return null;
  }
}
