import fs from 'fs';
import path from 'path';
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { clerk, setupClerkTestingToken } from '@clerk/testing/playwright';

const RESULTS_DIR = path.join(process.cwd(), 'test-results');

type Creds = { identifier: string; password: string; userId: string };

const CLERK_API = 'https://api.clerk.com/v1';

function requireSecretKey(): string {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    throw new Error(
      'Missing CLERK_SECRET_KEY, so Playwright cannot provision a Clerk test user ' +
        'or mint a sign-in token.',
    );
  }
  return secretKey;
}

// Mirrors the repo's resolveTestCredentials: honor explicit env creds, else
// auto-provision a fresh +clerk_test user via the Clerk Backend API using the
// secret key. Each call creates a distinct user so two-player tests don't
// collide on the no-double-connect guard. We resolve the userId either way so
// we can mint sign-in tokens (ticket strategy), which is required because the
// dev Clerk instance enforces a second factor that password sign-in can't pass.
async function provisionTestUser(): Promise<Creds> {
  const secretKey = requireSecretKey();
  const envIdentifier = process.env.E2E_CLERK_USER_IDENTIFIER;
  const envPassword = process.env.E2E_CLERK_USER_PASSWORD;

  if (envIdentifier && envPassword) {
    // Resolve the existing user's id so we can mint sign-in tokens for it.
    const res = await fetch(
      `${CLERK_API}/users?email_address=${encodeURIComponent(envIdentifier)}`,
      { headers: { Authorization: `Bearer ${secretKey}` } },
    );
    if (!res.ok) {
      throw new Error(`Failed to look up E2E_CLERK_USER_IDENTIFIER: ${res.status} ${await res.text()}`);
    }
    const list = (await res.json()) as Array<{ id: string }>;
    if (!list.length) throw new Error(`No Clerk user found for ${envIdentifier}`);
    return { identifier: envIdentifier, password: envPassword, userId: list[0].id };
  }

  const rand = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const generatedEmail = `playwright${rand}+clerk_test@example.com`;
  const generatedPassword = `Woc!${rand}pass`;

  const response = await fetch(`${CLERK_API}/users`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email_address: [generatedEmail], password: generatedPassword }),
  });
  if (!response.ok) {
    throw new Error(`Failed to provision Clerk test user: ${response.status} ${await response.text()}`);
  }
  const user = (await response.json()) as { id: string };
  return { identifier: generatedEmail, password: generatedPassword, userId: user.id };
}

// Mint a short-lived Clerk sign-in token (ticket). The ticket strategy bypasses
// the second factor the dev instance enforces, so it's the only reliable
// headless sign-in for this Clerk instance.
async function mintSignInTicket(userId: string): Promise<string> {
  const secretKey = requireSecretKey();
  const res = await fetch(`${CLERK_API}/sign_in_tokens`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, expires_in_seconds: 300 }),
  });
  if (!res.ok) {
    throw new Error(`Failed to mint sign-in token: ${res.status} ${await res.text()}`);
  }
  return (await res.json()).token as string;
}

// Sign in same-origin (no hosted redirect) using the e2e_no_redirect gate hook,
// then drive the real UI into the world and wait for a live DO connection.
async function signInAndEnter(page: Page, creds: Creds): Promise<void> {
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`[browser:error] ${msg.text()}`);
  });
  page.on('pageerror', (err) => console.log(`[browser:pageerror] ${err.message}`));

  const ticket = await mintSignInTicket(creds.userId);

  await setupClerkTestingToken({ page });
  await page.goto('/?e2e_no_redirect=1');
  await clerk.loaded({ page });
  await clerk.signIn({ page, signInParams: { strategy: 'ticket', ticket } });

  // The gate resolves only after the Clerk session exists; once it does it
  // stashes __wocClerkToken AND wires the start-screen click handlers. Wait for
  // that so the Play Online click actually has a listener attached (clicking
  // the button before wireStartScreens runs is a silent no-op).
  await page.waitForFunction(() => typeof (window as any).__wocClerkToken === 'function', {
    timeout: 60_000,
  });

  // The boot gate routes a signed-in user STRAIGHT to character select (Clerk is
  // the login; there is no marketing homepage / Play-Online step). refreshCharacters
  // auto-seeds a Hero and renders its "Enter World" button — wait for it and click.
  await page.waitForSelector('#char-list .enter-world-btn', { state: 'visible', timeout: 60_000 });
  await page.click('#char-list .enter-world-btn');

  // enterWorld fetches a play-token and opens the WS to the realm DO.
  await page.waitForFunction(() => Boolean((window as any).__wocWorld), { timeout: 60_000 });
  await page.waitForFunction(() => (window as any).__wocWorld?.connected === true, { timeout: 60_000 });
  // The DO sends hello (sets playerId), then the first world snapshot populates
  // the entity table — wait for our own entity to land so the world is live.
  await page.waitForFunction(() => {
    const w = (window as any).__wocWorld;
    return w && w.playerId > 0 && w.entities.has(w.playerId);
  }, { timeout: 60_000 });
}

test.beforeAll(() => {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
});

test('single player connects and spawns', async ({ page }) => {
  const creds = await provisionTestUser();
  await signInAndEnter(page, creds);

  // DO sent hello -> playerId set, and we are present in the entity table.
  const spawn = await page.evaluate(() => {
    const w = (window as any).__wocWorld;
    return { playerId: w.playerId, entityCount: w.entities.size };
  });
  expect(spawn.playerId).toBeGreaterThan(0);
  expect(spawn.entityCount).toBeGreaterThanOrEqual(1);

  // Drive movement and assert the local player's position changes.
  const before = await page.evaluate(() => {
    const p = (window as any).__wocWorld.player.pos;
    return { x: p.x, y: p.y, z: p.z };
  });

  await page.evaluate(() => {
    (window as any).__wocWorld.setMoveInput({ forward: true });
  });
  await page.waitForTimeout(2500);
  // stop moving so we read a settled pose
  await page.evaluate(() => {
    (window as any).__wocWorld.setMoveInput({ forward: false });
  });

  const after = await page.evaluate(() => {
    const p = (window as any).__wocWorld.player.pos;
    return { x: p.x, y: p.y, z: p.z };
  });

  const moved =
    Math.abs(after.x - before.x) + Math.abs(after.y - before.y) + Math.abs(after.z - before.z);
  console.log(`single-player moved delta=${moved.toFixed(3)} from`, before, 'to', after);
  expect(moved).toBeGreaterThan(0.01);

  await page.screenshot({ path: path.join(RESULTS_DIR, 'single-player.png') });
});

test('two players see each other', async ({ browser }) => {
  let ctxA: BrowserContext | undefined;
  let ctxB: BrowserContext | undefined;
  try {
    ctxA = await browser.newContext();
    ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    const credsA = await provisionTestUser();
    const credsB = await provisionTestUser();

    await signInAndEnter(pageA, credsA);
    await signInAndEnter(pageB, credsB);

    const pidB = await pageB.evaluate(() => (window as any).__wocWorld.playerId);

    // Sample B's view of foreign (not-B) entity positions while A moves.
    const sampleForeign = () =>
      pageB.evaluate((selfPid: number) => {
        const w = (window as any).__wocWorld;
        const out: Record<number, { x: number; y: number; z: number }> = {};
        for (const [id, e] of w.entities as Map<number, any>) {
          if (id !== selfPid) out[id] = { x: e.pos.x, y: e.pos.y, z: e.pos.z };
        }
        return out;
      }, pidB);

    // Drive A forward for ~2.5s, sampling B's view across the window.
    await pageA.evaluate(() => (window as any).__wocWorld.setMoveInput({ forward: true }));
    const first = await sampleForeign();
    await pageB.waitForTimeout(2500);
    const last = await sampleForeign();
    await pageA.evaluate(() => (window as any).__wocWorld.setMoveInput({ forward: false }));

    // B must see at least one foreign entity (that's A) whose position changed.
    const foreignIds = new Set([...Object.keys(first), ...Object.keys(last)].map(Number));
    expect(foreignIds.size).toBeGreaterThanOrEqual(1);

    let sawMovement = false;
    for (const id of foreignIds) {
      const a = first[id];
      const b = last[id];
      if (!a || !b) continue;
      const delta = Math.abs(b.x - a.x) + Math.abs(b.y - a.y) + Math.abs(b.z - a.z);
      if (delta > 0.01) {
        sawMovement = true;
        console.log(`B saw foreign entity ${id} move delta=${delta.toFixed(3)}`);
      }
    }

    await pageA.screenshot({ path: path.join(RESULTS_DIR, 'two-player-A.png') });
    await pageB.screenshot({ path: path.join(RESULTS_DIR, 'two-player-B.png') });

    expect(sawMovement).toBe(true);
  } finally {
    await ctxA?.close();
    await ctxB?.close();
  }
});
