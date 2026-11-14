// A worker thread that compares two versions from plain JSON (HIS-011 criterion 4): the
// comparison needs no state of a room, so a room host can run it off its event loop.
import { parentPort, workerData } from 'node:worker_threads';
import type { LogCommit } from '@docedit/authority';
import { cdmSchema } from '@docedit/model/prosemirror';
import { AttributionMap, type AttributionJson } from '../../src/attribution.ts';
import { compareStates, compareSteps } from '../../src/compare.ts';

interface Data {
  from: { seq: number; doc: unknown };
  to: { seq: number; doc: unknown; attribution: AttributionJson };
  commits: LogCommit[];
}

const data = workerData as Data;
const schema = cdmSchema();
const from = { seq: data.from.seq, doc: schema.nodeFromJSON(data.from.doc) };
const steps = compareSteps({ schema, from, commits: data.commits });
const aligned = compareStates({
  from,
  to: {
    seq: data.to.seq,
    doc: schema.nodeFromJSON(data.to.doc),
    attribution: AttributionMap.fromJSON(data.to.attribution),
  },
});
parentPort!.postMessage({
  steps: steps.ok ? steps.comparison : steps,
  aligned: aligned.ok ? aligned.comparison : aligned,
});
