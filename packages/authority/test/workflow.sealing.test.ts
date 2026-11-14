// The sealing key selection and the binding of a seal request (FRW-052 criteria 3 and 4, for the
// pure rules only; the service, the keys and the audit are not built here).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type SealRequest,
  type SealingConfig,
  checkSealRequest,
  selectSealingKey,
} from '../src/workflow/sealing.ts';

const OPERATOR = 'op-key-1';
const CALLER = 'document-service';
const hash = 'c'.repeat(64);

const tenantArb = fc.string({ minLength: 1, maxLength: 16 }).filter((s) => s !== '__proto__');

describe('the sealing key is selected per tenant from configuration (FRW-052 criterion 4)', () => {
  it('gives a tenant its own key when it has one, and the operator key otherwise (property)', () => {
    fc.assert(
      fc.property(
        fc.dictionary(tenantArb, fc.string({ minLength: 1, maxLength: 20 }), { maxKeys: 5 }),
        tenantArb,
        (tenantKeyIds, tenant) => {
          const config: SealingConfig = { operatorKeyId: OPERATOR, tenantKeyIds };
          const key = selectSealingKey(config, tenant);
          if (Object.prototype.hasOwnProperty.call(tenantKeyIds, tenant))
            expect(key).toEqual({ owner: 'tenant', keyId: tenantKeyIds[tenant] });
          else expect(key).toEqual({ owner: 'operator', keyId: OPERATOR });
        },
      ),
    );
  });

  it('does not reach the prototype for a tenant named like an object property', () => {
    const config: SealingConfig = { operatorKeyId: OPERATOR, tenantKeyIds: {} };
    expect(selectSealingKey(config, 'constructor')).toEqual({ owner: 'operator', keyId: OPERATOR });
    expect(selectSealingKey(config, 'toString')).toEqual({ owner: 'operator', keyId: OPERATOR });
  });

  it('refuses an empty operator key, an empty tenant id and an empty tenant key', () => {
    expect(() => selectSealingKey({ operatorKeyId: '', tenantKeyIds: {} }, 't')).toThrow(
      RangeError,
    );
    expect(() => selectSealingKey({ operatorKeyId: OPERATOR, tenantKeyIds: {} }, '')).toThrow(
      RangeError,
    );
    expect(() =>
      selectSealingKey({ operatorKeyId: OPERATOR, tenantKeyIds: { t: '' } }, 't'),
    ).toThrow(RangeError);
  });
});

describe('a seal request is bound to the document, seq and PDF hash, from the document service (FRW-052 criterion 3)', () => {
  const expected = { documentId: 'doc-1', seq: 42, pdfSha256: hash };
  const good: SealRequest = { caller: CALLER, ...expected };

  it('accepts a request that matches every expected value', () => {
    expect(checkSealRequest(good, expected, CALLER)).toEqual({ ok: true });
  });

  it('refuses any other caller, whatever the binding (property)', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 20 }), (caller) => {
        fc.pre(caller !== CALLER);
        expect(checkSealRequest({ ...good, caller }, expected, CALLER)).toEqual({
          ok: false,
          reason: 'wrong_caller',
        });
      }),
    );
  });

  it('names the first binding that differs: document, seq or PDF hash', () => {
    expect(checkSealRequest({ ...good, documentId: 'doc-2' }, expected, CALLER)).toEqual({
      ok: false,
      reason: 'document_mismatch',
    });
    expect(checkSealRequest({ ...good, seq: 43 }, expected, CALLER)).toEqual({
      ok: false,
      reason: 'seq_mismatch',
    });
    expect(checkSealRequest({ ...good, pdfSha256: 'd'.repeat(64) }, expected, CALLER)).toEqual({
      ok: false,
      reason: 'hash_mismatch',
    });
  });
});
