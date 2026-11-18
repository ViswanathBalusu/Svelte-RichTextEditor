/**
 * The main-thread half of opening a large checkpoint (BE-019 criterion 5; owner decision 72). A
 * worker has parsed and checked the document (`open` in tasks.ts) and cut the children of its large
 * containers into slices of JSON text. Here the nodes are built from the slices, and the event loop
 * runs between two slices, so that the acknowledgements of other rooms are not held for the whole
 * document. A slice is `OPEN_SLICE` children; the count is a choice, not a measurement.
 */
import type { JsonNode } from '@docedit/model';
import type { cdmSchema } from '@docedit/model/prosemirror';
import type { OpenedParts } from './tasks.ts';

type Schema = ReturnType<typeof cdmSchema>;
type Doc = ReturnType<Schema['nodeFromJSON']>;

/** Children per slice. */
export const OPEN_SLICE = 1000;

const text = new TextDecoder();
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface Shell {
  type: string;
  attrs?: Record<string, unknown>;
  marks?: unknown[];
  content?: JsonNode[];
}

/** The document the parts describe. The worker has checked it; nothing is checked again here. */
export async function buildFromParts(schema: Schema, parts: OpenedParts): Promise<Doc> {
  const root = parts.doc as unknown as Shell;
  const children: Doc[] = [];
  const at = new Map(parts.split.map((s) => [s.at, s.slices]));
  const shells = root.content ?? [];
  for (let i = 0; i < shells.length; i++) {
    const shell = shells[i] as unknown as Shell;
    const slices = at.get(i);
    if (!slices) {
      children.push(schema.nodeFromJSON(shell));
      continue;
    }
    const kids: Doc[] = [];
    for (const slice of slices) {
      for (const json of JSON.parse(text.decode(slice)) as JsonNode[])
        kids.push(schema.nodeFromJSON(json));
      await turn();
    }
    const marks = shell.marks?.map((m) => schema.markFromJSON(m as never));
    children.push(schema.node(shell.type, shell.attrs ?? null, kids, marks));
    await turn();
  }
  const marks = root.marks?.map((m) => schema.markFromJSON(m as never));
  return schema.node(root.type, root.attrs ?? null, children, marks);
}
