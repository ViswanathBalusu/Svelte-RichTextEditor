/**
 * Builds a `layout.json` with the export worker's own code (FE-068; lane V-FE-065-080, round 3 fix):
 * a sidecar file in the format the class's Lua code writes (`main.layout`, read strictly by
 * `parseRawLayout`) is joined with a converter map (`buildLayout`) and checked against the
 * published schema (`validateLayout`), all from services/export-worker/src/layout.ts. The element's
 * tests then feed the result to the element's reader, so the reader is proven against the shape the
 * worker serves, not a shape written for the test. Used by test/fe-068-page-guides.test.ts and
 * e2e/fe-068-page-guides.spec.ts.
 */
import {
  buildLayout,
  parseRawLayout,
  validateLayout,
  type LayoutJson,
} from '../../../services/export-worker/src/layout.ts';

/** Scaled points per twip, as the worker converts them. */
const SP = 65781.76 / 20;

/** One page of the sidecar file: the block it starts in (an index into `blocks`) and the offset. */
export interface SidecarPageStart {
  readonly block: number;
  readonly offset: number;
}

/**
 * The worker's `layout.json` for a document whose blocks are `blockIds` (in document order) and
 * whose pages start at `pageStarts`. Throws when the worker's own schema check fails, so a test
 * never runs on a file the worker would not serve.
 */
export function workerLayoutJson(
  blockIds: readonly string[],
  pageStarts: readonly SidecarPageStart[],
  seq: number | null = 7,
): LayoutJson {
  const raw = JSON.stringify({
    v: 1,
    level: 1,
    pages: pageStarts.map((p, i) => ({
      n: i + 1,
      w: 39159881,
      h: 55381663,
      start: [p.block + 1, p.offset, Math.round(1440 * SP)],
      first: [p.block + 1, 1],
    })),
    blocks: Object.fromEntries(
      blockIds.map((_, i) => [
        String(i + 1),
        [pageStarts.filter((p) => p.block <= i).length || 1, Math.round((1440 + 400 * i) * SP), 0],
      ]),
    ),
    lines: [],
  });
  const layout = buildLayout(
    parseRawLayout(raw),
    {
      version: 1,
      blocks: [null, ...blockIds],
      kinds: ['', ...blockIds.map(() => 'paragraph')],
      owners: [null, ...blockIds.map(() => null)],
      lines: [],
      setups: ['ps1'],
    },
    { seq, classVersion: '0.1.0-s4', setup: 'ps1' },
  );
  const problems = validateLayout(layout);
  if (problems.length > 0) throw new Error(`worker layout.json invalid: ${problems.join('; ')}`);
  return layout;
}
