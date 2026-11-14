// SYN-031 criterion 2: when a transient authority finishes, it leaves no subscribers, no timers and
// no held memory for the document. The room is the whole of the authority's state, so the run is
// checked on the room: its channels, its pending writes, the timers scheduled while it ran, and
// whether the garbage collector can release it. Process exit and the host's registry are BE's.
import vm from 'node:vm';
import v8 from 'node:v8';
import { Fragment, type Node, Slice } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Room, type RoomInit } from '../src/room/room.ts';
import type { CommitInput } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { REQUIRES, USERS, baseDoc, basePermissions, posInside, schema } from './fixtures.ts';

const T0 = 1_790_300_000_000;
const ID_1 = '0192f0c4-9100-7000-8000-000000000001';

function room(init: Partial<RoomInit> = {}): Room {
  return new Room({
    schema,
    initial: baseDoc(),
    requires: REQUIRES,
    log: [],
    perms: basePermissions(),
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-transient-resources',
    now: () => T0,
    ...init,
  });
}

function insertCommit(doc: Node, paragraph: string, id: string, base: number): CommitInput {
  const pos = posInside(doc, paragraph);
  return {
    id,
    base,
    steps: stepsToJson([
      new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text('edit')), 0, 0)),
    ]),
  };
}

/** One transient run: load the checkpoint, apply one commit, store it, then exit. */
function transientRun(checkpoint: Node, seq: number): Room {
  const transient = room({ initial: checkpoint, initialSeq: seq });
  transient.open('ed', USERS.carol);
  const fx = transient.submit('ed', insertCommit(checkpoint, 'pMiddle000000001', ID_1, seq));
  if (fx.write) transient.writeCompleted({ status: 'ok' });
  transient.close('ed');
  transient.stop();
  return transient;
}

/** Exposes `gc` for this file only; Node allows it through a new context. */
function exposeGc(): () => void {
  v8.setFlagsFromString('--expose_gc');
  return vm.runInNewContext('gc') as () => void;
}

describe('a transient authority leaves nothing held (SYN-031 criterion 2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes every channel, schedules no timers and holds no pending write', () => {
    const checkpoint = baseDoc();
    const transient = transientRun(checkpoint, 0);

    expect(transient.isStopped).toBe(true);
    expect(transient['channels'].size, 'no subscribers').toBe(0);
    expect(transient.pendingCount, 'no pending writes').toBe(0);
    expect(vi.getTimerCount(), 'no timers').toBe(0);
  });

  it('lets the garbage collector release the room after the run', async () => {
    const gc = exposeGc();
    vi.useRealTimers();
    let ref: WeakRef<Room> | undefined;

    const run = (): void => {
      const checkpoint = baseDoc();
      ref = new WeakRef(transientRun(checkpoint, 0));
    };
    run();

    for (let i = 0; i < 10 && ref?.deref() !== undefined; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      gc();
    }
    expect(ref?.deref(), 'the room is collected').toBeUndefined();
  });
});
