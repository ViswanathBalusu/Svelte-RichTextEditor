// End-to-end property test of reconnect and resume (PRO-093, PRO-094; 04 §2 G1, G3, G4, G5; 04 §9):
// two writers edit one document through backend-dep while the network cuts connections and drops
// or duplicates the server's frames. Behind the network is the real authority (backend-mock's
// room). Whatever happens, each writer sees a gap-free sequence, every commit is stored exactly
// once, and once the network heals both writers reach the head with the same content.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalNodeText, uuid7, type JsonNode } from '@docedit/model';
import {
  isPortError,
  isSyncReject,
  type ChannelState,
  type Commit,
  type SyncChannel,
} from '@docedit/protocol';
import { createDepBackend, type DepBackend } from '../src/index.ts';
import {
  IDS,
  LEGAL_GRANT,
  USERS,
  contractDocument,
  insertText,
  posIn,
  textOf,
} from './support/fixtures.ts';
import { MemoryNetwork, type Fate } from './support/memory-network.ts';
import { MockDepServer } from './support/mock-server.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The editing core, reduced to its bookkeeping over the ports. */
class Writer {
  readonly backend: DepBackend;
  readonly docId: string;
  readonly name: string;
  channel: SyncChannel | null = null;
  seq = 0;
  live = false;
  inflight: { commit: Commit; waiting: boolean } | null = null;
  readonly marks: string[] = [];
  readonly violations: string[] = [];
  private pos = 0;
  private opening = false;
  private count = 0;

  constructor(backend: DepBackend, docId: string, name: string) {
    this.backend = backend;
    this.docId = docId;
    this.name = name;
  }

  /** Reads the content at the head and opens the channel resumed at it (05 §5.2). */
  async open(): Promise<void> {
    if (this.opening) return;
    this.opening = true;
    try {
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          await this.backend.connect();
          const c = await this.backend.sync.loadContent(this.docId);
          this.seq = c.seq;
          this.pos = posIn(c.doc, IDS.intro);
          const ch = await this.backend.sync.open(this.docId, {
            resume: { seq: c.seq, incarnation: c.incarnation },
          });
          this.attach(ch);
          return;
        } catch {
          await sleep(10);
        }
      }
      this.violations.push('could not open');
    } finally {
      this.opening = false;
    }
  }

  private attach(ch: SyncChannel): void {
    this.channel = ch;
    this.live = false;
    ch.onCommits((commits) => {
      if (this.channel !== ch) return;
      for (const c of commits) {
        if (c.seq !== this.seq + 1)
          this.violations.push(`${this.name}: commit ${c.seq} after ${this.seq}`);
        this.seq = c.seq;
        if (this.inflight && c.id === this.inflight.commit.id) this.inflight = null;
      }
    });
    ch.onState((s: ChannelState) => {
      if (this.channel !== ch) return;
      this.live = s.status === 'live';
      if (s.status === 'live') this.resubmit();
      if (s.status === 'closed') {
        // The channel cannot continue (a reload, a refusal): read the content again and reopen.
        this.channel = null;
        if (this.inflight) this.inflight.waiting = true;
        void this.open();
      }
    });
  }

  edit(): void {
    if (!this.channel || !this.live || this.inflight) return;
    const mark = `${this.name}${++this.count}.`;
    const commit: Commit = { id: uuid7(), base: this.seq, steps: [insertText(this.pos, mark)] };
    this.marks.push(mark);
    this.inflight = { commit, waiting: false };
    this.send(commit);
  }

  private resubmit(): void {
    if (this.inflight?.waiting && this.channel && this.live) {
      this.inflight.waiting = false;
      // The same commit, unchanged: the authority stores it once, whether it was stored before or
      // not (04 §3.1, §5 step 2).
      this.send(this.inflight.commit);
    }
  }

  private send(commit: Commit): void {
    const ch = this.channel!;
    ch.submit(commit).then(
      (ack) => {
        if (this.inflight?.commit.id !== commit.id) return;
        if (ack.seq === this.seq + 1) this.seq = ack.seq;
        else if (ack.seq > this.seq)
          this.violations.push(`${this.name}: ack ${ack.seq} after ${this.seq}`);
        this.inflight = null;
      },
      (e: unknown) => {
        if (this.inflight?.commit.id !== commit.id) return;
        if (isSyncReject(e)) {
          if (e.action === 'retry') {
            this.inflight.waiting = true;
            void sleep(e.retryAfterMs ?? 5).then(() => this.resubmit());
          } else {
            this.violations.push(`${this.name}: ${e.code} ${e.action}`);
            this.inflight = null;
          }
        } else if (isPortError(e) && e.code === 'unavailable') {
          this.inflight.waiting = true;
          if (this.live && this.channel === ch) this.resubmit();
        } else this.violations.push(`${this.name}: ${String(e)}`);
      },
    );
  }

  get settled(): boolean {
    return this.channel !== null && this.live && this.inflight === null;
  }
}

type Step =
  | { op: 'edit'; who: 0 | 1 }
  | { op: 'cut' }
  | { op: 'faults'; fate: Fate; n: number }
  | { op: 'wait'; ms: number };

const steps: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.constantFrom<0 | 1>(0, 1).map((who) => ({ op: 'edit' as const, who })),
  },
  { weight: 1, arbitrary: fc.constant({ op: 'cut' as const }) },
  {
    weight: 2,
    arbitrary: fc.record({
      op: fc.constant('faults' as const),
      fate: fc.constantFrom<Fate>('drop', 'duplicate'),
      n: fc.integer({ min: 1, max: 4 }),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.integer({ min: 0, max: 15 }).map((ms) => ({ op: 'wait' as const, ms })),
  },
);

async function scenario(script: readonly Step[]): Promise<void> {
  // A short answer timeout, so that a lost acknowledgement is noticed within the test.
  const server = new MockDepServer({ limits: { ackTimeoutMs: 120 } });
  const net = new MemoryNetwork(server);
  let pending: { fate: Fate; n: number } | null = null;
  net.fate = () => {
    if (!pending || pending.n <= 0) return 'deliver';
    pending.n--;
    return pending.fate;
  };
  const docId = server.service.createDocument(contractDocument(), { grants: [LEGAL_GRANT] });
  const make = (user: { sub: string; name: string; groups?: readonly string[] }) =>
    createDepBackend({
      endpoint: server.endpoint,
      getToken: async () => server.mintToken(user, { [docId]: 'editor' }),
      platform: { ...net.platform(), random: () => 0.5 },
    });
  const writers = [
    new Writer(make(USERS.editor), docId, 'a'),
    new Writer(make(USERS.grantee), docId, 'b'),
  ];
  try {
    await Promise.all(writers.map((w) => w.open()));
    for (const s of script) {
      if (s.op === 'edit') writers[s.who]!.edit();
      else if (s.op === 'cut') net.cut();
      else if (s.op === 'faults') pending = { fate: s.fate, n: s.n };
      else await sleep(s.ms);
    }
    // The network heals. A frame lost on a live connection shows only through later traffic (a
    // real socket loses frames only with the connection), so each writer edits once more; then
    // both settle at the head.
    pending = null;
    const head = () => server.service.document(docId)!.head;
    const settle = async (what: (w: Writer) => boolean) => {
      const deadline = Date.now() + 20_000;
      while (!writers.every(what)) {
        if (Date.now() > deadline)
          throw new Error(
            `did not settle: head ${head()}, ${writers.map((w) => `${w.name} seq ${w.seq} live ${w.live} inflight ${w.inflight ? 'yes' : 'no'}`).join(', ')}`,
          );
        await sleep(5);
      }
    };
    await settle((w) => w.settled);
    for (const w of writers) {
      w.edit();
      await settle((x) => x.settled);
    }
    await settle((w) => w.settled && w.seq === head());
    expect(writers.flatMap((w) => w.violations)).toEqual([]);
    const contents = await Promise.all(writers.map((w) => w.backend.sync.loadContent(docId)));
    expect(canonicalNodeText(contents[0]!.doc as unknown as JsonNode)).toBe(
      canonicalNodeText(contents[1]!.doc as unknown as JsonNode),
    );
    const text = textOf(contents[0]!.doc, IDS.intro);
    for (const mark of writers.flatMap((w) => w.marks))
      expect(text.split(mark).length - 1, `${mark} in ${text}`).toBe(1);
  } finally {
    await Promise.all(writers.map((w) => w.backend.close()));
    await server.service.dispose();
  }
}

describe('reconnect and resume end to end (property)', () => {
  it('keeps both writers gap-free, stores every commit once and converges', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(steps, { minLength: 1, maxLength: 40 }), (script) =>
        scenario(script),
      ),
      { numRuns: 15 },
    );
  }, 300_000);
});
