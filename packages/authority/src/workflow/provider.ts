/**
 * A signature provider reached through an adapter (12 §8.3, §13 phase 4; ADR 0013; FRW-059), as pure
 * functions over the provider's answer.
 *
 * - Only the document hash leaves the platform. The request type has no other field, and a hash that
 *   is not lower-case SHA-256 hexadecimal is refused before the provider is called.
 * - The provider's signature is embedded in the PDF by `embed`, which the caller supplies. Nothing is
 *   sealed unless the embedding succeeds: a failed embed is a failed seal, never a half-signed file.
 * - The level and the signer identification the provider reports are returned as asserted facts
 *   (`assertedBy: 'provider'`). The platform does not verify them.
 * - A provider result without a time-stamp is treated as the time-stamp not obtained, so
 *   `finaliseWorkflow` refuses it as a seal without a time-stamp (FRW-053 criterion 5).
 *
 * Not built here: the network call (the adapter for the Cloud Signature Consortium API is the
 * deployment's), the recording of the asserted facts in the evidence tables, and the PDF embedding
 * itself. `SignatureProvider` is not in the port list of 05 §8.3; see ADR 0148.
 */
import type { SealResult } from './finalisation.ts';

/** The only data a provider receives: the document hash. */
export interface ProviderRequest {
  /** Lower-case hexadecimal SHA-256 of the document bytes to sign. */
  readonly documentHash: string;
}

export type ProviderFailure =
  'provider_unreachable' | 'provider_refused' | 'provider_invalid_response';

export type ProviderResult =
  | {
      readonly ok: true;
      /** The signature value the provider returns. */
      readonly signature: Uint8Array;
      /** The signature level the provider reports, in its own words. Asserted, not verified. */
      readonly assertedLevel: string;
      /** The signer identification the provider reports. Asserted, not verified. */
      readonly assertedSigner: string;
      /** Whether the provider's result carries an RFC 3161 time-stamp token. */
      readonly timestamped: boolean;
    }
  | { readonly ok: false; readonly reason: ProviderFailure };

export interface SignatureProvider {
  /** The provider's name, recorded as the source of the asserted facts. */
  readonly name: string;
  /** Signs the hash. A thrown error counts as the provider being unreachable. */
  sign(request: ProviderRequest): Promise<ProviderResult>;
}

/** The facts a provider asserts about a seal, recorded as asserted by that provider. */
export interface AssertedFacts {
  readonly assertedBy: 'provider';
  readonly provider: string;
  readonly signatureLevel: string;
  readonly signerIdentification: string;
}

export interface ProviderSealOutcome {
  /** The seal in the form `finaliseWorkflow` takes. */
  readonly seal: SealResult;
  /** The asserted facts, only when the seal succeeded; null otherwise. */
  readonly facts: AssertedFacts | null;
}

/**
 * Embeds the provider's signature in the PDF and returns the hash of the resulting sealed bytes. A
 * throw, or a hash that is not SHA-256 hexadecimal, is a failed seal.
 */
export type Embed = (signature: Uint8Array) => Promise<string>;

const HASH = /^[0-9a-f]{64}$/;

function refused(
  reason: 'tsa_unreachable' | 'signing_unavailable' | 'seal_failed',
): ProviderSealOutcome {
  return { seal: { ok: false, reason }, facts: null };
}

function mapFailure(reason: ProviderFailure): 'signing_unavailable' | 'seal_failed' {
  return reason === 'provider_invalid_response' ? 'seal_failed' : 'signing_unavailable';
}

/**
 * Seals a document through `provider`. The provider is called with the hash alone; a malformed hash
 * never leaves the platform.
 */
export async function sealWithProvider(
  provider: SignatureProvider,
  documentHash: string,
  embed: Embed,
): Promise<ProviderSealOutcome> {
  if (!HASH.test(documentHash)) return refused('seal_failed');
  let result: ProviderResult;
  try {
    result = await provider.sign({ documentHash });
  } catch {
    return refused('signing_unavailable');
  }
  if (!result.ok) return refused(mapFailure(result.reason));
  if (!result.timestamped) return refused('tsa_unreachable');
  let sealedHash: string;
  try {
    sealedHash = await embed(result.signature);
  } catch {
    return refused('seal_failed');
  }
  if (!HASH.test(sealedHash)) return refused('seal_failed');
  return {
    seal: { ok: true, timestamped: true, sealedHash },
    facts: {
      assertedBy: 'provider',
      provider: provider.name,
      signatureLevel: result.assertedLevel,
      signerIdentification: result.assertedSigner,
    },
  };
}

/**
 * The seal of a workflow with or without a provider. Without one, the native seal runs unchanged and
 * no provider is called; with one, the provider's seal is used.
 */
export async function sealWorkflow(options: {
  readonly provider: SignatureProvider | null;
  readonly documentHash: string;
  readonly native: () => Promise<SealResult>;
  readonly embed: Embed;
}): Promise<ProviderSealOutcome> {
  if (options.provider === null) return { seal: await options.native(), facts: null };
  return sealWithProvider(options.provider, options.documentHash, options.embed);
}
