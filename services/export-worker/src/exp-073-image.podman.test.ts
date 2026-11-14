/**
 * EXP-073 criterion 5 (export worker, Podman): the worker image contains the pre-built font name
 * cache of EXP-047. The image is started with its entry point replaced by `find`, read-only, with
 * no network and no capabilities, so the test looks at the image as the sandbox sees it. Skipped
 * when Podman or the worker image is not available here (see sandbox-ready.ts).
 *
 * The cache directory is the one the Containerfile copies to /opt/docedit/luaotfload-names and
 * that image/compile.sh copies into the job's work directory. The test checks that the directory
 * holds at least one non-empty file, and that the names database is one of them.
 */
import { describe, expect, it } from 'vitest';
import { podman } from './container.ts';
import { IMAGE } from './sandbox.ts';
import { sandboxReady } from './sandbox-ready.ts';

const CACHE = '/opt/docedit/luaotfload-names';

const ready = await sandboxReady();

describe.skipIf(!ready.ok)(
  `EXP-073 criterion 5: the image holds the pre-built font name cache (${ready.reason})`,
  () => {
    it('lists non-empty files under the names cache, including the names database', async () => {
      const r = await podman(
        [
          'run',
          '--rm',
          '--network=none',
          '--read-only',
          '--cap-drop=ALL',
          '--user=10001:10001',
          '--entrypoint=find',
          IMAGE,
          CACHE,
          '-type',
          'f',
          '-size',
          '+0c',
        ],
        { timeoutMs: 120_000, maxStdoutBytes: 1024 * 1024 },
      );
      expect(r.code, r.stderr.slice(0, 500)).toBe(0);
      const paths = new TextDecoder()
        .decode(r.stdout)
        .split('\n')
        .filter((l) => l.length > 0);
      expect(paths.length).toBeGreaterThan(0);
      expect(paths.some((p) => p.startsWith(CACHE + '/'))).toBe(true);
      expect(paths.some((p) => /luaotfload-names[^/]*$/.test(p) || /\/names\b/.test(p))).toBe(true);
    }, 180_000);
  },
);
