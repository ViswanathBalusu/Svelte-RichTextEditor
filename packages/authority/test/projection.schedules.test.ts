// Two schedules that the random runs of S12 (projection.property.test.ts) found on 2026-11-20, with
// the seeds 1780757714 and -959420596, cut down to the operations that matter. In each of them a
// reader who may not read the confidential region received the region's marker, and in neither was
// that a leak by the room or the gateway (ADR 0423):
//
// 1. A client that may read the region re-applied its unconfirmed typing after a snapshot reset. One
//    of its steps no longer applied, and the steps made after it were applied without it, so the
//    typing landed 47 positions early, in a paragraph everyone reads. The client now maps a step
//    made after a failed one back over it (04 §8; `sync.reset` in harness/client.ts, as in the
//    engine's `reset`), and the typing stays in its paragraph.
// 2. A user who may edit the region and the body removed the region and kept its paragraphs. They
//    are body text from then on, and the room rightly sends them to everyone. The simulation's
//    marker stops being a secret when a stored version holds it outside the region.
import { describe, expect, it } from 'vitest';
import type { UserName } from './fixtures.ts';
import {
  LEGAL,
  ProjectionSim,
  SECRET_REGION,
  markerOutsideRegion,
} from './harness/projection-sim.ts';
import type { Op } from './harness/sim.ts';

function run(users: UserName[], ops: readonly Op[]): { sim: ProjectionSim; failures: string[] } {
  const sim = new ProjectionSim(users, ['mallory']);
  for (const op of ops) sim.step(op);
  sim.quiesce();
  return { sim, failures: sim.check() };
}

/** The text of the paragraph with this identifier in the full head, or null when it is not there. */
function paragraph(sim: ProjectionSim, id: string): string | null {
  let found: string | null = null;
  sim.gateway.fullHead.descendants((n) => {
    if (n.type.name === 'paragraph' && n.attrs['id'] === id) found = n.textContent;
    return found === null;
  });
  return found;
}

function hasRegion(sim: ProjectionSim, id: string): boolean {
  let found = false;
  sim.gateway.fullHead.descendants((n) => {
    if (n.type.name === 'region' && n.attrs['id'] === id) found = true;
    return !found;
  });
  return found;
}

describe('S12: schedules the random runs found', () => {
  it('after a snapshot reset, typing queued behind a step that no longer applies stays in the confidential paragraph', () => {
    const { sim, failures } = run(
      ['alice', 'dave', 'mallory'],
      [
        // Alice, the owner, types the marker in the confidential paragraph and sends it.
        { k: 'edit', c: 0, a: 0, b: 0, s: 'a' },
        { k: 'send', c: 0 },
        // She deletes from the first region into the paragraph after it (47 positions), loses her
        // connection, and types the marker in the confidential paragraph again.
        { k: 'edit', c: 0, a: 691, b: 210, s: 'a' },
        { k: 'drop', c: 0 },
        { k: 'edit', c: 0, a: 0, b: 0, s: 'a' },
        // An earlier version is restored, another user edits, and the grants change.
        { k: 'snapshot', a: 0 },
        { k: 'edit', c: 1, a: 538, b: 233, s: 'a' },
        { k: 'grants', a: 0, b: 0 },
      ],
    );
    expect(failures).toEqual([]);
    const alice = sim.clients[0]!;
    expect(alice.resets).toBe(1);
    // The deletion did not apply to the restored content and is recovered work; the typing made
    // after it was kept.
    expect(alice.recovered).toBe(1);
    // The restore took the first marker she typed away again. The second, typed behind the deletion,
    // is in the confidential paragraph with the one the document began with, and none is anywhere
    // else.
    expect(paragraph(sim, 'pSecret00000001B')!.split(SECRET_REGION)).toHaveLength(3);
    expect(markerOutsideRegion(sim.gateway.fullHead)).toBe(false);
    expect(sim.stats.declassified).toBe(0);
    expect(paragraph(sim, 'pMiddle000000001')).toBe('Between the regions.');
    // Mallory may not read the region, and nothing she holds has the marker.
    expect(sim.clients[2]!.confirmed!.textContent).not.toContain(SECRET_REGION);
  });

  it('when a user who may edit the region removes it, its paragraphs are body text and no leak is counted', () => {
    const { sim, failures } = run(
      ['erin', 'mallory'],
      [
        // Mallory's refreshed token puts her in the group that is granted the region below.
        { k: 'refresh', c: 267, a: 671 },
        { k: 'crash', a: 0 },
        { k: 'grants', a: 0, b: 0 },
        { k: 'grants', a: 0, b: 0 },
        { k: 'reconnect', c: 291 },
        { k: 'toServer', c: 513 },
        { k: 'toClient', c: 199 },
        // She removes the region around its two paragraphs.
        { k: 'evil', c: 73, a: 183, b: 481 },
      ],
    );
    expect(failures).toEqual([]);
    // The room stored the removal: mallory could edit the region and the body.
    expect(hasRegion(sim, LEGAL)).toBe(false);
    expect(paragraph(sim, 'pSecret00000001B')).toBe(`The ${SECRET_REGION} clause.`);
    expect(markerOutsideRegion(sim.gateway.fullHead)).toBe(true);
    expect(sim.stats.declassified).toBe(1);
    // Erin, who could not read the region, holds the projection of the head, which now has the
    // paragraphs as body text.
    const erin = sim.clients[0]!;
    expect(erin.name).toBe('erin');
    expect(erin.confirmed!.textContent).toContain(SECRET_REGION);
  });
});
