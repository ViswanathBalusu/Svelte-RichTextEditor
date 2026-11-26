/**
 * A signature provider through the Cloud Signature Consortium API, version 2 (12 §8.3, §13 phase 4;
 * ADR 0013, ADR 0411; FRW-059). The provider holds the signer's key and certificate; the platform
 * does not become a trust service provider.
 *
 * `CscKeyService` is the `KeyService` port over three CSC calls: `credentials/info` (the certificate
 * chain, the state of the key, the authorisation mode), `credentials/authorize` (a signature
 * activation data token, for the explicit mode) and `signatures/signHash`. Nothing else is sent: the
 * hash is the SHA-256 of the CMS signed attributes, which hold the digest of the PDF's signed byte
 * ranges. The PDF, a name and the document identifier never leave the signing service. The
 * signature that comes back is checked against the certificate's public key before it is used, so a
 * provider's wrong answer is a failed seal and not a bad signature in a PDF.
 *
 * The access token is the deployment's secret: it is asked for at each call (`accessToken`) and is
 * never stored or logged here. Only the `implicit` and `explicit` authorisation modes are served;
 * `oauth2code` needs the signer at the provider's own page and is refused. What the provider
 * asserts about the level and the signer (`assertion`) is returned as asserted, not as verified.
 */
import { constants, createPublicKey, publicDecrypt } from 'node:crypto';
import { certificateOf } from './cms.ts';
import {
  digestInfo,
  type DigestAlgorithm,
  type KeyService,
  type ProviderAssertion,
} from './keyservice.ts';
import type { CertificateSource } from './service.ts';

const SHA256_OID = '2.16.840.1.101.3.4.2.1';
const SHA256_WITH_RSA_OID = '1.2.840.113549.1.1.11';

export class CscError extends Error {
  readonly code: string;
  constructor(code: string, message = code) {
    super(message);
    this.code = code;
  }
}

export interface CscOptions {
  /** The API base, for example `https://provider.example/csc/v2`, without a trailing slash. */
  readonly baseUrl: string;
  /** The identifier of the signer's credential at the provider. */
  readonly credentialId: string;
  /** The provider's name, recorded as the source of the asserted facts. */
  readonly provider: string;
  /**
   * The signature level the provider issues, as the operator records it from the provider's own
   * statement. Asserted, not verified. Absent: the credential's `description`, else "not stated".
   */
  readonly level?: string;
  /** The OAuth 2 access token of the deployment's service account. Asked for at each call. */
  readonly accessToken: () => Promise<string>;
  /** How long to wait for one answer, ms. No default: the specification gives none. */
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
}

interface CredentialInfo {
  readonly certificates: readonly Uint8Array[];
  readonly subject: string;
  readonly authMode: string;
  readonly description: string | null;
}

const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');
const unb64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));

export class CscKeyService implements KeyService {
  readonly keyLabel: string;
  readonly #o: CscOptions;
  #info: Promise<CredentialInfo> | null = null;

  constructor(options: CscOptions) {
    if (!(options.timeoutMs >= 1)) throw new RangeError('timeoutMs must be at least 1');
    this.#o = options;
    this.keyLabel = `csc:${options.provider}:${options.credentialId}`;
  }

  async #post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await (this.#o.fetch ?? fetch)(`${this.#o.baseUrl}/${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await this.#o.accessToken()}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#o.timeoutMs),
      });
    } catch {
      throw new CscError('provider_unreachable');
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new CscError(res.status >= 500 ? 'provider_unreachable' : 'provider_invalid_response');
    }
    if (!res.ok) {
      // A CSC error is `{error, error_description}`; its text is the provider's, not ours to show.
      throw new CscError(res.status >= 500 ? 'provider_unreachable' : 'provider_refused');
    }
    if (typeof json !== 'object' || json === null) throw new CscError('provider_invalid_response');
    return json as Record<string, unknown>;
  }

  /** The credential's certificate chain, state and authorisation mode (read once, then kept). */
  #credential(): Promise<CredentialInfo> {
    this.#info ??= this.#post('credentials/info', {
      credentialID: this.#o.credentialId,
      certificates: 'chain',
      certInfo: true,
    })
      .then((j) => {
        const key = j['key'] as { status?: unknown } | undefined;
        const cert = j['cert'] as
          { status?: unknown; certificates?: unknown; subjectDN?: unknown } | undefined;
        if (key?.status !== 'enabled' || (cert?.status !== undefined && cert.status !== 'valid'))
          throw new CscError('credential_not_usable');
        if (
          !Array.isArray(cert?.certificates) ||
          cert.certificates.length === 0 ||
          !cert.certificates.every((c) => typeof c === 'string')
        )
          throw new CscError('provider_invalid_response');
        const authMode = typeof j['authMode'] === 'string' ? j['authMode'] : 'implicit';
        return {
          certificates: (cert.certificates as string[]).map(unb64),
          subject: typeof cert.subjectDN === 'string' ? cert.subjectDN : '',
          authMode,
          description: typeof j['description'] === 'string' ? j['description'] : null,
        };
      })
      .catch((e: unknown) => {
        // A failure is not kept: the next call asks again.
        this.#info = null;
        throw e;
      });
    return this.#info;
  }

  /** The signing certificate (DER), then its issuers, as the provider gives them. */
  async chain(): Promise<readonly Uint8Array[]> {
    return (await this.#credential()).certificates;
  }

  async publicKey(): Promise<Uint8Array> {
    const first = (await this.#credential()).certificates[0];
    if (first === undefined) throw new CscError('provider_invalid_response');
    return new Uint8Array(certificateOf(first).subjectPublicKeyInfo.toSchema().toBER());
  }

  async assertion(): Promise<ProviderAssertion> {
    const info = await this.#credential();
    return {
      provider: this.#o.provider,
      level: this.#o.level ?? info.description ?? 'not stated',
      signer: info.subject,
    };
  }

  async signDigest(algorithm: DigestAlgorithm, digest: Uint8Array): Promise<Uint8Array> {
    // Only a SHA-256 digest of 32 bytes is ever sent: `digestInfo` refuses anything else.
    const wanted = digestInfo(algorithm, digest);
    const info = await this.#credential();
    const hash = b64(digest);
    let sad: string | undefined;
    if (info.authMode === 'explicit') {
      const auth = await this.#post('credentials/authorize', {
        credentialID: this.#o.credentialId,
        numSignatures: 1,
        hash: [hash],
      });
      if (typeof auth['SAD'] !== 'string') throw new CscError('provider_invalid_response');
      sad = auth['SAD'];
    } else if (info.authMode !== 'implicit') {
      throw new CscError('auth_mode_unsupported');
    }
    const out = await this.#post('signatures/signHash', {
      credentialID: this.#o.credentialId,
      ...(sad !== undefined ? { SAD: sad } : {}),
      hash: [hash],
      hashAlgo: SHA256_OID,
      signAlgo: SHA256_WITH_RSA_OID,
    });
    const sigs = out['signatures'];
    if (!Array.isArray(sigs) || sigs.length !== 1 || typeof sigs[0] !== 'string')
      throw new CscError('provider_invalid_response');
    const signature = unb64(sigs[0]);
    // The signature must be the provider's signature over this digest, with the certificate's key.
    const first = info.certificates[0];
    try {
      const key = createPublicKey({
        key: Buffer.from(
          certificateOf(first as Uint8Array)
            .subjectPublicKeyInfo.toSchema()
            .toBER(),
        ),
        format: 'der',
        type: 'spki',
      });
      const opened = publicDecrypt(
        { key, padding: constants.RSA_PKCS1_PADDING },
        Buffer.from(signature),
      );
      if (!opened.equals(Buffer.from(wanted))) throw new Error('differs');
    } catch {
      throw new CscError('signature_invalid');
    }
    return signature;
  }
}

/** The certificate chains of CSC credentials, by key identifier, for the signing service. */
export function cscCertificates(keys: ReadonlyMap<string, CscKeyService>): CertificateSource {
  return {
    chainFor: async (keyId) => {
      const key = keys.get(keyId);
      if (key === undefined) throw new Error(`no provider credential for ${keyId}`);
      return key.chain();
    },
  };
}
