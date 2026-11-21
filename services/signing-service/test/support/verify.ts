/**
 * An independent check of a sealed PDF (spike S8): the signatures and time-stamps are verified by
 * the OpenSSL command line (`openssl cms -verify`, `openssl ts -verify`), not by the code that
 * made them. The only thing read with this repository's own code is where the signature bytes are
 * (the `/ByteRange` and `/Contents` of each signature dictionary, found by text search) and the
 * time-stamp token inside the CMS, which `pkijs` extracts so that OpenSSL can check it.
 *
 * What it checks: the CMS signature and its certificate chain to the test root, the message digest
 * over the byte ranges, and, for each time-stamp token, the signature of the authority, the chain
 * and the imprint (the signature value for a signature time-stamp, the byte ranges for a document
 * time-stamp). What it does not check: revocation, policy, or anything Acrobat checks that
 * OpenSSL does not.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import type { TestPki } from './pki.ts';

const OPENSSL = process.env['DOCEDIT_OPENSSL'] ?? 'openssl';

export interface FoundSignature {
  kind: 'signature' | 'document-time-stamp';
  subFilter: string;
  byteRange: [number, number, number, number];
  /** The DER bytes (padding removed). */
  contents: Uint8Array;
  /** The bytes the signature covers. */
  signed: Uint8Array;
  /** The signature covers the file up to its last byte. */
  coversWholeFile: boolean;
}

export function findSignatures(pdf: Uint8Array): FoundSignature[] {
  const text = Buffer.from(pdf).toString('latin1');
  const found: FoundSignature[] = [];
  for (const m of text.matchAll(/\/ByteRange \[(\d+) (\d+) (\d+) (\d+)\]/g)) {
    const r = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as [
      number,
      number,
      number,
      number,
    ];
    const before = text.slice(Math.max(0, m.index - 200), m.index);
    const sub = /\/SubFilter \/([A-Za-z0-9.]+)/.exec(before.slice(before.lastIndexOf('/Type')));
    const hex = text.slice(r[1] + 1, r[2] - 1);
    const all = Buffer.from(hex, 'hex');
    const l = all[1] as number;
    const head = l < 0x80 ? 2 : 2 + (l & 0x7f);
    let len = l;
    if (l >= 0x80) {
      len = 0;
      for (let i = 0; i < (l & 0x7f); i++) len = len * 256 + (all[2 + i] as number);
    }
    const signed = Buffer.concat([
      Buffer.from(pdf.subarray(r[0], r[0] + r[1])),
      Buffer.from(pdf.subarray(r[2], r[2] + r[3])),
    ]);
    found.push({
      kind: sub?.[1] === 'ETSI.RFC3161' ? 'document-time-stamp' : 'signature',
      subFilter: sub?.[1] ?? '',
      byteRange: r,
      contents: new Uint8Array(all.subarray(0, head + len)),
      signed: new Uint8Array(signed),
      coversWholeFile: r[2] + r[3] === pdf.length,
    });
  }
  return found;
}

export interface Check {
  ok: boolean;
  /** OpenSSL's own words, on failure. */
  detail: string;
}

export interface SignatureReport {
  signature: FoundSignature;
  /** `openssl cms -verify`, or `openssl ts -verify` for a document time-stamp. */
  main: Check;
  /** `openssl ts -verify` on the signature time-stamp token, for a signature. */
  timestamp: Check | null;
}

function run(dir: string, args: string[]): Check {
  const r = spawnSync(OPENSSL, args, {
    cwd: dir,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
  });
  return {
    ok: !r.error && r.status === 0,
    detail: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}`.trim(),
  };
}

/** The signature value and the signature time-stamp token (DER) of a CMS, if it has one. */
export function cmsParts(cms: Uint8Array): {
  signatureValue: Uint8Array;
  token: Uint8Array | null;
} {
  const ab = cms.buffer.slice(cms.byteOffset, cms.byteOffset + cms.byteLength) as ArrayBuffer;
  const ci = new pkijs.ContentInfo({ schema: asn1js.fromBER(ab).result });
  const sd = new pkijs.SignedData({ schema: ci.content });
  const si = sd.signerInfos[0];
  if (!si) throw new Error('no signer');
  const tsAttr = si.unsignedAttrs?.attributes.find((a) => a.type === '1.2.840.113549.1.9.16.2.14');
  return {
    signatureValue: new Uint8Array(si.signature.valueBlock.valueHexView),
    token: tsAttr?.values[0] ? new Uint8Array(tsAttr.values[0].toBER()) : null,
  };
}

/**
 * A detached CMS over `content` (FRW-054 criterion 3: the signed chain head), checked by the
 * OpenSSL command line as the signatures of a PDF are: the signature and its chain to the test
 * root, the message digest over `content`, and the signature time-stamp token over the signature
 * value.
 */
export function verifyDetached(
  cms: Uint8Array,
  content: Uint8Array,
  pki: TestPki,
): { main: Check; timestamp: Check | null } {
  const dir = mkdtempSync(join(tmpdir(), 'docedit-frw054-verify-'));
  try {
    writeFileSync(join(dir, 'inter.der'), pki.intermediate);
    run(dir, ['x509', '-inform', 'DER', '-in', 'inter.der', '-out', 'inter.pem']);
    writeFileSync(join(dir, 'content.bin'), content);
    writeFileSync(join(dir, 'cms.der'), cms);
    const main = run(dir, [
      'cms',
      '-verify',
      '-inform',
      'DER',
      '-in',
      'cms.der',
      '-content',
      'content.bin',
      '-binary',
      '-CAfile',
      pki.rootPem,
      '-purpose',
      'any',
      '-out',
      'out.bin',
    ]);
    const parts = cmsParts(cms);
    let timestamp: Check | null = null;
    if (parts.token) {
      writeFileSync(join(dir, 'sigvalue.bin'), parts.signatureValue);
      writeFileSync(join(dir, 'token.der'), parts.token);
      timestamp = run(dir, [
        'ts',
        '-verify',
        '-data',
        'sigvalue.bin',
        '-in',
        'token.der',
        '-token_in',
        '-CAfile',
        pki.rootPem,
        '-untrusted',
        'inter.pem',
      ]);
    }
    return { main, timestamp };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function verifyWithOpenssl(pdf: Uint8Array, pki: TestPki): SignatureReport[] {
  const dir = mkdtempSync(join(tmpdir(), 'docedit-spk021-verify-'));
  try {
    writeFileSync(join(dir, 'inter.der'), pki.intermediate);
    run(dir, ['x509', '-inform', 'DER', '-in', 'inter.der', '-out', 'inter.pem']);
    return findSignatures(pdf).map((s, i) => {
      writeFileSync(join(dir, `signed${i}.bin`), s.signed);
      writeFileSync(join(dir, `contents${i}.der`), s.contents);
      if (s.kind === 'document-time-stamp') {
        return {
          signature: s,
          main: run(dir, [
            'ts',
            '-verify',
            '-data',
            `signed${i}.bin`,
            '-in',
            `contents${i}.der`,
            '-token_in',
            '-CAfile',
            pki.rootPem,
            '-untrusted',
            'inter.pem',
          ]),
          timestamp: null,
        };
      }
      const main = run(dir, [
        'cms',
        '-verify',
        '-inform',
        'DER',
        '-in',
        `contents${i}.der`,
        '-content',
        `signed${i}.bin`,
        '-binary',
        '-CAfile',
        pki.rootPem,
        '-purpose',
        'any',
        '-out',
        `out${i}.bin`,
      ]);
      const parts = cmsParts(s.contents);
      let timestamp: Check | null = null;
      if (parts.token) {
        writeFileSync(join(dir, `sigvalue${i}.bin`), parts.signatureValue);
        writeFileSync(join(dir, `token${i}.der`), parts.token);
        timestamp = run(dir, [
          'ts',
          '-verify',
          '-data',
          `sigvalue${i}.bin`,
          '-in',
          `token${i}.der`,
          '-token_in',
          '-CAfile',
          pki.rootPem,
          '-untrusted',
          'inter.pem',
        ]);
      }
      return { signature: s, main, timestamp };
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
