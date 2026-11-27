/**
 * The dates of the suggestions of a `docx` export written as tracked changes (EXP-093 criterion 2;
 * 09 §10; 03 §5; HIS-042). A suggestion mark carries no time, so its date in Word is the server time
 * of the commit that introduced the suggestion's identifier. The control plane finds that commit by
 * the identifier in the suggestion index (`LogStore.introducedBy`, never a scan of the log), reads
 * only its metadata row for the time, and gives the job one RFC 3339 time for each identifier. The
 * export worker passes them to the writer as `suggestionDates`; it reads no client value.
 *
 * Only identifiers that the content the requester may read uses are looked up, so a date is part of
 * what the requester already reads (as in `getSuggestionIntroduction`, which answers the date of a
 * suggestion in the document whatever the history gate). An identifier the index does not know, or
 * whose commit row is gone, is left out, and the writer then writes no `w:date` for it.
 */
import { formatTimestamp } from '@docedit/model';
import type { Kit } from './kit.ts';
import type { DocRef } from '../storage/types.ts';

const SUGGESTION_MARKS = new Set(['ins', 'del', 'fmt']);

/** Most identifiers one export looks up; more than this is not a document a person reviews. */
const MAX_IDS = 5000;

/** The suggestion identifiers of the content: its marks, and the `suggest` attribute of its blocks. */
export function suggestionIdsOf(node: unknown): string[] {
  const ids = new Set<string>();
  const note = (m: unknown): void => {
    const e = m as { type?: unknown; attrs?: { id?: unknown } } | null;
    if (!e || !SUGGESTION_MARKS.has(String(e.type))) return;
    const id = e.attrs?.id;
    if (typeof id === 'string' && id !== '') ids.add(id);
  };
  const stack: unknown[] = [node];
  while (stack.length) {
    const n = stack.pop() as {
      marks?: unknown[];
      attrs?: { suggest?: unknown };
      content?: unknown[];
    } | null;
    if (!n || typeof n !== 'object') continue;
    for (const m of n.marks ?? []) note(m);
    const suggest = n.attrs?.suggest;
    if (Array.isArray(suggest)) for (const m of suggest) note(m);
    if (Array.isArray(n.content)) stack.push(...n.content);
  }
  return [...ids].sort();
}

/**
 * The server time of the introducing commit of each suggestion in `content`, by identifier, as the
 * model's canonical timestamp. Empty when the log store keeps no suggestion index.
 */
export async function suggestionDatesAt(
  d: Pick<Kit['d'], 'logs'>,
  ref: DocRef,
  content: unknown,
): Promise<Record<string, string>> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  const logs = d.logs;
  if (!logs.introducedBy) return out;
  const times = new Map<number, string | null>();
  for (const id of suggestionIdsOf(content).slice(0, MAX_IDS)) {
    const seq = await logs.introducedBy(ref, id);
    if (seq === undefined) continue;
    let time = times.get(seq);
    if (time === undefined) {
      // Metadata only: a commit whose payload was removed (HIS-040, HIS-032) still has its row.
      const rows = logs.readMeta
        ? await logs.readMeta(ref, seq, seq)
        : await logs.read(ref, seq, seq);
      const row = rows[0];
      time = row && Number.isFinite(row.time) ? formatTimestamp(row.time) : null;
      times.set(seq, time);
    }
    if (time !== null) out[id] = time;
  }
  return out;
}
