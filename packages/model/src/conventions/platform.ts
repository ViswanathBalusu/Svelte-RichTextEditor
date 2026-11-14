/**
 * The few platform APIs the universal packages may use. They exist in every supported browser,
 * in Node.js 22 and in Web Workers (the WinterTC minimum common API), so using them does not tie
 * `model` or `authority` to one runtime (01 §6; FND-004). The package's TypeScript lib is ES2023
 * only, so these minimal declarations are the whole surface the code can reach.
 */

interface UniversalSubtleCrypto {
  digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer>;
}

interface UniversalCrypto {
  getRandomValues<T extends Uint8Array>(array: T): T;
  readonly subtle: UniversalSubtleCrypto;
}

interface UniversalTextEncoder {
  encode(input: string): Uint8Array;
}

interface UniversalGlobals {
  readonly crypto: UniversalCrypto;
  readonly TextEncoder: new () => UniversalTextEncoder;
}

const g = globalThis as unknown as UniversalGlobals;

/** Cryptographically strong random bytes from the platform (WebCrypto). */
export function randomBytes(length: number): Uint8Array {
  return g.crypto.getRandomValues(new Uint8Array(length));
}

/** SHA-256 with the platform's native implementation (FND-005: "SHA-256 uses the platform's native implementation on both sides"). */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await g.crypto.subtle.digest('SHA-256', data));
}

let encoder: UniversalTextEncoder | undefined;

/** UTF-8 encoding of a string. */
export function utf8(input: string): Uint8Array {
  encoder ??= new g.TextEncoder();
  return encoder.encode(input);
}
