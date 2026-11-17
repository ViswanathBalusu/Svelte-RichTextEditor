/**
 * UX-047 criterion 3 through the real core: the request the assistant port is given is made from
 * the live document, and a mock port that records its input holds only the three named parts and
 * the host's attachments. Sentinel strings sit in everything else the core holds or can reach: the
 * user, the other sessions' names, the access object, a region the reader may not view and the
 * definitions. The core never holds a token (no config or attach option takes
 * one), so the check for a token is that the request's keys and text are exactly the named ones.
 * Node.js, no DOM.
 */
import type { AssistantChunk, AssistantContext, AssistantTask } from '@docedit/protocol';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { STYLE_IDS, styledDocument, styledEditorAccess } from './fixtures.ts';
import { microtask, posOf } from './support.ts';

interface Recorded {
  docId: string;
  task: AssistantTask;
  prompt: string;
  context: AssistantContext;
}

/** A port that records the request it is given, as a string and as a value. */
function recordingPort() {
  const calls: Recorded[] = [];
  const text: string[] = [];
  return {
    calls,
    text,
    port: {
      request(request: Recorded): AsyncIterable<AssistantChunk> {
        calls.push(request);
        text.push(JSON.stringify(request));
        return (async function* () {
          yield { kind: 'done', agent: 'test' } as const;
        })();
      },
    },
  };
}

const SECRET = {
  token: 'tok-SENTINEL-7f3a',
  user: 'user-SENTINEL-1c2d',
  peer: 'Peer-SENTINEL-name',
  hidden: 'HIDDEN-SENTINEL-text',
  def: 'DEFINITION-SENTINEL',
};

function core(access = styledEditorAccess()): DocumentCore {
  const doc = styledDocument();
  // A definition that holds text the request must not carry.
  const root = doc.doc as unknown as { content: Array<{ type: string; content?: unknown[] }> };
  const defs = root.content[0]!.content!;
  defs.splice(defs.length - 1, 0, {
    type: 'style_def',
    attrs: { id: 'Sentinel', kind: 'paragraph', name: SECRET.def },
  });
  const c = new DocumentCore({ doc, access, user: SECRET.user, schedule: microtask });
  c.presence.set([{ id: 'p1', user: { id: 'u-peer', name: SECRET.peer } }] as unknown as never);
  return c;
}

function select(c: DocumentCore, id: string, from: number, to: number): void {
  const i = internals(c);
  const at = posOf(i.state.doc, id) + 1;
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, at + from, at + to)));
}

describe('UX-047 criterion 3: what a port records', () => {
  it('holds the selection, the blocks around it, the outline and the host attachment, and nothing else', () => {
    const c = core();
    select(c, STYLE_IDS.plain, 0, 5);
    const rec = recordingPort();
    const { omitted, ...request } = c.assistantRequest('rewrite', 'make it formal', [
      { id: 'a1', label: 'House style', text: 'Use British spelling.' },
    ]);
    void rec.port.request(request as Recorded);
    expect(omitted).toBe(0);
    expect(Object.keys(request).sort()).toEqual(['context', 'docId', 'prompt', 'task']);
    const context = rec.calls[0]!.context as unknown as Record<string, unknown>;
    expect(Object.keys(context).sort()).toEqual(['attachments', 'blocks', 'outline', 'selection']);
    expect(context['selection']).toEqual({
      blockId: STYLE_IDS.plain,
      from: 0,
      to: 5,
      text: 'Plain',
    });
    expect((context['blocks'] as Array<{ blockId: string }>).map((b) => b.blockId)).toEqual([
      STYLE_IDS.quote,
      STYLE_IDS.inRegion,
    ]);
    expect((context['outline'] as Array<{ text: string }>).map((o) => o.text)).toEqual([
      'Introduction',
    ]);
    expect(context['attachments']).toEqual([
      { source: 'host', id: 'a1', label: 'House style', text: 'Use British spelling.' },
    ]);
    const all = rec.text.join('');
    for (const secret of Object.values(SECRET)) expect(all).not.toContain(secret);
    // Text of the body that is not selected, next to it or a heading is not in the request.
    expect(all).not.toContain('After the region');
  });

  it('gives no attachments key when the host attaches nothing, and no selection for a caret', () => {
    const c = core();
    select(c, STYLE_IDS.plain, 3, 3);
    const { context } = c.assistantRequest('answer', 'what is this?');
    expect(Object.keys(context).sort()).toEqual(['blocks', 'outline']);
  });

  it('leaves out the text of a scope the reader cannot view, and counts it', () => {
    const access = styledEditorAccess();
    access.scopes[`region:${STYLE_IDS.region}`] = [];
    const c = core(access);
    // Select across the plain paragraph, the region and the paragraph after it.
    const i = internals(c);
    const from = posOf(i.state.doc, STYLE_IDS.plain) + 1;
    const to = posOf(i.state.doc, STYLE_IDS.after) + 1 + 'After'.length;
    i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, from, to)));
    const rec = recordingPort();
    const { omitted, ...request } = c.assistantRequest('summarise', 's');
    void rec.port.request(request as Recorded);
    expect(omitted).toBeGreaterThan(0);
    const all = rec.text.join('');
    expect(all).not.toContain('Protected');
    expect(all).toContain('Plain text');
    expect(all).toContain('After');
    expect(rec.calls[0]!.context.selection?.text).toBe('Plain text\nAfter');
  });
});
