/**
 * SEC-035 criterion 5 (lane U-SEC-033-048): the environment of a running job holds no credential.
 *
 * The static search in image-secrets.test.ts reads the Containerfile and the image directory. This
 * file runs `env` and the key scan inside the real sandbox (Podman), so it checks what a job can
 * actually read. It needs Podman and the worker image, and skips otherwise (`sandboxReady`).
 */
import { describe, expect, it, vi } from 'vitest';
import { runInSandbox } from './sandbox.ts';
import { sandboxReady } from './sandbox-ready.ts';

// Each case starts a container.
vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

const ready = await sandboxReady();

// Names of variables that would carry a credential. DOCEDIT_ limits are not credentials and are not matched.
const SECRET_NAME =
  /(SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|SIGNING|PRIVATE|API_KEY|ACCESS_KEY|AWS_|DATABASE|DSN)/i;

// Values of the kinds key material and credentialed URLs come in.
const SECRET_VALUE: readonly RegExp[] = [
  /BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk_(?:live|test)_[0-9A-Za-z]{8,}/,
  /\bghp_[0-9A-Za-z]{20,}/,
  /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
];

/** The variables of an `env` listing: one `NAME=value` line each, values may span lines. */
function variables(out: string): Map<string, string> {
  const vars = new Map<string, string>();
  let name: string | null = null;
  for (const line of out.split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) {
      name = m[1]!;
      vars.set(name, m[2]!);
    } else if (name !== null) {
      vars.set(name, `${vars.get(name)}\n${line}`);
    }
  }
  return vars;
}

describe.skipIf(!ready.ok)(`SEC-035 sandbox environment (${ready.reason})`, () => {
  it('lists its environment and holds no credential-like variable', async () => {
    const r = await runInSandbox('exec 2>&1\nenv\necho env-done\n');
    const out = new TextDecoder().decode(r.stdout);
    expect(out).toContain('env-done');
    const vars = variables(out);
    expect(vars.size).toBeGreaterThan(0);
    expect([...vars.keys()].filter((n) => SECRET_NAME.test(n))).toEqual([]);
  });

  it('holds no variable whose value is key material or a URL with a password', async () => {
    const r = await runInSandbox('exec 2>&1\nenv\necho env-done\n');
    const out = new TextDecoder().decode(r.stdout);
    expect(out).toContain('env-done');
    for (const [name, value] of variables(out))
      for (const re of SECRET_VALUE)
        expect({ name, hit: re.test(value) }).toEqual({ name, hit: false });
  });
});
