/**
 * EXP-093 criterion 4 (comment threads become Word comments with replies, anchored to a block):
 * the paragraph gets a range start, a range end and a reference for each message, `comments.xml`
 * holds the messages with their authors and dates, and `commentsExtended.xml` links each reply to
 * its root. The text range form of the criterion is not built (see the story's Notes).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { newDocument, type JsonEnvelope, type JsonNode } from '@docedit/model';
import { AssetStore, entryData, parseXml, readZip, type XmlElement } from '../src/index.ts';
import { writeDocx, type WriteResult } from '../src/writer.ts';
import type { CommentThread } from '../src/writer-comments.ts';

const pid = (n: number): string => `p${String(n).padStart(15, '0')}`;

function envelopeWith(paragraphs: string[]): JsonEnvelope {
  const env = newDocument({ lang: 'en-GB' });
  const body = env.doc.content!.find((n) => n.type === 'body')!;
  body.content = paragraphs.map(
    (text, i) =>
      ({
        type: 'paragraph',
        attrs: { id: pid(i + 1) },
        content: [{ type: 'text', text }],
      }) as JsonNode,
  );
  return env;
}

async function write(env: JsonEnvelope, comments?: CommentThread[]): Promise<WriteResult> {
  return writeDocx(env, new AssetStore(), comments ? { comments } : {});
}

function partText(res: WriteResult, name: string): string | undefined {
  const zip = readZip(res.bytes);
  const e = zip.entries.find((x) => x.name === name);
  return e ? new TextDecoder().decode(entryData(zip, e)) : undefined;
}

function all(root: XmlElement, local: string): XmlElement[] {
  const out: XmlElement[] = [];
  const stack = [root];
  while (stack.length) {
    const e = stack.pop()!;
    if (e.local === local) out.push(e);
    for (let i = e.children.length - 1; i >= 0; i--) {
      const c = e.children[i]!;
      if (c.kind === 'element') stack.push(c);
    }
  }
  return out;
}

const attr = (e: XmlElement, local: string): string | undefined =>
  e.attrs.find((a) => a.local === local)?.value;

const parse = (text: string): XmlElement => parseXml(new TextEncoder().encode(text)).root;

/** The text of every `w:t` under an element, in document order. */
const textOf = (e: XmlElement): string =>
  all(e, 't')
    .map((t) => t.children.map((c) => (c.kind === 'text' ? c.value : '')).join(''))
    .join('');

const thread: CommentThread = {
  id: 'thr-1',
  block: pid(2),
  messages: [
    { author: 'word: Ada Lovelace', date: '2026-11-07T10:00:00Z', text: 'Check the figure' },
    { author: 'word: Grace Hopper', date: '2026-11-07T11:30:00Z', text: 'Done & verified' },
  ],
};

describe('EXP-093 criterion 4: comment threads become Word comments with replies', () => {
  it('anchors every message of a thread to its paragraph with a range and a reference', async () => {
    const res = await write(envelopeWith(['First', 'Second', 'Third']), [thread]);
    const docXml = parse(partText(res, 'word/document.xml')!);
    const paras = all(docXml, 'p');
    const second = paras[1]!;
    const starts = all(second, 'commentRangeStart').map((e) => attr(e, 'id'));
    const ends = all(second, 'commentRangeEnd').map((e) => attr(e, 'id'));
    const refs = all(second, 'commentReference').map((e) => attr(e, 'id'));
    expect(starts).toEqual(['0', '1']);
    expect(ends).toEqual(['0', '1']);
    expect(refs).toEqual(['0', '1']);
    // The other paragraphs carry no comment markers.
    expect(all(paras[0]!, 'commentRangeStart')).toHaveLength(0);
    expect(all(paras[2]!, 'commentReference')).toHaveLength(0);
  });

  it('writes each message with its author, date and text in comments.xml', async () => {
    const res = await write(envelopeWith(['First', 'Second']), [thread]);
    const comments = all(parse(partText(res, 'word/comments.xml')!), 'comment');
    expect(comments).toHaveLength(2);
    expect(attr(comments[0]!, 'author')).toBe('word: Ada Lovelace');
    expect(attr(comments[0]!, 'date')).toBe('2026-11-07T10:00:00Z');
    expect(textOf(comments[0]!)).toBe('Check the figure');
    expect(attr(comments[1]!, 'author')).toBe('word: Grace Hopper');
    expect(textOf(comments[1]!)).toBe('Done & verified');
  });

  it('links each reply to its root in commentsExtended.xml', async () => {
    const res = await write(envelopeWith(['First', 'Second']), [thread]);
    const ext = all(parse(partText(res, 'word/commentsExtended.xml')!), 'commentEx');
    expect(ext).toHaveLength(2);
    const rootPara = attr(ext[0]!, 'paraId');
    expect(rootPara).toMatch(/^[0-7][0-9A-F]{7}$/);
    expect(attr(ext[0]!, 'paraIdParent')).toBeUndefined();
    expect(attr(ext[1]!, 'paraIdParent')).toBe(rootPara);
    expect(attr(ext[0]!, 'done')).toBe('0');
  });

  it('connects the comment parts from the document and declares their content types', async () => {
    const res = await write(envelopeWith(['First', 'Second']), [thread]);
    const rels = partText(res, 'word/_rels/document.xml.rels')!;
    expect(rels).toContain('Target="comments.xml"');
    expect(rels).toContain('Target="commentsExtended.xml"');
    const types = partText(res, '[Content_Types].xml')!;
    expect(types).toContain('/word/comments.xml');
    expect(types).toContain('/word/commentsExtended.xml');
  });

  it('writes no comment part when there is no thread', async () => {
    const res = await write(envelopeWith(['First']));
    expect(partText(res, 'word/comments.xml')).toBeUndefined();
    expect(partText(res, 'word/commentsExtended.xml')).toBeUndefined();
  });

  it('leaves out a thread whose paragraph is not in the document, with a warning', async () => {
    const orphan: CommentThread = {
      id: 'thr-2',
      block: 'pMissingBlock',
      messages: thread.messages,
    };
    const res = await write(envelopeWith(['First', 'Second']), [orphan]);
    expect(partText(res, 'word/comments.xml')).toBeUndefined();
    expect(res.warnings.join('\n')).toContain('names no paragraph of the document');
  });

  it('never writes a thread with no message, and says so', async () => {
    const empty: CommentThread = { id: 'thr-3', block: pid(1), messages: [] };
    const res = await write(envelopeWith(['First', 'Second']), [empty, thread]);
    const comments = all(parse(partText(res, 'word/comments.xml')!), 'comment');
    expect(comments).toHaveLength(2);
    expect(res.warnings.join('\n')).toContain('no message is not written');
  });

  it('keeps any author and text through the XML escaping (fast-check, seed 20261113)', async () => {
    // Line breaks split a comment into paragraphs, so the property uses single-line text.
    // Array.from keeps each emoji whole; splitting it would leave lone surrogates, which XML cannot carry.
    const chars = fc.constantFrom(...Array.from('aZ 09<>&"\'!?-éü€😀\t'));
    const line = fc.array(chars, { minLength: 1, maxLength: 40 }).map((cs) => cs.join(''));
    await fc.assert(
      fc.asyncProperty(line, line, async (author, body) => {
        const t: CommentThread = {
          id: 'thr-x',
          block: pid(1),
          messages: [{ author, text: body }],
        };
        const res = await write(envelopeWith(['First']), [t]);
        const comment = all(parse(partText(res, 'word/comments.xml')!), 'comment')[0]!;
        expect(attr(comment, 'author')).toBe(author);
        expect(textOf(comment)).toBe(body);
      }),
      { seed: 20261113, numRuns: 30 },
    );
  });
});
