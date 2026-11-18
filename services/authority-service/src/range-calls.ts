/**
 * The `mapRanges` call of the authority service (05 §10; PRO-105; ADR 0015): comment ranges and
 * presence positions, given at one seq of a state, mapped through the commits the state holds up
 * to its head. The mapping is `mapRangesThrough` of `@docedit/authority`, the function the
 * in-process engine uses, so a relay or sidecar backend gets the same answer on the same log.
 *
 * A range whose content was deleted collapses (`collapsed: true`, `from` equal to `to`), as
 * ADR 0015 defines; the caller shows such a thread as detached. A presence position is a range of
 * zero width. The call reads no permission: a range is a pair of positions, and the caller already
 * holds the document it is on. A snapshot commit collapses every range at 0 (as in-process).
 *
 * A `stateId` the service does not hold is answered by the state lookup (`unknown_state`: call
 * `open` again). A `seq` outside the state (before its checkpoint, or past its head) is refused
 * as `not_found`, as the other history calls do.
 */
import { type MappedRange, type Range, mapRangesThrough } from '@docedit/authority';
import type { Schema } from 'prosemirror-model';
import { type Answer, type HeldState, fail } from './common.ts';

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The request body: the seq the ranges are on, and the ranges (or presence positions). */
export interface MapRangesRequest {
  seq: number;
  ranges: Range[];
}

export interface MapRangesAnswer {
  /** The seq the ranges were given at. */
  seq: number;
  /** The head of the state the ranges were mapped to. */
  headSeq: number;
  /** The ranges at the head, in the order they were given. */
  ranges: MappedRange[];
}

function parseRequest(input: unknown): Answer<{ request: MapRangesRequest }> {
  const bad = (m: string) => fail('invalid_request', m);
  if (!isObject(input)) return bad('the request must be a JSON object');
  const seq = input['seq'];
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0)
    return bad('seq must be a non-negative integer');
  const raw = input['ranges'];
  if (!Array.isArray(raw)) return bad('ranges must be an array');
  const ranges: Range[] = [];
  for (const [i, r] of raw.entries()) {
    if (!isObject(r)) return bad(`ranges[${i}] must be an object with from and to`);
    const from = r['from'];
    const to = r['to'];
    if (typeof from !== 'number' || !Number.isSafeInteger(from) || from < 0)
      return bad(`ranges[${i}].from must be a non-negative integer`);
    if (typeof to !== 'number' || !Number.isSafeInteger(to) || to < 0)
      return bad(`ranges[${i}].to must be a non-negative integer`);
    ranges.push({ from, to });
  }
  return { ok: true, request: { seq, ranges } };
}

/** `mapRanges` (05 §10): the ranges given at `seq`, mapped to the head of the state. */
export function mapRangesCall(
  schema: Schema,
  state: HeldState,
  input: unknown,
): Answer<MapRangesAnswer> {
  const parsed = parseRequest(input);
  if (!parsed.ok) return parsed;
  const { seq, ranges } = parsed.request;
  if (seq < state.first)
    return fail('not_found', `the state was opened from a checkpoint at ${state.first}`, { seq });
  if (seq > state.head)
    return fail('not_found', `the state ends at ${state.head}, not ${seq}`, {
      seq,
    });
  const commits = state.log.filter((c) => c.seq > seq && c.seq <= state.head);
  return {
    ok: true,
    seq,
    headSeq: state.head,
    ranges: mapRangesThrough(ranges, commits, schema),
  };
}
