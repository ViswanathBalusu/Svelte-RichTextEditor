/**
 * EXP-076 criteria 3 and 4 (lane U-EXP-065-080): a PDF holds no host name, path or random
 * identifier that differs between runs, and the same bundle compiled twice on this host gives the
 * same bytes. The compiles run in real single-use sandboxes of the worker image under Podman and
 * skip otherwise (`sandboxReady`). Criterion 2 (several hosts) is not covered here.
 */
import { describe, expect, it, vi } from 'vitest';
import { compileInSandbox } from './sandbox.ts';
import { sandboxReady } from './sandbox-ready.ts';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

const ready = await sandboxReady();

const FILES = {
  'main.tex':
    '\\documentclass{article}\n\\begin{document}\nEXP076 reproducibility probe.\n\\end{document}\n',
};

const EPOCH = 1_700_000_000;

/** The strings that would betray a host, a path or a job: none may appear in the PDF bytes. */
const FORBIDDEN = ['/work', '/home/', '/root/', '/tmp/', '/usr/', '/var/', '/etc/', 'E:\\', 'C:\\'];

describe.skipIf(!ready.ok)(`EXP-076 PDF content (${ready.reason})`, () => {
  it('compiles the same bundle twice on this host to byte-identical PDFs', async () => {
    const a = await compileInSandbox(FILES, {
      minPasses: 1,
      maxPasses: 2,
      sourceDateEpoch: EPOCH,
      name: `docedit-u-exp-065-080-pdfa-${Date.now().toString(36)}`,
    });
    const b = await compileInSandbox(FILES, {
      minPasses: 1,
      maxPasses: 2,
      sourceDateEpoch: EPOCH,
      name: `docedit-u-exp-065-080-pdfb-${Date.now().toString(36)}`,
    });
    expect(a.ok, a.log.slice(0, 400)).toBe(true);
    expect(b.ok, b.log.slice(0, 400)).toBe(true);
    expect(a.pdf).not.toBeNull();
    expect(Buffer.from(a.pdf!).equals(Buffer.from(b.pdf!))).toBe(true);
  });

  it('holds no host name, path, job name or container name', async () => {
    const name = `docedit-u-exp-065-080-pdfc-${Date.now().toString(36)}`;
    const r = await compileInSandbox(FILES, {
      minPasses: 1,
      maxPasses: 2,
      sourceDateEpoch: EPOCH,
      name,
    });
    expect(r.ok, r.log.slice(0, 400)).toBe(true);
    const text = Buffer.from(r.pdf!).toString('latin1');
    for (const s of [...FORBIDDEN, name, 'sandbox', 'docedit']) {
      expect(text.includes(s), `PDF contains ${JSON.stringify(s)}`).toBe(false);
    }
  });
});
