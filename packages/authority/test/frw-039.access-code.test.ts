// FRW-039 criteria 3 and 5 (lane U-FRW-037-054): the access code is stored only as a salted hash,
// and a workflow's `auth` member accepts nothing but `access_code`. Pure functions; Node.js.
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  checkAuthRequire,
  registerAccessCode,
  verifyAccessCode,
} from '../src/workflow/access-code.ts';

const SALT = new Uint8Array(16).map((_, i) => i * 7 + 1);

describe('access code storage (FRW-039 criterion 3)', () => {
  it('stores the salt and the SHA-256 of salt followed by the code, never the code', async () => {
    const code = 'open-sesame-7741';
    const record = await registerAccessCode(code, SALT);
    const saltHex = Buffer.from(SALT).toString('hex');
    const expected = createHash('sha256')
      .update(Buffer.concat([Buffer.from(SALT), Buffer.from(code, 'utf8')]))
      .digest('hex');
    expect(record).toEqual({ method: 'access_code', salt: saltHex, hash: expected });
    expect(JSON.stringify(record)).not.toContain(code);
  });

  it('never leaves the plaintext in the stored record for any code (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 40 }), async (code) => {
        const record = await registerAccessCode(code, SALT);
        expect(Object.keys(record).sort()).toEqual(['hash', 'method', 'salt']);
        // The record holds no field equal to the code, which is what a table or a log would hold.
        expect(Object.values(record)).not.toContain(code);
      }),
      { numRuns: 100 },
    );
  });

  it('refuses an empty code and a code that is not a string', async () => {
    await expect(registerAccessCode('', SALT)).rejects.toThrow(RangeError);
    await expect(registerAccessCode(42 as unknown as string, SALT)).rejects.toThrow(RangeError);
  });

  it('verifies the registered code and refuses any other (property)', async () => {
    const record = await registerAccessCode('correct-horse', SALT);
    expect(await verifyAccessCode('correct-horse', record)).toBe(true);
    expect(await verifyAccessCode('Correct-horse', record)).toBe(false);
    expect(await verifyAccessCode(' correct-horse', record)).toBe(false);
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 20 }), async (guess) => {
        fc.pre(guess !== 'correct-horse');
        expect(await verifyAccessCode(guess, record)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('refuses a record whose salt or hash is malformed, without throwing', async () => {
    const record = await registerAccessCode('x', SALT);
    expect(await verifyAccessCode('x', { ...record, salt: 'zz' })).toBe(false);
    expect(await verifyAccessCode('x', { ...record, hash: 'ABC' })).toBe(false);
  });

  it('draws a fresh salt per registration when none is given', async () => {
    const a = await registerAccessCode('same-code');
    const b = await registerAccessCode('same-code');
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('the auth member accepts only access_code (FRW-039 criterion 5)', () => {
  it('accepts an absent auth, an empty require and a require of access_code', () => {
    expect(checkAuthRequire(undefined)).toEqual({ ok: true, require: [] });
    expect(checkAuthRequire({})).toEqual({ ok: true, require: [] });
    expect(checkAuthRequire({ require: [] })).toEqual({ ok: true, require: [] });
    expect(checkAuthRequire({ require: ['access_code'] })).toEqual({
      ok: true,
      require: ['access_code'],
    });
  });

  it('refuses any other method, alone or beside access_code, with the method named', () => {
    expect(checkAuthRequire({ require: ['sms_otp'] })).toEqual({
      ok: false,
      reason: 'unsupported_method',
      method: 'sms_otp',
    });
    expect(checkAuthRequire({ require: ['access_code', 'id_verification'] })).toMatchObject({
      ok: false,
      reason: 'unsupported_method',
      method: 'id_verification',
    });
  });

  it('refuses a non-string entry, a non-list require, a non-object auth and any other member', () => {
    expect(checkAuthRequire({ require: [1] })).toMatchObject({
      ok: false,
      reason: 'unsupported_method',
    });
    expect(checkAuthRequire({ require: 'access_code' })).toMatchObject({
      ok: false,
      reason: 'require_not_a_list',
    });
    expect(checkAuthRequire('access_code')).toMatchObject({ ok: false, reason: 'not_an_object' });
    expect(checkAuthRequire(['access_code'])).toMatchObject({ ok: false, reason: 'not_an_object' });
    expect(checkAuthRequire({ require: ['access_code'], passcode: 'x' })).toMatchObject({
      ok: false,
      reason: 'unknown_member',
    });
  });
});
