// What backend-local promises beyond the shared contract suite (PRO-100): the document survives a
// reload with its history, two tabs on one store converge through the broadcast channel, the
// authority in the page refuses what a role may not do, and nothing of the store leaks to another
// store. The scenarios take the store as a parameter: a memory store in Node.js
// (test/local.test.ts) and IndexedDB in the browsers (src/local.universal.test.ts).
import { IDS, contractDocument, posIn } from '@docedit/protocol/contract';
import { isSyncReject, type RemoteCommit, type Step, type SyncChannel } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { LocalService, type LocalStore } from '../src/index.ts';

const insert = (pos: number, text: string): Step => ({
  stepType: 'replace',
  from: pos,
  to: pos,
  slice: { content: [{ type: 'text', text }] },
});

let counter = 0;
const commitId = (): string => `0192f0c4-7b1e-7c3a-9a54-${String(++counter).padStart(12, '0')}`;

const wait = async (ok: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** The text of the first paragraph of a document, from its JSON. */
function introText(doc: unknown): string {
  const body = (doc as { content: { content: { content?: { text?: string }[] }[] }[] }).content[1]!;
  return (body.content[0]!.content ?? []).map((t) => t.text ?? '').join('');
}

export interface Scenarios {
  /** A handle on the persistent store `name`; two handles of one name see the same data. */
  openStore(name: string): LocalStore;
  /** A name no earlier test used. */
  fresh(): string;
}

async function join(
  service: LocalService,
  docId: string,
  sub: string,
  role: 'editor' | 'viewer' | 'owner',
  groups: string[] = [],
): Promise<{ ch: SyncChannel; head: number }> {
  const backend = service.backend({ sub, groups }, { [docId]: role });
  await backend.connect();
  const content = await backend.sync.loadContent(docId);
  const ch = await backend.sync.open(docId, {
    resume: { seq: content.seq, incarnation: content.incarnation },
  });
  return { ch, head: content.seq };
}

export function localScenarios(s: Scenarios): void {
  describe('backend-local: persistence and tabs', () => {
    it('keeps the document and its history across a reload (criterion 1)', async () => {
      const name = s.fresh();
      const first = await LocalService.open(s.openStore(name), { channel: null });
      const docId = await first.create(contractDocument());
      const { ch, head } = await join(first, docId, 'eddie', 'editor');
      const at = posIn(contractDocument().doc, IDS.intro, 0);
      await ch.submit({ id: commitId(), base: head, steps: [insert(at, 'One ')] });
      await ch.submit({ id: commitId(), base: head + 1, steps: [insert(at, 'Two ')] });
      await first.dispose();

      // A new service on a new handle of the same store: the page was reloaded.
      const second = await LocalService.open(s.openStore(name), { channel: null });
      const doc = second.document(docId);
      expect(doc?.head).toBe(2);
      const b = second.backend({ sub: 'eddie' }, { [docId]: 'editor' });
      await b.connect();
      const now = await b.sync.loadContent(docId);
      expect(now.seq).toBe(2);
      expect(introText(now.doc)).toBe('Two One Hello world');
      // The history is there too: every earlier state can be read back.
      expect(introText((await b.sync.loadContent(docId, 0)).doc)).toBe('Hello world');
      expect(introText((await b.sync.loadContent(docId, 1)).doc)).toBe('One Hello world');
      // The log goes on where it stopped.
      const again = await b.sync.open(docId, {
        resume: { seq: now.seq, incarnation: now.incarnation },
      });
      const ack = await again.submit({ id: commitId(), base: 2, steps: [insert(at, 'Three ')] });
      expect(ack.seq).toBe(3);
      await second.dispose();
    });

    it('keeps the grants and the document state across a reload', async () => {
      const name = s.fresh();
      const first = await LocalService.open(s.openStore(name), { channel: null });
      const docId = await first.create(contractDocument(), {
        grants: [{ region: IDS.locked, principal: 'group:legal', role: 'editor' }],
      });
      first.setGrants(docId, [
        { region: IDS.locked, principal: 'group:legal', role: 'editor' },
        { region: IDS.open, principal: 'group:legal', role: 'viewer' },
      ]);
      await first.flush();
      await first.dispose();
      const second = await LocalService.open(s.openStore(name), { channel: null });
      const b = second.backend({ sub: 'grace', groups: ['legal'] }, { [docId]: 'editor' });
      await b.connect();
      const grants = await b.permissions.grants!(docId);
      expect(grants.value.grants.map((g) => `${g.region}:${g.role}`).sort()).toEqual(
        [`${IDS.locked}:editor`, `${IDS.open}:viewer`].sort(),
      );
      await second.dispose();
    });

    it('converges a second tab through the broadcast channel (criterion 2)', async () => {
      const name = s.fresh();
      const channel = `tabs-${name}`;
      const tabA = await LocalService.open(s.openStore(name), { channelName: channel });
      const docId = await tabA.create(contractDocument());
      const tabB = await LocalService.open(s.openStore(name), { channelName: channel });
      const a = await join(tabA, docId, 'eddie', 'editor');
      const b = await join(tabB, docId, 'grace', 'editor');
      const seen: RemoteCommit[] = [];
      b.ch.onCommits((c) => seen.push(...c));
      const at = posIn(contractDocument().doc, IDS.intro, 0);
      await a.ch.submit({ id: commitId(), base: a.head, steps: [insert(at, 'A ')] });
      await wait(() => seen.length === 1);
      expect(seen[0]?.seq).toBe(1);
      // Tab B now edits on top of it; tab A receives that in turn.
      const back: RemoteCommit[] = [];
      a.ch.onCommits((c) => back.push(...c));
      await b.ch.submit({ id: commitId(), base: 1, steps: [insert(at, 'B ')] });
      await wait(() => back.length === 1);
      expect(back[0]?.seq).toBe(2);
      const check = tabB.backend({ sub: 'x' }, { [docId]: 'viewer' });
      await check.connect();
      expect(introText((await check.sync.loadContent(docId)).doc)).toBe('B A Hello world');
      await tabA.dispose();
      await tabB.dispose();
    });

    it('lets one of two tabs that edit at once store its commit and brings the other along', async () => {
      const name = s.fresh();
      const channel = `race-${name}`;
      const tabA = await LocalService.open(s.openStore(name), { channelName: channel });
      const docId = await tabA.create(contractDocument());
      const tabB = await LocalService.open(s.openStore(name), { channelName: channel });
      const a = await join(tabA, docId, 'eddie', 'editor');
      const b = await join(tabB, docId, 'grace', 'editor');
      const at = posIn(contractDocument().doc, IDS.intro, 0);
      const results = await Promise.allSettled([
        a.ch.submit({ id: commitId(), base: 0, steps: [insert(at, 'A ')] }),
        b.ch.submit({ id: commitId(), base: 0, steps: [insert(at, 'B ')] }),
      ]);
      // Whatever the interleaving, no acknowledged commit is lost: each one is in the store.
      const stored = await s.openStore(name).read(docId);
      const acked = results.filter((r) => r.status === 'fulfilled').length;
      expect(stored?.commits.length).toBeGreaterThanOrEqual(Math.max(1, acked));
      expect(stored?.commits.map((e) => e.ext)).toEqual(stored?.commits.map((_, i) => i + 1));
      await tabA.dispose();
      await tabB.dispose();
    });

    it('refuses in the page what the stored role may not do (criterion 3)', async () => {
      const name = s.fresh();
      const first = await LocalService.open(s.openStore(name), { channel: null });
      const docId = await first.create(contractDocument(), {
        grants: [{ region: IDS.locked, principal: 'group:legal', role: 'editor' }],
      });
      await first.dispose();
      const service = await LocalService.open(s.openStore(name), { channel: null });
      const locked = posIn(contractDocument().doc, IDS.lockedPara, 0);
      // A viewer may edit nothing.
      const viewer = await join(service, docId, 'victor', 'viewer');
      const denied = await viewer.ch
        .submit({ id: commitId(), base: viewer.head, steps: [insert(locked, 'x')] })
        .catch((e: unknown) => e);
      expect(isSyncReject(denied) && [denied.code, denied.action]).toEqual([
        'permission_denied',
        'drop',
      ]);
      // An editor of the document without the grant on the restricted region may not either.
      const editor = await join(service, docId, 'eddie', 'editor');
      const refused = await editor.ch
        .submit({ id: commitId(), base: editor.head, steps: [insert(locked, 'x')] })
        .catch((e: unknown) => e);
      expect(isSyncReject(refused) && refused.code).toBe('permission_denied');
      // The grantee may.
      const grantee = await join(service, docId, 'grace', 'editor', ['legal']);
      const ok = await grantee.ch.submit({
        id: commitId(),
        base: grantee.head,
        steps: [insert(locked, 'y')],
      });
      expect(ok.seq).toBe(1);
      await service.dispose();
    });

    it('keeps one store apart from another', async () => {
      const a = await LocalService.open(s.openStore(s.fresh()), { channel: null });
      const b = await LocalService.open(s.openStore(s.fresh()), { channel: null });
      const docId = await a.create(contractDocument());
      expect(a.document(docId)).toBeDefined();
      expect(b.document(docId)).toBeUndefined();
      await a.dispose();
      await b.dispose();
    });
  });
}
