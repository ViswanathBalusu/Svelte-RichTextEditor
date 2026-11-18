// HIS-026: the history visibility gate is proved on every place that takes a sequence number, over
// HTTP, for each setting (`editors`, `all`, `since_access`) and each role (07 §8, §12; 08 §9; ADR 0034).
// Every request below the gate is refused with `forbidden`, and the same request at or above it
// succeeds, so the suite fails when the gate is too strict as well as when it is too lax. The
// expected gate is written out per case here and is not computed with the authority's rule.
// The resume answer (`catchUp: "reload"`) is in src/data-plane/his-026-resume-gate.test.ts.
// PostgreSQL: pwsh -NoProfile -File infra/test-env.ps1 up (FND-010); the cases skip without it.
import { randomUUID } from 'node:crypto';
import { type StoredCommit } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DocRef } from '../../src/storage/types.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type CallResult,
  type Harness,
  type Storage,
} from './support.ts';

const INTRO = 'pIntro0000000001';
const HEAD = 4;
const STEP_MS = 10_000;

type Setting = 'editors' | 'all' | 'since_access';
type Role = 'owner' | 'editor' | 'commenter' | 'viewer';
const ROLES: readonly Role[] = ['owner', 'editor', 'commenter', 'viewer'];

interface Scenario {
  name: string;
  setting: Setting;
  role: Role;
  /** Whether the token carries `access_since` (at commit 3). */
  claim: boolean;
  /** The lowest seq whose state the caller may read, written out by hand (ADR 0034). */
  gate: number;
}

/** The expected gate: editors with `edit` see all; `all` everyone; `since_access` the claim or the head. */
function gateOf(setting: Setting, role: Role, claim: boolean): number {
  if (setting === 'all') return 0;
  if (setting === 'editors') return role === 'owner' || role === 'editor' ? 0 : HEAD;
  return claim ? 3 : HEAD;
}

const SCENARIOS: Scenario[] = [];
for (const setting of ['editors', 'all', 'since_access'] as Setting[])
  for (const role of ROLES)
    for (const claim of setting === 'since_access' ? [true, false] : [false])
      SCENARIOS.push({
        name: `${setting}, ${role}${setting === 'since_access' ? (claim ? ', with access_since' : ', without it') : ''}`,
        setting,
        role,
        claim,
        gate: gateOf(setting, role, claim),
      });

function inside(doc: unknown, id: string): number {
  let at = -1;
  cdmSchema()
    .nodeFromJSON(doc)
    .descendants((n, pos) => {
      if (n.attrs['id'] === id) at = pos + 1;
      return at < 0;
    });
  return at;
}

/** Appends one text commit at the clock's time. */
async function appendOne(h: Harness, doc: string, text: string): Promise<number> {
  const ref: DocRef = { tenant: h.tenant, doc };
  const epoch = await h.parts.ownership.claim(ref, 'his-026-node');
  const head = await h.parts.logs.head(ref);
  const perms = await h.parts.grants.current(ref);
  const pos = inside(documentWithRegions()['doc'], INTRO);
  const time = h.now();
  const commit: StoredCommit = {
    seq: head.seq + 1,
    id: uuid7(),
    kind: 'steps',
    steps: [
      { stepType: 'replace', from: pos, to: pos, slice: { content: [{ type: 'text', text }] } },
    ] as StoredCommit['steps'],
    user: 'u-test',
    session: 'session-test',
    time,
    origin: 'input',
    scopes: ['body'],
    revision: perms.revision,
    cdm: 1,
    engine: 'pm-steps/1',
    retired: [],
    claimed: [],
  };
  const r = await h.parts.logs.append(ref, {
    epoch,
    revision: perms.revision,
    fromSeq: head.seq + 1,
    commits: [commit],
  });
  expect(r.status).toBe('ok');
  return time;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`the visibility gate on every sequence number (HIS-026, ${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    /** The time of commit n, for the `access_since` claim. */
    const times = new Map<number, number>();

    /**
     * The setting has no route yet (the column is read by the gate, 08 §9), so it is set in storage:
     * by SQL on PostgreSQL, and on the memory store by answering the document with the setting.
     */
    const settings = new Map<string, Setting>();
    async function setSetting(doc: string, setting: Setting): Promise<void> {
      if (h.db) {
        await h.db.admin.query(`UPDATE documents SET history_visibility = $2 WHERE id = $1`, [
          doc,
          setting,
        ]);
        return;
      }
      settings.set(doc, setting);
    }

    /** A document with four commits, at times ten seconds apart, under `setting`. */
    async function makeDoc(setting: Setting): Promise<string> {
      const doc = await h.createDocument({ content: documentWithRegions(), title: 'Gate' });
      await setSetting(doc, setting);
      for (let i = 1; i <= HEAD; i++) {
        h.advance(STEP_MS);
        times.set(i, await appendOne(h, doc, `c${i}`));
      }
      return doc;
    }
    /** The token of the scenario: `access_since` is a moment after commit 3 and before commit 4. */
    function tokenOf(doc: string, s: Scenario): string {
      const claims = s.claim ? { access_since: new Date(times.get(3)! + 500).toISOString() } : {};
      return h.userToken({ [doc]: s.role }, { sub: `u-${s.role}`, ...claims });
    }

    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage, { realDataPlane: true });
      if (!h.db) {
        const store = h.parts.documents;
        const original = store.get.bind(store);
        store.get = async (ref) => {
          const r = await original(ref);
          const setting = settings.get(ref.doc);
          return r && setting ? { ...r, historyVisibility: setting } : r;
        };
      }
    });
    afterAll(async () => {
      await h?.close();
    });

    const outcome = (r: CallResult) => `${r.status} ${r.json?.code ?? ''}`;
    /** A read at `seq`, and whether it is a state (the head and named versions are visible) or a run. */
    const reads: Array<{
      name: string;
      kind: 'state' | 'run';
      call: (doc: string, token: string, seq: number) => Promise<CallResult>;
      ok: number;
    }> = [
      {
        name: 'content?seq',
        kind: 'state',
        call: (d, t, s) => h.call('GET', `/v1/documents/${d}/content?seq=${s}`, { token: t }),
        ok: 200,
      },
      {
        name: 'commits?after',
        kind: 'run',
        call: (d, t, s) => h.call('GET', `/v1/documents/${d}/commits?after=${s}`, { token: t }),
        ok: 200,
      },
      {
        name: 'history?fromSeq',
        kind: 'run',
        call: (d, t, s) =>
          h.call('GET', `/v1/documents/${d}/history?fromSeq=${s + 1}`, { token: t }),
        ok: 200,
      },
      {
        name: 'history?toSeq',
        kind: 'state',
        call: (d, t, s) => h.call('GET', `/v1/documents/${d}/history?toSeq=${s}`, { token: t }),
        ok: 200,
      },
      {
        name: 'diff',
        kind: 'state',
        call: (d, t, s) =>
          h.call('GET', `/v1/documents/${d}/diff?fromSeq=${s}&toSeq=${HEAD}`, { token: t }),
        ok: 200,
      },
      {
        name: 'attribution?atSeq',
        kind: 'state',
        call: (d, t, s) => h.call('GET', `/v1/documents/${d}/attribution?atSeq=${s}`, { token: t }),
        ok: 200,
      },
      {
        name: 'exports (seq)',
        kind: 'state',
        call: (d, t, s) =>
          h.call('POST', `/v1/documents/${d}/exports`, {
            token: t,
            body: { target: 'pdf', seq: s },
          }),
        ok: 202,
      },
      {
        name: 'threads?seq',
        kind: 'state',
        call: (d, t, s) => h.call('GET', `/v1/documents/${d}/threads?seq=${s}`, { token: t }),
        ok: 200,
      },
      {
        name: 'field-values?seq',
        kind: 'state',
        call: (d, t, s) => h.call('GET', `/v1/documents/${d}/field-values?seq=${s}`, { token: t }),
        ok: 200,
      },
    ];

    for (const s of SCENARIOS) {
      it.skipIf(skip !== null)(
        `reads: refused below the gate, served at or above it (${s.name}; gate ${s.gate})`,
        async () => {
          const doc = await makeDoc(s.setting);
          const token = tokenOf(doc, s);
          const refused: string[] = [];
          const strict: string[] = [];
          for (const read of reads) {
            for (let seq = 0; seq <= HEAD; seq++) {
              // A run starts at the state `seq`; a single state is also visible at the head.
              const visible = seq >= s.gate || (read.kind === 'state' && seq === HEAD);
              const expected = visible;
              const r = await read.call(doc, token, seq);
              if (expected) {
                if (r.status !== read.ok) strict.push(`${read.name} ${seq}: ${outcome(r)}`);
              } else if (r.status !== 403 || r.json?.code !== 'forbidden') {
                refused.push(`${read.name} ${seq}: ${outcome(r)}`);
              }
            }
          }
          // Too lax: a request below the gate that is not refused. Too strict: one at or above it that is.
          expect(refused, 'answered below the gate').toEqual([]);
          expect(strict, 'refused at or above the gate').toEqual([]);
        },
      );
    }

    // The activity takes no seq from the caller: its marker may lie below the gate, and what it lists
    // starts at the gate (HIS-027 criterion 5). Nothing below the gate is listed, and the head is.
    for (const s of SCENARIOS) {
      it.skipIf(skip !== null)(
        `activity: a marker below the gate lists nothing below it (${s.name}; gate ${s.gate})`,
        async () => {
          const doc = await makeDoc(s.setting);
          const token = tokenOf(doc, s);
          const marker = await h.call('PUT', `/v1/documents/${doc}/read-marker`, {
            token,
            body: { seq: 0 },
          });
          expect(marker.status, marker.text).toBe(200);
          const r = await h.call('GET', `/v1/documents/${doc}/activity`, { token });
          expect(r.status, r.text).toBe(200);
          const seqs = (r.json.items as Array<{ seq: number }>).map((i) => i.seq);
          expect(seqs.every((x) => x >= Math.max(s.gate, 1))).toBe(true);
          expect(seqs).toContain(HEAD);
        },
      );
    }

    // Named-version creation and restore change the document, so each case has a document of its own.
    const writers: Array<{
      name: string;
      who: readonly Role[];
      call: (doc: string, token: string, seq: number) => Promise<CallResult>;
      ok: number;
    }> = [
      {
        name: 'named-version creation',
        who: ['owner', 'editor'],
        call: (d, t, s) =>
          h.call('POST', `/v1/documents/${d}/versions`, {
            token: t,
            body: { seq: s, name: `at ${s}` },
          }),
        ok: 201,
      },
      {
        name: 'restore',
        who: ['owner'],
        call: (d, t, s) =>
          h.call('POST', `/v1/documents/${d}/restore`, { token: t, body: { toSeq: s } }),
        ok: 200,
      },
    ];
    for (const s of SCENARIOS) {
      for (const w of writers) {
        it.skipIf(skip !== null)(
          `${w.name}: refused below the gate, done at or above it (${s.name}; gate ${s.gate})`,
          async () => {
            const wrong: string[] = [];
            for (let seq = 0; seq <= HEAD; seq++) {
              const doc = await makeDoc(s.setting);
              const token = tokenOf(doc, s);
              const r = await w.call(doc, token, seq);
              const visible = seq >= s.gate || seq === HEAD;
              // A role without the right is refused for that reason, whatever the gate.
              const right = w.who.includes(s.role);
              if (visible && right) {
                if (r.status !== w.ok) wrong.push(`seq ${seq}: ${outcome(r)} (wanted ${w.ok})`);
              } else if (r.status !== 403 || r.json?.code !== 'forbidden') {
                wrong.push(`seq ${seq}: ${outcome(r)} (wanted forbidden)`);
              }
            }
            expect(wrong).toEqual([]);
          },
        );
      }
    }

    it.skipIf(skip !== null)(
      'fork: a service credential names the user it acts for, and that user gate applies',
      async () => {
        for (const setting of ['editors', 'all', 'since_access'] as Setting[]) {
          const doc = await makeDoc(setting);
          const fork = (atSeq: number, actor?: string) =>
            h.call('POST', `/v1/documents/${doc}/fork`, {
              token: h.apiKey,
              headers: {
                'Idempotency-Key': randomUUID(),
                ...(actor ? { 'DEP-Actor': actor } : {}),
              },
              body: { atSeq },
            });
          // Without an actor a service credential reads full history, whatever the setting.
          expect((await fork(1)).status, `${setting} without an actor`).toBe(201);
          // A named user with no role of their own holds the lowest role and no claim: the gate is
          // the head under `editors` and `since_access`, and 0 under `all`.
          const gate = setting === 'all' ? 0 : HEAD;
          for (let seq = 0; seq <= HEAD; seq++) {
            const r = await fork(seq, 'carol');
            if (seq >= gate || seq === HEAD) expect(r.status, `${setting} ${seq}`).toBe(201);
            else {
              expect(r.status, `${setting} ${seq}`).toBe(403);
              expect(r.json.code).toBe('forbidden');
            }
          }
        }
      },
    );

    it.skipIf(skip !== null)(
      'a range that straddles the gate contains nothing from below it (history and diff)',
      async () => {
        const doc = await makeDoc('since_access');
        const s: Scenario = {
          name: 'x',
          setting: 'since_access',
          role: 'viewer',
          claim: true,
          gate: 3,
        };
        const token = tokenOf(doc, s);
        // The history from the start is refused; the history without a start lists only commit 4.
        const refused = await h.call('GET', `/v1/documents/${doc}/history?fromSeq=1`, { token });
        expect(refused.status).toBe(403);
        const all = await h.call('GET', `/v1/documents/${doc}/history`, { token });
        expect(all.status).toBe(200);
        const seqs = (all.json.items as Array<{ fromSeq?: number; toSeq?: number }>).flatMap(
          (i) => [i.fromSeq, i.toSeq],
        );
        expect(seqs.filter((x) => x !== undefined && x <= 3)).toEqual([]);
        expect(all.text).not.toContain('"fromSeq":1');
        // The comparison from the gate shows only what changed after it.
        const diff = await h.call('GET', `/v1/documents/${doc}/diff?fromSeq=3&toSeq=${HEAD}`, {
          token,
        });
        expect(diff.status).toBe(200);
        expect(diff.json.fromSeq).toBe(3);
        // The state at the gate holds the text of commits 1 to 3, as any state does; what the
        // comparison names of the history is the commits after the gate.
        const spanSeqs = (diff.json.changes as Array<{ spans?: Array<{ seq?: number }> }>).flatMap(
          (c) => (c.spans ?? []).map((x) => x.seq),
        );
        expect(spanSeqs.length).toBeGreaterThan(0);
        expect(spanSeqs.every((x) => x !== undefined && x > 3)).toBe(true);
      },
    );
  });
}
