/**
 * The replay worker (BE-001 criterion 3; BE-036 criterion 3): rebuilds the content at a sequence
 * number from a checkpoint and the steps of the commits after it, off the main thread. Errors are
 * reported by name only: a message could quote content (BE-088).
 *
 * It also compares two versions (HIS-011 criterion 4): the comparison walks both documents and the
 * commits between them, which can take long on a large document, so it runs here and never on the
 * loop that serves requests and rooms.
 *
 * And it serialises the content a document is created with (`serialise`; BE-001 criterion 3): that
 * content is the checkpoint at sequence number 0, and its canonical text and compression are the
 * same work as any other checkpoint's.
 */
import { parentPort, threadId, workerData } from 'node:worker_threads';
import { DEFAULT_LIMITS, applySteps, parseSteps } from '@docedit/authority';
import type { JsonEnvelope } from '@docedit/model';
import { compareTask, type CompareTask } from './compare-task.ts';
import { cdmSchema } from '@docedit/model/prosemirror';
import { encodeCheckpoint } from '../../objects/checkpoints.ts';

interface Materialise {
  /** The document root at the checkpoint. */
  doc: unknown;
  /** The steps of each commit after the checkpoint, in order; empty for control commits. */
  commits: unknown[][];
}

const allowCrash = (workerData as { allowCrash?: boolean } | null)?.allowCrash === true;
const schema = cdmSchema();

function materialise(input: Materialise): { doc: unknown; threadId: number } {
  let doc = schema.nodeFromJSON(input.doc);
  for (const steps of input.commits) {
    if (steps.length === 0) continue;
    const parsed = parseSteps(schema, steps, DEFAULT_LIMITS);
    if (!parsed.ok) throw new Error('a stored commit has steps that do not parse');
    const applied = applySteps(doc, parsed.value);
    if (!applied.ok) throw new Error('a stored commit does not apply');
    doc = applied.value.doc;
  }
  return { doc: doc.toJSON(), threadId };
}

parentPort?.on('message', (m: { id: number; kind: string; input: unknown }) => {
  try {
    if (m.kind === 'materialise')
      parentPort!.postMessage({ id: m.id, ok: true, value: materialise(m.input as Materialise) });
    else if (m.kind === 'compare')
      parentPort!.postMessage({
        id: m.id,
        ok: true,
        value: { result: compareTask(m.input as CompareTask), threadId },
      });
    else if (m.kind === 'serialise')
      parentPort!.postMessage({
        id: m.id,
        ok: true,
        value: {
          // A copy in a buffer of its own: what Zstandard returns may share a pooled one.
          bytes: new Uint8Array(encodeCheckpoint((m.input as { content: JsonEnvelope }).content)),
          threadId,
        },
      });
    else if (m.kind === 'crash' && allowCrash) process.exit(70);
    else if (m.kind === 'thread') parentPort!.postMessage({ id: m.id, ok: true, value: threadId });
    else parentPort!.postMessage({ id: m.id, ok: false, error: 'unknown task' });
  } catch (e) {
    parentPort!.postMessage({ id: m.id, ok: false, error: e instanceof Error ? e.name : 'error' });
  }
});
