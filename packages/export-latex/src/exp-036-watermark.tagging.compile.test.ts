/**
 * Watermark and the tagged reading order in the compiled PDF (Node.js only, sandbox): EXP-036
 * criterion 3. The bundle is compiled with tagging on through `test/harness.ts`, and the page's
 * content streams are read as bytes (Flate streams are inflated) to follow the marked content.
 *
 * - The class prints the watermark inside `\SuspendTagging`, so its text must not sit inside a
 *   marked-content sequence with an MCID (the tagged reading order). The check is on the content
 *   stream: a text block (`BT` ... `ET`) whose font size is well above the body text is a
 *   watermark block, and its innermost marked content must not carry an MCID.
 * - Positive controls: the watermark block is found (one or more), and the body paragraph's text
 *   block sits inside an MCID sequence, so the parser does recognise tagged text.
 *
 * The test skips when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { doc, para, type J } from '../test/docs.ts';
import { convertAndCompile, keep, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';
const A4: J = {
  width: 11906,
  height: 16838,
  marginTop: 1440,
  marginBottom: 1440,
  marginLeft: 1440,
  marginRight: 1440,
  gutter: 0,
  headerDistance: 720,
  footerDistance: 720,
};

/** A text block read from a content stream: its font size and whether it sits in the reading order. */
interface TextBlock {
  size: number;
  inReadingOrder: boolean;
  text: string;
}

/** The content streams of the PDF that hold text (page content), inflated as latin1 strings. */
function contentStreams(pdf: Uint8Array): string[] {
  const text = Buffer.from(pdf).toString('latin1');
  const out: string[] = [];
  let at = 0;
  for (;;) {
    const s = text.indexOf('stream', at);
    if (s < 0) break;
    const end = text.indexOf('endstream', s);
    if (end < 0) break;
    let start = s + 'stream'.length;
    if (text[start] === '\r') start++;
    if (text[start] === '\n') start++;
    try {
      const plain = inflateSync(Buffer.from(text.slice(start, end), 'latin1')).toString('latin1');
      if (/\bBT\b/.test(plain)) out.push(plain);
    } catch {
      // Not a Flate stream (fonts, object streams, images): skipped.
    }
    at = end + 'endstream'.length;
  }
  return out;
}

/**
 * The text blocks of one content stream, in order. Marked content is tracked with a stack: a `BDC`
 * with an MCID or a `BMC` opens a sequence, `EMC` closes it. A block is in the reading order when
 * any open sequence carries an MCID.
 */
function textBlocks(stream: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  const stack: boolean[] = [];
  const tokens =
    /\/[^\s/<>[\]]+\s*<<[^>]*>>\s*BDC|\/[^\s/<>[\]]+\s+BDC|\/[^\s/<>[\]]+\s+BMC|\bEMC\b|\bBT\b|\bET\b|\bTf\b|\bTJ\b|\bTj\b/g;
  let size = 0;
  let inBlock = false;
  let shown = '';
  let blockInOrder = false;
  for (const m of stream.matchAll(tokens)) {
    const t = m[0];
    if (t.endsWith('BDC')) stack.push(/MCID/.test(t));
    else if (t.endsWith('BMC')) stack.push(false);
    else if (t === 'EMC') stack.pop();
    else if (t === 'BT') {
      inBlock = true;
      size = 0;
      shown = '';
      blockInOrder = false;
    } else if (t === 'ET') {
      if (inBlock && shown !== '') blocks.push({ size, inReadingOrder: blockInOrder, text: shown });
      inBlock = false;
    } else if (t === 'Tf') {
      // The operands precede the operator: the size is the number before `Tf`.
      const before = stream.slice(0, m.index).trimEnd();
      const n = /\/[^\s/]+\s+(-?[\d.]+)$/.exec(before);
      size = n ? Number(n[1]) : 0;
    } else if (t === 'TJ' || t === 'Tj') {
      blockInOrder = stack.some(Boolean);
      // The operand is an array of hex glyph strings (`[<0027>20<0055>]TJ`) or one hex string.
      const before = stream.slice(0, m.index).trimEnd();
      const operand = /\[([^\]]*)\]$|<([0-9A-Fa-f]*)>$/.exec(before);
      shown += operand ? (operand[1] ?? operand[2] ?? '') : '';
    }
  }
  return blocks;
}

const compiled = async (name: string, envelope: ReturnType<typeof doc>) => {
  const c = await convertAndCompile(envelope, {
    profile: 'preview',
    title: name,
    instant: INSTANT,
    timeZone: 'Europe/London',
    suggestions: 'accept',
    layout: 'block',
    tagging: 'on',
    pdfStandard: 'none',
  } as never);
  if (!c.compile.ok || !c.compile.pdf)
    throw new Error(`the compile failed (${keep(name, c)}):\n${c.compile.log.slice(-1500)}`);
  return c;
};

describe.skipIf(!ready)(
  'EXP-036 criterion 3: the watermark is outside the tagged reading order',
  () => {
    it('prints the watermark in an artifact sequence, and the body text in an MCID sequence', async () => {
      const c = await compiled(
        'exp-036-watermark-tagging',
        doc([para('One body paragraph.')], {
          pageSetups: [
            { type: 'page_setup', attrs: { id: 'ps1', ...A4, watermark: 'Draft & 50% copy' } },
          ],
        }),
      );
      const blocks = contentStreams(c.compile.pdf!).flatMap((s) => textBlocks(s));
      // The body is 11 pt; the watermark is set in \Huge, far larger.
      const watermark = blocks.filter((b) => b.size >= 20);
      const body = blocks.filter((b) => b.size > 0 && b.size < 20);
      expect(watermark.length, 'a watermark text block is in the content stream').toBeGreaterThan(
        0,
      );
      expect(body.length, 'a body text block is in the content stream').toBeGreaterThan(0);
      // Positive control: the tagged body text is inside an MCID sequence.
      expect(body.some((b) => b.inReadingOrder)).toBe(true);
      // The criterion: no watermark block is in the reading order.
      expect(watermark.filter((b) => b.inReadingOrder)).toEqual([]);
    }, 300_000);
  },
);
