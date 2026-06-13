import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../src/sync/auth.js';

describe('password hashing', () => {
  it('produces a self-describing scrypt string', async () => {
    const h = await hashPassword('correct horse');
    const parts = h.split('$');
    expect(parts[0]).toBe('scrypt');
    expect(parts).toHaveLength(6); // scrypt,N,r,p,salt,hash
  });

  it('verifies the right password and rejects the wrong one', async () => {
    const h = await hashPassword('s3cret-password');
    expect(await verifyPassword('s3cret-password', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });

  it('uses a random salt (two hashes of same password differ)', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    expect(a).not.toBe(b);
  });

  it('returns false (no throw) on a malformed stored value', async () => {
    expect(await verifyPassword('x', 'not-a-valid-hash')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$bad')).toBe(false);
  });
});
