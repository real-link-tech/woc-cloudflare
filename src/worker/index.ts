import { Hono } from 'hono';
import { requireClerkUser } from './auth';
import { signPlayToken } from './play-token';
import { charactersRoutes } from './characters-routes';

type Env = {
  ASSETS: { fetch: (req: Request) => Promise<Response> };
  CLERK_JWT_ISSUER: string;
  CLERK_PUBLISHABLE_KEY: string;
  CLERK_SECRET_KEY: string;
  PLAY_SESSION_SIGNING_SECRET: string;
  HYPERDRIVE: { connectionString: string };
  WORLD_REALMS: DurableObjectNamespace;
};

const app = new Hono<{ Bindings: Env }>();

app.get('/api/woc/health', (c) => c.json({ ok: true, service: 'woc-cloudflare' }));

app.get('/api/woc/me', async (c) => {
  const user = await requireClerkUser(c.req.header('Authorization') ?? null, c.env.CLERK_JWT_ISSUER);
  if (!user) return c.json({ error: 'not authenticated' }, 401);
  return c.json({ userId: user.userId });
});

app.post('/api/woc/play-token', async (c) => {
  const user = await requireClerkUser(c.req.header('Authorization') ?? null, c.env.CLERK_JWT_ISSUER);
  if (!user) return c.json({ error: 'not authenticated' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const characterId = Number((body as { character?: unknown }).character);
  if (!Number.isFinite(characterId)) return c.json({ error: 'invalid character' }, 400);
  // NOTE (M1): once characters live in the DB, verify this user owns characterId
  // before minting. M0 mints for any authed user to exercise the flow.
  const token = await signPlayToken({ userId: user.userId, characterId }, c.env.PLAY_SESSION_SIGNING_SECRET, 120);
  return c.json({ token });
});

app.route('/api/woc/characters', charactersRoutes);

// A path whose last segment carries a non-HTML file extension (e.g. .glb, .js,
// .png) is an asset request, not a client route. Missing assets must 404 — if
// they SPA-fell-back to index.html, a missing .glb would surface as a cryptic
// GLTFLoader parse error instead of a clear 404 (matches the original server).
function looksLikeAsset(pathname: string): boolean {
  const last = pathname.split('/').pop() ?? '';
  const ext = last.includes('.') ? last.slice(last.lastIndexOf('.')).toLowerCase() : '';
  return ext !== '' && ext !== '.html';
}

// Static client: serve built assets; SPA-fallback to index.html only for
// extensionless client routes, never for missing asset files.
app.all('*', async (c) => {
  const url = new URL(c.req.url);
  if (url.pathname.startsWith('/api/')) return c.json({ error: 'unknown endpoint' }, 404);
  const res = await c.env.ASSETS.fetch(c.req.raw);
  if (res.status !== 404 || looksLikeAsset(url.pathname)) return res;
  const indexReq = new Request(new URL('/index.html', url), c.req.raw);
  return c.env.ASSETS.fetch(indexReq);
});

export default app;

// Cloudflare requires the Durable Object class to be a named export of the
// worker entry module so the runtime can instantiate it.
export { WorldRealmDurableObject } from './realm-do';
