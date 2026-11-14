/**
 * Formatting suggestions are checked by the authority on commit (FE-043 criterion 4; lane
 * U-FE-033-048). Two suggesters format the same text through `DocumentCore`; the mock service runs
 * the real authority `Room`, which accepts each commit only if every `fmt` mark names the submitting
 * user and uses a suggestion identifier that belongs to that user (03 §5; identity.ts). The test then
 * reads the server's marks and checks that each `fmt` names its own user, that the identifier was
 * minted by that user's core, that no identifier is shared, and that the head moved once per commit
 * with nothing set aside.
 *
 * Node.js, backend-mock with the real Room. Not run in a browser.
 */
import type { CdmEnvelope } from '@docedit/model';
import { validate } from '@docedit/model/validate';
import type { MockService } from '@docedit/backend-mock';
import type { DocRole } from '@docedit/protocol';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { DocumentCore, type CoreConfig } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { IDS, contractDocument } from './fixtures.ts';
import { countedPort, microtask, newService, posOf, until } from './support.ts';

interface JsonNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

interface Member {
  core: DocumentCore;
  detach: () => void;
}

/** Identifiers minted per member, distinct per user and prefixed by the user's name. */
function idSource(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${String(++n).padStart(16 - prefix.length, '0')}`;
}

async function joinAs(
  service: MockService,
  docId: string,
  sub: string,
  role: DocRole,
  config: Partial<CoreConfig> = {},
): Promise<Member> {
  const backend = service.backend({ sub }, { [docId]: role });
  await backend.connect();
  const content = await backend.sync.loadContent(docId);
  const core = new DocumentCore({
    doc: content,
    schedule: microtask,
    generateId: idSource(`s${sub}`),
    ...config,
  });
  const port = countedPort(backend.sync);
  const channel = await port.open(docId, {
    resume: { seq: content.seq, incarnation: content.incarnation },
  });
  const detach = core.attach(channel, {
    seq: content.seq,
    incarnation: content.incarnation,
    sync: port,
    batchMs: 0,
    retry: { minMs: 2, maxMs: 20 },
    user: backend.auth.session!.user.id,
  });
  await until(() => core.permissions.get() !== null, 'access');
  return { core, detach };
}

function serverDoc(service: MockService, docId: string): JsonNode {
  return service.document(docId)!.content().doc as unknown as JsonNode;
}

/** The marks of every text run of the paragraph `id`, in document order. */
function runMarks(service: MockService, docId: string, id: string) {
  const find = (n: JsonNode): JsonNode | null => {
    if (n.attrs?.['id'] === id) return n;
    for (const c of n.content ?? []) {
      const r = find(c);
      if (r) return r;
    }
    return null;
  };
  return (find(serverDoc(service, docId))!.content ?? [])
    .filter((t) => t.type === 'text')
    .map((t) => ({ text: t.text ?? '', marks: t.marks ?? [] }));
}

function select(core: DocumentCore, id: string, from: number, to: number): void {
  const i = internals(core);
  const at = posOf(i.state.doc, id) + 1;
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, at + from, at + to)));
}

async function saved(m: Member): Promise<void> {
  await until(() => m.core.saveState.get() === 'saved', 'saved', 5000);
}

describe('the authority checks each fmt mark names its submitter (FE-043 criterion 4)', () => {
  it('two suggesters format the same text: every fmt names its user and an identifier of that user', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument());
    const head = service.document(docId)!.head;
    const sam = await joinAs(service, docId, 'sam', 'suggester');
    const tess = await joinAs(service, docId, 'tess', 'suggester');

    select(sam.core, IDS.intro, 'Hello '.length, 'Hello world'.length);
    expect(sam.core.run('bold')).toBe(true);
    await saved(sam);
    await until(
      () => tess.core.confirmedSeq.get() === service.document(docId)!.head,
      'tess sees sam',
    );
    select(tess.core, IDS.intro, 'Hello '.length, 'Hello world'.length);
    expect(tess.core.run('italic')).toBe(true);
    await saved(tess);

    // The authority accepted both commits: the head moved twice and nothing was set aside.
    expect(service.document(docId)!.head).toBeGreaterThanOrEqual(head + 2);
    expect(sam.core.recovered.get().count).toBe(0);
    expect(tess.core.recovered.get().count).toBe(0);

    const c = service.document(docId)!.content();
    const env = { cdm: 1, requires: c.requires, doc: c.doc } as unknown as CdmEnvelope;
    expect(validate(env).valid).toBe(true);

    const fmts: { user: unknown; id: unknown }[] = [];
    for (const run of runMarks(service, docId, IDS.intro)) {
      for (const m of run.marks) {
        if (m.type === 'fmt') fmts.push({ user: m.attrs?.['user'], id: m.attrs?.['id'] });
      }
    }
    expect(fmts.map((f) => f.user).sort()).toEqual(['sam', 'tess']);
    for (const f of fmts) {
      // The identifier was minted by the submitting user's own core (its prefix is `s` + the name).
      expect(String(f.id).startsWith(`s${String(f.user)}`)).toBe(true);
    }
    expect(new Set(fmts.map((f) => f.id)).size).toBe(fmts.length);

    sam.detach();
    tess.detach();
    await service.dispose();
  });
});
