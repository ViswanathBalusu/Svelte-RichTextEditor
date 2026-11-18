/**
 * EXP-114 criterion 2: an export of a reference's input, compiled again in the export worker's
 * sandbox (Podman), is compared with the stored reference PDF by the positions of its text and by
 * rendered pixels, with the tolerances of `services/export-worker/src/exp-114-reference-compare.ts`;
 * the comparison says what differs. Node.js only. It skips, with the reason in the title, when
 * sandboxed compiles or poppler's `pdftotext` and `pdftoppm` are not available here.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { pdftotextCli } from '../../../services/export-worker/src/exp-078-pdftotext.ts';
import {
  compareWithReference,
  pdftoppmCli,
} from '../../../services/export-worker/src/exp-114-reference-compare.ts';
import { sandboxReady } from '../test/harness.ts';
import { compileReference, refDir, references } from '../test/references.ts';

const sandbox = await sandboxReady();
const poppler = [pdftotextCli(), pdftoppmCli()].find(
  (cli) => spawnSync(cli, ['-v'], { windowsHide: true, timeout: 20_000 }).error,
);
const absent = !sandbox.ok
  ? `sandboxed compiles cannot run here: ${sandbox.reason}`
  : poppler
    ? `${poppler} is not installed`
    : null;

// The references that compile in a few minutes. `exp-114-corpus-pages-20-*` has 22 pages and is
// left to the manual run of `scripts/exp-114-make-references.ts`.
const QUICK = [
  'exp-114-sample-ua2-a4f.pdf',
  'exp-114-suggestions-markup.pdf',
  'exp-114-corpus-pages-1-ua2-a4f.pdf',
];

describe.skipIf(absent !== null)(
  `EXP-114 criterion 2: an export is compared with its stored reference${absent ? ` (skipped: ${absent})` : ''}`,
  () => {
    for (const ref of references.filter((r) => QUICK.includes(r.file))) {
      it(`${ref.file}: the text positions and the pixels are inside the tolerances`, async () => {
        const c = await compileReference(ref);
        expect(c.compile.ok, c.compile.log.slice(-800)).toBe(true);
        const stored = new Uint8Array(readFileSync(refDir + ref.file));
        const cmp = await compareWithReference(ref.file, c.compile.pdf!, stored);
        // The report names every difference; an empty one means there is none.
        expect(cmp.report).toBe('');
        expect(cmp.differs).toBe(false);
        expect(cmp.text.pageCount.ref).toBe(cmp.text.pageCount.cand);
        expect(cmp.pixels.pages.every((p) => p.pixels === 0)).toBe(true);
      }, 600_000);
    }
  },
);
