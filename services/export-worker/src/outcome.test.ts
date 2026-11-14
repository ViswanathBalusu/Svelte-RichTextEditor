/**
 * Which limit a failed compile reached (EXP-071 criterion 2), from what the sandbox reports.
 */
import { describe, expect, it } from 'vitest';
import { parseLog } from './diagnostics.ts';
import { limitDiagnostic, limitMessage, limitReached } from './outcome.ts';
import { LIMITS, type CompileResult } from './sandbox.ts';

const base: CompileResult = {
  ok: false,
  exitCode: 1,
  timedOut: false,
  outputOverflow: false,
  cancelled: false,
  passes: [],
  converged: false,
  pdf: null,
  log: '',
  layoutRaw: null,
  stderr: '',
  wallMs: 1000,
  stdout: new Uint8Array(),
  name: 'docedit-job-test',
  limits: { ...LIMITS },
  passTimeoutSeconds: 110,
};
const r = (over: Partial<CompileResult>): CompileResult => ({ ...base, ...over });
const noLog = parseLog('', null);

describe('limits of a failed compile (EXP-071)', () => {
  it('tells a pass killed at its time limit from one killed by the memory limit', () => {
    expect(limitReached(r({ passes: [{ pass: 1, rc: 137, ms: 109_900 }] }), noLog)).toBe('time');
    expect(limitReached(r({ passes: [{ pass: 1, rc: 137, ms: 6_800 }] }), noLog)).toBe('memory');
  });

  it("recognises Podman's and the worker's time limits, and the output limit", () => {
    expect(limitReached(r({ exitCode: 255 }), noLog)).toBe('time');
    expect(limitReached(r({ timedOut: true, exitCode: null }), noLog)).toBe('time');
    expect(limitReached(r({ passes: [{ pass: 1, rc: 153, ms: 900 }] }), noLog)).toBe('output');
    expect(limitReached(r({ outputOverflow: true }), noLog)).toBe('output');
  });

  it('reads the page limit and a full working directory from the log', () => {
    const pages = parseLog('./main.tex:9: docedit: page limit exceeded (2000 pages).', null);
    expect(limitReached(r({ exitCode: 3 }), pages)).toBe('pages');
    const disk = parseLog("! I can't write on file `main.pdf'.\nNo space left on device", null);
    expect(limitReached(r({ exitCode: 1 }), disk)).toBe('workdir');
    // When the log itself could not be written, compile.sh's failed writes say so on stderr.
    const stderr = '/opt/docedit/compile.sh: 46: echo: echo: I/O error\n';
    expect(limitReached(r({ exitCode: 1, stderr }), noLog)).toBe('workdir');
    expect(limitReached(r({ exitCode: 1 }), noLog)).toBeNull();
  });

  it('names the limit and its value', () => {
    const t = r({ timedOut: true });
    expect(limitMessage('time', t)).toBe('the compile reached its limit of 120 s (limit_time)');
    expect(limitDiagnostic('memory', t)).toMatchObject({
      code: 'limit_memory',
      severity: 'error',
      message: expect.stringContaining('1536 MiB'),
    });
    expect(limitDiagnostic('pages', t).message).toContain('2000 pages');
    expect(limitDiagnostic('output', t).message).toContain('200 MiB');
    expect(limitDiagnostic('workdir', t).message).toContain('256 MiB');
  });
});
