/**
 * The `/run/secrets` verdict of the sandbox readiness check (EXP-072; lane U-EXP-113-123, round 3
 * fix). The two mountinfo lines are from runs on this host (Windows 11, Podman 6, WSL machine
 * `podman-machine-default`, machine route), 2026-11-13: the job's own arguments with
 * `--tmpfs=/run/secrets:ro`, and a control with that tmpfs and the empty default mounts file removed.
 */
import { describe, expect, it } from 'vitest';
import { parseMountLine, secretsVerdict } from './secrets-probe.ts';

const OWN_TMPFS = '819 814 0:113 / /run/secrets ro,nosuid,nodev,relatime - tmpfs tmpfs rw';
const DEFAULT_MOUNT =
  '823 814 0:63 /containers/storage/overlay-containers/1b81afbea6975f07f49501a12f8125e04db7229cd2c1db2de723076d538d8fb8/userdata/run/secrets /run/secrets ro,nosuid,nodev,noexec - tmpfs none rw,mode=755';

const out = (...lines: string[]): string => [...lines, 'sandbox-ok', ''].join('\n');

describe('secrets-probe: the /run/secrets verdict (EXP-072)', () => {
  it('accepts a sandbox without /run/secrets', () => {
    expect(secretsVerdict(out('secrets=absent'))).toBe('ok');
  });

  it("accepts only the job's own empty read-only tmpfs", () => {
    expect(secretsVerdict(out('secrets=present', `mount=${OWN_TMPFS}`))).toBe('ok');
  });

  it("refuses Podman's default mount, with its files", () => {
    expect(
      secretsVerdict(out('secrets=present', 'entry=/run/secrets/rhsm', `mount=${DEFAULT_MOUNT}`)),
    ).toBe('host-mounts');
  });

  it("refuses Podman's default mount even when the copied directory is empty", () => {
    expect(secretsVerdict(out('secrets=present', `mount=${DEFAULT_MOUNT}`))).toBe('host-mounts');
  });

  it('refuses an entry in the own tmpfs, a second mount below it, or a writable tmpfs', () => {
    expect(
      secretsVerdict(out('secrets=present', 'entry=/run/secrets/key', `mount=${OWN_TMPFS}`)),
    ).toBe('host-mounts');
    expect(
      secretsVerdict(
        out(
          'secrets=present',
          `mount=${OWN_TMPFS}`,
          'mount=820 819 0:64 /x /run/secrets/rhsm ro - tmpfs none rw',
        ),
      ),
    ).toBe('host-mounts');
    expect(
      secretsVerdict(out('secrets=present', `mount=${OWN_TMPFS.replace(' ro,', ' rw,')}`)),
    ).toBe('host-mounts');
  });

  it('refuses a plain directory of the image and a separate /var/run/secrets', () => {
    expect(secretsVerdict(out('secrets=present'))).toBe('host-mounts');
    expect(secretsVerdict(out('secrets=absent', 'var-secrets=present'))).toBe('host-mounts');
    expect(
      secretsVerdict(
        out(
          'secrets=absent',
          `mount=${DEFAULT_MOUNT.replace(' /run/secrets ', ' /var/run/secrets ')}`,
        ),
      ),
    ).toBe('host-mounts');
  });

  it('reports no answer when the probe did not finish or is ambiguous', () => {
    expect(secretsVerdict('secrets=absent\n')).toBe('no-answer');
    expect(secretsVerdict(out())).toBe('no-answer');
    expect(secretsVerdict(out('secrets=absent', 'secrets=present'))).toBe('no-answer');
  });

  it('parses a mountinfo line into root, mount point, options, type and source', () => {
    expect(parseMountLine(DEFAULT_MOUNT)).toMatchObject({
      mountPoint: '/run/secrets',
      fsType: 'tmpfs',
      source: 'none',
    });
    expect(parseMountLine(OWN_TMPFS)).toMatchObject({
      root: '/',
      options: ['ro', 'nosuid', 'nodev', 'relatime'],
    });
    expect(parseMountLine('garbage')).toBeNull();
  });
});
