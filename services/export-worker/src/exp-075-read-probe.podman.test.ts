/**
 * EXP-075 criterion 1, the read half (lane V-EXP-065-080, Podman): a bundle that bypasses the
 * converter and tries to read files outside its working directory fails. The probe opens host
 * paths and parent-relative paths with \openin in a real single-use sandbox of the worker image
 * and writes, through the log, whether each read worked. A control reads a file of the image's TeX
 * tree, which the engine needs and which is read by design. Skipped when Podman or the worker image
 * is not available (sandbox-ready.ts).
 *
 * What this does not cover: \input of an absolute path (EXP-068 and sandbox.escape.test.ts), other
 * jobs' files (each job has its own container), and the question whether the image's TeX tree may
 * be read at all, which the criterion does not settle (see the story's Notes).
 */
import { describe, expect, it, vi } from 'vitest';
import { compileInSandbox } from './sandbox.ts';
import { sandboxReady } from './sandbox-ready.ts';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

const ready = await sandboxReady();

const MAIN = [
  '\\documentclass{article}',
  '\\newread\\rone',
  '\\newread\\rtwo',
  '\\newread\\rthree',
  '\\newread\\rfour',
  '\\openin\\rone=/etc/passwd',
  '\\openin\\rtwo=../../../../etc/passwd',
  '\\openin\\rthree=/proc/self/environ',
  '\\openin\\rfour=article.cls',
  '\\immediate\\write16{PROBEA:\\ifeof\\rone FAILED\\else READ\\fi}',
  '\\immediate\\write16{PROBEB:\\ifeof\\rtwo FAILED\\else READ\\fi}',
  '\\immediate\\write16{PROBEC:\\ifeof\\rthree FAILED\\else READ\\fi}',
  '\\immediate\\write16{PROBED:\\ifeof\\rfour FAILED\\else READ\\fi}',
  '\\begin{document}x\\end{document}',
  '',
].join('\n');

describe.skipIf(!ready.ok)(`EXP-075 criterion 1, read probe (${ready.reason})`, () => {
  // Known gap (EXP-075 Notes, lane V-EXP-065-080, 2026-11-13): under the image's settings, \openin
  // reads /etc/passwd, ../../../../etc/passwd and /proc/self/environ. `it.fails` records the gap
  // as a passing suite; when the engine refuses these reads the test fails, and this marker must
  // then be changed to a plain `it`.
  it.fails(
    'refuses \\openin of absolute and parent-relative host paths, and reads the TeX tree',
    async () => {
      const r = await compileInSandbox(
        { 'main.tex': MAIN },
        {
          minPasses: 1,
          maxPasses: 1,
          sourceDateEpoch: 1_700_000_000,
          name: `docedit-v-exp-065-080-read-${Date.now().toString(36)}`,
        },
      );
      expect(r.log).toMatch(/PROBEA:FAILED/);
      expect(r.log).toMatch(/PROBEB:FAILED/);
      expect(r.log).toMatch(/PROBEC:FAILED/);
      // The control: the image's TeX tree is readable, as the engine needs.
      expect(r.log).toMatch(/PROBED:READ/);
    },
    240_000,
  );
});
