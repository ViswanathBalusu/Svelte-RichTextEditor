/**
 * Two users edit the same footer story at the same time, and both commits converge (FE-056
 * criterion 4; lane V-FE-049-064). The two sessions are real sync clients in the core against
 * backend-mock, which runs the real `Room`, so the authority's rebase is the one the product uses.
 *
 * The footer is typed the way `SubEditor` types it: the story is a sub-editor state of its own, the
 * transaction is applied there, and its steps are forwarded to the core as steps on the one
 * document (`forwardToMain`), so they go through the guard and the sync client.
 *
 * Run with `pnpm vitest run --project node packages/engine/test/fe-056-footer-converge.test.ts`.
 */
import type { CdmEnvelope } from '@docedit/model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { internals } from '../src/testing.ts';
import { forwardToMain, locate } from '../src/subeditor-sync.ts';
import { contractDocument, LEGAL_GRANT_FOR_TESTS } from './fixtures.ts';
import { join, newService, until } from './support.ts';

const FOOTER_STORY = 'stFooter00000001';
const FOOTER_PARA = 'pFooter000000001';
const TARGET = { kind: 'story' as const, id: FOOTER_STORY };

/** The contract document with a footer story after the body, and the page setup naming it. */
function documentWithFooter(): CdmEnvelope {
  const env = contractDocument();
  const top = (env.doc as unknown as { content: Array<Record<string, unknown>> }).content;
  const defs = top[0] as { content: Array<{ type: string; attrs: Record<string, unknown> }> };
  const setup = defs.content.find((n) => n.type === 'page_setup')!;
  setup.attrs['footerDefault'] = FOOTER_STORY;
  // The CDM's doc content is `defs story* body`: the story sits before the body.
  top.splice(1, 0, {
    type: 'story',
    attrs: { id: FOOTER_STORY, kind: 'footer' },
    content: [
      {
        type: 'paragraph',
        attrs: { id: FOOTER_PARA },
        content: [{ type: 'text', text: 'Footer' }],
      },
    ],
  });
  return env;
}

/** The text of the footer story in a JSON CDM document (an envelope, or the server's `Content`). */
function footerTextOfJson(env: { readonly doc: unknown }): string {
  const top = (
    env.doc as unknown as {
      content: Array<{ type: string; attrs?: { id?: string }; content?: unknown[] }>;
    }
  ).content;
  const story = top.find((n) => n.type === 'story' && n.attrs?.id === FOOTER_STORY)!;
  const text = (node: unknown): string => {
    const n = node as { text?: string; content?: unknown[] };
    return n.text ?? (n.content ?? []).map(text).join('');
  };
  return text(story);
}

type Core = Parameters<typeof internals>[0];

/** The text of the footer story in a core's document. */
function footerTextOfCore(core: Core): string {
  return internals(core).state.doc.nodeAt(locate(internals(core).state.doc, TARGET))!.textContent;
}

/** Types `text` at the start of the footer paragraph, as the footer's sub-editor does. */
function typeInFooter(core: Core, text: string): void {
  const i = internals(core);
  const pos = locate(i.state.doc, TARGET);
  expect(pos).toBeGreaterThanOrEqual(0);
  const node = i.state.doc.nodeAt(pos)!;
  const inner = EditorState.create({ doc: node });
  const tr = inner.tr.setSelection(TextSelection.create(inner.doc, 1)).insertText(text, 1);
  const outer = forwardToMain(i.state, TARGET, pos, tr.steps);
  expect(outer).not.toBeNull();
  i.dispatch(outer!);
}

const saved = (...members: Array<{ core: { saveState: { get(): string } } }>) =>
  until(() => members.every((m) => m.core.saveState.get() === 'saved'), 'saved');

describe('two users edit one footer at the same time (FE-056 criterion 4)', () => {
  it('both commits reach the authority and both sessions and the server hold the same footer', async () => {
    const service = newService();
    const docId = service.createDocument(documentWithFooter(), {
      grants: [LEGAL_GRANT_FOR_TESTS],
    });
    const a = await join(service, docId, 'olivia', 'owner');
    const b = await join(service, docId, 'eddie', 'editor');
    try {
      for (let i = 0; i < 3; i++) {
        typeInFooter(a.core, `A${i}`);
        typeInFooter(b.core, `B${i}`);
      }
      await saved(a, b);
      await until(() => footerTextOfCore(a.core) === footerTextOfCore(b.core), 'same footer');

      const server = await a.backend.sync.loadContent(docId);
      const serverFooter = footerTextOfJson(server);
      const fromA = footerTextOfCore(a.core);
      const fromB = footerTextOfCore(b.core);

      expect(fromA).toBe(fromB);
      expect(serverFooter).toBe(fromA);
      // Every typed string from both users is in the footer, once.
      for (const s of ['A0', 'A1', 'A2', 'B0', 'B1', 'B2']) {
        expect(fromA.split(s).length - 1).toBe(1);
      }
    } finally {
      a.detach();
      b.detach();
      await service.dispose();
    }
  });
});
