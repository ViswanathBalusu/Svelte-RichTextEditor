// The visibility gate on every history function that takes a sequence number (08 §9; 07 §8;
// HIS-026), and the right to name a version (08 §4; HIS-006 criterion 2). The gate itself is
// `minVisibleSeq` in the authority; these tests run the package's functions with it for each
// setting (`editors`, `all`, `since_access`) and each role. A request below the gate is refused
// with `forbidden` before any rebuild work (the sources below throw if they are touched); a
// request at or above it succeeds; a comparison that straddles the gate returns nothing.
import {
  type Access,
  type Connection,
  type ContentSource,
  type DocRole,
  type PermissionState,
  NOTHING_HIDDEN,
  computeAccess,
  editsSomewhere,
  minVisibleSeq,
  regionInfos,
} from '@docedit/authority';
import { Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { AttributionMap, applyCommit } from '../src/attribution.ts';
import { type CompareSource, compare } from '../src/compare.ts';
import { UNKNOWN_SEQ, attributionFor, versionFor } from '../src/reader.ts';
import { withRunTimes } from '../src/who-wrote-times.ts';
import { type RestoreContext, planRestore } from '../src/restore.ts';
import { createVersion } from '../src/versions.ts';
import type { HistoryGate } from '../src/types.ts';
import { LogBuilder, posOf, schema, typeAt } from './fixtures.ts';

const NOW = 1_790_000_000_000;
const ROLES: readonly DocRole[] = ['owner', 'editor', 'filler', 'suggester', 'commenter', 'viewer'];
const SETTINGS = ['editors', 'all', 'since_access'] as const;

type Setting = (typeof SETTINGS)[number];

const conn = (sub: string, role: DocRole): Connection => ({
  sub,
  session: `s-${sub}`,
  role,
  groups: [],
  participantRoles: [],
  participantActive: false,
});

const NO_GRANTS: PermissionState = {
  revision: 1,
  grants: [],
  regionStates: new Map(),
  leases: [],
  documentState: 'active',
  workflowActive: false,
};

/** Three commits by three people; the head is seq 3. */
function log(): LogBuilder {
  const b = new LogBuilder();
  b.add((d) => typeAt(d, 'pTerms000000001A', 0, 'Changed. '), { user: 'carol' });
  b.add(
    (d) => {
      const at = posOf(d, 'pTerms000000002A');
      return new Transform(d).delete(at, at + d.nodeAt(at)!.nodeSize);
    },
    { user: 'carol' },
  );
  b.add((d) => typeAt(d, 'pTerms000000003A', 0, 'Later. '), { user: 'dan' });
  return b;
}

function mapsOf(b: LogBuilder): AttributionMap[] {
  const maps = [AttributionMap.create(b.docs[0]!.content.size, { user: 'owner', seq: 0 })];
  for (const c of b.log) {
    const m = maps[maps.length - 1]!.clone();
    applyCommit(m, c, schema);
    maps.push(m);
  }
  return maps;
}

/** The gate a connection gets under a setting, computed by the authority (07 §8). */
function gateFor(b: LogBuilder, c: Connection, setting: Setting): HistoryGate {
  const es = editsSomewhere(c, regionInfos(b.doc), NO_GRANTS, NOW);
  const min = minVisibleSeq({
    setting,
    editsSomewhere: es,
    accessSince: b.log[0]!.time,
    head: b.head,
    timeOf: (seq) => b.log.find((x) => x.seq === seq)?.time,
    floor: 0,
  });
  return { min, head: b.head };
}

/** A source that fails the test if a refused request reaches the rebuild. */
function forbiddenSource(head: number): CompareSource & ContentSource {
  const boom = (): never => {
    throw new Error('the rebuild ran before the gate refused');
  };
  return {
    schema,
    incarnation: 'inc-1',
    content: boom,
    commits: boom,
    attribution: boom,
    get checkpoints(): never {
      return boom();
    },
    head,
  } as unknown as CompareSource & ContentSource;
}

function sourceOf(b: LogBuilder, maps: AttributionMap[]): CompareSource {
  return {
    schema,
    incarnation: 'inc-1',
    content: (seq) => b.docs[seq],
    commits: (after, to) => b.commits(after, to),
    attribution: (seq) => maps[seq],
  };
}

function restoreCtx(
  b: LogBuilder,
  c: Connection,
  gate: HistoryGate,
  maps: AttributionMap[],
): RestoreContext {
  const access: Access = computeAccess(c, regionInfos(b.doc), NO_GRANTS, NOW);
  return {
    schema,
    head: { seq: b.head, doc: b.doc, attribution: maps[b.head]! },
    target: (seq) => ({ doc: b.docs[seq]!, attribution: maps[seq]! }),
    gate,
    hidden: NOTHING_HIDDEN,
    access,
    user: c.sub,
  };
}

describe('naming a version needs edit somewhere in the document (HIS-006 criterion 2)', () => {
  it('refuses view, comment, suggest and fill with forbidden, and allows edit', () => {
    const b = log();
    const gate = { min: 0, head: b.head };
    for (const role of ROLES) {
      const c = conn(`u-${role}`, role);
      // The service computes canEdit from the connection (08 §9); the test does the same.
      const canEdit = editsSomewhere(c, regionInfos(b.doc), NO_GRANTS, NOW);
      const r = createVersion(
        [],
        { seq: 2, kind: 'named', name: 'Sent to legal', createdBy: c.sub, createdAt: NOW },
        { canEdit, head: b.head, gate },
      );
      if (role === 'owner' || role === 'editor') expect(r).toMatchObject({ ok: true });
      else expect(r).toMatchObject({ ok: false, code: 'forbidden' });
    }
    expect(
      ROLES.filter((r) => editsSomewhere(conn('x', r), regionInfos(b.doc), NO_GRANTS, NOW)),
    ).toEqual(['owner', 'editor']);
  });
});

describe('the visibility gate on every sequence number (HIS-026)', () => {
  for (const setting of SETTINGS) {
    for (const role of ROLES) {
      it(`refuses a seq below the gate with forbidden: ${setting}, ${role}`, () => {
        const b = log();
        const maps = mapsOf(b);
        const c = conn(`u-${role}`, role);
        const gate = gateFor(b, c, setting);
        if (gate.min === 0) return; // nothing is below the gate for this pairing
        const below = gate.min - 1;
        const src = forbiddenSource(gate.head);

        // Comparison: from below the gate to the head (a straddling range) is refused first.
        expect(
          compare({ fromSeq: below, toSeq: gate.head }, src, { gate, hidden: NOTHING_HIDDEN }),
        ).toMatchObject({ ok: false, code: 'forbidden' });
        // Attribution at a version below the gate.
        expect(
          attributionFor({
            doc: b.docs[below]!,
            map: maps[below]!,
            seq: below,
            gate,
            hidden: NOTHING_HIDDEN,
          }),
        ).toMatchObject({ ok: false, code: 'forbidden' });
        // The content at a version below the gate is refused before the rebuild (HIS-005).
        expect(versionFor(below, src, gate, NOTHING_HIDDEN)).toMatchObject({
          ok: false,
          code: 'forbidden',
        });
        // A named version below the gate.
        expect(
          createVersion(
            [],
            { seq: below, kind: 'named', createdBy: c.sub, createdAt: NOW },
            { canEdit: true, head: gate.head, gate },
          ),
        ).toMatchObject({ ok: false, code: 'forbidden' });
        // A restore to a version below the gate: refused whoever asks.
        expect(planRestore({ toSeq: below }, restoreCtx(b, c, gate, maps))).toMatchObject({
          ok: false,
        });
      });
    }
  }
});

describe('a request at or above the gate succeeds (HIS-026 criterion 2)', () => {
  for (const setting of SETTINGS) {
    for (const role of ROLES) {
      it(`answers at the gate and at the head: ${setting}, ${role}`, () => {
        const b = log();
        const maps = mapsOf(b);
        const c = conn(`u-${role}`, role);
        const gate = gateFor(b, c, setting);
        const src = sourceOf(b, maps);
        const canEdit = editsSomewhere(c, regionInfos(b.doc), NO_GRANTS, NOW);
        for (const seq of new Set([gate.min, gate.head])) {
          expect(
            compare({ fromSeq: seq, toSeq: gate.head }, src, { gate, hidden: NOTHING_HIDDEN }).ok,
          ).toBe(true);
          expect(
            attributionFor({
              doc: b.docs[seq]!,
              map: maps[seq]!,
              seq,
              gate,
              hidden: NOTHING_HIDDEN,
            }).ok,
          ).toBe(true);
          expect(
            createVersion(
              [],
              { seq, kind: 'named', createdBy: c.sub, createdAt: NOW },
              { canEdit, head: gate.head, gate },
            ).ok,
          ).toBe(canEdit);
        }
      });
    }
  }
});

describe('a comparison that straddles the gate contains nothing from below it (HIS-026 criterion 3)', () => {
  it('returns no comparison at all when the range starts below the gate', () => {
    const b = log();
    const maps = mapsOf(b);
    const c = conn('u-viewer', 'viewer');
    const gate = gateFor(b, c, 'editors');
    expect(gate.min).toBe(gate.head);
    const r = compare({ fromSeq: gate.min - 1, toSeq: gate.head }, sourceOf(b, maps), {
      gate,
      hidden: NOTHING_HIDDEN,
    });
    expect(r.ok).toBe(false);
    expect(r).not.toHaveProperty('comparison');
  });
});

describe('attribution across the gate shows an unknown person (owner decision 37; HIS-026 criterion 3)', () => {
  const read = (min: number, seq: number) => {
    const b = log();
    const maps = mapsOf(b);
    const r = attributionFor({
      doc: b.docs[seq]!,
      map: maps[seq]!,
      seq,
      gate: { min, head: b.head },
      hidden: NOTHING_HIDDEN,
    });
    if (!r.ok) throw new Error(`refused: ${r.code}`);
    return r;
  };

  it('withholds the author and the time of content written below the gate', () => {
    // The gate is the head: only the commit of seq 3 (dan) is at or above it.
    const r = read(3, 3);
    expect(r.spans.some((s) => s.unknown)).toBe(true);
    for (const s of r.spans) {
      if (s.unknown) expect(s).toMatchObject({ user: '', seq: UNKNOWN_SEQ });
      else expect(s).toMatchObject({ user: 'dan', seq: 3 });
      if (s.unknown) expect(s).not.toHaveProperty('agent');
    }
    expect(r.spans.filter((s) => !s.unknown).length).toBeGreaterThan(0);
    const text = JSON.stringify(r);
    for (const below of ['carol', 'owner']) expect(text).not.toContain(below);
    // No run names a commit below the gate.
    expect(r.spans.every((s) => s.unknown || s.seq >= 3)).toBe(true);
  });

  it('merges neighbouring unknown spans, so that the commits below the gate are not told apart', () => {
    const r = read(3, 3);
    for (let i = 1; i < r.spans.length; i++) {
      const a = r.spans[i - 1]!;
      const s = r.spans[i]!;
      expect(Boolean(a.unknown && s.unknown && a.blockId === s.blockId && a.to === s.from)).toBe(
        false,
      );
    }
  });

  it('shows every author when nothing is below the gate, and the times are withheld in the join', () => {
    expect(read(0, 3).spans.some((s) => s.unknown)).toBe(false);
    const b = log();
    const timed = withRunTimes(read(3, 3), b.log.map((c) => ({ seq: c.seq, time: c.time })), {
      createdAt: 500,
    });
    if (!timed.ok) throw new Error('refused');
    for (const run of timed.runs) {
      if (run.unknown) expect(run).not.toHaveProperty('time');
      else expect(run.time).toBeTypeOf('number');
    }
    expect(timed.authors.map((a) => a.user)).toEqual(['dan']);
  });
});
