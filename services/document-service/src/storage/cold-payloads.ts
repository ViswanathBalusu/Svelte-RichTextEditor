/**
 * Reading commit payloads that have moved to cold segments (HIS-029; 08 §11; 06 §4.2).
 *
 * A payload older than 30 days leaves `doc_commit_payloads` for a compressed segment object in
 * object storage (`control-plane/cold-segments.ts` moves it). The commit's metadata row, its payload
 * hash and the hash chain stay in PostgreSQL, and `commit_cold_segments` (migration 0097) says which
 * object holds which range. The log store reads a range from both stores: where a commit has no
 * payload row, it asks this module for the payload in its segment.
 *
 * The read is `coldPayloads` of `@docedit/history`, which uses a payload only when the hash the
 * segment records for it and the hash of the payload itself both equal the hash in the commit's
 * metadata, the hash the chain covers. So a segment object that was changed, cut short or swapped
 * for another cannot put a different payload into a read.
 *
 * - A commit that no segment covers, or that its segment no longer holds (a payload thinned or
 *   replaced by a tombstone after the move), is left out: the caller answers as for any removed
 *   payload (`PayloadAbsentError`).
 * - A segment that cannot be read, or a payload that does not match its hash, is
 *   `ColdSegmentUnavailableError`, whose `code` is `unavailable` (HIS-029 criterion 5). Nothing is
 *   served in its place.
 * - A document whose own key was destroyed, or whose key service cannot be reached (HIS-041), fails
 *   as it does for any other object of the document; those errors pass through unchanged.
 * - An object key outside the tenant's prefix is never asked for (`TenantObjects`); it reads as a
 *   segment that cannot be read.
 *
 * No decoded segment is kept between reads: a payload removed from a segment is gone from the next
 * read, on every node.
 */
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { coldPayloads, type SegmentCodec } from '@docedit/history';
import { TenantObjects, type ObjectStore } from '../objects/store.ts';
import { DocumentKeyDestroyedError, DocumentKeyUnavailableError } from './document-keys.ts';
import type { DocRef } from './types.ts';

/** Segment objects are Zstandard-compressed text, like every other stored payload (08 §11). */
export const SEGMENT_CODEC: SegmentCodec = {
  encode: async (text) => zstdCompressSync(Buffer.from(text, 'utf8')),
  decode: async (bytes) => zstdDecompressSync(bytes).toString('utf8'),
};

/** One row of `commit_cold_segments` that may be read: the range it covers and its object. */
export interface ColdIndexRow {
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly objectKey: string;
}

/**
 * A cold range could not be read: the segment object is missing or cannot be decoded, or a payload
 * in it does not match the hash the chain covers. The message names the commit, never content.
 */
export class ColdSegmentUnavailableError extends Error {
  override name = 'ColdSegmentUnavailableError';
  /** A registry code, so that the REST pipeline answers `unavailable` (05 §6.1). */
  readonly code = 'unavailable';
  readonly seq: number | undefined;
  /** `mismatch` is an integrity failure, not an outage: the stored bytes are not what was moved. */
  readonly status: 'unavailable' | 'mismatch';

  constructor(status: 'unavailable' | 'mismatch', reason: string, seq?: number) {
    super(
      seq === undefined
        ? `a cold segment cannot be read: ${reason}`
        : `the payload of commit ${seq} is in a cold segment that cannot be read: ${reason}`,
    );
    this.status = status;
    this.seq = seq;
  }
}

/** Where the log store reads cold payloads from. */
export interface ColdPayloadSource {
  /**
   * The payloads of the commits in `wanted` (their `seq` and the payload hash of their metadata, in
   * lower-case hexadecimal) from the segments of `index`, which are rows of the document `ref`. A
   * commit that no row covers, or that its segment no longer holds, is absent from the result.
   */
  read(
    ref: DocRef,
    wanted: ReadonlyMap<number, string>,
    index: readonly ColdIndexRow[],
  ): Promise<Map<number, unknown>>;
}

/** Cold payloads read from an object store. */
export class ObjectColdPayloads implements ColdPayloadSource {
  readonly #objects: ObjectStore;

  constructor(objects: ObjectStore) {
    this.#objects = objects;
  }

  async read(
    ref: DocRef,
    wanted: ReadonlyMap<number, string>,
    index: readonly ColdIndexRow[],
  ): Promise<Map<number, unknown>> {
    if (wanted.size === 0) return new Map();
    const objects = new TenantObjects(this.#objects, ref.tenant);
    let keyFailure: unknown;
    const found = await coldPayloads(
      wanted,
      index.map((row) => ({ fromSeq: row.fromSeq, toSeq: row.toSeq, path: row.objectKey })),
      {
        objects: {
          put: async () => {
            throw new Error('a read never writes a segment');
          },
          get: async (key) => {
            try {
              return (await objects.get(key)) ?? undefined;
            } catch (e) {
              // A destroyed or unreachable document key is its own answer (HIS-041), not an outage
              // of the segment.
              if (
                e instanceof DocumentKeyDestroyedError ||
                e instanceof DocumentKeyUnavailableError
              )
                keyFailure = e;
              throw e;
            }
          },
        },
        codec: SEGMENT_CODEC,
      },
    );
    if (keyFailure !== undefined) throw keyFailure;
    if (!found.ok) throw new ColdSegmentUnavailableError(found.status, found.reason, found.seq);
    return found.payloads;
  }
}
