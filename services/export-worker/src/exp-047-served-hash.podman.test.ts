/**
 * EXP-047 criterion 3, checked against the worker image (export worker, Podman; lane
 * V-EXP-033-048, round 8): "Given a font served to the editor and the same font mounted in a worker,
 * when their SHA-256 hashes are compared, then they are equal."
 *
 * The font files are read out of the real worker image (`/opt/docedit/fonts`, the same files the
 * worker mounts). Their bytes are loaded as the document service loads its font directory
 * (`loadFontCatalogue`) and served by its font route (`fontFileHandler`, `GET /fonts/{sha256}.{ext}`),
 * which is the route the editor fetches from. For each font file the test compares three hashes:
 * the hash the served bytes give, the hash the file is named by, and `sha256sum` run inside the image
 * on the mounted file. All three must be equal.
 *
 * The HTTP server itself is not started: the route is called directly with the same handler the
 * server mounts under `/fonts/`. Skipped when the sandbox is not ready here (sandbox-ready.ts);
 * DOCEDIT_REQUIRE_SANDBOX=1 makes it fail instead.
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fontFileHandler,
  loadFontCatalogue,
} from '../../document-service/src/control-plane/fonts.ts';
import { podman } from './container.ts';
import { IMAGE } from './sandbox.ts';
import { sandboxReady } from './sandbox-ready.ts';

const FONTS = '/opt/docedit/fonts';
const LIMIT = { timeoutMs: 180_000, maxStdoutBytes: 64 * 1024 * 1024 };
const BASE = 'https://fonts.example.test/fonts';

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

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const ready = await sandboxReady();

describe.skipIf(!ready.ok)(
  `EXP-047 criterion 3: served and mounted fonts hash alike (${ready.reason})`,
  () => {
    it('serves each image font with the SHA-256 it is named by and the worker mounts', async () => {
      const list = await podman(readOnly('find', [FONTS, '-maxdepth', '1', '-type', 'f']), LIMIT);
      expect(list.code, list.stderr.slice(0, 500)).toBe(0);
      const names = new TextDecoder()
        .decode(list.stdout)
        .split('\n')
        .filter((p) => p.length > 0)
        .map((p) => p.slice(FONTS.length + 1))
        .filter((n) => /\.(ttf|otf)$/.test(n));
      expect(names.length, 'the image holds font files').toBeGreaterThan(0);

      // The worker's side: sha256sum inside the image, on the files as they are mounted.
      const sums = await podman(
        readOnly(
          'sha256sum',
          names.map((n) => `${FONTS}/${n}`),
        ),
        LIMIT,
      );
      expect(sums.code, sums.stderr.slice(0, 300)).toBe(0);
      const mounted = new Map<string, string>();
      for (const line of new TextDecoder().decode(sums.stdout).split('\n')) {
        const m = /^([0-9a-f]{64})\s+\S*\/([^/\s]+)$/.exec(line);
        if (m) mounted.set(m[2] ?? '', m[1] ?? '');
      }

      const dir = await mkdtemp(join(tmpdir(), 'docedit-V-EXP-033-048-served-'));
      try {
        // The document service's side: its font directory, copied out of the image byte for byte.
        const manifest = await podman(readOnly('cat', [`${FONTS}/fonts.json`]), LIMIT);
        expect(manifest.code, manifest.stderr.slice(0, 300)).toBe(0);
        await writeFile(join(dir, 'fonts.json'), manifest.stdout);
        for (const n of names) {
          const bytes = await podman(readOnly('cat', [`${FONTS}/${n}`]), LIMIT);
          expect(bytes.code, `${n} is read out of the image`).toBe(0);
          await writeFile(join(dir, n), bytes.stdout);
        }

        const catalogue = await loadFontCatalogue(dir, BASE);
        expect(catalogue.excluded, 'no font of the image is left out of the catalogue').toEqual([]);
        const handler = fontFileHandler(() => catalogue);

        for (const n of names) {
          const reply = await handler(
            { method: 'GET' } as IncomingMessage,
            new URL(`${BASE}/${n}`),
          );
          expect(reply.status, `${n} is served`).toBe(200);
          const served = sha256(reply.bytes ?? new Uint8Array());
          const named = n.split('.')[0];
          expect(served, `${n}: served bytes hash to the name`).toBe(named);
          expect(mounted.get(n), `${n}: the mounted file hashes to the name`).toBe(named);
          expect(served, `${n}: served and mounted hashes are equal`).toBe(mounted.get(n));
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }, 900_000);
  },
);
