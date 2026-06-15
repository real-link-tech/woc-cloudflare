import { Hono } from 'hono';
import { requireClerkUser } from './auth';
import { createWocDb } from './db';
import type { PlayerClass } from '../sim/types';

const REALM = 'Claudemoon';
const CLASSES: PlayerClass[] = ['warrior','paladin','hunter','rogue','priest','shaman','mage','warlock','druid'];

export type CharEnv = {
  HYPERDRIVE: { connectionString: string };
  CLERK_JWT_ISSUER: string;
};

function validName(n: unknown): n is string {
  return typeof n === 'string' && /^[A-Za-z][A-Za-z' -]{1,15}$/.test(n.trim());
}

export const charactersRoutes = new Hono<{ Bindings: CharEnv }>();

charactersRoutes.get('/', async (c) => {
  const user = await requireClerkUser(c.req.header('Authorization') ?? null, c.env.CLERK_JWT_ISSUER);
  if (!user) return c.json({ error: 'not authenticated' }, 401);
  const db = createWocDb(c.env.HYPERDRIVE.connectionString);
  try {
    const chars = await db.listCharacters(user.userId, REALM);
    return c.json({ realm: REALM, characters: chars.map((x) => ({ id: x.id, name: x.name, class: x.class, level: x.level })) });
  } finally { await db.end(); }
});

charactersRoutes.post('/', async (c) => {
  const user = await requireClerkUser(c.req.header('Authorization') ?? null, c.env.CLERK_JWT_ISSUER);
  if (!user) return c.json({ error: 'not authenticated' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const name = typeof body?.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
  if (!validName(name)) return c.json({ error: 'invalid character name (2-16 letters)' }, 400);
  if (!CLASSES.includes(body?.class)) return c.json({ error: 'invalid class' }, 400);
  const db = createWocDb(c.env.HYPERDRIVE.connectionString);
  try {
    const existing = await db.listCharacters(user.userId, REALM);
    if (existing.length >= 10) return c.json({ error: 'character limit reached' }, 400);
    const created = await db.createCharacter(user.userId, name, body.class, REALM);
    return c.json({ id: created.id, name: created.name, class: created.class, level: created.level });
  } catch (e: any) {
    if (String(e?.code) === '23505') return c.json({ error: 'that name is taken' }, 409);
    throw e;
  } finally { await db.end(); }
});
