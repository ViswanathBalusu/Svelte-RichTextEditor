/**
 * SEC-036 criterion 6 — a downloadable `tex` bundle carries the notice that it should be compiled
 * with the same restrictions as the export service (09 §9.3 item 7; EXP-085).
 *
 * The proof builds the real archive with `texArchive` from `packages/export-latex/src/archive.ts`,
 * reads the tar back with a small ustar reader written here, and checks the README it holds. The
 * notice is the sentence the README gives before its command; the restrictions it names are the
 * ones of 09 §9.3 (no shell escape, paranoid file access, an empty directory). Node.js only.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { texArchive } from '../../../packages/export-latex/src/archive.ts';
import type { Bundle } from '../../../packages/export-latex/src/bundle.ts';

const RUNS = Number(process.env['FUZZ_RUNS'] ?? 200);
const decoder = new TextDecoder();

/** The entries of a ustar archive: name and bytes, read from the 512-byte headers. */
function readTar(bytes: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  let at = 0;
  while (at + 512 <= bytes.length) {
    const header = bytes.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const name = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/s, '');
    const sizeText = decoder.decode(header.subarray(124, 136)).replace(/\0.*$/s, '').trim();
    const size = parseInt(sizeText, 8);
    out.set(name, bytes.subarray(at + 512, at + 512 + size));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** A minimal bundle, shaped as the converter returns it. */
function bundleWith(seq: number | null, chainHead: string | null): Bundle {
  return {
    files: { 'main.tex': '\\documentclass{docedit}\n', 'manifest.json': '{}' },
    assets: {},
    map: {} as Bundle['map'],
    manifest: {
      bundleVersion: 1,
      seq,
      chainHead,
      imageDigest: null,
      cdm: 1,
      classVersion: '1.0.0',
      fonts: [],
      options: {},
      redactions: [],
      files: {},
      bundleHash: 'a'.repeat(64),
    },
    diagnostics: [],
    ok: true,
  } as unknown as Bundle;
}

describe('SEC-036 criterion 6: the tex bundle carries the same-restrictions notice', () => {
  it('the archive holds a README with the notice and the three restrictions of 09 §9.3', () => {
    const entries = readTar(texArchive(bundleWith(7, 'b'.repeat(64))));
    const readme = entries.get('README.txt');
    expect(readme).toBeDefined();
    const text = decoder.decode(readme!);
    expect(text).toContain(
      'Compile it with the same restrictions the export service uses (09 §9.3):',
    );
    expect(text).toContain('no shell escape (shell_escape=f), no network, paranoid file access');
    expect(text).toContain('(openin_any=p, openout_any=p)');
    expect(text).toContain('--no-shell-escape');
  });

  it('the notice is present for every seq and chain head, including none', () => {
    fc.assert(
      fc.property(
        fc.option(fc.nat(), { nil: null }),
        fc.option(
          fc
            .array(fc.constantFrom(...'0123456789abcdef'.split('')), {
              minLength: 64,
              maxLength: 64,
            })
            .map((cs) => cs.join('')),
          { nil: null },
        ),
        (seq, head) => {
          const readme = decoder.decode(
            readTar(texArchive(bundleWith(seq, head))).get('README.txt')!,
          );
          expect(readme).toContain('same restrictions the export service uses');
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('the bundle files are in the archive beside the README, so the notice travels with them', () => {
    const entries = readTar(texArchive(bundleWith(1, null)));
    // EXP-085 adds the licence text and the licence list of the class files beside them.
    expect([...entries.keys()].sort()).toEqual([
      'LICENCE.txt',
      'README.txt',
      'licences.json',
      'main.tex',
      'manifest.json',
    ]);
  });
});
