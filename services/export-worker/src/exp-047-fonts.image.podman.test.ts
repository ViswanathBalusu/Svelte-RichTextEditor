/**
 * EXP-047 criteria 1 and 5, checked in the worker image (export worker, Podman; lane
 * U-EXP-033-048). The image is started read-only, with no network and no capabilities, as a job
 * runs it, and its entry point is replaced by a small command so the test can look at the font
 * directory. The arguments are plain words (the machine route passes them through ssh):
 *
 * - criterion 1: the font files sit at /opt/docedit/fonts, each named by its SHA-256 (the bytes
 *   hash to the name, checked by sha256sum in the image), every face of the image's font manifest has its
 *   file there, the directory cannot be written, and the environment names no system font
 *   directory (OSFONTDIR=/nonexistent), so fontspec has nothing to find by a system lookup.
 * - criterion 5: the fonts are still addressed by path and hash in the image that holds the
 *   pre-built name cache (the cache itself is checked by exp-073-image.podman.test.ts).
 *
 * Skipped when Podman or the worker image is not available here (sandbox-ready.ts).
 */
import { describe, expect, it } from 'vitest';
import { podman } from './container.ts';
import { IMAGE } from './sandbox.ts';
import { sandboxReady } from './sandbox-ready.ts';

const FONTS = '/opt/docedit/fonts';
const LIMIT = { timeoutMs: 180_000, maxStdoutBytes: 64 * 1024 * 1024 };

interface FaceRef {
  file: string;
  sha256: string;
}

interface ImageManifest {
  families: Array<{ regular: FaceRef; bold: FaceRef; italic: FaceRef; boldItalic: FaceRef }>;
  math: FaceRef;
}

/** The read-only sandbox shape used for each look at the image (no network, no capabilities). */
function readOnly(entrypoint: string, rest: string[]): string[] {
  return [
    'run',
    '--rm',
    '--network=none',
    '--read-only',
    '--cap-drop=ALL',
    '--user=10001:10001',
    `--entrypoint=${entrypoint}`,
    IMAGE,
    ...rest,
  ];
}

const ready = await sandboxReady();

describe.skipIf(!ready.ok)(
  `EXP-047 criteria 1 and 5: the worker's fonts are read-only and named by hash (${ready.reason})`,
  () => {
    it('names every font file by its SHA-256, keeps the directory read-only and names no system font directory', async () => {
      // The file names in the font directory.
      const list = await podman(readOnly('find', [FONTS, '-maxdepth', '1', '-type', 'f']), LIMIT);
      expect(list.code, list.stderr.slice(0, 500)).toBe(0);
      const paths = new TextDecoder()
        .decode(list.stdout)
        .split('\n')
        .filter((p) => p.length > 0);
      const names = paths.map((p) => p.slice(FONTS.length + 1));
      const fontNames = names.filter((n) => /\.(ttf|otf)$/.test(n));
      expect(fontNames.length, 'the image holds font files').toBeGreaterThan(0);

      // Each font file's bytes hash to its name (the file is addressed by its hash): one sha256sum
      // call over every font file. Each output line is "<hash>  <path>".
      const sums = await podman(
        readOnly(
          'sha256sum',
          fontNames.map((n) => `${FONTS}/${n}`),
        ),
        LIMIT,
      );
      expect(sums.code, sums.stderr.slice(0, 300)).toBe(0);
      const hashOf = new Map<string, string>();
      for (const line of new TextDecoder().decode(sums.stdout).split('\n')) {
        const m = /^([0-9a-f]{64})\s+\S*\/([^/\s]+)$/.exec(line);
        if (m) hashOf.set(m[2] ?? '', m[1] ?? '');
      }
      for (const name of fontNames) {
        expect(hashOf.get(name), `${name} has a hash`).toBeDefined();
        expect(name.split('.')[0], `${name} is named by its hash`).toBe(hashOf.get(name));
      }

      // Every face of the image's manifest has its file in that directory, under its hash.
      const m = await podman(readOnly('cat', [`${FONTS}/fonts.json`]), LIMIT);
      expect(m.code, m.stderr.slice(0, 300)).toBe(0);
      const manifest = JSON.parse(new TextDecoder().decode(m.stdout)) as ImageManifest;
      const faces: FaceRef[] = [manifest.math];
      for (const fam of manifest.families)
        faces.push(fam.regular, fam.bold, fam.italic, fam.boldItalic);
      for (const face of faces) {
        expect(
          names.includes(face.file),
          `the manifest's face ${face.file} is in the directory`,
        ).toBe(true);
        expect(face.file.split('.')[0], `${face.file} is addressed by its hash`).toBe(face.sha256);
      }

      // The directory is not writable by the job: find's -writable test uses access(2), which fails on
      // a read-only file system. The directory itself is listed by a plain find, so an empty output
      // from -writable means "not writable" and not a failed search.
      const writable = await podman(
        readOnly('find', [FONTS, '-maxdepth', '0', '-writable']),
        LIMIT,
      );
      expect(writable.code, writable.stderr.slice(0, 300)).toBe(0);
      expect(
        new TextDecoder().decode(writable.stdout).trim(),
        'the font directory is not writable',
      ).toBe('');

      // No system font directory is named: OSFONTDIR is the placeholder the Containerfile sets.
      const env = await podman(readOnly('printenv', ['OSFONTDIR']), LIMIT);
      expect(env.code).toBe(0);
      expect(new TextDecoder().decode(env.stdout).trim()).toBe('/nonexistent');
    }, 900_000);
  },
);
