/**
 * SPK-021 criterion 3, by construction: no key, and no way to reach one, on the compile side
 * (12 §8.2 step 3). These checks read files only, so they run everywhere.
 *
 * - The export worker (the compile worker), the LaTeX converter and the house class do not import
 *   the signing service, do not name a key service, and contain no private key block.
 * - The signing service's own sources hold no private key block and do not import the export worker.
 * - The sealing code's only use of the key is the `KeyService` port, which has a public key and a
 *   call that takes a digest (checked in the port's type and in spk-021-seal.test.ts, where the
 *   recorded calls are 32 bytes each).
 *
 * The running evidence (the token reports the key as never extractable, the compile worker's image
 * holds nothing of a key service) is in spk-021-key-service.podman.test.ts.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'out' || e === '.git') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const isTest = (p: string): boolean =>
  /\.test\.ts$/.test(p) || /[\\/]test[\\/]/.test(relative(root, p).replace(/\\/g, '/'));

/** An actual PEM private key: the header followed by base64 lines, not a mention of the words. */
const PEM_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----\s+[A-Za-z0-9+/=]{16,}/;
const KEY_SERVICE_WORDS =
  /softhsm|pkcs11|pkcs#11|keyservice|signing-service|@docedit\/signing-service/i;

// The header is built from parts so that the secret scan of SEC-048 does not read this file as a key.
const PEM_HEADER = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ');

describe('SPK-021 criterion 3: the scan itself', () => {
  it('matches a private key block and a key service name, and not a mention of a key', () => {
    expect(PEM_KEY.test(`${PEM_HEADER}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC`)).toBe(true);
    expect(PEM_KEY.test(`the text ${PEM_HEADER} is a header`)).toBe(false);
    expect(KEY_SERVICE_WORDS.test('import x from "./softhsm.ts"')).toBe(true);
    expect(KEY_SERVICE_WORDS.test('compile a document')).toBe(false);
  });
});

describe('SPK-021 criterion 3: the compile side has no key and no way to a key', () => {
  const compileSide = [
    ...walk(join(root, 'services/export-worker')),
    ...walk(join(root, 'packages/export-latex')),
  ].filter((p) => /\.(ts|js|json|lua|tex|cls|sty|sh|md)$/.test(p) || /Containerfile/.test(p));

  it('finds the compile worker and the converter to scan', () => {
    expect(compileSide.length).toBeGreaterThan(50);
  });

  it('contains no private key block anywhere, tests included', () => {
    const hits = compileSide.filter((p) => PEM_KEY.test(readFileSync(p, 'latin1')));
    expect(hits.map((p) => relative(root, p))).toEqual([]);
  });

  it('names no key service and imports no signing code outside its tests', () => {
    const hits = compileSide
      .filter((p) => !isTest(p))
      .filter((p) => KEY_SERVICE_WORDS.test(readFileSync(p, 'latin1')));
    expect(hits.map((p) => relative(root, p))).toEqual([]);
  });

  it('has no dependency on the signing service in its package files', () => {
    for (const pkg of [
      'services/export-worker/package.json',
      'packages/export-latex/package.json',
    ]) {
      const j = JSON.parse(readFileSync(join(root, pkg), 'utf8')) as Record<string, unknown>;
      const deps = JSON.stringify({ d: j['dependencies'], e: j['devDependencies'] });
      expect(deps, pkg).not.toContain('signing-service');
    }
  });
});

describe('SPK-021 criterion 3: the signing service holds no key either', () => {
  const own = walk(join(root, 'services/signing-service')).filter(
    (p) => /\.(ts|json|sh|md)$/.test(p) || /Containerfile/.test(p),
  );

  it('has no private key block in any file', () => {
    expect(
      own.filter((p) => PEM_KEY.test(readFileSync(p, 'latin1'))).map((p) => relative(root, p)),
    ).toEqual([]);
  });

  it('does not import the export worker from its sources', () => {
    const hits = own
      .filter(
        (p) =>
          p.endsWith('.ts') &&
          relative(root, p).replace(/\\/g, '/').startsWith('services/signing-service/src/'),
      )
      .filter((p) => /export-worker|export-latex/.test(readFileSync(p, 'utf8')));
    expect(hits.map((p) => relative(root, p))).toEqual([]);
  });

  it('gives the sealing code a port with no way to ask for the key', () => {
    const src = readFileSync(join(root, 'services/signing-service/src/keyservice.ts'), 'utf8');
    const port = /export interface KeyService \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? '';
    const methods = [...port.matchAll(/^\s{2}(?:readonly )?(\w+)\(?/gm)].map((m) => m[1]);
    // `assertion` (FRW-059) reports the provider's own words, never a key.
    expect(methods).toEqual(['keyLabel', 'assertion', 'publicKey', 'signDigest']);
  });
});
