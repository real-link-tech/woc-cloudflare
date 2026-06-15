import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRealm, parsePlayTokenFromUrl } from './realm-protocol';

test('resolveRealm falls back to default for empty/bad', () => {
  assert.equal(resolveRealm(undefined), 'Claudemoon');
  assert.equal(resolveRealm('  '), 'Claudemoon');
  assert.equal(resolveRealm('Ironforge'), 'Ironforge');
});

test('resolveRealm rejects overly long or illegal names', () => {
  assert.equal(resolveRealm('x'.repeat(40)), 'Claudemoon');
  assert.equal(resolveRealm('!!!'), 'Claudemoon');
});

test('parsePlayTokenFromUrl reads ?token=', () => {
  assert.equal(parsePlayTokenFromUrl('https://x/ws?token=abc.def'), 'abc.def');
  assert.equal(parsePlayTokenFromUrl('https://x/ws'), null);
  assert.equal(parsePlayTokenFromUrl('not a url'), null);
});
