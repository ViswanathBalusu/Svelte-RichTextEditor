/**
 * What the sealing tests share: a stand-in key service that holds its key in this process (fast
 * tests of the file handling only, never evidence for "the key stays in the key service"), the
 * sealing options over a test chain and a test time-stamp authority, and byte helpers.
 */
import { constants, generateKeyPairSync, privateEncrypt } from 'node:crypto';
import { HttpTimestampAuthority } from '../../src/cms.ts';
import { digestInfo, type DigestAlgorithm, type KeyService } from '../../src/keyservice.ts';
import type { PadesProfile, SealOptions } from '../../src/pades.ts';
import type { TestPki } from './pki.ts';
import type { TestTsa } from './tsa.ts';

/** An RSA key in this process. Only for tests of file handling. */
export class InProcessKeyService implements KeyService {
  readonly keyLabel = 'in-process stand-in (tests of file handling only)';
  private readonly priv: string;
  private readonly pub: Uint8Array;
  readonly calls: { algorithm: DigestAlgorithm; length: number }[] = [];
  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 3072,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'der' },
    });
    this.priv = privateKey;
    this.pub = new Uint8Array(publicKey);
  }
  publicKey(): Promise<Uint8Array> {
    return Promise.resolve(this.pub);
  }
  signDigest(algorithm: DigestAlgorithm, digest: Uint8Array): Promise<Uint8Array> {
    this.calls.push({ algorithm, length: digest.length });
    return Promise.resolve(
      new Uint8Array(
        privateEncrypt(
          { key: this.priv, padding: constants.RSA_PKCS1_PADDING },
          Buffer.from(digestInfo(algorithm, digest)),
        ),
      ),
    );
  }
}

export function sealOptions(
  pki: TestPki,
  tsa: TestTsa,
  keyService: KeyService,
  profile: PadesProfile,
): SealOptions {
  return {
    keyService,
    chain: [pki.seal, pki.intermediate],
    timestamps: new HttpTimestampAuthority(tsa.url),
    profile,
    reason: 'Sealed by the signing service (spike S8)',
    validationData: () => ({
      // The signer's chain, the root, and the time-stamp authority's certificate; CRLs for both
      // CAs. No OCSP responder is run, so there are none.
      certificates: [pki.seal, pki.intermediate, pki.root, pki.tsa],
      crls: [pki.rootCrl, pki.intermediateCrl],
      ocsps: [],
    }),
  };
}

export function flipByte(pdf: Uint8Array, at: number): Uint8Array {
  const out = new Uint8Array(pdf);
  out[at] = (out[at] as number) ^ 0x01;
  return out;
}

export function startsWith(whole: Uint8Array, prefix: Uint8Array): boolean {
  return (
    whole.length >= prefix.length &&
    Buffer.compare(Buffer.from(whole.subarray(0, prefix.length)), Buffer.from(prefix)) === 0
  );
}
