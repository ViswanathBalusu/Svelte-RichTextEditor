/**
 * EXP-015 criterion 6 (lane V-EXP-001-016): the house class's licence is recorded in the licence
 * manifest of the export worker image (EXP-073). The test runs the manifest generator
 * (scripts/licence-manifest.ts) against the built image through Podman, writes its output to a
 * temporary directory, and reads the `houseClass` entry back. It checks that the name, the
 * version and the licence are those of the class the converter ships (`CLASS_VERSION` and
 * `CLASS_LICENCE` in @docedit/export-latex). The full licence manifest (EXP-073 criterion 3) is
 * not asserted here: this test checks only the house class entry.
 *
 * Skipped when Podman or the worker image is not available (see sandbox-ready.ts).
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CLASS_LICENCE, CLASS_VERSION } from '@docedit/export-latex';
import { describe, expect, it } from 'vitest';
import { sandboxReady } from './sandbox-ready.ts';

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const script = join(root, 'scripts', 'licence-manifest.ts');

const ready = await sandboxReady();

describe.skipIf(!ready.ok)(
  `EXP-015 criterion 6: the house class licence is in the licence manifest (${ready.reason})`,
  () => {
    it('records the class name, version and licence in the generated manifest', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'docedit-v-exp-001-016-licence-'));
      try {
        await execFileAsync(process.execPath, [script, '--out', dir], {
          cwd: root,
          timeout: 300_000,
          maxBuffer: 16 * 1024 * 1024,
        });
        const manifest = JSON.parse(readFileSync(join(dir, 'licence-manifest.json'), 'utf8')) as {
          houseClass: { name: string; version: string; licence: string };
          packageCount: number;
        };
        expect(manifest.houseClass.name).toBe('docedit');
        expect(manifest.houseClass.version).toBe(CLASS_VERSION);
        expect(manifest.houseClass.licence).toBe(CLASS_LICENCE);
        expect(manifest.packageCount).toBeGreaterThan(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 360_000);
  },
);
