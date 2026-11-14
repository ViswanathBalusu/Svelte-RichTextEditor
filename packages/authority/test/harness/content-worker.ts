/**
 * A worker thread that rebuilds content at a sequence number from plain data alone (HIS-005
 * criterion 1; SYN-039): the checkpoints and the log arrive as JSON, the result leaves as the
 * canonical text of the document. It needs nothing of the room.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { canonicalNodeText, type JsonNode } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { contentAt, defaultReplayers } from '../../src/room/content.ts';
import type { LogCommit, SnapshotCommit } from '../../src/room/types.ts';

interface Input {
  seq: number;
  head: number;
  incarnation: string;
  checkpoints: Array<{ seq: number; doc: unknown }>;
  log: LogCommit[];
  /** Checkpoint contents by reference, for snapshot commits. */
  objects: Record<string, unknown>;
}

const input = workerData as Input;
const schema = cdmSchema();
const r = contentAt(input.seq, {
  incarnation: input.incarnation,
  head: input.head,
  checkpoints: input.checkpoints.map((c) => ({ seq: c.seq, doc: schema.nodeFromJSON(c.doc) })),
  commits: (after, to) => input.log.filter((c) => c.seq > after && c.seq <= to),
  resolve: (c: SnapshotCommit) => schema.nodeFromJSON(input.objects[c.snapshot.checkpoint]),
  replayers: defaultReplayers(schema),
});
parentPort!.postMessage(
  r.ok
    ? {
        ok: true,
        text: canonicalNodeText(r.doc.toJSON() as JsonNode),
        from: r.from,
        replayed: r.replayed,
      }
    : { ok: false, code: r.code, reason: r.reason },
);
