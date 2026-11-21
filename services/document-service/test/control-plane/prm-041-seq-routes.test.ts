// PRM-041 criterion 1 (lane U-PRM-035-051): every route or message field that takes a sequence
// number, as SEQ_INPUTS lists it (HIS-024 criterion 4), is shown to call the visibility gate, or is
// named here as open with its reason. The route files are read from the source, so the check
// follows the code. A gated route that is not yet gated fails the test that keeps it open, so the
// list is updated when the gate lands.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SEQ_INPUTS } from '../../src/data-plane/gate.ts';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));
const CONTROL_GATE = /minVisibleSeqOf\(|refuseBelowGate\(|refuseSeqBelowGate\(/;
const ROOM_GATE = /stateAllowed\(|rangeAllowed\(|minVisibleSeq\(/;

/** Built routes and the file that serves each, with the call that applies the gate there. */
const BUILT: Record<string, { file: string; gate: RegExp }> = {
  'ch.open': { file: 'data-plane/room-host.ts', gate: ROOM_GATE },
  'GET /documents/{id}/content': { file: 'control-plane/handlers.ts', gate: CONTROL_GATE },
  'GET /documents/{id}/commits': { file: 'control-plane/commit-routes.ts', gate: CONTROL_GATE },
  'POST /documents/{id}/exports': { file: 'control-plane/export-routes.ts', gate: CONTROL_GATE },
  'GET /documents/{id}/field-values': { file: 'control-plane/field-routes.ts', gate: CONTROL_GATE },
  // PRO-055 and PRO-056: the history reads and the restore read the gate through `historyViewOf`
  // and `minVisibleSeqOf`, and refuse with `checkSeq` or `planRestore`.
  'GET /documents/{id}/diff': { file: 'control-plane/history-reads.ts', gate: CONTROL_GATE },
  'GET /documents/{id}/attribution': { file: 'control-plane/history-reads.ts', gate: CONTROL_GATE },
  'GET /documents/{id}/history': {
    // HIS-026: `historyViewOf` reads the gate; `checkSeq` and `rangeVisible` refuse below it.
    file: 'control-plane/history-list-route.ts',
    gate: /historyViewOf\(/,
  },
  // HIS-037: the segment starts at the caller's gate (`minVisibleSeqOf`) and refuses a range below it.
  'GET /documents/{id}/audit-segment': {
    file: 'control-plane/audit-segment-route.ts',
    gate: CONTROL_GATE,
  },
  'POST /documents/{id}/versions': { file: 'control-plane/versions-routes.ts', gate: CONTROL_GATE },
  'POST /documents/{id}/restore': { file: 'control-plane/restore-route.ts', gate: CONTROL_GATE },
  'POST /documents/{id}/fork': { file: 'control-plane/history-routes.ts', gate: CONTROL_GATE },
  // PRM-042: the threads at a state are refused below the gate, as the content is.
  'GET /documents/{id}/threads': { file: 'control-plane/thread-routes.ts', gate: CONTROL_GATE },
  // FRW-062 and FRW-063: the template seq is pinned through `pinTemplate`, which calls
  // `refuseSeqBelowGate` as the fork does (a service credential: the gate of the user it names).
  'POST /documents': { file: 'control-plane/template-routes.ts', gate: CONTROL_GATE },
  'POST /bulk-sends': { file: 'control-plane/bulk-send.ts', gate: /pinTemplate\(/ },
};

/** Gated inputs that are not gated yet, or whose route is not built; each with its reason. */
const OPEN: Record<string, { file: string; reason: string }> = {};

const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

describe('every sequence input is gated or named as open (PRM-041 criterion 1)', () => {
  const gated = [...new Set(SEQ_INPUTS.filter((i) => i.rule !== 'exempt').map((i) => i.where))];

  it('every gated input is either built and gated, or open with a reason', () => {
    const unaccounted = gated.filter((w) => !(w in BUILT) && !(w in OPEN));
    expect(unaccounted).toEqual([]);
    const stale = [...Object.keys(BUILT), ...Object.keys(OPEN)].filter((w) => !gated.includes(w));
    expect(stale).toEqual([]);
  });

  it('each built route calls the gate in the file that serves it', () => {
    for (const [where, { file, gate }] of Object.entries(BUILT))
      expect(read(file), `${where} in ${file}`).toMatch(gate);
  });
});
