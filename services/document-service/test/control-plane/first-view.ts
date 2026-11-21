// Opening a channel as a bound participant, and waiting until the first view that the open records
// has settled in the room (FRW-040).
//
// The first view is recorded after `ch.opened` is sent. The control plane raises the grants
// revision first, then moves the workflow row, then tells the room, which sends `perm.changed` to
// every channel. Between the first step and the last the room still holds the old revision, and a
// commit written then is refused as `unavailable` with `action: 'retry'` (the write's condition
// finds the revision moved; 04 §5, 06 §8). That is the documented answer and a client resubmits.
// A test that wants to submit at once, or to count the `perm.changed` messages of a channel, waits
// for the room to catch up instead: the workflow row is not enough, because it moves before the room
// is told. Under load the gap grew from microseconds to tens of milliseconds.
import type { Received } from '../data-plane/client.ts';
import type { DepClient } from '../data-plane/client.ts';
import type { Harness } from './support.ts';

/** The pause between two reads of a value that another part of the service writes. */
const POLL_MS = 20;

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${what} after ${ms} ms`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/**
 * Opens channel `ch` of `doc` on `c` and returns the answer. When the open is the first view of the
 * bound participant, this returns after the workflow row shows the view and the channel has had
 * the `perm.changed` that the room sends for it. That message is taken from the client's queue, so
 * that a later `take` of a `perm.changed` waits for the next one. `c.all` still lists it.
 */
export async function openAndSettle(
  h: Harness,
  c: DepClient,
  doc: string,
  ch = 1,
): Promise<Received> {
  const read = () => h.parts.workflows!.read(h.tenant, doc);
  const unviewed = new Set(
    ((await read())?.participants ?? [])
      .filter((p) => p.firstViewedAt === undefined)
      .map((p) => p.id),
  );
  const opened = await c.open(ch, doc);
  if (opened.t !== 'ch.opened') return opened;
  const fill = (opened.d as { access: { fill: { participant?: string } | null } }).access.fill;
  const pid = fill?.participant;
  if (pid === undefined || !unviewed.has(pid)) return opened;
  await until(`the first view of ${pid}`, async () => {
    const row = await read();
    return row?.participants.find((p) => p.id === pid)?.firstViewedAt !== undefined;
  });
  await c.take(
    (m) => m.t === 'perm.changed' && m.ch === ch,
    10_000,
    'perm.changed of the first view',
  );
  return opened;
}
