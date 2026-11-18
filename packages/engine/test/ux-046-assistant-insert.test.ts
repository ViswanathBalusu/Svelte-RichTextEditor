/**
 * An approved assistant result enters the document as suggestions (UX-046 criteria 1 and 4; 13 §6.2;
 * 07 §5.2 P4). Members join the mock service (the real authority room). `insertAssistantResult` puts
 * the text at the selection as suggestions by the user whatever the role or edit mode, so an editor's
 * result is never a direct edit. Where the user holds no `suggest` it is refused, nothing is applied and
 * nothing is sent. The commit carries the origin hint `assistant`.
 */
import { describe, expect, it } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import { internals } from '../src/testing.ts';
import { IDS, LEGAL_GRANT_FOR_TESTS, contractDocument } from './fixtures.ts';
import { join, newService, traffic, until, type Member } from './support.ts';

interface JsonNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

const saved = (m: Member): Promise<void> =>
  until(() => m.core.saveState.get() === 'saved', 'saved', 5000);

/** The runs of a paragraph on the server, with the suggestion marks as `kind:user`. */
function serverRuns(
  service: Awaited<ReturnType<typeof setUp>>['service'],
  docId: string,
  id: string,
): [string, string[]][] {
  const doc = service.document(docId)!.content().doc as unknown as JsonNode;
  const find = (n: JsonNode): JsonNode | null => {
    if (n.attrs?.['id'] === id) return n;
    for (const c of n.content ?? []) {
      const r = find(c);
      if (r) return r;
    }
    return null;
  };
  return (find(doc)!.content ?? []).map((t) => [
    t.text ?? '',
    (t.marks ?? []).map((m) =>
      m.attrs?.['user'] ? `${m.type}:${String(m.attrs['user'])}` : m.type,
    ),
  ]);
}

function select(m: Member, id: string, from: number, to: number): void {
  const i = internals(m.core);
  let at = -1;
  i.state.doc.descendants((n, pos) => {
    if (n.attrs['id'] === id) at = pos + 1;
    return at < 0;
  });
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, at + from, at + to)));
}

async function setUp(sub: string, role: 'editor' | 'suggester' | 'commenter' | 'viewer') {
  const service = newService();
  const docId = service.createDocument(contractDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
  traffic.clear();
  let n = 0;
  const m: Member = await join(
    service,
    docId,
    sub,
    role,
    { user: sub, generateId: () => `s${sub}${String(++n).padStart(15 - sub.length, '0')}` },
    {},
  );
  await until(() => m.core.permissions.get() !== null, 'access');
  return { service, docId, m, sent: traffic };
}

describe('an assistant result arrives as suggestions (UX-046 criterion 1)', () => {
  it('for an editor in editing mode, the text is an ins suggestion by the editor and the baseline stays', async () => {
    const { service, docId, m, sent } = await setUp('grace', 'editor');
    expect(m.core.suggestion.get().on).toBe(false);
    select(m, IDS.intro, 'Hello '.length, 'Hello '.length);
    expect(m.core.insertAssistantResult('drafted ')).toEqual({ ok: true });
    await saved(m);
    expect(serverRuns(service, docId, IDS.intro)).toEqual([
      ['Hello ', []],
      ['drafted ', ['ins:grace']],
      ['world', []],
    ]);
    expect(sent.submitted.map((c) => c.origin)).toContain('assistant');
    m.detach();
    await service.dispose();
  });

  it('replacing a selection keeps the old text as a deletion suggestion and adds the new text as an insertion', async () => {
    const { service, docId, m } = await setUp('grace', 'editor');
    select(m, IDS.intro, 'Hello '.length, 'Hello world'.length);
    expect(m.core.insertAssistantResult('there')).toEqual({ ok: true });
    await saved(m);
    const runs = serverRuns(service, docId, IDS.intro);
    expect(runs[0]).toEqual(['Hello ', []]);
    expect(runs.some(([text, marks]) => text === 'world' && marks.includes('del:grace'))).toBe(
      true,
    );
    expect(runs.some(([text, marks]) => text === 'there' && marks.includes('ins:grace'))).toBe(
      true,
    );
    // Nothing of the baseline was removed.
    expect(runs.map(([text]) => text).join('')).toContain('world');
    m.detach();
    await service.dispose();
  });

  it('for a suggester it is accepted by the authority as a suggestion', async () => {
    const { service, docId, m } = await setUp('sam', 'suggester');
    select(m, IDS.intro, 0, 0);
    expect(m.core.insertAssistantResult('Intro: ')).toEqual({ ok: true });
    await saved(m);
    expect(m.core.recovered.get().count).toBe(0);
    expect(serverRuns(service, docId, IDS.intro)[0]).toEqual(['Intro: ', ['ins:sam']]);
    m.detach();
    await service.dispose();
  });
});

describe('a result where the user has no suggest is refused (UX-046 criterion 4)', () => {
  it.each(['viewer', 'commenter'] as const)(
    'refuses it for a %s: nothing is applied, nothing is sent and the refusal is recorded',
    async (role) => {
      const { service, docId, m, sent } = await setUp('vera', role);
      const before = serverRuns(service, docId, IDS.intro);
      const refusals = m.core.refusal.get()?.n ?? 0;
      select(m, IDS.intro, 0, 0);
      expect(m.core.insertAssistantResult('nope')).toEqual({ ok: false, reason: 'read-only' });
      expect(m.core.refusal.get()?.n).toBe(refusals + 1);
      expect(sent.submitted).toEqual([]);
      expect(serverRuns(service, docId, IDS.intro)).toEqual(before);
      m.detach();
      await service.dispose();
    },
  );

  it('refuses it in a restricted region the editor has no grant on, and tells the author why', async () => {
    const { service, docId, m, sent } = await setUp('grace', 'editor');
    const before = serverRuns(service, docId, IDS.lockedPara);
    const refusals = m.core.refusal.get()?.n ?? 0;
    select(m, IDS.lockedPara, 0, 0);
    expect(m.core.insertAssistantResult('nope')).toEqual({ ok: false, reason: 'no-suggest' });
    expect(m.core.refusal.get()).toMatchObject({ n: refusals + 1, reason: 'scope' });
    expect(m.core.refusal.get()?.scopes).toEqual([`region:${IDS.locked}`]);
    expect(sent.submitted).toEqual([]);
    expect(serverRuns(service, docId, IDS.lockedPara)).toEqual(before);
    m.detach();
    await service.dispose();
  });

  it('refuses an empty result without a change', async () => {
    const { service, m, sent } = await setUp('grace', 'editor');
    expect(m.core.insertAssistantResult('')).toEqual({ ok: false, reason: 'not-recorded' });
    expect(sent.submitted).toEqual([]);
    m.detach();
    await service.dispose();
  });
});

describe('LaTeX in an assistant result is literal text in the document (UX-048 criterion 5)', () => {
  const attack = [
    '\\section{Injected}',
    '\\input{/etc/passwd}',
    '\\write18{rm -rf /}',
    '$x^2$ and $$y$$',
    '%comment \\newcommand',
    '{\\catcode`\\%=0 }',
    '#1 & ~ _ ^ {}',
  ].join(' ');

  it('stores the strings as one text run with only the suggestion mark, and no node besides text', async () => {
    const { service, docId, m } = await setUp('grace', 'editor');
    select(m, IDS.intro, 0, 0);
    expect(m.core.insertAssistantResult(attack)).toEqual({ ok: true });
    await saved(m);
    const doc = service.document(docId)!.content().doc as unknown as JsonNode;
    const para = (function find(n: JsonNode): JsonNode | null {
      if (n.attrs?.['id'] === IDS.intro) return n;
      for (const c of n.content ?? []) {
        const r = find(c);
        if (r) return r;
      }
      return null;
    })(doc)!;
    const first = para.content![0]!;
    expect(first).toMatchObject({ type: 'text', text: attack });
    expect((first.marks ?? []).map((mark) => mark.type)).toEqual(['ins']);
    // Nothing the insertion made is a node: every child of the paragraph is text.
    expect(para.content!.every((child) => child.type === 'text')).toBe(true);
    m.detach();
    await service.dispose();
  });
});
