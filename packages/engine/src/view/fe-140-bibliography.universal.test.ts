/**
 * FE-140 criterion 2: a bibliography lists the cited sources in the document's citation style, and
 * it follows the citations as they are added and removed.
 *
 * The first suite reads the generated entries (`bibliographyEntries`) and runs everywhere. The second
 * mounts the body view and reads the list the page shows; it runs in real browser engines through
 * `pnpm vitest run --project browser <this file>` (Chromium, Firefox and WebKit) and is skipped in
 * Node.js, where there is no DOM.
 */
import type { Access } from '@docedit/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { CdmEnvelope } from '../api.ts';
import { bibliographyEntries, entryText } from '../bibliography.ts';
import { internals } from '../testing.ts';
import { caret } from '../../test/support.ts';
import { BIBLIOGRAPHY_EMPTY, BIBLIOGRAPHY_ENTRY_CLASS } from './bibliography-view.ts';
import { EditorCore } from './web.ts';

const isBrowser = typeof document !== 'undefined';

const P1 = 'pBibA00000000001';
const P2 = 'pBibB00000000001';
const EDIT = ['view', 'comment', 'suggest', 'edit'] as const;

const SMITH = 'Smith, Ann (2026). A book. London: Press.';
const JONES =
  'Jones, Bo and Cy Adams (2024). An article. Journal of Tests, 3(2), pp. 10-20. https://doi.org/10.1234/abc';
const BROWN = 'Brown Institute (2020). Uncited report.';

function envelope(style: 'authorYear' | 'numeric', include: 'cited' | 'all' = 'cited'): CdmEnvelope {
  const paragraph = (id: string, text: string) => ({
    type: 'paragraph',
    attrs: { id, style: null },
    content: [{ type: 'text', text }],
  });
  const doc = {
    type: 'doc',
    content: [
      {
        type: 'defs',
        content: [
          {
            type: 'settings',
            attrs: { lang: 'en-GB', defaultParagraphStyle: 'Normal', citationStyle: style },
          },
          {
            type: 'style_def',
            attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
          },
          { type: 'page_setup', attrs: { id: 'ps1' } },
          {
            type: 'source_def',
            attrs: {
              id: 'smith2026',
              kind: 'book',
              title: 'A book',
              authors: [{ family: 'Smith', given: 'Ann' }],
              issued: '2026',
              publisher: 'Press',
              publisherPlace: 'London',
            },
          },
          {
            type: 'source_def',
            attrs: {
              id: 'jones2024',
              kind: 'article-journal',
              title: 'An article',
              authors: [
                { family: 'Jones', given: 'Bo' },
                { family: 'Adams', given: 'Cy' },
              ],
              issued: '2024-05',
              containerTitle: 'Journal of Tests',
              volume: '3',
              issue: '2',
              pages: '10-20',
              doi: '10.1234/abc',
            },
          },
          {
            type: 'source_def',
            attrs: {
              id: 'brown2020',
              kind: 'report',
              title: 'Uncited report',
              authors: [{ literal: 'Brown Institute' }],
              issued: '2020',
            },
          },
        ],
      },
      {
        type: 'body',
        attrs: { pageSetup: 'ps1' },
        content: [
          paragraph(P1, 'Alpha beta'),
          paragraph(P2, 'Gamma delta'),
          { type: 'bibliography', attrs: { id: 'bBib000000000001', include } },
        ],
      },
    ],
  };
  return { cdm: 1, requires: [], doc } as unknown as CdmEnvelope;
}

function access(): Access {
  return {
    rev: 1,
    asOfSeq: 0,
    docRole: 'editor',
    caps: [...EDIT],
    scopes: { doc: ['view'], body: [...EDIT], defs: ['view'] },
    leases: {},
    fill: null,
    restrictions: [],
  };
}

function newCore(style: 'authorYear' | 'numeric', include: 'cited' | 'all' = 'cited'): EditorCore {
  return new EditorCore({
    doc: envelope(style, include),
    access: access(),
    schedule: (run) => queueMicrotask(run),
  });
}

function cite(core: EditorCore, paragraph: string, source: string): boolean {
  caret(core, paragraph, 3);
  return core.run('insertCitation', { citation: { items: [{ source }] } });
}

/** Deletes the last citation of the document that names `source`. */
function removeCitation(core: EditorCore, source: string): void {
  const i = internals(core);
  let at = -1;
  i.state.doc.descendants((node, pos) => {
    const items = node.attrs['items'] as Array<{ source: string }> | undefined;
    if (node.type.name === 'citation' && items?.some((item) => item.source === source)) at = pos;
  });
  if (at < 0) throw new Error(`no citation of ${source}`);
  i.dispatch(i.state.tr.delete(at, at + 1));
}

const texts = (core: EditorCore, include: 'cited' | 'all' = 'cited'): string[] =>
  bibliographyEntries(internals(core).state.doc, include).map(entryText);

describe('the generated entries of a bibliography (FE-140 criterion 2)', () => {
  it('lists nothing before a source is cited, and follows citations as they come and go', () => {
    const core = newCore('authorYear');
    expect(texts(core)).toEqual([]);

    expect(cite(core, P1, 'smith2026')).toBe(true);
    expect(texts(core)).toEqual([SMITH]);
    expect(cite(core, P2, 'jones2024')).toBe(true);
    // Author and year style: by first author, whatever the order of the citations.
    expect(texts(core)).toEqual([JONES, SMITH]);

    // A second citation of a listed source adds no entry.
    expect(cite(core, P2, 'smith2026')).toBe(true);
    expect(texts(core)).toEqual([JONES, SMITH]);

    // Removing a citation removes its entry once no other citation names the source.
    removeCitation(core, 'smith2026');
    expect(texts(core)).toEqual([JONES, SMITH]);
    removeCitation(core, 'jones2024');
    expect(texts(core)).toEqual([SMITH]);
    removeCitation(core, 'smith2026');
    expect(texts(core)).toEqual([]);
    core.destroy();
  });

  it('numbers the entries in the order of first citation in the numeric style', () => {
    const core = newCore('numeric');
    expect(cite(core, P2, 'jones2024')).toBe(true);
    expect(cite(core, P1, 'smith2026')).toBe(true);
    // The first paragraph comes first in the document, so its source is number 1.
    expect(texts(core)).toEqual([`[1] ${SMITH}`, `[2] ${JONES}`]);
    // `include: all` adds the sources no citation names, after the cited ones.
    expect(texts(core, 'all')).toEqual([`[1] ${SMITH}`, `[2] ${JONES}`, `[3] ${BROWN}`]);
    core.destroy();
  });

  it('sets whole works and containers in italics, and marks the address', () => {
    const core = newCore('authorYear', 'all');
    const entries = bibliographyEntries(internals(core).state.doc, 'all');
    expect(entries.map((e) => e.sourceId)).toEqual(['brown2020', 'jones2024', 'smith2026']);
    const italic = (id: string) =>
      entries
        .find((e) => e.sourceId === id)!
        .parts.filter((p) => p.italic)
        .map((p) => p.text);
    expect(italic('smith2026')).toEqual(['A book. ']);
    expect(italic('jones2024')).toEqual(['Journal of Tests']);
    const jones = entries.find((e) => e.sourceId === 'jones2024')!;
    expect(jones.parts.at(-1)).toEqual({
      text: 'https://doi.org/10.1234/abc',
      url: 'https://doi.org/10.1234/abc',
    });
    core.destroy();
  });

  it('gives sources with the same author and year a letter after the year', () => {
    const env = envelope('authorYear', 'all') as unknown as {
      doc: { content: Array<{ content: Array<{ type: string; attrs: Record<string, unknown> }> }> };
    };
    env.doc.content[0]!.content.push({
      type: 'source_def',
      attrs: {
        id: 'smith2026b',
        kind: 'book',
        title: 'Another book',
        authors: [{ family: 'Smith', given: 'Ann' }],
        issued: '2026',
      },
    });
    const core = new EditorCore({
      doc: env as unknown as CdmEnvelope,
      access: access(),
      schedule: (run) => queueMicrotask(run),
    });
    expect(texts(core, 'all').filter((t) => t.startsWith('Smith'))).toEqual([
      'Smith, Ann (2026a). A book. London: Press.',
      'Smith, Ann (2026b). Another book.',
    ]);
    core.destroy();
  });
});

describe.skipIf(!isBrowser)('the bibliography in the body view (FE-140 criterion 2)', () => {
  it('shows the cited sources and updates as citations are added and removed', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const core = newCore('numeric');
    const unmount = core.mountBody(host);
    try {
      const list = host.querySelector<HTMLElement>('.de-bibliography');
      if (!list) throw new Error('the bibliography was not drawn');
      const shown = (): string[] =>
        [...list.querySelectorAll(`.${BIBLIOGRAPHY_ENTRY_CLASS}[role="listitem"]`)].map(
          (el) => el.textContent ?? '',
        );

      // One non-editable list, empty before any citation.
      expect(list.getAttribute('role')).toBe('list');
      expect(list.getAttribute('aria-label')).toBe('Bibliography');
      expect(list.isContentEditable).toBe(false);
      expect(shown()).toEqual([]);
      expect(list.textContent).toBe(BIBLIOGRAPHY_EMPTY);

      expect(cite(core, P2, 'jones2024')).toBe(true);
      await vi.waitFor(() => expect(shown()).toEqual([`[1] ${JONES}`]));
      // The container is in italics and the address is text, not a link.
      expect([...list.querySelectorAll('i')].map((i) => i.textContent)).toEqual([
        'Journal of Tests',
      ]);
      expect(list.querySelector('a')).toBeNull();

      // A citation earlier in the document renumbers the list.
      expect(cite(core, P1, 'smith2026')).toBe(true);
      await vi.waitFor(() => expect(shown()).toEqual([`[1] ${SMITH}`, `[2] ${JONES}`]));

      // Removing a citation removes its entry.
      removeCitation(core, 'smith2026');
      await vi.waitFor(() => expect(shown()).toEqual([`[1] ${JONES}`]));
      removeCitation(core, 'jones2024');
      await vi.waitFor(() => expect(shown()).toEqual([]));
      expect(list.textContent).toBe(BIBLIOGRAPHY_EMPTY);

      // The same element is kept: the list is redrawn in place, and the node stores no entry.
      expect(host.querySelector('.de-bibliography')).toBe(list);
      const stored: unknown[] = [];
      internals(core).state.doc.descendants((n) => {
        if (n.type.name === 'bibliography') stored.push(n.toJSON());
      });
      expect(JSON.stringify(stored)).not.toContain('Jones');
    } finally {
      unmount();
      core.destroy();
      host.remove();
    }
  });
});
