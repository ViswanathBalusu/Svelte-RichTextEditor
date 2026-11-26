/**
 * EXP-075 criterion 1, the read half (lane V-EXP-065-080, Podman; reworded by owner decision 213
 * and ADR 0368 to "outside the sandbox"). The probe opens absolute and parent-relative paths
 * with \openin in a real single-use sandbox of the worker image
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
  // ADR 0368, owner decision 213 (2026-11-18): outside the working directory is read as outside
  // the single-use sandbox. The files of the read-only image (the TeX tree, /etc, /proc of the
  // container) are readable by design; the host, other jobs and every secret are not (the other
  // tests of sandbox.escape.test.ts and sec-035-sandbox-env.test.ts). This probe records what the
  // engine's \openin reaches and checks the control: the TeX tree is readable, as the engine needs.
  it('reads the files of the image by design, and the engine still compiles', async () => {
    const r = await compileInSandbox(
      { 'main.tex': MAIN },
      {
        minPasses: 1,
        maxPasses: 1,
        sourceDateEpoch: 1_700_000_000,
        name: `docedit-v-exp-065-080-read-${Date.now().toString(36)}`,
      },
    );
    // The control: the image's TeX tree is readable, as the engine needs.
    expect(r.log).toMatch(/PROBED:READ/);
    // The record: what the image exposes to a read (container files, not host files).
    const seen = [...r.log.matchAll(/PROBE([ABC]):(READ|FAILED)/g)].map((m) => `${m[1]}=${m[2]}`);
    console.log(
      'read probe of image files (A /etc/passwd, B parent-relative, C /proc/self/environ):',
      seen.join(' '),
    );
    expect(seen).toHaveLength(3);
  }, 240_000);
});
