import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWocDb } from './db';

const URL = process.env.DATABASE_URL;
const maybe = URL ? test : test.skip;

maybe('create → list → save → get character roundtrip', async () => {
  const db = createWocDb(URL!);
  const userId = `test_user_${Date.now()}`;
  const created = await db.createCharacter(userId, `T${Date.now() % 100000}`, 'warrior', 'Claudemoon');
  assert.equal(created.class, 'warrior');
  const list = await db.listCharacters(userId, 'Claudemoon');
  assert.ok(list.some((c) => c.id === created.id));
  await db.saveCharacterState(created.id, 5, { lifetimeXp: 123 } as any);
  const got = await db.getCharacter(userId, created.id, 'Claudemoon');
  assert.equal(got?.level, 5);
  assert.equal((got?.state as any)?.lifetimeXp, 123);
  await db.end();
});
