// KeyService (BE-002 criterion 5; ADR 0013): the service signs and unwraps with keys it holds,
// and no operation returns private key material. WebCrypto, in process.
import { webcrypto } from 'node:crypto';
import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  KeyDisabledError,
  KeyExistsError,
  KeyNotFoundError,
  KeyPurposeError,
  MemoryKeyService,
  wrapDataKey,
  type Jwk,
  type KeyService,
} from './key-service.ts';

const { subtle } = webcrypto;
const PRIVATE = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];

async function verifyWith(
  publicJwk: Jwk,
  data: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  const key = await subtle.importKey(
    'jwk',
    publicJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, data);
}

describe('KeyService', () => {
  let keys: MemoryKeyService;

  beforeAll(async () => {
    keys = new MemoryKeyService();
    await keys.create('tokens-1', 'sign');
    await keys.create('tenant-a', 'unwrap');
    await keys.create('tenant-b', 'unwrap');
  });

  it('signs with a sign key and a verifier holding only the public JWK accepts the result', async () => {
    const data = new TextEncoder().encode('header.payload');
    const signature = await keys.sign('tokens-1', data);
    expect(signature.byteLength).toBe(64);
    expect(await verifyWith(await keys.publicJwk('tokens-1'), data, signature)).toBe(true);
    expect(
      await verifyWith(
        await keys.publicJwk('tokens-1'),
        new TextEncoder().encode('other'),
        signature,
      ),
    ).toBe(false);
  });

  it('publishes public JWKs with no private member', async () => {
    for (const id of ['tokens-1', 'tenant-a']) {
      const jwk = await keys.publicJwk(id);
      for (const member of PRIVATE) expect(jwk).not.toHaveProperty(member);
    }
    // The JWK is a copy: changing it does not change the key.
    const copy = await keys.publicJwk('tenant-a');
    copy.n = 'tampered';
    expect((await keys.publicJwk('tenant-a')).n).not.toBe('tampered');
  });

  it('unwraps a data key wrapped with the public half, and round-trips arbitrary keys', async () => {
    const publicJwk = await keys.publicJwk('tenant-a');
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 1, maxLength: 190 }), async (dek) => {
        const wrapped = await wrapDataKey(publicJwk, dek);
        expect(Buffer.from(await keys.unwrap('tenant-a', wrapped))).toEqual(Buffer.from(dek));
      }),
      { numRuns: 25 },
    );
  });

  it('a key that is not the wrapping key cannot unwrap the data key', async () => {
    const wrapped = await wrapDataKey(await keys.publicJwk('tenant-a'), new Uint8Array(32).fill(7));
    await expect(keys.unwrap('tenant-b', wrapped)).rejects.toThrow();
  });

  it('refuses an operation of the wrong purpose', async () => {
    await expect(keys.sign('tenant-a', new Uint8Array(4))).rejects.toBeInstanceOf(KeyPurposeError);
    await expect(keys.unwrap('tokens-1', new Uint8Array(256))).rejects.toBeInstanceOf(
      KeyPurposeError,
    );
  });

  it('refuses unknown keys and duplicate identifiers', async () => {
    await expect(keys.sign('missing', new Uint8Array(1))).rejects.toBeInstanceOf(KeyNotFoundError);
    await expect(keys.create('tokens-1', 'sign')).rejects.toBeInstanceOf(KeyExistsError);
    await expect(keys.create('bad id!', 'sign')).rejects.toThrow('malformed');
  });

  it('a disabled key stops signing and unwrapping, and other keys are unaffected', async () => {
    const service = new MemoryKeyService();
    await service.create('a', 'unwrap');
    await service.create('b', 'unwrap');
    await service.create('s', 'sign');
    const wrappedA = await wrapDataKey(await service.publicJwk('a'), new Uint8Array(16).fill(1));
    const wrappedB = await wrapDataKey(await service.publicJwk('b'), new Uint8Array(16).fill(2));
    expect(await service.enabled('a')).toBe(true);
    await service.disable('a');
    expect(await service.enabled('a')).toBe(false);
    expect(await service.enabled('missing')).toBe(false);
    await expect(service.unwrap('a', wrappedA)).rejects.toBeInstanceOf(KeyDisabledError);
    expect(Buffer.from(await service.unwrap('b', wrappedB))).toEqual(
      Buffer.from(new Uint8Array(16).fill(2)),
    );
    await service.disable('s');
    await expect(service.sign('s', new Uint8Array(1))).rejects.toBeInstanceOf(KeyDisabledError);
  });

  it('exposes no operation that returns private key material', () => {
    const service: KeyService = keys;
    const names = new Set<string>();
    for (
      let proto = Object.getPrototypeOf(service) as object | null;
      proto && proto !== Object.prototype;
    ) {
      for (const name of Object.getOwnPropertyNames(proto)) names.add(name);
      proto = Object.getPrototypeOf(proto) as object | null;
    }
    const operations = [...names].filter((n) => n !== 'constructor');
    expect(operations.sort()).toEqual([
      'create',
      'destroy',
      'disable',
      'enabled',
      'publicJwk',
      'sign',
      'unwrap',
    ]);
    expect(operations.some((n) => /private|export|secret|raw|material/i.test(n))).toBe(false);
  });
});
