/**
 * The comparison of two versions as one function over plain data (HIS-011 criterion 4): the replay
 * worker runs it off the main thread, and a service built without a pool runs it inline. A worker
 * receives no functions or sets, so everything `compare` reads is passed as JSON and lists.
 */
import type { LogCommit } from '@docedit/authority';
import {
  AttributionMap,
  compare,
  type AttributionJson,
  type CompareRequest,
} from '@docedit/history';
import { cdmSchema } from '@docedit/model/prosemirror';

/**
 * What a comparison needs: the documents it reads (by `seq`) as JSON, the commits between them, the
 * gate with its named versions listed, the hidden set as lists, and the attribution map at `toSeq`
 * for the aligned method.
 */
export interface CompareTask {
  request: CompareRequest;
  incarnation: string;
  /** The content at each `seq` the comparison reads, as document JSON. */
  docs: Record<string, unknown>;
  commits: LogCommit[];
  gate: { min: number; head: number; named: number[] };
  hidden: { regions: string[]; values: string[]; titles: boolean };
  attribution: AttributionJson | null;
}

/** What the task answers: the history result, which is plain data. */
export type CompareAnswer = ReturnType<typeof compare>;

let schemaCache: ReturnType<typeof cdmSchema> | undefined;

export function compareTask(input: CompareTask): CompareAnswer {
  const schema = (schemaCache ??= cdmSchema());
  const nodes = new Map<number, ReturnType<typeof schema.nodeFromJSON>>();
  for (const [seq, doc] of Object.entries(input.docs))
    nodes.set(Number(seq), schema.nodeFromJSON(doc));
  const map = input.attribution === null ? null : AttributionMap.fromJSON(input.attribution);
  const named = new Set(input.gate.named);
  return compare(
    input.request,
    {
      schema,
      incarnation: input.incarnation,
      content: (seq) => nodes.get(seq),
      commits: (after, upTo) => input.commits.filter((c) => c.seq > after && c.seq <= upTo),
      ...(map ? { attribution: () => map } : {}),
    },
    {
      gate: { min: input.gate.min, head: input.gate.head, named: (s) => named.has(s) },
      hidden: {
        regions: new Set(input.hidden.regions),
        values: new Set(input.hidden.values),
        titles: input.hidden.titles,
      },
    },
  );
}
