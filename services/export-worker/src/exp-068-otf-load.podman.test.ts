/**
 * EXP-068 criterion 3 (lane V-EXP-065-080, Podman): OpenType fonts load from file in the sandbox,
 * and the engine runs without `--safer`. The test lists the fonts the image holds under
 * /opt/docedit/fonts (copied out of the TeX tree and named by SHA-256, see the Containerfile), then
 * compiles a probe document in a real single-use sandbox that loads one of them by path with
 * fontspec. The PDF must embed a font program. The PDF's streams are inflated first, because the
 * font descriptors may sit in compressed object streams. Skipped when Podman or the worker image is
 * not available (sandbox-ready.ts).
 */
import { inflateSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { podman } from './container.ts';
import { IMAGE, compileInSandbox } from './sandbox.ts';
import { sandboxReady } from './sandbox-ready.ts';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

const ready = await sandboxReady();
const FONT_DIR = '/opt/docedit/fonts';

/** The PDF text with every Flate stream inflated (object streams included). */
function inflatedText(pdf: Uint8Array): string {
  const raw = Buffer.from(pdf);
  const parts: string[] = [raw.toString('latin1')];
  let at = 0;
  for (;;) {
    const s = raw.indexOf('stream', at, 'latin1');
    if (s < 0) break;
    let start = s + 6;
    if (raw[start] === 0x0d) start++;
    if (raw[start] === 0x0a) start++;
    const e = raw.indexOf('endstream', start, 'latin1');
    if (e < 0) break;
    try {
      parts.push(inflateSync(raw.subarray(start, e)).toString('latin1'));
    } catch {
      // Not a Flate stream: nothing to add.
    }
    at = e + 9;
  }
  return parts.join('\n');
}

describe.skipIf(!ready.ok)(
  `EXP-068 criterion 3: OpenType fonts load from file (${ready.reason})`,
  () => {
    it('embeds an OpenType font that the probe loads by path, with no --safer', async () => {
      const listed = await podman(
        [
          'run',
          '--rm',
          '--network=none',
          '--read-only',
          '--cap-drop=ALL',
          '--user=10001:10001',
          '--entrypoint=find',
          IMAGE,
          FONT_DIR,
          '-maxdepth',
          '1',
          '-type',
          'f',
        ],
        { timeoutMs: 120_000, maxStdoutBytes: 1024 * 1024 },
      );
      expect(listed.code, listed.stderr.slice(0, 500)).toBe(0);
      const files = new TextDecoder()
        .decode(listed.stdout)
        .split('\n')
        .filter((l) => l.length > 0);
      const otf = files.find((f) => f.endsWith('.otf'));
      expect(otf, 'the image holds an .otf font file').toBeDefined();
      const fileName = otf!.slice(FONT_DIR.length + 1);

      const r = await compileInSandbox(
        {
          'main.tex':
            '\\documentclass{article}\n' +
            '\\usepackage{fontspec}\n' +
            `\\setmainfont[Path=${FONT_DIR}/]{${fileName}}\n` +
            '\\begin{document}\nEXP068 OpenType probe.\n\\end{document}\n',
        },
        {
          minPasses: 1,
          maxPasses: 2,
          sourceDateEpoch: 1_700_000_000,
          name: `docedit-v-exp-065-080-otf-${Date.now().toString(36)}`,
        },
      );
      if (!r.ok) throw new Error(`the probe did not compile: ${r.log.slice(0, 800)}`);
      expect(r.pdf).not.toBeNull();
      const text = inflatedText(r.pdf!);
      // A font program is embedded: a FontFile2 or FontFile3 stream of the descriptor.
      expect(/\/FontFile[23]\b/.test(text)).toBe(true);
      expect(/safer/i.test(r.log)).toBe(false);
    }, 240_000);
  },
);
