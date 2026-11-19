/**
 * WASM-015: the kernel's bidirectional algorithm (UAX #9) against the browsers' own. For many
 * random strings over an alphabet of Latin, Hebrew and Arabic letters, European and Arabic-Indic
 * digits, separators, brackets and the explicit embedding, override and isolate controls, the page
 * lays the string out in a `white-space: pre` element, reads the horizontal position of each
 * visible character, and compares the order they stand in, left to right, with the order the
 * kernel gives for the same text and base direction: left to right, right to left, and automatic
 * (`unicode-bidi: plaintext`, the first strong character).
 *
 * The strings come from a fixed seed, so a failure repeats; it names the string by its code points.
 * Needs the build (`pnpm --filter @docedit/layout-kernel build:wasm`).
 */
import { expect, test } from '@playwright/test';
import { openKernelPage } from './kernel-page.ts';

/** The alphabet, with the weight of each group. */
const GROUPS: Array<{ weight: number; chars: string[] }> = [
  { weight: 5, chars: ['a', 'b', 'c'] },
  { weight: 5, chars: ['א', 'ב', 'ג'] },
  { weight: 3, chars: ['ا', 'ب', 'ج'] },
  { weight: 3, chars: ['1', '2', '3'] },
  { weight: 2, chars: ['١', '٢'] },
  { weight: 3, chars: [' ', ' '] },
  { weight: 3, chars: ['(', ')', '[', ']'] },
  { weight: 3, chars: [',', '.', ':', '-', '+', '%', '$', '"', '/'] },
  {
    weight: 3,
    chars: [
      '‪', // LRE
      '‫', // RLE
      '‬', // PDF
      '‭', // LRO
      '‮', // RLO
      '⁦', // LRI
      '⁧', // RLI
      '⁨', // FSI
      '⁩', // PDI
    ],
  },
];

/** A small seeded generator (mulberry32). */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function strings(count: number, seed: number): string[] {
  const next = random(seed);
  const total = GROUPS.reduce((n, g) => n + g.weight, 0);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const length = 2 + Math.floor(next() * 11);
    let s = '';
    for (let k = 0; k < length; k++) {
      let pick = next() * total;
      const group = GROUPS.find((g) => (pick -= g.weight) < 0) ?? GROUPS[0]!;
      s += group.chars[Math.floor(next() * group.chars.length)]!;
    }
    out.push(s);
  }
  return out;
}

const COUNT = 1500;

test('the kernel orders mixed-direction text as the browser does, for 1500 random strings in each base direction', async ({
  page,
  browserName,
}, info) => {
  await openKernelPage(page);
  const result = await page.evaluate(
    async ({ samples, directions, skipArabicIndic }) => {
      const wrapper = (await import(`${location.origin}/src/index.ts`)) as {
        createKernel(glue: unknown, wasm: Uint8Array): Kernel;
      };
      interface Kernel {
        bidi: {
          visualRuns(
            text: string,
            direction: string,
            from?: number,
            to?: number,
          ): Array<{ start: number; end: number; level: number; rtl: boolean }>;
        };
      }
      const glue = await import(`${location.origin}/dist/docedit_layout_kernel.js`);
      const wasm = new Uint8Array(
        await (await fetch(`${location.origin}/dist/docedit_layout_kernel_bg.wasm`)).arrayBuffer(),
      );
      const kernel = wrapper.createKernel(glue, wasm);

      const controls = /[‪-‮⁦-⁩]/;
      const host = document.createElement('div');
      host.style.cssText =
        'position:absolute;left:0;top:0;width:900px;font:20px/1.2 monospace;white-space:pre;';
      document.body.append(host);

      /** The browser's order: the indexes of the visible characters, left to right. */
      function browserOrder(text: string, direction: string): number[] {
        host.textContent = '';
        host.style.direction = direction === 'rtl' ? 'rtl' : 'ltr';
        host.style.unicodeBidi = direction === 'auto' ? 'plaintext' : 'normal';
        const node = document.createTextNode(text);
        host.append(node);
        const seen: Array<{ index: number; left: number }> = [];
        for (let i = 0; i < text.length; i++) {
          if (controls.test(text[i]!)) continue;
          const range = document.createRange();
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const rect = range.getClientRects()[0];
          if (rect && rect.width > 0) seen.push({ index: i, left: rect.left });
        }
        seen.sort((a, b) => a.left - b.left || a.index - b.index);
        return seen.map((s) => s.index);
      }

      /** The kernel's order of the same characters. */
      function kernelOrder(text: string, direction: string): number[] {
        const order: number[] = [];
        for (const run of kernel.bidi.visualRuns(text, direction)) {
          const indexes: number[] = [];
          for (let i = run.start; i < run.end; i++) indexes.push(i);
          if (run.rtl) indexes.reverse();
          order.push(...indexes);
        }
        return order.filter((i) => !controls.test(text[i]!));
      }

      const mismatches: string[] = [];
      let compared = 0;
      for (const text of samples) {
        if (skipArabicIndic && /[\u0660-\u0669\u2066-\u2069]/.test(text)) continue;
        for (const direction of directions) {
          const want = browserOrder(text, direction);
          // Only characters the browser gave a width to are compared (a mark has none).
          const visible = new Set(want);
          const got = kernelOrder(text, direction).filter((i) => visible.has(i));
          compared++;
          if (JSON.stringify(want) !== JSON.stringify(got) && mismatches.length < 15)
            mismatches.push(
              `${direction} ${Array.from(text, (c) => c.codePointAt(0)!.toString(16)).join(' ')} browser ${want.join(',')} kernel ${got.join(',')}`,
            );
        }
      }
      return { compared, mismatches };
    },
    {
      samples: strings(COUNT, 20260611),
      // WebKit differs from UAX #9, and from Chromium, Edge and Firefox, in two ways. Its
      // `unicode-bidi: plaintext` does not take the paragraph direction from the first strong
      // character (P2, P3): it gives right to left to `/"]aa` followed by Hebrew and Arabic, and
      // places trailing spaces differently. And it does not raise Arabic-Indic digits (class AN) to
      // level 2 in left-to-right text: `AN ] AN` stays in logical order where UAX #9 reverses it.
      // It also orders text after an unmatched isolate initiator differently (`aa RLI [ 1`: UAX #9 puts the digit left of the bracket). So the run in WebKit compares the two explicit directions, on strings without such digits and without isolate controls.
      directions: browserName === 'webkit' ? ['ltr', 'rtl'] : ['ltr', 'rtl', 'auto'],
      skipArabicIndic: browserName === 'webkit',
    },
  );

  expect(result.mismatches, 'strings the browser and the kernel order differently').toEqual([]);
  expect(result.compared).toBeGreaterThan(COUNT * (browserName === 'webkit' ? 1 : 3) * 0.9);
  await info.attach(`wasm-015-bidi-${browserName}.json`, {
    contentType: 'application/json',
    body: JSON.stringify({ browser: browserName, compared: result.compared }),
  });
});
