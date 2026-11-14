// The signature provider adapter (12 §8.3; ADR 0013; FRW-059 criteria 1 to 5). The provider here is a
// mock; the contract below is what any real adapter must pass.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type Embed,
  type ProviderRequest,
  type ProviderResult,
  type SignatureProvider,
  finaliseWorkflow,
  sealWithProvider,
  sealWorkflow,
} from '../src/index.ts';

const hash = 'a'.repeat(64);
const sealed = 'c'.repeat(64);

type Behaviour = ProviderResult | 'throw';

function mockProvider(behaviour: Behaviour) {
  const requests: ProviderRequest[] = [];
  const provider: SignatureProvider = {
    name: 'mock-provider',
    async sign(request) {
      requests.push(request);
      if (behaviour === 'throw') throw new Error('network down');
      return behaviour;
    },
  };
  return { provider, requests };
}

const signed: ProviderResult = {
  ok: true,
  signature: new Uint8Array([1, 2, 3]),
  assertedLevel: 'AdES-B-T',
  assertedSigner: 'Signer as the provider names it',
  timestamped: true,
};

const embedOk: Embed = async () => sealed;

const hexHash = fc
  .array(fc.constantFrom(...'0123456789abcdef'), { minLength: 64, maxLength: 64 })
  .map((chars) => chars.join(''));

describe('the provider receives the document hash and nothing else (FRW-059 criterion 1)', () => {
  it('sends an object whose only key is the hash', async () => {
    const { provider, requests } = mockProvider(signed);
    await sealWithProvider(provider, hash, embedOk);
    expect(requests).toEqual([{ documentHash: hash }]);
    expect(Object.keys(requests[0] ?? {})).toEqual(['documentHash']);
  });

  it('refuses a malformed hash before calling the provider (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.string({ maxLength: 80 }),
          hexHash.map((h) => h.toUpperCase()),
          hexHash.map((h) => `${h}0`),
        ),
        async (candidate) => {
          const { provider, requests } = mockProvider(signed);
          const out = await sealWithProvider(provider, candidate, embedOk);
          return requests.length === 0 && out.seal.ok === false && out.facts === null;
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('a provider failure leaves nothing half-signed and visible (FRW-059 criterion 4)', () => {
  const failures: Behaviour[] = [
    { ok: false, reason: 'provider_unreachable' },
    { ok: false, reason: 'provider_refused' },
    { ok: false, reason: 'provider_invalid_response' },
    'throw',
  ];

  it('never produces a sealed outcome or asserted facts, and never embeds', async () => {
    for (const behaviour of failures) {
      let embedded = false;
      const { provider } = mockProvider(behaviour);
      const out = await sealWithProvider(provider, hash, async () => {
        embedded = true;
        return sealed;
      });
      expect(out.seal.ok).toBe(false);
      expect(out.facts).toBeNull();
      expect(embedded).toBe(false);
    }
  });

  it('a failed provider stops finalisation at the seal, with completed and an alert', async () => {
    const { provider } = mockProvider({ ok: false, reason: 'provider_unreachable' });
    const { seal } = await sealWithProvider(provider, hash, embedOk);
    const out = finaliseWorkflow({
      compile: { ok: true },
      seal,
      store: { ok: true, storedHash: sealed },
    });
    expect(out.status).toBe('completed');
    expect(out.raised).toEqual(['completed']);
    expect(out.stoppedAt).toBe('seal');
    expect(out.failure?.code).toBe('signing_unavailable');
    expect(out.alert).toBe(true);
    expect(out.sealedHash).toBeNull();
  });

  it('a failed embedding is a failed seal, and no sealed hash is returned', async () => {
    const { provider } = mockProvider(signed);
    const out = await sealWithProvider(provider, hash, async () => {
      throw new Error('PDF rejected the signature');
    });
    expect(out.seal).toEqual({ ok: false, reason: 'seal_failed' });
    expect(out.facts).toBeNull();
  });

  it('an embedding that returns a malformed hash is a failed seal', async () => {
    const { provider } = mockProvider(signed);
    const out = await sealWithProvider(provider, hash, async () => 'not-a-hash');
    expect(out.seal.ok).toBe(false);
  });

  it('a result without a time-stamp is refused, as a seal without a time-stamp', async () => {
    const { provider } = mockProvider({
      ...signed,
      ok: true,
      timestamped: false,
    } as ProviderResult);
    const out = await sealWithProvider(provider, hash, embedOk);
    const final = finaliseWorkflow({
      compile: { ok: true },
      seal: out.seal,
      store: { ok: true, storedHash: sealed },
    });
    expect(final.status).toBe('completed');
    expect(final.failure).not.toBeNull();
    expect(final.sealedHash).toBeNull();
  });
});

describe('the asserted facts name the provider (FRW-059 criterion 3)', () => {
  it('records the level and the signer identification as asserted by the provider', async () => {
    const { provider } = mockProvider(signed);
    const out = await sealWithProvider(provider, hash, embedOk);
    expect(out.seal).toEqual({ ok: true, timestamped: true, sealedHash: sealed });
    expect(out.facts).toEqual({
      assertedBy: 'provider',
      provider: 'mock-provider',
      signatureLevel: 'AdES-B-T',
      signerIdentification: 'Signer as the provider names it',
    });
  });
});

describe('a successful provider seal completes finalisation (FRW-059 criterion 1, the seal half)', () => {
  it('finalises when the embedded bytes are stored unchanged', async () => {
    const { provider } = mockProvider(signed);
    const { seal } = await sealWithProvider(provider, hash, embedOk);
    const out = finaliseWorkflow({
      compile: { ok: true },
      seal,
      store: { ok: true, storedHash: sealed },
    });
    expect(out.status).toBe('finalised');
    expect(out.raised).toEqual(['completed', 'finalised']);
  });
});

describe('a workflow without a provider uses the native seal (FRW-059 criterion 2)', () => {
  it('runs the native seal and never calls a provider when none is configured', async () => {
    let nativeRuns = 0;
    const out = await sealWorkflow({
      provider: null,
      documentHash: hash,
      native: async () => {
        nativeRuns += 1;
        return { ok: true, timestamped: true, sealedHash: sealed };
      },
      embed: embedOk,
    });
    expect(nativeRuns).toBe(1);
    expect(out).toEqual({ seal: { ok: true, timestamped: true, sealedHash: sealed }, facts: null });
  });

  it('uses the provider when one is configured, and the native seal is not run', async () => {
    const { provider, requests } = mockProvider(signed);
    let nativeRuns = 0;
    const out = await sealWorkflow({
      provider,
      documentHash: hash,
      native: async () => {
        nativeRuns += 1;
        return { ok: false, reason: 'seal_failed' };
      },
      embed: embedOk,
    });
    expect(nativeRuns).toBe(0);
    expect(requests).toHaveLength(1);
    expect(out.seal.ok).toBe(true);
  });
});

// The contract any SignatureProvider adapter must pass (FRW-059 criterion 5), run here against the
// mock. A real adapter is run through the same cases by its own tests.
describe('the signature provider contract (FRW-059 criterion 5)', () => {
  const contract: Array<[string, Behaviour, boolean]> = [
    ['signs with a time-stamp', signed, true],
    ['is unreachable', { ok: false, reason: 'provider_unreachable' }, false],
    ['refuses', { ok: false, reason: 'provider_refused' }, false],
    ['answers with an invalid response', { ok: false, reason: 'provider_invalid_response' }, false],
    ['throws', 'throw', false],
  ];

  for (const [name, behaviour, succeeds] of contract) {
    it(`the adapter ${name}: the seal succeeds only when it should`, async () => {
      const { provider, requests } = mockProvider(behaviour);
      const out = await sealWithProvider(provider, hash, embedOk);
      expect(out.seal.ok).toBe(succeeds);
      expect(requests).toHaveLength(1);
      expect(out.facts !== null).toBe(succeeds);
    });
  }
});
