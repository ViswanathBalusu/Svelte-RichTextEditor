/**
 * EXP-037, EXP-026, EXP-047 (export worker, Podman): the worker image has the Noto faces of the
 * fallback chain (owner decisions 228 and 241). `image/noto-fonts.tsv` pins each download and
 * face by SHA-256 and `image/fetch-noto.sh` refuses any other file, so the build itself is the
 * check of the pins; this test reads the finished image as the sandbox sees it (read-only, no
 * network, no capabilities): `fonts.json` lists the chain in the order of the file, every face of
 * the chain is a file whose name is its SHA-256 and whose bytes hash to it, and the licence text
 * of every Noto face is in the image. Skipped when Podman or the worker image is not available.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { podman } from './container.ts';
import { IMAGE } from './sandbox.ts';
import { sandboxReady } from './sandbox-ready.ts';

const ready = await sandboxReady();

interface Row {
  name: string;
  faceSha: string;
  licenceSha: string;
  face: string;
}

/** The rows of `image/noto-fonts.tsv`. */
function rows(): Row[] {
  const text = readFileSync(new URL('../image/noto-fonts.tsv', import.meta.url), 'utf8');
  return text
    .split('\n')
    .filter((l) => l !== '' && !l.startsWith('#'))
    .map((l) => l.split('\t'))
    .map((c) => ({ name: c[0]!, face: c[5]!, faceSha: c[6]!, licenceSha: c[9]! }));
}

describe('EXP-037: the pins of the Noto faces', () => {
  it('pin every download, face and licence text by SHA-256, from https, in the order of the chain', () => {
    const list = rows();
    expect(list.map((r) => r.name)).toEqual([
      'Noto Sans Arabic',
      'Noto Sans Hebrew',
      'Noto Sans Devanagari',
      'Noto Sans Thai',
      'Noto Sans CJK JP',
    ]);
    const text = readFileSync(new URL('../image/noto-fonts.tsv', import.meta.url), 'utf8');
    for (const line of text.split('\n').filter((l) => l !== '' && !l.startsWith('#'))) {
      const c = line.split('\t');
      expect(c).toHaveLength(10);
      expect(c[2]).toMatch(/^https:\/\/(github\.com|raw\.githubusercontent\.com)\/notofonts\//u);
      for (const i of [3, 6, 9]) expect(c[i]).toMatch(/^[0-9a-f]{64}$/u);
      expect(c[7]).toBe('OFL-1.1');
    }
    // The script checks every file and stops on a mismatch.
    const script = readFileSync(new URL('../image/fetch-noto.sh', import.meta.url), 'utf8');
    expect(script).toContain('set -eu');
    expect(script).toContain("--proto '=https'");
    expect(script.match(/check "\$/gu)).toHaveLength(3);
  });
});

describe.skipIf(!ready.ok)(`EXP-037: the image has the Noto faces (${ready.reason})`, () => {
  /** Runs one program of the image as the sandbox does: read-only, no network, no capabilities. */
  const inImage = async (entrypoint: string, ...args: string[]): Promise<string> => {
    const r = await podman(
      [
        'run',
        '--rm',
        '--network=none',
        '--read-only',
        '--cap-drop=ALL',
        '--user=10001:10001',
        `--entrypoint=${entrypoint}`,
        IMAGE,
        ...args,
      ],
      { timeoutMs: 180_000, maxStdoutBytes: 8 * 1024 * 1024 },
    );
    expect(r.code, r.stderr.slice(0, 500)).toBe(0);
    return new TextDecoder().decode(r.stdout);
  };

  it('lists the fallback chain, with each face a hash-named file that hashes to its name, and keeps the licence texts', async () => {
    const manifest = JSON.parse(await inImage('cat', '/opt/docedit/fonts/fonts.json')) as {
      fallback: Array<{ name: string; file: string; sha256: string; licence: string }>;
    };
    expect(manifest.fallback.map((f) => f.name)).toEqual([
      'STIX Two Math',
      ...rows().map((r) => r.name),
    ]);
    expect(manifest.fallback.slice(1).map((f) => f.sha256)).toEqual(rows().map((r) => r.faceSha));
    expect(manifest.fallback.every((f) => f.licence === 'OFL-1.1')).toBe(true);
    const sums = await inImage(
      'sha256sum',
      ...manifest.fallback.map((f) => `/opt/docedit/fonts/${f.file}`),
    );
    for (const f of manifest.fallback)
      expect(sums).toContain(`${f.sha256}  /opt/docedit/fonts/${f.file}`);
    const licences = await inImage(
      'sha256sum',
      ...rows().map((r) => `/opt/docedit/licences/noto/${r.face}.OFL.txt`),
    );
    for (const r of rows())
      expect(licences).toContain(`${r.licenceSha}  /opt/docedit/licences/noto/${r.face}.OFL.txt`);
    // The downloads and the build files are not left in the image.
    const left = await inImage('ls', '/opt/docedit', '/opt/docedit/licences');
    expect(left).not.toContain('noto-src');
    expect(left).not.toContain('build');
    expect(left).toContain('noto-fonts.tsv');
  }, 300_000);
});
