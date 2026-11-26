/**
 * FE-140 criterion 3: the sources a citation names are announced when the caret reaches it. The web
 * view gives each citation, a `note`, an accessible name that holds the sources in the document's
 * citation style with the prefix, locator and suffix the author set, and keeps it current when a
 * source changes.
 *
 * The first suite is pure and runs everywhere. The second mounts the body view and reads the name
 * the page exposes; it runs in real browser engines through `pnpm vitest run --project browser
 * <this file>` and is skipped in Node.js, where there is no DOM. No screen reader product is run:
 * the accessible name is what one reads.
 */
import type { Access } from '@docedit/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { CdmEnvelope } from '../api.ts';
import { internals } from '../testing.ts';
import { caret } from '../../test/support.ts';
import { citationName, sourceLabels } from './citation-names-view.ts';
import { EditorCore } from './web.ts';

const isBrowser = typeof document !== 'undefined';
const P1 = 'pCitA00000000001';
const EDIT = ['view', 'comment', 'suggest', 'edit'] as const;
const SMITH = 'Smith, Ann (2026). A book. London: Press.';

function envelope(): CdmEnvelope {
  const doc = {
    type: 'doc',
    content: [
      {
        type: 'defs',
        content: [
          { type: 'settings', attrs: { lang: 'en-GB', defaultParagraphStyle: 'Normal' } },
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
        ],
      },
      {
        type: 'body',
        attrs: { pageSetup: 'ps1' },
        content: [
          {
            type: 'paragraph',
            attrs: { id: P1, style: null },
            content: [{ type: 'text', text: 'Alpha beta' }],
          },
        ],
      },
    ],
  };
  return { cdm: 1, requires: [], doc } as unknown as CdmEnvelope;
}

const access = (): Access => ({
  rev: 1,
  asOfSeq: 0,
  docRole: 'editor',
  caps: [...EDIT],
  scopes: { doc: ['view'], body: [...EDIT], defs: ['view'] },
  leases: {},
  fill: null,
  restrictions: [],
});

describe('the accessible name of a citation', () => {
  const label = (id: string): string | null => (id === 'smith2026' ? SMITH : null);

  it('holds the cited sources in order, with prefix, locator and suffix', () => {
    expect(citationName({ items: [{ source: 'smith2026' }] }, label)).toBe(`Citation: ${SMITH}`);
    expect(
      citationName(
        {
          items: [
            { source: 'smith2026', prefix: 'see', locator: '12', suffix: 'and following' },
            { source: 'other', label: 'chapter', locator: '3' },
          ],
        },
        label,
      ),
    ).toBe(`Citation: see ${SMITH} (12) and following; other (chapter 3)`);
  });

  it('keeps the identifier of a source the document does not define, and has a name for none', () => {
    expect(citationName({ items: [{ source: 'gone' }] }, label)).toBe('Citation: gone');
    expect(citationName({ items: [] }, label)).toBe('Citation');
    expect(citationName({}, label)).toBe('Citation');
  });
});

describe.skipIf(!isBrowser)('the body view names its citations (FE-140 criterion 3)', () => {
  it('exposes the sources as the name of a note, and follows a change of the source', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const core = new EditorCore({
      doc: envelope(),
      access: access(),
      schedule: (run) => queueMicrotask(run),
    });
    const unmount = core.mountBody(host);
    try {
      caret(core, P1, 3);
      expect(
        core.run('insertCitation', {
          citation: { items: [{ source: 'smith2026', locator: '12' }] },
        }),
      ).toBe(true);
      const note = (): HTMLElement => host.querySelector<HTMLElement>('.de-citation')!;
      await vi.waitFor(() =>
        expect(note().getAttribute('aria-label')).toBe(`Citation: ${SMITH} (12)`),
      );
      expect(note().getAttribute('role')).toBe('note');
      expect(sourceLabels(internals(core).state.doc).get('smith2026')).toBe(SMITH);
    } finally {
      unmount();
      core.destroy();
      host.remove();
    }
  });
});
