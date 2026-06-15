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
  // Expose the same Clerk instance so Clerk testing tooling (Playwright) can
  // drive sign-in against it. Harmless in production.
  (window as unknown as { Clerk?: unknown }).Clerk = clerk;
  await clerk.load();
  // TEST-ONLY escape hatch: when ?e2e_no_redirect=1 is present, do not redirect
  // to the hosted sign-in. Instead poll until a session exists (the test signs
  // in same-origin via Clerk testing tooling), then continue. Harmless in prod:
  // an unauthenticated visitor passing the flag just waits with no access; no
  // token is ever issued.
  const noRedirect = new URLSearchParams(location.search).has('e2e_no_redirect');
  if (!clerk.user) {
    if (noRedirect) {
      await new Promise<void>((resolve) => {
        const iv = setInterval(() => { if (clerk!.user) { clearInterval(iv); resolve(); } }, 200);
      });
    } else {
      await clerk.redirectToSignIn({ redirectUrl: window.location.href });
      await new Promise<never>(() => {}); // never resolves; navigation is in flight
    }
  }
  return {
    userId: clerk.user!.id,
    getToken: () => clerk!.session?.getToken() ?? Promise.resolve(null),
  };
}

// Sign out of the shared Clerk session and return to the gate, which then sends
// the (now signed-out) user to Clerk's hosted sign-in. This is the only "log
// out" in the app — there is no legacy WoC account to sign out of.
export async function clerkSignOut(): Promise<void> {
  try { await clerk?.signOut(); } catch { /* fall through to reload */ }
  window.location.href = '/';
}
