/**
 * The worker holds no signing key and no credential (EXP-072 criterion 3; 09 §9.3 item 6; 10 §3.6).
 * This is a static search of what the worker is built and started from: the Containerfile, the
 * image directory, the image's environment and the arguments of every job's container. It finds
 * the key material it knows how to recognise; it does not prove that none is present.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sandboxArgs } from './sandbox.ts';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const imageDir = fileURLToPath(new URL('../image/', import.meta.url));
const imageFiles = readdirSync(imageDir).map((f) => ({
  name: `image/${f}`,
  text: read(`../image/${f}`),
}));
const sources = [{ name: 'Containerfile', text: read('../Containerfile') }, ...imageFiles];

// Key material of the kinds a signing or cloud key comes in.
const KEY_MATERIAL: readonly RegExp[] = [
  /BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY/,
  /BEGIN OPENSSH PRIVATE KEY/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk_(?:live|test)_[0-9A-Za-z]{8,}/,
  /\bghp_[0-9A-Za-z]{20,}/,
];

// Names of environment variables that would carry a credential.
const SECRET_NAME =
  /(SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|SIGNING|PRIVATE_KEY|API_KEY|ACCESS_KEY)/i;

describe('the worker image and its configuration hold no signing key (EXP-072 criterion 3)', () => {
  it('searches the Containerfile and every file of the image directory', () => {
    expect(imageFiles.length).toBeGreaterThanOrEqual(3);
    expect(sources.map((s) => s.name)).toContain('Containerfile');
  });

  it('finds no key material in the Containerfile or the image directory', () => {
    for (const s of sources)
      for (const re of KEY_MATERIAL)
        expect({ file: s.name, hit: re.test(s.text) }).toEqual({ file: s.name, hit: false });
  });

  it('names no credential-like variable in the image environment', () => {
    const envNames = [...containerfileEnvNames(sources[0]!.text)];
    expect(envNames.length).toBeGreaterThan(0);
    expect(envNames.filter((n) => SECRET_NAME.test(n))).toEqual([]);
  });

  it('gives the job container no credential-like variable, mount or secret', () => {
    const args = sandboxArgs('docedit-secrets-test');
    const envNames = args
      .filter((a) => a.startsWith('--env='))
      .map((a) => a.slice(6, a.indexOf('=', 6)));
    expect(envNames.length).toBeGreaterThan(0);
    expect(envNames.filter((n) => SECRET_NAME.test(n))).toEqual([]);
    // No host path, volume or secret reaches the job: the bundle comes in on standard input.
    const forbidden = /^(--volume|--mount|--secret|--env-file|-v|-e|--mount=|--volume=|--secret=)/;
    expect(args.filter((a) => forbidden.test(a))).toEqual([]);
    for (const k of KEY_MATERIAL) expect(args.some((a) => k.test(a))).toBe(false);
  });
});

/** The names of the variables a Containerfile's ENV instructions set. */
function containerfileEnvNames(text: string): Set<string> {
  const names = new Set<string>();
  const m = /^ENV ((?:.*\\\n)*.*)$/m.exec(text);
  for (const pair of (m?.[1] ?? '').replace(/\\\n/g, ' ').split(/\s+/)) {
    const i = pair.indexOf('=');
    if (i > 0) names.add(pair.slice(0, i));
  }
  return names;
}
