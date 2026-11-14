/**
 * Real rooms (packages/authority) over the PostgreSQL stores, for the tests where the room's
 * reaction to a storage outcome is the point: fencing, failed and unknown writes.
 */
import {
  Room,
  type CommitInput,
  type Effects,
  type Outbound,
  type PermissionState,
  type LogCommit,
} from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import {
  REQUIRES,
  USERS,
  baseDoc,
  basePermissions,
  posInside,
  schema,
} from '../../../../packages/authority/test/fixtures.ts';

export { USERS, basePermissions };

export function openRoom(opts: {
  log: readonly LogCommit[];
  epoch: number;
  incarnation: string;
  perms?: PermissionState;
}): Room {
  return new Room({
    schema,
    initial: baseDoc(),
    requires: REQUIRES,
    log: opts.log,
    perms: opts.perms ?? basePermissions(),
    initialRevision: 1,
    epoch: opts.epoch,
    incarnation: opts.incarnation,
    now: () => 1_760_000_000_000,
  });
}

/** Alice types `text` at the start of the introduction paragraph, against `base`. */
export function typing(base: number, text = 'x'): CommitInput {
  const pos = posInside(baseDoc(), 'pIntro0000000001');
  return {
    id: uuid7(),
    base,
    steps: [
      { stepType: 'replace', from: pos, to: pos, slice: { content: [{ type: 'text', text }] } },
    ],
    origin: 'input',
  };
}

export function messages(fx: Effects): Outbound['msg'][] {
  return fx.send.map((o) => o.msg);
}
