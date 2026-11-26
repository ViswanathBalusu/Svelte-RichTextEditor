/**
 * Comments in the margin, compiled (EXP-084 criteria 1 and 5; Node.js, sandbox and veraPDF in
 * Podman). The note stands in the right margin beside its paragraph (read from `pdftotext -bbox`),
 * `none` prints no comment, and the tagged PDF still passes PDF/UA-2 with the reading order of the
 * body unchanged. The tests skip when `sandboxReady()` reports that sandboxed compiles cannot run.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { doc, para } from '../test/docs.ts';
import {
  convertAndCompile,
  firstError,
  keep,
  pdfText,
  sandboxReady,
  validatePdf,
} from '../test/harness.ts';
import type { CommentThread } from './bundle.ts';

const ready = (await sandboxReady()).ok;

const A = 'pAAAAAAAAAAAAAAA';
const B = 'pBBBBBBBBBBBBBBB';
const C = 'pCCCCCCCCCCCCCCC';

const body = () => [
  para('Alpha paragraph opens the page.', { id: A }),
  para('Bravo paragraph carries the comment.', { id: B }),
  para('Charlie paragraph closes the page.', { id: C }),
];

const thread: CommentThread = {
  id: 'tAAAAAAAAAAAAAAA',
  block: B,
  quote: 'Bravo',
  messages: [
    { author: 'Ada Lovelace', text: 'Marginnote checks this claim.' },
    { author: 'Grace Hopper', text: 'Replynote agrees.' },
  ],
};

const compile = async (name: string, options: Record<string, unknown>) => {
  const c = await convertAndCompile(doc(body()), {
    profile: 'final',
    title: name,
    instant: '2026-11-26T10:00:00.000Z',
    timeZone: 'Europe/London',
    layout: 'block',
    ...options,
  } as never);
  if (!c.compile.ok || !c.compile.pdf) {
    keep(name, c);
    throw new Error(`the compile of ${name} failed:\n${firstError(c.compile.log)}`);
  }
  return c;
};

interface Word {
  text: string;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

/** The words of page 1 with their boxes, by `pdftotext -bbox`. */
function words(pdf: Uint8Array): { page: { w: number; h: number }; words: Word[] } {
  const dir = mkdtempSync(join(tmpdir(), 'docedit-bbox-'));
  const file = join(dir, 'in.pdf');
  writeFileSync(file, pdf);
  const r = spawnSync('pdftotext', ['-f', '1', '-l', '1', '-bbox', file, '-'], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(r.status, r.stderr).toBe(0);
  const page = /<page width="([\d.]+)" height="([\d.]+)"/.exec(r.stdout)!;
  const out: Word[] = [];
  for (const m of r.stdout.matchAll(
    /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g,
  ))
    out.push({
      text: m[5]!,
      xMin: +m[1]!,
      yMin: +m[2]!,
      xMax: +m[3]!,
      yMax: +m[4]!,
    });
  return { page: { w: +page[1]!, h: +page[2]! }, words: out };
}

/**
 * The structure elements of the PDF in the order the tagging code made them (their `/ID` rises with
 * the document), as `{ role, mcid }`. The object streams hold them, so every Flate stream is
 * inflated first (as in exp-111-tagged.compile.test.ts).
 */
function structure(pdf: Uint8Array): Array<{ role: string; mcid: number | null }> {
  const raw = Buffer.from(pdf).toString('latin1');
  const parts = [raw];
  for (let at = 0; ;) {
    const s = raw.indexOf('stream', at);
    if (s < 0) break;
    const end = raw.indexOf('endstream', s);
    if (end < 0) break;
    let start = s + 'stream'.length;
    if (raw[start] === '\r') start++;
    if (raw[start] === '\n') start++;
    try {
      parts.push(inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1'));
    } catch {
      // Not a Flate stream.
    }
    at = end + 'endstream'.length;
  }
  const out: Array<{ role: string; mcid: number | null }> = [];
  const re = /<<[^<>]*\/Type\s*\/StructElem[^<>]*(?:<<[^<>]*>>[^<>]*)*>>/g;
  for (const m of parts.join('\n').matchAll(re)) {
    const role = /\/S\s*\/([\w-]+)/.exec(m[0])?.[1] ?? '';
    const mcid = /\/MCID\s+(\d+)/.exec(m[0])?.[1];
    out.push({ role, mcid: mcid === undefined ? null : Number(mcid) });
  }
  return out;
}

describe.skipIf(!ready)(
  'EXP-084 criterion 1: a margin note beside its paragraph (compiled)',
  () => {
    it('puts the note in the right margin at the height of its paragraph, and none with `none`', async () => {
      const c = await compile('exp-084-margin', {
        comments: 'margin',
        commentThreads: [thread],
        tagging: 'on',
        pdfStandard: 'ua-2+a-4f',
      });
      const { page, words: ws } = words(c.compile.pdf!);
      const find = (t: string) => ws.find((w) => w.text === t);
      const bravo = find('Bravo')!;
      const note = find('Marginnote')!;
      const reply = find('Replynote')!;
      expect(bravo && note && reply, 'the words are in the PDF').toBeTruthy();
      const bodyRight = Math.max(...ws.filter((w) => w.xMin < page.w * 0.7).map((w) => w.xMax));
      // Right of every body word, inside the page, and level with the paragraph (within 40 pt).
      expect(note.xMin).toBeGreaterThan(bodyRight - 1);
      expect(note.xMax).toBeLessThan(page.w);
      expect(Math.abs(note.yMin - bravo.yMin)).toBeLessThan(40);
      expect(reply.yMin).toBeGreaterThan(note.yMin);
      // No body paragraph moved into the margin or out of order.
      const raw = pdfText(c.compile.pdf!, '-raw')!;
      expect(raw.indexOf('Alpha')).toBeLessThan(raw.indexOf('Bravo'));
      expect(raw.indexOf('Bravo')).toBeLessThan(raw.indexOf('Charlie'));

      const none = await compile('exp-084-none', { comments: 'none', commentThreads: [thread] });
      expect(pdfText(none.compile.pdf!, '-raw')).not.toContain('Marginnote');
    }, 240_000);

    it('keeps the tagged PDF valid (PDF/UA-2) and the reading order of the body (criterion 5)', async () => {
      const c = await compile('exp-084-ua2', {
        comments: 'margin',
        commentThreads: [thread],
        tagging: 'on',
        pdfStandard: 'ua-2+a-4f',
      });
      const ua2 = await validatePdf(c.compile.pdf!, 'ua2');
      expect(ua2.error, 'the validator output parses').toBeUndefined();
      expect(ua2.failures, 'no PDF/UA-2 rule fails').toEqual([]);
      expect(ua2.compliant).toBe(true);
      // The note is one `Aside` of the paragraph it follows (PDF 2.0), made after that paragraph's
      // text and before the next paragraph's: the marked content of the page reads in the order of
      // the body, 0 to 5, with the three blocks of the note (the quote and two messages) between.
      const tree = structure(c.compile.pdf!);
      expect(tree.filter((e) => e.role === 'Aside')).toHaveLength(1);
      expect(tree.filter((e) => e.mcid !== null).map((e) => e.mcid)).toEqual([0, 1, 2, 3, 4, 5]);
      const aside = tree.findIndex((e) => e.role === 'Aside');
      expect(tree.slice(aside + 1).find((e) => e.mcid !== null)?.mcid).toBe(2);
    }, 240_000);
  },
);
