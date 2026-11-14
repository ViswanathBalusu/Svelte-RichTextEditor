/**
 * SEC-032 (criterion 2 and the visibility rule behind criteria 1 and 3): the history settings
 * `editors` (the default), `all` and `since_access` applied to a viewer, a commenter and an editor,
 * through the data plane's gate (services/document-service/src/data-plane/gate.ts, the one place the
 * data plane evaluates it). The head document, the permissions and the commit times are built here.
 *
 * What this proves: for each setting and each role, the set of states the gate lets a user read
 * (single states, `stateVisible`) and the runs it lets them receive (`rangeVisible`) match the
 * setting. It does not run the room, the routes or the resume: criterion 1 (each place a sequence
 * number is supplied, including `resume.seq` answered with `catchUp: "reload"`) and criteria 3 to 5
 * are not proved here.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { minVisibleSeq, type HistoryVisibility, type RoomConnection } from '@docedit/authority';
import {
  gateOf,
  rangeAllowed,
  stateAllowed,
  type StoredState,
} from '../../../services/document-service/src/data-plane/gate.ts';
import { CAROL, FRANK, fieldsDoc, permissions } from './support/authority-fixtures.ts';

const HEAD = 10;
/** Commit `seq` was stored at `seq * 1000` ms, so the log is easy to read. */
const LOG = Array.from({ length: HEAD }, (_, i) => ({ seq: i + 1, time: (i + 1) * 1000 }));
/** The token's `access_since`: the last commit at or before it is seq 5. */
const ACCESS_SINCE = 5500;

/** A commenter: holds `comment` on the body and no `edit` anywhere. */
const COMMENTER: RoomConnection = {
  sub: 'cora',
  session: 's-cora',
  role: 'commenter',
  groups: [],
  participantRoles: [],
  participantActive: false,
};

const ROLES: Record<string, RoomConnection> = {
  viewer: FRANK,
  commenter: COMMENTER,
  editor: CAROL,
};

function stateOf(setting: HistoryVisibility): StoredState {
  return {
    setting,
    head: fieldsDoc(),
    headSeq: HEAD,
    perms: permissions(),
    log: LOG,
    now: 0,
  };
}

/** The states in 1 to HEAD that the gate lets `conn` read. */
function visibleStates(conn: RoomConnection, setting: HistoryVisibility): number[] {
  const gate = gateOf(conn, stateOf(setting));
  const out: number[] = [];
  for (let s = 1; s <= HEAD; s++) if (stateAllowed(gate, s, HEAD)) out.push(s);
  return out;
}

const range = (a: number, b: number): number[] =>
  Array.from({ length: b - a + 1 }, (_, i) => a + i);

describe('SEC-032 criterion 2: each history setting, for a viewer, a commenter and an editor', () => {
  it('editors (the default): the editor reads every state; a viewer and a commenter read the head only', () => {
    expect(visibleStates(CAROL, 'editors')).toEqual(range(1, HEAD));
    expect(visibleStates(FRANK, 'editors')).toEqual([HEAD]);
    expect(visibleStates(COMMENTER, 'editors')).toEqual([HEAD]);
  });

  it('editors: a viewer and a commenter may not receive the run of commits after an older seq', () => {
    const gate = gateOf(FRANK, stateOf('editors'));
    expect(rangeAllowed(gate, 4)).toBe(false);
    expect(rangeAllowed(gate, HEAD)).toBe(true);
    const editorGate = gateOf(CAROL, stateOf('editors'));
    expect(rangeAllowed(editorGate, 1)).toBe(true);
  });

  it('all: every role reads every state', () => {
    for (const conn of Object.values(ROLES))
      expect(visibleStates(conn, 'all')).toEqual(range(1, HEAD));
  });

  it('since_access with the claim: every role reads from the last commit at or before access_since', () => {
    for (const conn of Object.values(ROLES)) {
      const withClaim: RoomConnection = { ...conn, accessSince: ACCESS_SINCE };
      expect(visibleStates(withClaim, 'since_access')).toEqual(range(5, HEAD));
    }
  });

  it('since_access without the claim: the gate fails closed at the head for every role', () => {
    for (const conn of Object.values(ROLES))
      expect(visibleStates(conn, 'since_access')).toEqual([HEAD]);
  });
});

describe('SEC-032 criterion 2: the since_access gate is the last commit at or before access_since', () => {
  it('for any head and any access time, the gate is the last seq stored at or before it, never above the head', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200 }),
        fc.integer({ min: 0, max: 250_000 }),
        (head, accessSince) => {
          const gate = minVisibleSeq({
            setting: 'since_access',
            editsSomewhere: false,
            accessSince,
            head,
            timeOf: (seq) => seq * 1000,
          });
          expect(gate).toBe(Math.min(head, Math.floor(accessSince / 1000)));
          expect(gate).toBeGreaterThanOrEqual(0);
          expect(gate).toBeLessThanOrEqual(head);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('the gate for editors is 0 for an editor and the head for anyone else, whatever the head', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 500 }), (head) => {
        expect(
          minVisibleSeq({
            setting: 'editors',
            editsSomewhere: true,
            head,
            timeOf: () => undefined,
          }),
        ).toBe(0);
        expect(
          minVisibleSeq({
            setting: 'editors',
            editsSomewhere: false,
            head,
            timeOf: () => undefined,
          }),
        ).toBe(head);
      }),
      { numRuns: 200 },
    );
  });
});
