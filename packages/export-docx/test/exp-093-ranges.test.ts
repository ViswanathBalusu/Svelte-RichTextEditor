/**
 * EXP-093 criterion 4, the range form (owner decision 102: the exact range of text the thread is
 * on): a thread with `from` and `to` is anchored to that text, not to the whole paragraph. The
 * markers are woven in at the positions of the paragraph's inline content, splitting a text node
 * where one falls inside it; an atom counts as one position. Threads without a range keep the
 * block form (`exp-093-comments.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import { newDocument, type JsonEnvelope, type JsonNode } from '@docedit/model';
import { AssetStore, entryData, readZip } from '../src/index.ts';
import { writeDocx } from '../src/writer.ts';
import { weaveAnchors, type CommentThread } from '../src/writer-comments.ts';

const P1 = 'p000000000000001';

function envelopeWith(content: JsonNode[]): JsonEnvelope {
  const env = newDocument({ lang: 'en-GB' });
  const body = env.doc.content!.find((n) => n.type === 'body')!;
  body.content = [{ type: 'paragraph', attrs: { id: P1 }, content } as JsonNode];
  return env;
}

const text = (t: string, marks: JsonNode[] = []): JsonNode =>
  (marks.length ? { type: 'text', text: t, marks } : { type: 'text', text: t }) as JsonNode;

async function documentXml(env: JsonEnvelope, comments: CommentThread[]): Promise<string> {
  const res = await writeDocx(env, new AssetStore(), { comments });
  const zip = readZip(res.bytes);
  return new TextDecoder().decode(
    entryData(
      zip,
      zip.entries.find((e) => e.name === 'word/document.xml')!,
    ),
  );
}

/** The text the thread's first message covers: the `w:t` between its range start and end. */
function covered(xml: string, id: number): string {
  const start = xml.indexOf(`<w:commentRangeStart w:id="${id}"/>`);
  const end = xml.indexOf(`<w:commentRangeEnd w:id="${id}"/>`);
  expect(start, `start of comment ${id}`).toBeGreaterThanOrEqual(0);
  expect(end, `end of comment ${id}`).toBeGreaterThan(start);
  return [...xml.slice(start, end).matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)]
    .map((m) => m[1])
    .join('');
}

const thread = (over: Partial<CommentThread> = {}): CommentThread => ({
  id: 'thr-1',
  block: P1,
  messages: [{ author: 'Ada Lovelace', text: 'Why?' }],
  ...over,
});

describe('EXP-093 criterion 4: a comment is anchored to its range', () => {
  it('covers exactly the text of the range, inside one run', async () => {
    const xml = await documentXml(envelopeWith([text('Alpha beta gamma delta')]), [
      thread({ from: 6, to: 10 }),
    ]);
    expect(covered(xml, 0)).toBe('beta');
    // The text on both sides is still there, in order, outside the range.
    const plain = [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('');
    expect(plain).toBe('Alpha beta gamma delta');
  });

  it('covers a range that crosses runs of different formatting, and counts an atom as one', async () => {
    const bold = [{ type: 'bold' }] as JsonNode[];
    const content = [
      text('Alpha '),
      text('beta', bold),
      { type: 'tab' } as JsonNode,
      text(' gamma'),
    ];
    // Positions: `Alpha ` 0-6, `beta` 6-10, the tab 10-11, ` gamma` 11-17. From 8 to 14: `ta`, the
    // tab and ` ga`.
    const xml = await documentXml(envelopeWith(content), [thread({ from: 8, to: 14 })]);
    expect(covered(xml, 0)).toBe('ta ga');
    const between = xml.slice(
      xml.indexOf('<w:commentRangeStart'),
      xml.indexOf('<w:commentRangeEnd'),
    );
    expect(between).toContain('<w:tab/>');
  });

  it('gives each reply the same range, and the reference after the range end', async () => {
    const xml = await documentXml(envelopeWith([text('Alpha beta gamma')]), [
      thread({
        from: 0,
        to: 5,
        messages: [
          { author: 'Ada Lovelace', text: 'Why?' },
          { author: 'Grace Hopper', text: 'Because.' },
        ],
      }),
    ]);
    expect(covered(xml, 0)).toBe('Alpha');
    expect(covered(xml, 1)).toBe('Alpha');
    expect(xml.indexOf('<w:commentRangeEnd w:id="1"/>')).toBeLessThan(
      xml.indexOf('<w:commentReference w:id="1"/>'),
    );
  });

  it('cuts a range that runs past the paragraph, and keeps the block form without a range', async () => {
    const clipped = await documentXml(envelopeWith([text('Alpha beta')]), [
      thread({ from: 6, to: 999 }),
    ]);
    expect(covered(clipped, 0)).toBe('beta');
    for (const t of [thread(), thread({ from: 4, to: 2 }), thread({ from: 1.5, to: 3 })]) {
      const whole = await documentXml(envelopeWith([text('Alpha beta')]), [t]);
      expect(covered(whole, 0)).toBe('Alpha beta');
    }
  });

  it('keeps overlapping threads apart, each on its own text', async () => {
    const xml = await documentXml(envelopeWith([text('Alpha beta gamma delta')]), [
      thread({ id: 'a', from: 0, to: 10 }),
      thread({ id: 'b', from: 6, to: 16 }),
    ]);
    expect(covered(xml, 0)).toBe('Alpha beta');
    expect(covered(xml, 1)).toBe('beta gamma');
  });
});

describe('weaveAnchors', () => {
  it('returns the content itself with no marker, and does not change it with some', () => {
    const content = [text('Alpha beta')];
    expect(weaveAnchors(content, [])).toBe(content);
    const before = JSON.stringify(content);
    const woven = weaveAnchors(content, [{ offset: 5, raw: '<m/>' }]);
    expect(JSON.stringify(content)).toBe(before);
    expect(woven.map((n) => (n.type === 'text' ? n.text : 'marker'))).toEqual([
      'Alpha',
      'marker',
      ' beta',
    ]);
  });

  it('puts markers at the start and the end, and keeps the order of markers at one position', () => {
    const woven = weaveAnchors(
      [text('ab')],
      [
        { offset: 2, raw: 'E1' },
        { offset: 0, raw: 'S1' },
        { offset: 2, raw: 'E2' },
        { offset: 99, raw: 'E3' },
      ],
    );
    expect(woven.map((n) => (n.type === 'text' ? n.text : (n.attrs?.['raw'] as string)))).toEqual([
      'S1',
      'ab',
      'E1',
      'E2',
      'E3',
    ]);
  });
});
