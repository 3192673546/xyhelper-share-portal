import assert from 'node:assert/strict';
import test from 'node:test';
import { hashPassword, normalizeEmail, verifyPassword } from '../src/security.mjs';

test('passwords are salted and can be verified', () => {
  const first = hashPassword('correct horse battery staple');
  const second = hashPassword('correct horse battery staple');
  assert.notEqual(first, second);
  assert.equal(verifyPassword('correct horse battery staple', first), true);
  assert.equal(verifyPassword('wrong password', first), false);
  assert.equal(verifyPassword('correct horse battery staple', 'broken'), false);
});

test('email normalization rejects malformed values', () => {
  assert.equal(normalizeEmail('  User@Example.COM '), 'user@example.com');
  assert.throws(() => normalizeEmail('not-an-email'));
});
