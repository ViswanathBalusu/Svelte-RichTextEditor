/**
 * SPK-021: a second independent verifier, pyHanko (MIT, Python), on a file sealed here. It is not a
 * dependency of the repository, so the test runs only when DOCEDIT_PYHANKO_PYTHON names a Python
 * interpreter that has `pyhanko` and `pyhanko-certvalidator` installed, for example
 *
 *   python -m venv <folder>; <folder>/Scripts/python -m pip install pyhanko pyhanko-certvalidator
 *
 * pyHanko checks what OpenSSL does not: the PDF structure of the signature, the validation data in
 * the document security store (the CRLs here), and what later updates may change (the modification
 * level). On 2026-11-18 it was run with pyHanko 0.38.1 and pyhanko-certvalidator 0.33.0.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDocumentTimestamp, sealPdf } from '../src/pades.ts';
import { classicPdf } from './support/classic-pdf.ts';
import { makePki, opensslAvailable, type TestPki } from './support/pki.ts';
import { startTestTsa, type TestTsa } from './support/tsa.ts';
import { flipByte, InProcessKeyService, sealOptions } from './support/world.ts';

const python = process.env['DOCEDIT_PYHANKO_PYTHON'];
const script = fileURLToPath(new URL('./support/pyhanko-validate.py', import.meta.url));

interface Row {
  type: string;
  intact: boolean;
  valid: boolean;
  trusted: boolean;
  coverage: string;
  modification_level: string;
}

function validate(pki: TestPki, pdf: Uint8Array, profile: string, work: string): Row[] {
  const file = join(work, `${profile}-${pdf.length}-${pdf[40]}.pdf`);
  writeFileSync(file, pdf);
  const r = spawnSync(python as string, ['-I', script, pki.dir, file, profile], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Row);
}

describe.skipIf(!python || !opensslAvailable())('SPK-021: pyHanko as a second verifier', () => {
  let pki: TestPki;
  let tsa: TestTsa;
  let work: string;
  let b_lt: Uint8Array;
  let b_lta: Uint8Array;

  beforeAll(async () => {
    const ks = new InProcessKeyService();
    pki = makePki(await ks.publicKey());
    tsa = await startTestTsa(pki);
    work = mkdtempSync(join(tmpdir(), 'docedit-spk021-pyhanko-'));
    const opts = sealOptions(pki, tsa, ks, 'B-LT');
    b_lt = (await sealPdf(classicPdf(), opts)).pdf;
    b_lta = await addDocumentTimestamp(b_lt, { timestamps: opts.timestamps });
  }, 300_000);

  afterAll(async () => {
    await tsa?.stop();
    pki?.remove();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it('accepts the B-LT file: intact, valid, trusted, the DSS an allowed update', () => {
    const rows = validate(pki, b_lt, 'B-LT', work);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ intact: true, valid: true, trusted: true });
    expect(rows[0]!.modification_level).toContain('LTA_UPDATES');
  });

  it('accepts the B-LTA file, signature and document time-stamp', () => {
    const rows = validate(pki, b_lta, 'B-LTA', work);
    expect(rows.map((r) => r.type)).toEqual(['/Sig', '/DocTimeStamp']);
    for (const r of rows) expect(r).toMatchObject({ intact: true, valid: true, trusted: true });
  });

  it('reports one changed byte', () => {
    const bad = validate(
      pki,
      flipByte(b_lt, Buffer.from(b_lt).indexOf('Classic table') + 2),
      'B-LT',
      work,
    );
    expect(bad[0]!.intact === false || bad[0]!.valid === false).toBe(true);
  });
});
