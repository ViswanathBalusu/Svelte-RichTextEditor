/**
 * Size and time of one Word file through the importer and the writer: the canonical CDM with
 * shared trees, without sharing and without preservation, against I7's 16 MiB; the source map;
 * import and export times; R0; validate(). Used for files too large or not licensed for the
 * corpus (S11's `bug65649.docx`). The machine is printed with the figures.
 *
 * Run from the repository root: node packages/export-docx/scripts/measure-file.ts <file.docx>
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { canonicalText, utf8 } from '@docedit/model';
import { LIMITS, validate } from '@docedit/model/validate';
import { checkR0, exportDocx, importDocx } from '../src/index.ts';

const path = process.argv[2];
if (!path) throw new Error('usage: measure-file.ts <file.docx>');
const bytes = new Uint8Array(readFileSync(path));
const time = async <T>(f: () => Promise<T>): Promise<[T, number]> => {
  const t0 = performance.now();
  const r = await f();
  return [r, Math.round(performance.now() - t0)];
};
const [shared, importMs] = await time(() => importDocx(bytes, { validate: false }));
const [unshared] = await time(() => importDocx(bytes, { validate: false, share: false }));
const [bare] = await time(() => importDocx(bytes, { validate: false, preserve: false }));
const [out, exportMs] = await time(() =>
  exportDocx(shared.envelope, bytes, shared.sourceMap, shared.assets),
);
const [result, validateMs] = await time(async () =>
  validate(shared.envelope, { attachedAssets: shared.assets.ids() }),
);
const size = (e: typeof shared.envelope): number => utf8(canonicalText(e)).length;
const sharedBytes = size(shared.envelope);
const r0 = checkR0(bytes, out.bytes);
console.log(
  JSON.stringify(
    {
      file: path.split(/[\\/]/).pop(),
      bytes: bytes.length,
      machine: {
        cpu: os.cpus()[0]?.model ?? 'unknown',
        logicalCores: os.cpus().length,
        memoryGiB: Math.round(os.totalmem() / 2 ** 30),
        node: process.version,
        platform: `${os.platform()} ${os.release()}`,
      },
      canonicalBytes: {
        shared: sharedBytes,
        unshared: size(unshared.envelope),
        withoutPreservation: size(bare.envelope),
        limitI7: LIMITS.canonicalBytes,
        underI7: sharedBytes <= LIMITS.canonicalBytes,
      },
      shared: shared.stats.shared,
      sourceMapBytes: utf8(JSON.stringify(shared.sourceMap)).length,
      fragments: shared.assets.ofRole('fragment').length,
      smallAtoms: shared.stats.smallAtoms,
      importMs,
      exportMs,
      validateMs,
      valid: result.valid,
      violations: result.violations
        .slice(0, 5)
        .map((v) => `${v.invariant} ${v.code}: ${v.message}`),
      r0: r0.pass,
      r0Differences: r0.differences.slice(0, 5),
    },
    null,
    2,
  ),
);
