// Clerk login gate: block the client boot until the user has an active Clerk
// session (shared IPIO login). Signed-out users are redirected to Clerk's
// hosted sign-in; once signed in, the client shell loads.

import { Clerk } from '@clerk/clerk-js';

let clerk: Clerk | null = null;

// Resolves only once the user has an active Clerk session. Redirects to Clerk's
// hosted sign-in if signed out (and then never resolves, since navigation is in
// flight). Returns the userId and a fresh-token getter the network layer uses.
export async function requireClerkSession(
  publishableKey: string,
): Promise<{ getToken: () => Promise<string | null>; userId: string }> {
  clerk = new Clerk(publishableKey);
  await clerk.load();
  if (!clerk.user) {
    await clerk.redirectToSignIn({ redirectUrl: window.location.href });
    await new Promise<never>(() => {}); // never resolves; navigation is in flight
  }
  return {
    userId: clerk.user!.id,
    getToken: () => clerk!.session?.getToken() ?? Promise.resolve(null),
  };
}
