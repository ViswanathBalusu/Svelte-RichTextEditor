/**
 * The one visibility gate (HIS-024) evaluated from stored state: the gate of each setting, the
 * head that is never blocked, and the default `editors` setting for people who can and cannot edit.
 */
import {
  EMPTY_PERMISSIONS,
  HISTORY_VISIBILITIES,
  type HistoryVisibility,
  type RoomConnection,
} from '@docedit/authority';
import { cdmSchema } from '@docedit/model/prosemirror';
import { describe, expect, it } from 'vitest';
import { gateOf, rangeAllowed, stateAllowed, type StoredState } from './gate.ts';

const schema = cdmSchema();

/** A one-body document with a single paragraph: enough for the gate, which reads regions only. */
const doc = schema.nodeFromJSON({
  type: 'doc',
  content: [
    {
      type: 'defs',
      content: [
        {
          type: 'settings',
          attrs: { lang: 'en-GB', defaultTabStop: 720, defaultParagraphStyle: 'Normal' },
        },
        {
          type: 'style_def',
          attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
        },
        {
          type: 'page_setup',
          attrs: {
            id: 'ps1',
            width: 11906,
            height: 16838,
            marginTop: 1440,
            marginRight: 1440,
            marginBottom: 1440,
            marginLeft: 1440,
          },
        },
      ],
    },
    {
      type: 'body',
      attrs: { pageSetup: 'ps1' },
      content: [{ type: 'paragraph', attrs: { id: 'p0000000000000001', style: 'Normal' } }],
    },
  ],
});

function conn(role: RoomConnection['role'], accessSince?: number): RoomConnection {
  return {
    sub: `user-${role}`,
    session: 's1',
    role,
    groups: [],
    participantRoles: [],
    participantActive: false,
    ...(accessSince !== undefined ? { accessSince } : {}),
  } as RoomConnection;
}

/** A log of `head` commits, the commit `seq` made at `seq * 1000` milliseconds. */
function stored(
  setting: HistoryVisibility,
  head: number,
  extra: Partial<StoredState> = {},
): StoredState {
  return {
    setting,
    head: doc,
    headSeq: head,
    perms: EMPTY_PERMISSIONS,
    log: Array.from({ length: head }, (_, i) => ({ seq: i + 1, time: (i + 1) * 1000 })),
    now: 10_000_000,
    ...extra,
  };
}

describe('the visibility gate (HIS-024)', () => {
  it('never blocks the head, for any setting and any role that can read the document', () => {
    for (const setting of HISTORY_VISIBILITIES)
      for (const role of ['viewer', 'commenter', 'editor', 'owner'] as const)
        for (const head of [0, 1, 2, 7]) {
          const gate = gateOf(conn(role, 1500), stored(setting, head));
          expect(gate, `${setting} ${role} head ${head}`).toBeLessThanOrEqual(head);
          expect(stateAllowed(gate, head, head)).toBe(true);
        }
  });

  it('shows full history to people who hold edit somewhere, under the default editors setting', () => {
    const s = stored('editors', 5);
    expect(gateOf(conn('editor'), s)).toBe(0);
    expect(gateOf(conn('owner'), s)).toBe(0);
    expect(stateAllowed(gateOf(conn('editor'), s), 1, 5)).toBe(true);
    expect(rangeAllowed(gateOf(conn('editor'), s), 0)).toBe(true);
  });

  it('shows only the current version to readers under the default editors setting', () => {
    const s = stored('editors', 5);
    const gate = gateOf(conn('viewer'), s);
    expect(gate).toBe(5);
    expect(stateAllowed(gate, 4, 5)).toBe(false);
    expect(stateAllowed(gate, 5, 5)).toBe(true);
    expect(rangeAllowed(gate, 4)).toBe(false);
  });

  it('shows full history to everyone with view under all', () => {
    expect(gateOf(conn('viewer'), stored('all', 5))).toBe(0);
  });

  it('under since_access, shows the state current at the access time, and fails closed without the claim', () => {
    // Commit 2 is at 2000 ms: the state current at access time 2500 ms is seq 2.
    expect(gateOf(conn('viewer', 2500), stored('since_access', 5))).toBe(2);
    expect(gateOf(conn('viewer'), stored('since_access', 5))).toBe(5);
  });
});
