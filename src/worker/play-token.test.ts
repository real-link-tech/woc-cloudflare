import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signPlayToken, verifyPlayToken } from './play-token';

const SECRET = 'test-secret';

test('a freshly signed token verifies and returns its claims', async () => {
  const token = await signPlayToken({ userId: 'user_1', characterId: 42 }, SECRET, 60);
  const claims = await verifyPlayToken(token, SECRET);
  assert.equal(claims?.userId, 'user_1');
  assert.equal(claims?.characterId, 42);
});

test('a tampered token fails verification', async () => {
  const token = await signPlayToken({ userId: 'user_1', characterId: 42 }, SECRET, 60);
  const claims = await verifyPlayToken(token + 'x', SECRET);
  assert.equal(claims, null);
});

test('an expired token fails verification', async () => {
  const token = await signPlayToken({ userId: 'user_1', characterId: 42 }, SECRET, -1);
  const claims = await verifyPlayToken(token, SECRET);
  assert.equal(claims, null);
});
