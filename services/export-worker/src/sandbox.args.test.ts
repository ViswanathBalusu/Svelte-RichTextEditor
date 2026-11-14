/**
 * The limits every job runs under, as the arguments the sandbox hands to Podman (EXP-071
 * criterion 1; 09 §9.3 item 4). These tests need no Podman: they check the command that a job's
 * container is started with. That the kernel enforces it is checked by the sandbox suite
 * (sandbox.escape.test.ts), which needs Podman and the image.
 */
import { describe, expect, it } from 'vitest';
import { LIMITS, sandboxArgs } from './sandbox.ts';

const MiB = 1024 * 1024;
const args = sandboxArgs('docedit-job-args-test');
const flag = (prefix: string): string | undefined => args.find((a) => a.startsWith(prefix));

describe('the limits of every job (EXP-071 criterion 1; 09 §9.3 item 4)', () => {
  it('has the values of 09 §9.3 item 4', () => {
    expect(LIMITS).toEqual({
      wallSeconds: 120,
      cpus: 1,
      memoryMiB: 1536,
      pids: 64,
      outputBytes: 200 * MiB,
      workMiB: 256,
      pages: 2000,
    });
  });

  it('gives every job 120 seconds of wall clock, one core and 1.5 GiB of memory with no swap', () => {
    expect(flag('--timeout=')).toBe('--timeout=120');
    expect(flag('--ulimit=cpu=')).toBe('--ulimit=cpu=120:120');
    expect(flag('--cpus=')).toBe('--cpus=1');
    expect(flag('--memory=')).toBe('--memory=1536m');
    expect(flag('--memory-swap=')).toBe('--memory-swap=1536m');
  });

  it('gives every job 200 MiB of output and a 256 MiB working directory', () => {
    expect(flag('--ulimit=fsize=')).toBe(`--ulimit=fsize=${200 * MiB}:${200 * MiB}`);
    const work = flag('--tmpfs=/work:');
    expect(work).toBeDefined();
    expect(work).toContain('size=256m');
    expect(work).toContain('noexec');
  });

  it('passes the page limit of 2,000 to the job and the pass time limit inside the wall clock', () => {
    expect(args).toContain('--env=DOCEDIT_MAX_PAGES=2000');
    expect(args).toContain('--env=DOCEDIT_PASS_TIMEOUT=110');
  });

  it('lets a caller lower a limit for a test, and keeps the others', () => {
    const lowered = sandboxArgs('docedit-job-args-test', { limits: { memoryMiB: 64 } });
    expect(lowered).toContain('--memory=64m');
    expect(lowered).toContain('--cpus=1');
    expect(lowered).toContain('--timeout=120');
  });
});

/**
 * The isolation every job starts with (EXP-070 criterion 1; 09 §9.3). Like the limits above, these
 * check the command only. That the running container has these properties is for the sandbox suite
 * (sandbox.escape.test.ts), which needs Podman and the image.
 */
describe('the isolation of every job (EXP-070 criterion 1; 09 §9.3)', () => {
  const name = 'docedit-job-isolation-test';
  const iso = sandboxArgs(name);

  it('runs in a single-use container: removed when it ends, named for this job', () => {
    expect(iso[0]).toBe('run');
    expect(iso).toContain('--rm');
    expect(iso).toContain(`--name=${name}`);
  });

  it('has no network', () => {
    expect(iso).toContain('--network=none');
  });

  it('has a read-only root file system, with no default tmpfs over /tmp, /var/tmp or /run', () => {
    expect(iso).toContain('--read-only');
    expect(iso).toContain('--read-only-tmpfs=false');
  });

  it('has one temporary working directory, mounted without exec, set-id or devices', () => {
    const work = iso.filter((a) => a.startsWith('--tmpfs=/work:'));
    expect(work).toHaveLength(1);
    const opts = work[0]!.slice('--tmpfs=/work:'.length).split(',');
    for (const opt of ['rw', 'noexec', 'nosuid', 'nodev']) expect(opts).toContain(opt);
  });

  it('drops every capability and adds none, and forbids new privileges', () => {
    expect(iso).toContain('--cap-drop=ALL');
    expect(iso.some((a) => a.startsWith('--cap-add'))).toBe(false);
    expect(iso).toContain('--security-opt=no-new-privileges');
    expect(iso).not.toContain('--privileged');
  });

  it('runs as a non-root user', () => {
    expect(iso).toContain('--user=10001:10001');
    expect(iso.some((a) => /^--user=(0|root)(:|$)/.test(a))).toBe(false);
  });

  it('mounts no host path into the container', () => {
    const mounts = iso.filter(
      (a) => a === '-v' || a === '--volume' || a.startsWith('--volume=') || a.startsWith('--mount'),
    );
    expect(mounts).toEqual([]);
  });
});
