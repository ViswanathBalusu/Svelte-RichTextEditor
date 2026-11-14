/**
 * Undo and redo of a user's own suggestion (FE-049 criterion 6; 02 §5.2; 03 §5; 07 §5.2 P4). A
 * suggester types in suggestion mode, the typing is committed through the authority, and then the
 * user runs `undo` and `redo` through the core's command registry. The test reads what the server
 * stored: undo removes the suggestion and leaves the baseline unchanged, and redo records it again as
 * a suggestion naming the same user. Each commit is accepted by the authority room.
 */
import type { CdmEnvelope } from '@docedit/model';
import { validate } from '@docedit/model/validate';
import type { MockService } from '@docedit/backend-mock';
import type { DocRole } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { DocumentCore, type CoreConfig } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { IDS, contractDocument } from './fixtures.ts';
import { caret, countedPort, microtask, newService, type, until } from './support.ts';

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

/** A fresh identifier source per member, valid node identifiers (03 §9), distinct per user. */
function idSource(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${String(++n).padStart(16 - prefix.length, '0')}`;
}

/** Joins as the element does: content over REST, the channel resumed, `attach` given the user. */
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

/** The runs of a paragraph on the server: text, and suggestion or formatting marks as names. */
function serverRuns(service: MockService, docId: string, id: string): [string, string[]][] {
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
      m.attrs?.['user'] === undefined ? m.type : `${m.type}:${String(m.attrs['user'])}`,
    ),
  ]);
}

async function saved(m: Member): Promise<void> {
  await until(() => m.core.saveState.get() === 'saved', 'saved', 5000);
}

/** Every commit was accepted: nothing set aside, the head moved, the server's content is valid. */
function accepted(m: Member, service: MockService, docId: string, head: number, commits: number) {
  expect(m.core.recovered.get().count).toBe(0);
  expect(service.document(docId)!.head).toBeGreaterThanOrEqual(head + commits);
  const c = service.document(docId)!.content();
  const env = { cdm: 1, requires: c.requires, doc: c.doc } as unknown as CdmEnvelope;
  expect(validate(env).valid).toBe(true);
}

async function setUp() {
  const service = newService();
  const docId = service.createDocument(contractDocument());
  return { service, docId, head: service.document(docId)!.head };
}

describe('undo and redo of a suggestion (FE-049 criterion 6)', () => {
  it('undo removes the user’s own suggestion and the baseline is unchanged', async () => {
    const { service, docId, head } = await setUp();
    const sam = await joinAs(service, docId, 'sam', 'suggester');
    caret(sam.core, IDS.intro, 'Hello '.length);
    type(sam.core, 'big ');
    await saved(sam);
    expect(serverRuns(service, docId, IDS.intro)).toEqual([
      ['Hello ', []],
      ['big ', ['ins:sam']],
      ['world', []],
    ]);
    const afterTyping = service.document(docId)!.head;

    expect(sam.core.run('undo')).toBe(true);
    await saved(sam);
    accepted(sam, service, docId, head, 1);
    expect(service.document(docId)!.head).toBeGreaterThan(afterTyping);
    // The suggestion is gone; the text of the baseline is exactly as it was, with no mark.
    const runs = serverRuns(service, docId, IDS.intro);
    expect(runs.map(([t]) => t).join('')).toBe('Hello world');
    expect(runs.every(([, marks]) => marks.length === 0)).toBe(true);
    sam.detach();
    await service.dispose();
  });

  it('redo records the same suggestion again, naming the same user', async () => {
    const { service, docId, head } = await setUp();
    const sam = await joinAs(service, docId, 'sam', 'suggester');
    caret(sam.core, IDS.intro, 'Hello '.length);
    type(sam.core, 'big ');
    await saved(sam);
    expect(sam.core.run('undo')).toBe(true);
    await saved(sam);
    expect(sam.core.run('redo')).toBe(true);
    await saved(sam);
    accepted(sam, service, docId, head, 3);
    const runs = serverRuns(service, docId, IDS.intro);
    expect(runs.filter(([, marks]) => marks.includes('ins:sam')).map(([t]) => t)).toEqual(['big ']);
    expect(internals(sam.core).state.doc.textContent).toContain('big ');
    sam.detach();
    await service.dispose();
  });
});
