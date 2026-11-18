/**
 * Several clients receive the same confirmed step that cannot apply, and all skip it and converge
 * (04 §14; SYN-045 criterion 2). The clients are cores attached to a document on backend-mock and
 * on backend-local (which runs backend-mock over a local store).
 *
 * Neither backend can hold such a step: the authority's room applies every step before it stores
 * it, and refuses to open from a log that does not replay. Only a relay stores steps it cannot
 * test (04 §14), and no relay server is built. So the step is delivered the way a relay would
 * deliver it: as one more confirmed commit on the clients' channels, after the commits that the
 * backend sent. What is tested is what each client does with it, over the real backend's content,
 * channel and acknowledgements.
 */
import { type MockService } from '@docedit/backend-mock';
import type { DocRole, RemoteCommit, SyncChannel } from '@docedit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalService, MemoryStore } from '../../backend-local/src/index.ts';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { IDS, LEGAL_GRANT_FOR_TESTS, contractDocument } from './fixtures.ts';
import { caret, microtask, newService, type, until } from './support.ts';

/** A step that cannot apply to any document of the fixture's size. */
const unappliable = { stepType: 'replace', from: 9999, to: 9999 } as RemoteCommit['steps'][number];

interface Joined {
  core: DocumentCore;
  detach: () => void;
  /** Delivers a commit on the channel as the backend would. */
  deliver: (commits: RemoteCommit[]) => void;
}

/** Joins as 05 §5.2 describes, keeping the channel's commit callback so a commit can be added. */
async function joinTapped(service: MockService, docId: string, sub: string, role: DocRole) {
  const backend = service.backend({ sub }, { [docId]: role });
  await backend.connect();
  const content = await backend.sync.loadContent(docId);
  const core = new DocumentCore({ doc: content, schedule: microtask });
  const channel = await backend.sync.open(docId, {
    resume: { seq: content.seq, incarnation: content.incarnation },
  });
  let callback: ((commits: RemoteCommit[]) => void) | null = null;
  const tapped: SyncChannel = {
    get docId() {
      return channel.docId;
    },
    get opened() {
      return channel.opened;
    },
    submit: (c) => channel.submit(c),
    onCommits: (cb) => {
      callback = cb;
      return channel.onCommits(cb);
    },
    onReset: (cb) => channel.onReset(cb),
    onAccess: (cb) => channel.onAccess(cb),
    onEvent: (cb) => channel.onEvent(cb),
    onState: (cb) => channel.onState(cb),
    onCheck: (cb) => channel.onCheck(cb),
    close: () => channel.close(),
  };
  const limits = backend.auth.session?.limits;
  const detach = core.attach(tapped, {
    seq: content.seq,
    incarnation: content.incarnation,
    sync: backend.sync,
    ...(limits ? { limits } : {}),
    batchMs: 0,
    retry: { minMs: 2, maxMs: 20 },
  });
  const joined: Joined = {
    core,
    detach,
    deliver: (commits) => {
      if (!callback) throw new Error('the core has not subscribed to the channel');
      callback(commits);
    },
  };
  return { ...joined, backend };
}

const relayCommit = (seq: number): RemoteCommit => ({
  seq,
  kind: 'steps',
  id: `0192f0c4-0000-7000-8000-${String(seq).padStart(12, '0')}`,
  steps: [unappliable],
  control: null,
  author: { user: 'relay-client', session: 's9', agent: null },
  serverTime: '2026-11-06T10:00:00.000Z',
  origin: 'input',
});

const services: MockService[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.dispose();
});

describe('every client skips the same unappliable confirmed step (SYN-045 criterion 2)', () => {
  it('clients on backend-mock and on backend-local skip it and converge', async () => {
    const mock = newService();
    const local = await LocalService.open(new MemoryStore(), { presence: false, channel: null });
    services.push(mock, local);
    const mockDoc = mock.createDocument(contractDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
    const localDoc = await local.create(contractDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });

    const clients = [
      await joinTapped(mock, mockDoc, 'eddie', 'editor'),
      await joinTapped(mock, mockDoc, 'olivia', 'owner'),
      await joinTapped(local, localDoc, 'eddie', 'editor'),
      await joinTapped(local, localDoc, 'olivia', 'owner'),
    ];
    try {
      // The same edit on both backends first, so that the step comes after real history.
      for (const c of [clients[0]!, clients[2]!]) {
        caret(c.core, IDS.intro, 0);
        type(c.core, 'hello ');
      }
      await until(
        () =>
          clients.every((c) => internals(c.core).sync.seq === 1) &&
          clients.every((c) => c.core.saveState.get() === 'saved'),
        'the first edit at every client',
      );
      const before = clients.map((c) => JSON.stringify(internals(c.core).state.doc.toJSON()));
      expect(new Set(before).size).toBe(1);

      // The step that cannot apply, as seq 2, delivered to every client.
      for (const c of clients) c.deliver([relayCommit(2)]);
      await until(
        () => clients.every((c) => internals(c.core).sync.seq === 2),
        'the seq to advance at every client',
      );
      for (const c of clients) {
        expect(c.core.problem.get()).toMatchObject({ code: 'step_failed', fatal: false });
        expect(JSON.stringify(internals(c.core).state.doc.toJSON())).toBe(before[0]);
      }
    } finally {
      for (const c of clients) c.detach();
    }
  });
});
