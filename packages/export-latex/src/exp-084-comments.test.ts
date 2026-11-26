/**
 * Comments in the margin (EXP-084 criteria 1, 3 and 4; Node.js only). The threads come from the
 * job (`commentThreads`); the converter places them. Nothing here compiles: `exp-084-comments.compile.test.ts`
 * compiles the same kind of document. The rules are proposed in docs/adr/0428-w2-exp-084-margin-comments.md.
 */
import { describe, expect, it } from 'vitest';
import { doc, para, run } from '../test/docs.ts';
import type { CommentThread } from './bundle.ts';

const A = 'pAAAAAAAAAAAAAAA';
const B = 'pBBBBBBBBBBBBBBB';

const body = () => [para('First paragraph.', { id: A }), para('Second paragraph.', { id: B })];

const thread = (over: Partial<CommentThread> = {}): CommentThread => ({
  id: 'tAAAAAAAAAAAAAAA',
  block: B,
  quote: 'Second',
  messages: [
    { author: 'Ada Lovelace', text: 'Please check this.' },
    { author: 'Grace Hopper', text: 'Done.' },
  ],
  ...over,
});

const main = async (options: Record<string, unknown>) => {
  const b = await run(doc(body()), options);
  return { b, tex: b.files['main.tex'] as string };
};

describe('EXP-084 margin comments in the converter', () => {
  it('prints a note beside the paragraph with `margin`, and nothing with `none` or no option', async () => {
    const withNote = await main({ comments: 'margin', commentThreads: [thread()] });
    expect(withNote.tex).toContain('\\DEmargin{');
    expect(withNote.tex).toContain('\\DEnote{Ada Lovelace}{Please check this.}');
    expect(withNote.tex).toContain('\\DEnote{Grace Hopper}{Done.}');
    expect(withNote.tex).toContain('\\DEquote{Second}');
    // The note is in the second paragraph's macro, not the first.
    const at = (s: string) => withNote.tex.indexOf(s);
    expect(at('\\DEmargin{')).toBeGreaterThan(at('First'));
    expect(at('\\DEmargin{')).toBeLessThan(at('Second paragraph'));
    for (const options of [{ comments: 'none' }, {}]) {
      const none = await main({ ...options, commentThreads: [thread()] });
      expect(none.tex).not.toContain('DEmargin');
      expect(none.tex).not.toContain('Ada');
      expect(none.b.diagnostics.map((d) => d.code)).not.toContain('comment_detached');
    }
  });

  it('leaves out a resolved thread (owner decision 52)', async () => {
    const r = await main({ comments: 'margin', commentThreads: [thread({ done: true })] });
    expect(r.tex).not.toContain('Ada');
    expect(r.tex).not.toContain('DEunplaced');
  });

  it('lists a detached thread at the end with a warning, and does not anchor it (criterion 3)', async () => {
    const r = await main({ comments: 'margin', commentThreads: [thread({ detached: true })] });
    expect(r.tex).not.toContain('\\DEmargin{');
    expect(r.tex).toContain('\\DEunplacedhead');
    expect(r.tex).toContain('\\DEnote{Ada Lovelace}');
    const d = r.b.diagnostics.find((x) => x.code === 'comment_detached');
    expect(d?.severity).toBe('warning');
    expect(d?.blockId).toBe(B);
    // The list comes after the last paragraph.
    expect(r.tex.indexOf('\\DEunplacedhead')).toBeGreaterThan(r.tex.indexOf('Second paragraph'));
  });

  it('lists a thread whose paragraph is not in the document, naming no block', async () => {
    const r = await main({
      comments: 'margin',
      commentThreads: [thread({ block: 'pZZZZZZZZZZZZZZZ' })],
    });
    expect(r.tex).toContain('\\DEunplacedhead');
    const d = r.b.diagnostics.find((x) => x.code === 'comment_not_in_margin');
    expect(d?.blockId).toBeNull();
  });

  it('lists a thread on a heading or a table cell paragraph, which have no margin', async () => {
    const head = para('A heading', { id: A, style: 'Heading1' });
    const b = await run(doc([head, para('Text.', { id: B })]), {
      comments: 'margin',
      commentThreads: [thread({ block: A })],
    });
    const tex = b.files['main.tex'] as string;
    // A heading's note follows the heading; it is a note in the margin all the same.
    expect(tex).toContain('\\DEmargin{');
    expect(tex).not.toContain('\\DEunplacedhead');
  });

  it('writes text through the text emitter (criterion 4): TeX specials are escaped', async () => {
    const hostile = '\\input{x} $x$ 100% {a} #1 ~ ^ _ & [b]\nsecond line';
    const r = await main({
      comments: 'margin',
      commentThreads: [
        thread({ quote: '\\write18{x}', messages: [{ author: '}\\bad{', text: hostile }] }),
      ],
    });
    expect(r.tex).not.toMatch(/\\input\{x\}/);
    expect(r.tex).not.toContain('\\write18');
    expect(r.tex).not.toContain('\\bad{');
    expect(r.tex).toContain('\\textbackslash{}input\\{x\\}');
    expect(r.tex).toContain('100\\%');
    expect(r.tex).not.toContain('\nsecond line');
  });

  it('prints two threads on one paragraph in one note, and bounds the messages', async () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ author: 'A', text: `m${i}` }));
    const r = await main({
      comments: 'margin',
      commentThreads: [thread(), thread({ id: 'tBBBBBBBBBBBBBBB', messages: many })],
    });
    expect(r.tex.match(/\\DEmargin\{/g)).toHaveLength(1);
    expect(r.b.diagnostics.map((d) => d.code)).toContain('comments_truncated');
    expect(r.tex).toContain('{m49}');
    expect(r.tex).not.toContain('{m50}');
  });

  it('adds `comments` to the manifest only for margin, and changes the bundle', async () => {
    const plain = await main({});
    const margin = await main({ comments: 'margin', commentThreads: [thread()] });
    const options = (b: typeof plain.b) =>
      (JSON.parse(b.files['manifest.json'] as string) as { options: Record<string, unknown> })
        .options;
    expect(options(plain.b)['comments']).toBeUndefined();
    expect(options(margin.b)['comments']).toBe('margin');
    expect(plain.tex).not.toBe(margin.tex);
  });
});

void run;
