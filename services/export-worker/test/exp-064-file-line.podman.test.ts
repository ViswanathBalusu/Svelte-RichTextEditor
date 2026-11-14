// EXP-064 criterion 1 (lane U-EXP-049-064, round 7): the worker compiles with file and line error
// messages enabled. The engine call in image/compile.sh is `lualatex --file-line-error`; this test
// runs the real sandbox on a file that cannot compile and checks that the log holds an error in the
// `./main.tex:<line>: <message>` form that the parser of src/diagnostics.ts reads.
//
// Needs Podman and the worker image (DOCEDIT_EXPORT_IMAGE); skips, with the reason, otherwise
// (`sandboxReady`). The job is a plain `article`, which the image's TeX tree provides, so the
// undefined control sequence on line 4 is the only error.
import { describe, expect, it, vi } from 'vitest';
import { compileInSandbox } from '../src/sandbox.ts';
import { sandboxReady } from '../src/sandbox-ready.ts';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 240_000 });

const ready = await sandboxReady();

const SOURCE = [
  '\\documentclass{article}',
  '\\begin{document}',
  'A paragraph before the error.',
  '\\doceditundefinedcontrolsequence',
  '\\end{document}',
  '',
].join('\n');

describe.skipIf(!ready.ok)(`compile log with file and line errors (${ready.reason})`, () => {
  it('reports an undefined control sequence as ./main.tex:<line>: in the sandbox log (EXP-064 criterion 1)', async () => {
    const r = await compileInSandbox({ 'main.tex': SOURCE }, { minPasses: 1, maxPasses: 1 });
    expect(r.ok, 'a file with an undefined control sequence must not compile').toBe(false);
    expect(r.log).toMatch(/^\.\/main\.tex:4: Undefined control sequence\.$/m);
  });
});
