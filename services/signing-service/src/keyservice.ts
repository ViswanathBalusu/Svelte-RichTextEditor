/**
 * The key service port of the signing service (12 §8.2 step 3; spike S8, owner decision 222).
 *
 * The sealing code holds no private key and has no way to ask for one: this interface has a public
 * key and a signing call that takes a digest. A hardware security module, a cloud key service or
 * the Cloud Signature Consortium's `signHash` all fit it. The development emulator is SoftHSM2 in
 * a Podman container (test/support/softhsm.ts); it is not part of the service.
 */
export type DigestAlgorithm = 'SHA-256';

/**
 * What a signature provider says about its own signature (FRW-059). The platform does not check
 * these: they are recorded as asserted by the provider and worded as such (FRW-058).
 */
export interface ProviderAssertion {
  /** The provider's name. */
  readonly provider: string;
  /** The signature level the provider reports, in its own words. */
  readonly level: string;
  /** The signer identification the provider reports (for CSC, the certificate's subject). */
  readonly signer: string;
}

export interface KeyService {
  /** A name for logs and the audit record. */
  readonly keyLabel: string;
  /**
   * Present on a key that a signature provider holds (`CscKeyService`): what the provider asserts.
   * Absent on the operator's and the tenants' own keys, whose seal is the native one.
   */
  assertion?(): Promise<ProviderAssertion>;
  /** The DER SubjectPublicKeyInfo of the signing key. */
  publicKey(): Promise<Uint8Array>;
  /**
   * Signs a digest with RSA PKCS#1 v1.5. The caller hashes; the service never sees the document.
   * Returns the raw signature value.
   */
  signDigest(algorithm: DigestAlgorithm, digest: Uint8Array): Promise<Uint8Array>;
}

/** DER `DigestInfo` prefix for SHA-256 (RFC 8017 §9.2). */
const SHA256_DIGEST_INFO = Uint8Array.from([
  0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05,
  0x00, 0x04, 0x20,
]);

export function digestInfo(algorithm: DigestAlgorithm, digest: Uint8Array): Uint8Array {
  if (algorithm !== 'SHA-256' || digest.length !== 32)
    throw new RangeError('only a 32-byte SHA-256 digest is supported');
  const out = new Uint8Array(SHA256_DIGEST_INFO.length + digest.length);
  out.set(SHA256_DIGEST_INFO, 0);
  out.set(digest, SHA256_DIGEST_INFO.length);
  return out;
}
