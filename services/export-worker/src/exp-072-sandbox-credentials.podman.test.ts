/**
 * EXP-072 criteria 1 and 4 (lane w2, 2026-11-26; ADR 0045; owner decisions 196 to 220), in the real
 * sandbox. Needs Podman and the worker image; skips otherwise (`sandboxReady`).
 *
 * The design is ADR 0045's: the compile sandbox holds no credential at all, its outputs leave on
 * standard output, and the upload happens in the worker process after the sandbox has ended.
 * 09 §9.3 item 6 allows at most a write-only, per-job upload location; this design needs none.
 * So criterion 1 is read as: nothing a job can list is a credential. Criterion 4 is read as: when
 * a job ends, nothing of its sandbox is left to write to.
 */
import { describe, expect, it, vi } from 'vitest';
import { containerExists } from './container.ts';
import { runInSandbox } from './sandbox.ts';
import { sandboxReady } from './sandbox-ready.ts';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const ready = await sandboxReady();
const text = (b: Uint8Array): string => new TextDecoder().decode(b);

/** Kinds of key material, in the places a credential is kept on a Linux host. */
const KEY_MATERIAL = String.raw`BEGIN ([A-Z0-9]+ )*PRIVATE KEY|AKIA[0-9A-Z]{16}|sk_(live|test)_[0-9A-Za-z]{8,}|ghp_[0-9A-Za-z]{20,}|[a-z][a-z0-9+.-]*://[^[:space:]/:@]+:[^[:space:]/@]+@`;
const PLACES = '/etc /root /home /run /var /srv /opt/docedit /tmp /work /mnt /media';

/** The script lists what a job can reach: environment, mounts, key material, credential files, sockets. */
const LIST = [
  'exec 2>&1',
  'echo "[env]"; env | cut -d= -f1',
  'echo "[mounts]"; cut -d" " -f5,9 /proc/self/mountinfo',
  'echo "[key-material]"',
  `grep -rIlE '${KEY_MATERIAL}' ${PLACES} 2>/dev/null`,
  'echo "[credential-files]"',
  'ls -d /root/.aws /root/.ssh /root/.docker /root/.config /root/.netrc /root/.pgpass /home/*/.aws /home/*/.ssh /run/secrets/* /var/run/secrets/* 2>/dev/null',
  'find /etc/ssl/private -type f 2>/dev/null',
  'echo "[sockets]"',
  'find /run /var/run /tmp /work -type s 2>/dev/null',
  'echo "[done]"',
].join('\n');

/** The lines of one section of the listing. */
function section(out: string, name: string): string[] {
  const lines = out.split('\n');
  const from = lines.indexOf(`[${name}]`);
  if (from < 0) return ['<missing>'];
  const rest = lines.slice(from + 1);
  const end = rest.findIndex((l) => /^\[[a-z-]+\]$/.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).filter((l) => l.trim() !== '');
}

describe.skipIf(!ready.ok)(`EXP-072 the sandbox holds no credential (${ready.reason})`, () => {
  it('lists its environment, mounts and files and finds no credential (criterion 1)', async () => {
    const r = await runInSandbox(LIST);
    const out = text(r.stdout);
    expect(out).toContain('[done]');
    // The environment names no credential.
    const names = section(out, 'env');
    expect(names.length).toBeGreaterThan(0);
    expect(
      names.filter((n) =>
        /(SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|SIGNING|PRIVATE|KEY|AWS_|DATABASE|DSN)/i.test(n),
      ),
    ).toEqual([]);
    // No mount comes from the host: no bind of a host path, no socket, no secrets mount with files.
    const mounts = section(out, 'mounts').join('\n');
    expect(mounts).not.toMatch(/\/run\/podman|docker\.sock|\.sock\b/);
    // No file holds key material, no credential file of the usual names exists, no socket is open to reach.
    expect(section(out, 'key-material')).toEqual([]);
    expect(section(out, 'credential-files')).toEqual([]);
    expect(section(out, 'sockets')).toEqual([]);
  });

  it('would find a credential if one were there (positive control)', async () => {
    const r = await runInSandbox(
      `mkdir -p /work/probe && printf 'aws_access_key_id=AKIA0123456789ABCDEF\\n' > /work/probe/credentials\n${LIST}`,
    );
    const out = text(r.stdout);
    expect(out).toContain('[done]');
    expect(section(out, 'key-material')).toEqual(['/work/probe/credentials']);
  });

  it('leaves no container to write to once the job has ended, however it ended (criterion 4)', async () => {
    const ended: Array<[string, string, object]> = [
      ['normally', 'echo done\n', {}],
      ['with a failure', 'exit 3\n', {}],
      ['at its wall limit', 'sleep 60\n', { limits: { wallSeconds: 3 } }],
    ];
    for (const [how, script, opts] of ended) {
      const name = `docedit-test-w2-exp-072-${how.replace(/\W+/g, '-')}-${Date.now().toString(36)}`;
      await runInSandbox(script, { name, ...opts });
      // `--rm` removes the container when it ends; nothing of it is left to write to.
      let gone = false;
      for (let i = 0; i < 40 && !gone; i++) {
        gone = !(await containerExists(name));
        if (!gone) await new Promise((res) => setTimeout(res, 500));
      }
      expect(gone, `container ${how}`).toBe(true);
    }
  });
});
