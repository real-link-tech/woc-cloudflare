import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedIssuer } from './auth';

test('isAllowedIssuer accepts the configured Clerk issuer', () => {
  assert.equal(isAllowedIssuer('https://abc.clerk.accounts.dev', 'https://abc.clerk.accounts.dev'), true);
});

test('isAllowedIssuer rejects a different issuer', () => {
  assert.equal(isAllowedIssuer('https://evil.example.com', 'https://abc.clerk.accounts.dev'), false);
});
