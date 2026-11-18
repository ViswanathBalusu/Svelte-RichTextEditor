/**
 * FE-058 criterion 3 in a real browser: the footnote marks the web view renders in the body come from
 * the shared numbering algorithm, with `footnoteFormat` and `footnoteRestart`. The body is mounted, and
 * the `data-n` attribute of each rendered reference mark (the text the stylesheet prints with
 * `content: attr(data-n)`) is read from the DOM. The stylesheet is the element's and is not loaded here.
 *
 * Runs in real browser engines through `pnpm vitest run --project browser <this file>`. In Node.js
 * there is no DOM, so the suite is skipped there.
 */
import { describe, expect, it } from 'vitest';
import type { CdmEnvelope } from '../api.ts';
import { ownerAccess } from '../../test/fixtures.ts';
import { spikeDocument } from '../spike-document.ts';
import { EditorCore } from './web.ts';

const isBrowser = typeof document !== 'undefined' && typeof DataTransfer !== 'undefined';

type J = { type: string; attrs?: Record<string, unknown>; content?: J[]; text?: string };

const note = (id: string, paragraph: string): J => ({
  type: 'footnote',
  attrs: { id },
  content: [
    { type: 'paragraph', attrs: { id: paragraph }, content: [{ type: 'text', text: 'Note' }] },
  ],
});

const para = (id: string, content: J[]): J => ({
  type: 'paragraph',
  attrs: { id, style: 'Normal' },
  content,
});

/** Three footnotes in the body, with a section break before the third. */
function document3(settings: Record<string, unknown>): CdmEnvelope {
  const env = spikeDocument();
  const doc = env.doc as unknown as J;
  const sets = doc
    .content!.find((n) => n.type === 'defs')!
    .content!.find((n) => n.type === 'settings')!;
  sets.attrs = { ...sets.attrs, ...settings };
  doc.content!.find((n) => n.type === 'body')!.content = [
    para('pA0000000000001', [
      { type: 'text', text: 'One' },
      note('fnA0000000000001', 'pnA000000000001'),
    ]),
    para('pB0000000000001', [
      { type: 'text', text: 'Two' },
      note('fnB0000000000001', 'pnB000000000001'),
    ]),
    {
      type: 'section_break',
      attrs: { id: 'sbA0000000000001', pageSetup: 'ps1', start: 'nextPage' },
    },
    para('pC0000000000001', [
      { type: 'text', text: 'Three' },
      note('fnC0000000000001', 'pnC000000000001'),
    ]),
  ];
  return env;
}

/** Mounts the body, reads the rendered marks and unmounts. */
function renderedMarks(settings: Record<string, unknown>): { marks: string[]; labels: string[] } {
  const host = document.createElement('div');
  document.body.append(host);
  const core = new EditorCore({
    doc: document3(settings),
    access: ownerAccess(),
    schedule: (run) => queueMicrotask(run),
  });
  const unmount = core.mountBody(host);
  try {
    const refs = [...document.querySelectorAll<HTMLElement>('.de-footnote-ref')];
    return {
      marks: refs.map((el) => el.getAttribute('data-n') ?? ''),
      labels: refs.map((el) => el.getAttribute('aria-label') ?? ''),
    };
  } finally {
    unmount();
    core.destroy();
    host.remove();
  }
}

describe.skipIf(!isBrowser)('rendered footnote marks (FE-058 criterion 3)', () => {
  it('counts in the decimal format by default', () => {
    expect(renderedMarks({}).marks).toEqual(['1', '2', '3']);
  });

  it('takes the format of footnoteFormat', () => {
    expect(renderedMarks({ footnoteFormat: 'lowerRoman' }).marks).toEqual(['i', 'ii', 'iii']);
    const symbols = renderedMarks({ footnoteFormat: 'symbol' });
    expect(symbols.marks).toEqual(['*', '†', '‡']);
    expect(symbols.labels).toEqual(['Footnote *', 'Footnote †', 'Footnote ‡']);
  });

  it('restarts at the section break under perPageSection, and not under continuous', () => {
    expect(renderedMarks({ footnoteRestart: 'perPageSection' }).marks).toEqual(['1', '2', '1']);
    expect(renderedMarks({ footnoteRestart: 'continuous' }).marks).toEqual(['1', '2', '3']);
  });
});
