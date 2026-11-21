/**
 * Checkpoint serialisation off the main thread for the control plane (06 §1; BE-001 criterion 3).
 *
 * The content a document is created with is the checkpoint at sequence number 0 (D67). The request
 * that creates the document writes it, and so do a copy of a version and a document made from a
 * template. Its canonical text and compression are the same work as a room's checkpoint, so for
 * content of any size that matters they run in the worker pool too: creating a large document then
 * holds the loop that serves requests and rooms for the validation of the content only, not for
 * its serialisation.
 *
 * Small content is serialised by the request itself. Handing it over would not hold the loop for
 * less time worth having, and it would make every creation wait for a worker thread that is still
 * starting (about 0.6 s after the process starts). See `SERIALISE_IN_POOL_FROM`.
 *
 * The bytes are those `encodeCheckpoint` gives on the main thread, so nothing that reads a
 * checkpoint can tell the difference. A worker that is lost fails the write with the retryable
 * code `internal` (BE-001 criterion 4), and nothing is stored.
 */
import type { CheckpointStore } from '../../storage/types.ts';
import type { WorkerPool } from './pool.ts';

/**
 * Content with at least this many characters in its strings and member names is serialised in the
 * pool. A choice, not a target of the specification. Measured on the development machine (Windows
 * 11, Node.js 22.18, 2026-11-20, median of 15 runs after warm-up): serialising content of 60,068
 * JSON characters on the main thread took 0.8 ms, and of 2,309,960 characters 27.5 ms; handing the
 * same content to a worker held the main thread for 0.1 ms and 5.4 ms.
 */
export const SERIALISE_IN_POOL_FROM = 65_536;

/** What the `serialise` task of the replay worker answers. */
export interface Serialised {
  bytes: Uint8Array;
  threadId: number;
}

/**
 * Whether the strings and member names of `value` hold at least `limit` characters. The walk stops
 * as soon as they do, so it costs no more than a walk over `limit` characters of content.
 */
export function holdsAtLeast(value: unknown, limit: number): boolean {
  let left = limit;
  const walk = (v: unknown): boolean => {
    if (typeof v === 'string') left -= v.length;
    else if (Array.isArray(v)) {
      for (const item of v) if (walk(item)) return true;
    } else if (v !== null && typeof v === 'object') {
      for (const [key, member] of Object.entries(v)) {
        left -= key.length;
        if (walk(member)) return true;
      }
    }
    return left <= 0;
  };
  return walk(value);
}

/**
 * `inner` with a `put` that serialises large content in `pool`. A store that takes no encoded
 * bytes serialises for itself, so it is returned as it is.
 */
export function serialisedInPool(
  inner: CheckpointStore,
  pool: Pick<WorkerPool, 'run'>,
  from = SERIALISE_IN_POOL_FROM,
): CheckpointStore {
  if (!inner.putEncoded) return inner;
  const putEncoded = inner.putEncoded.bind(inner);
  const out: CheckpointStore = {
    async put(ref, seq, content) {
      if (!holdsAtLeast(content, from)) return inner.put(ref, seq, content);
      const { bytes } = await pool.run<Serialised>('serialise', { content });
      await putEncoded(ref, seq, bytes);
    },
    putEncoded,
    get: (ref, seq) => inner.get(ref, seq),
    latest: (ref, atOrBefore) => inner.latest(ref, atOrBefore),
  };
  if (inner.getEncoded) out.getEncoded = (ref, seq) => inner.getEncoded!(ref, seq);
  if (inner.putSide) out.putSide = (ref, seq, bytes) => inner.putSide!(ref, seq, bytes);
  if (inner.getSide) out.getSide = (ref, seq) => inner.getSide!(ref, seq);
  if (inner.setAside) out.setAside = (ref, aboveSeq) => inner.setAside!(ref, aboveSeq);
  return out;
}
