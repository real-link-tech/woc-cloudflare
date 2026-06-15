import { Hono } from 'hono';
import { requireClerkUser } from './auth';

type Env = {
  ASSETS: { fetch: (req: Request) => Promise<Response> };
  CLERK_JWT_ISSUER: string;
  CLERK_PUBLISHABLE_KEY: string;
  CLERK_SECRET_KEY: string;
  PLAY_SESSION_SIGNING_SECRET: string;
};

const app = new Hono<{ Bindings: Env }>();

app.get('/api/woc/health', (c) => c.json({ ok: true, service: 'woc-cloudflare' }));

app.get('/api/woc/me', async (c) => {
  const user = await requireClerkUser(c.req.header('Authorization') ?? null, c.env.CLERK_JWT_ISSUER);
  if (!user) return c.json({ error: 'not authenticated' }, 401);
  return c.json({ userId: user.userId });
});

// Static client: SPA fallback to index.html for non-API, non-asset paths.
app.all('*', async (c) => {
  const url = new URL(c.req.url);
  if (url.pathname.startsWith('/api/')) return c.json({ error: 'unknown endpoint' }, 404);
  const res = await c.env.ASSETS.fetch(c.req.raw);
  if (res.status !== 404) return res;
  const indexReq = new Request(new URL('/index.html', url), c.req.raw);
  return c.env.ASSETS.fetch(indexReq);
});

export default app;
