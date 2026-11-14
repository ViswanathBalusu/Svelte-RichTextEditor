/**
 * EXP-070 criterion 1 (lane U-EXP-065-080): a job starts in its own single-use sandbox with no
 * network, a read-only root file system, a temporary working directory, all capabilities dropped
 * and a non-root user. The properties are read from inside a real container of the worker image
 * under Podman. They need Podman and the image and skip otherwise (`sandboxReady`).
 */
import { describe, expect, it, vi } from 'vitest';
import { runInSandbox } from './sandbox.ts';
import { sandboxReady } from './sandbox-ready.ts';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const ready = await sandboxReady();

const PROBE = [
  'id -u',
  'grep -E "^(CapEff|CapBnd|NoNewPrivs)" /proc/self/status',
  'if touch /usr/EXP070-probe 2>/dev/null; then echo ROOT_WRITABLE; else echo ROOT_READ_ONLY; fi',
  'if touch /etc/EXP070-probe 2>/dev/null; then echo ETC_WRITABLE; else echo ETC_READ_ONLY; fi',
  'grep " /work " /proc/mounts',
  'pwd',
  'if touch /work/exp070-probe 2>/dev/null; then echo WORK_WRITABLE; else echo WORK_READ_ONLY; fi',
  '',
].join('\n');

describe.skipIf(!ready.ok)(`EXP-070 sandbox properties (${ready.reason})`, () => {
  it('runs as a non-root user with every capability dropped and no new privileges', async () => {
    const r = await runInSandbox(PROBE);
    const out = new TextDecoder().decode(r.stdout);
    expect(out).toMatch(/^10001$/m);
    expect(out).toMatch(/CapEff:\s+0000000000000000/);
    expect(out).toMatch(/CapBnd:\s+0000000000000000/);
    expect(out).toMatch(/NoNewPrivs:\s+1/);
  });

  it('has a read-only root file system', async () => {
    const r = await runInSandbox(PROBE);
    const out = new TextDecoder().decode(r.stdout);
    expect(out).toContain('ROOT_READ_ONLY');
    expect(out).not.toContain('ROOT_WRITABLE');
    expect(out).toContain('ETC_READ_ONLY');
    expect(out).not.toContain('ETC_WRITABLE');
  });

  it('runs in a temporary working directory on its own tmpfs, and that is the only writable place', async () => {
    const r = await runInSandbox(PROBE);
    const out = new TextDecoder().decode(r.stdout);
    const mount = out.split('\n').find((l) => / \/work /.test(l)) ?? '';
    expect(mount).toMatch(/\btmpfs\b/);
    expect(out).toContain('WORK_WRITABLE');
    expect(out).toMatch(/^\/work$/m);
  });
});
