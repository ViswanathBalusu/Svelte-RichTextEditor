/**
 * FRW-059 at the signing service: a tenant whose sealing key is held by a signature provider, reached
 * through the Cloud Signature Consortium API (a test double of the provider, test/support/csc-server.ts).
 * Only a hash is sent to the provider; its signature is embedded in the PDF and validates; its level
 * and the signer it reports come back as asserted by the provider; a failure of the provider leaves no
 * sealed bytes; and a tenant with no provider is sealed by the native key, with no call to a provider.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CscError, CscKeyService, cscCertificates } from '../src/csc.ts';
import { HttpTimestampAuthority } from '../src/cms.ts';
import { SigningService, type KeyDirectory } from '../src/service.ts';
import { verifySealedPdf } from '../src/verify-sealed.ts';
import { classicPdf } from './support/classic-pdf.ts';
import { startCscServer, type CscServer } from './support/csc-server.ts';
import { makePki, opensslAvailable, type TestPki } from './support/pki.ts';
import {
  command,
  DOCUMENT_SERVICE_SECRET,
  makeWorld,
  type World,
} from './support/service-world.ts';
import { startTestTsa, type TestTsa } from './support/tsa.ts';
import { verifyWithOpenssl } from './support/verify.ts';
import { InProcessKeyService } from './support/world.ts';

const TOKEN = 'csc-access-token-for-tests';
const CREDENTIAL = 'credential-1';
const SUBJECT = 'CN=Ada Lovelace,O=Example Trust Services,C=GB';

describe.skipIf(!opensslAvailable())('sealing through a signature provider (FRW-059)', () => {
  let pkiOperator: TestPki;
  let pkiProvider: TestPki;
  let tsa: TestTsa;
  let operatorKey: InProcessKeyService;
  let providerKey: InProcessKeyService;
  let strangerKey: InProcessKeyService;
  let csc: CscServer;
  let provider: CscKeyService;
  let service: SigningService;
  let world: World;
  const input = classicPdf();
  const inputHash = createHash('sha256').update(input).digest('hex');

  const options = (over: { accessToken?: () => Promise<string> } = {}) => ({
    baseUrl: csc.url,
    credentialId: CREDENTIAL,
    provider: 'Example Trust Services',
    level: 'advanced electronic signature (as the provider states it)',
    accessToken: over.accessToken ?? (() => Promise.resolve(TOKEN)),
    timeoutMs: 20_000,
  });

  /**
   * The service over the test world, with the tenant's key held by `k`. The provider's chain comes
   * from the provider; the time-stamp is the operator's authority's, so its certificates go in the
   * validation data of the provider's seal as well.
   */
  function build(k: CscKeyService): SigningService {
    const providers = new Map([['provider-key', k]]);
    const fromProvider = cscCertificates(providers);
    const directory: KeyDirectory = {
      get: (id) => (id === 'provider-key' ? k : id === 'operator-key' ? operatorKey : undefined),
    };
    return new SigningService({
      ...world.config,
      keys: directory,
      certificates: {
        chainFor: (id) =>
          providers.has(id) ? fromProvider.chainFor(id) : world.config.certificates.chainFor(id),
      },
      validationData: (id, tsCerts) => {
        const base = world.config.validationData(id, tsCerts);
        return id === 'provider-key'
          ? {
              ...base,
              certificates: [
                ...base.certificates,
                pkiOperator.root,
                pkiOperator.intermediate,
                pkiOperator.tsa,
              ],
              crls: [...base.crls, pkiOperator.rootCrl, pkiOperator.intermediateCrl],
            }
          : base;
      },
    });
  }
  beforeAll(async () => {
    operatorKey = new InProcessKeyService();
    providerKey = new InProcessKeyService();
    strangerKey = new InProcessKeyService();
    pkiOperator = makePki(await operatorKey.publicKey());
    pkiProvider = makePki(await providerKey.publicKey());
    tsa = await startTestTsa(pkiOperator);
    csc = await startCscServer({
      key: providerKey,
      otherKey: strangerKey,
      chain: [pkiProvider.seal, pkiProvider.intermediate],
      credentialId: CREDENTIAL,
      token: TOKEN,
      subjectDN: SUBJECT,
    });
    provider = new CscKeyService(options());
    world = makeWorld({
      operator: { id: 'operator-key', keyService: operatorKey, pki: pkiOperator },
      tenants: { 'tenant-prov': { id: 'provider-key', keyService: provider, pki: pkiProvider } },
      tsaUrl: tsa.url,
      timestamps: new HttpTimestampAuthority(tsa.url),
    });
    service = build(provider);
  }, 300_000);
  afterAll(async () => {
    await csc?.close();
    await tsa?.stop();
    pkiOperator?.remove();
    pkiProvider?.remove();
  });

  const roots = () => [pkiOperator.root, pkiProvider.root];

  it('embeds the provider signature in the PDF and sends the provider only a hash (criterion 1)', async () => {
    csc.requests.length = 0;
    const out = await service.seal(
      DOCUMENT_SERVICE_SECRET,
      command(input, { tenant: 'tenant-prov', documentId: 'doc-prov', seal: 'pades-b-lta' }),
    );
    if (!out.ok) throw new Error(out.code);
    // The signed attributes' digest was signed by the provider: its signature is in the PDF and checks
    // against the provider's certificate (OpenSSL) and with the verifier of this repository.
    const reports = verifyWithOpenssl(out.pdf, pkiProvider);
    expect(reports[0]!.main.ok, reports[0]!.main.detail).toBe(true);
    expect((await verifySealedPdf(out.pdf, roots())).ok).toBe(true);
    expect(Buffer.from(out.pdf.subarray(0, input.length)).equals(Buffer.from(input))).toBe(true);

    // What the provider received: the credential, the access token, and one 32-byte hash. No PDF, no
    // document identifier, no tenant, no name.
    const paths = csc.requests.map((r) => r.path);
    expect(paths).toEqual(['credentials/info', 'signatures/signHash']);
    for (const r of csc.requests) expect(r.authorization).toBe(`Bearer ${TOKEN}`);
    const sign = csc.requests.find((r) => r.path === 'signatures/signHash')!;
    expect(Object.keys(sign.body).sort()).toEqual(
      ['credentialID', 'hash', 'hashAlgo', 'signAlgo'].sort(),
    );
    const hashes = sign.body['hash'] as string[];
    expect(hashes).toHaveLength(1);
    expect(Buffer.from(hashes[0]!, 'base64')).toHaveLength(32);
    const wire = JSON.stringify(csc.requests);
    expect(wire).not.toContain('doc-prov');
    expect(wire).not.toContain('tenant-prov');
    expect(wire).not.toContain(Buffer.from(input.subarray(0, 64)).toString('base64').slice(0, 40));
    // The hash sent is not the PDF's own hash: it is the hash of the attributes that hold it.
    expect(Buffer.from(hashes[0]!, 'base64').toString('hex')).not.toBe(inputHash);
  });

  it('reports the level and the signer as the provider asserts them, never as verified (criterion 3, language)', async () => {
    const out = await service.seal(
      DOCUMENT_SERVICE_SECRET,
      command(input, { tenant: 'tenant-prov', documentId: 'doc-prov-2' }),
    );
    if (!out.ok) throw new Error(out.code);
    expect(out.provider).toEqual({
      provider: 'Example Trust Services',
      level: 'advanced electronic signature (as the provider states it)',
      signer: SUBJECT,
    });
    expect(out.keyId).toBe('provider-key');
  });

  it('seals a tenant with no provider with the native key, unchanged, and calls no provider (criterion 2)', async () => {
    csc.requests.length = 0;
    const out = await service.seal(
      DOCUMENT_SERVICE_SECRET,
      command(input, { tenant: 'tenant-native', documentId: 'doc-native' }),
    );
    if (!out.ok) throw new Error(out.code);
    expect(out.keyId).toBe('operator-key');
    expect(out.keyOwner).toBe('operator');
    expect(out.provider).toBeUndefined();
    expect(csc.requests).toEqual([]);
    const reports = verifyWithOpenssl(out.pdf, pkiOperator);
    expect(reports[0]!.main.ok, reports[0]!.main.detail).toBe(true);
  });

  it('leaves nothing sealed when the provider is down, refuses, answers badly or signs with another key (criterion 4)', async () => {
    for (const fault of ['down', 'refuse', 'garbage', 'wrong_key', 'key_disabled'] as const) {
      csc.fault = fault;
      // A fresh adapter: what was learned of the credential is not kept across a failure of it.
      const fresh = new CscKeyService(options());
      const failing = build(fresh);
      const out = await failing.seal(
        DOCUMENT_SERVICE_SECRET,
        command(input, { tenant: 'tenant-prov', documentId: `doc-${fault}` }),
      );
      expect(out.ok, fault).toBe(false);
      if (!out.ok) expect(['signing_unavailable', 'no_key']).toContain(out.code);
    }
    csc.fault = 'none';
  });

  it('refuses an authorisation mode it cannot serve, a digest that is not SHA-256, and a token it cannot get', async () => {
    const explicit = await startCscServer({
      key: providerKey,
      otherKey: strangerKey,
      chain: [pkiProvider.seal, pkiProvider.intermediate],
      credentialId: CREDENTIAL,
      token: TOKEN,
      subjectDN: SUBJECT,
      authMode: 'explicit',
    });
    const oauth = await startCscServer({
      key: providerKey,
      otherKey: strangerKey,
      chain: [pkiProvider.seal, pkiProvider.intermediate],
      credentialId: CREDENTIAL,
      token: TOKEN,
      subjectDN: SUBJECT,
      authMode: 'oauth2code',
    });
    try {
      // The explicit mode: the hash is authorised first, then signed with the activation data.
      const k = new CscKeyService({ ...options(), baseUrl: explicit.url });
      const digest = createHash('sha256').update('x').digest();
      expect((await k.signDigest('SHA-256', new Uint8Array(digest))).length).toBeGreaterThan(0);
      expect(explicit.requests.map((r) => r.path)).toEqual([
        'credentials/info',
        'credentials/authorize',
        'signatures/signHash',
      ]);
      const o = new CscKeyService({ ...options(), baseUrl: oauth.url });
      await expect(o.signDigest('SHA-256', new Uint8Array(digest))).rejects.toMatchObject({
        code: 'auth_mode_unsupported',
      });
      expect(oauth.requests.map((r) => r.path)).toEqual(['credentials/info']);
      // Only a 32-byte digest goes out.
      await expect(k.signDigest('SHA-256', new Uint8Array(20))).rejects.toThrow(RangeError);
      // A wrong token is the provider's refusal.
      const bad = new CscKeyService({ ...options(), accessToken: () => Promise.resolve('wrong') });
      await expect(bad.publicKey()).rejects.toBeInstanceOf(CscError);
    } finally {
      await explicit.close();
      await oauth.close();
    }
  });
});
