/**
 * Page guides in the web view (02 §7; 09 §7.1; FE-068): where the last typeset PDF started its
 * pages, taken from the compile's `layout.json`. A guide is drawn before a block only, so it is
 * placed at a block start (`offset` 0) and never inside a paragraph. Guides are exact only at the
 * starts a compile reported, and they drift between compiles (FE-068 notes).
 *
 * This module computes the positions and reads the report. The web view draws them (engine
 * `pageGuideDecorations`, set through `EditorCore.setPageGuides`), the element sends them there
 * (doc-editor.ts) and the config switch is `pageGuides` (config.ts). What happens to guides after an
 * edit since the compile's `seq` is open (FE-068, criterion 4; open question 28): this release draws
 * the starts it was given and does not compare `seq` with the document (the spec's drift, 02 §7).
 */

/** One page start: the block it opens with, and the UTF-16 offset into that block's text (EXP-055). */
export interface LayoutPageStart {
  readonly blockId: string;
  readonly offset: number;
}

/**
 * What this module keeps of a `layout.json`: the compile's `seq` (null when the job had none, as
 * the export worker writes it) and the start of each page, in page order. Pages whose start the
 * worker could not name (`starts: null`) are left out.
 */
export interface LayoutReport {
  readonly seq: number | null;
  readonly starts: readonly LayoutPageStart[];
}

/** The page limit of the published schema (services/export-worker/src/layout.ts, LAYOUT_SCHEMA). */
const MAX_PAGES = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Reads a parsed `layout.json` (09 §7.1; FE-068 criterion 2): `pages`, each `{ n, setup, starts,
 * opensWith }`, with `starts` either null or `{ blockId, offset }` (the export worker adds `y`).
 * Only `seq` and the page starts are read; the other members (`classVersion`, `granularity`,
 * `unit`, `blocks`, `fields`, a page's `setup`, `opensWith` and `y`) are not used here, and the
 * worker validates the whole file against its schema before it is served (09 §9.3 item 7; EXP-055).
 * A report whose `seq`, `pages` or any page start is malformed gives null, so it draws no guide at
 * all (02 §9.7: a `layout.json` that fails validation is not used); pages are numbered from 1 in
 * order, as the schema requires.
 */
export function parseLayoutReport(value: unknown): LayoutReport | null {
  if (!isRecord(value)) return null;
  const seq = value['seq'];
  if (seq !== null && !isNonNegativeInteger(seq)) return null;
  const pages = value['pages'];
  if (!Array.isArray(pages) || pages.length > MAX_PAGES) return null;
  const starts: LayoutPageStart[] = [];
  for (const [index, page] of (pages as unknown[]).entries()) {
    if (!isRecord(page) || page['n'] !== index + 1) return null;
    const start = page['starts'];
    if (start === null) continue;
    if (!isRecord(start)) return null;
    const blockId = start['blockId'];
    const offset = start['offset'];
    if (typeof blockId !== 'string' || blockId.length === 0 || !isNonNegativeInteger(offset))
      return null;
    starts.push({ blockId, offset });
  }
  return { seq, starts };
}

/**
 * Fetches a signed `layout.json` URL (09 §11; the export result's `layout`) and reads it. No token
 * is sent: the URL is signed by the server. Resolves null on any failure, which draws no guide and
 * raises no event, since guides are optional (02 §7).
 */
export async function loadLayoutReport(
  url: string,
  fetchFn: (input: string, init?: RequestInit) => Promise<Response> = (input, init) =>
    fetch(input, init),
): Promise<LayoutReport | null> {
  try {
    const response = await fetchFn(url, { credentials: 'omit', cache: 'no-store' });
    if (!response.ok) return null;
    return parseLayoutReport(await response.json());
  } catch {
    return null;
  }
}

/**
 * The blocks before which a page guide is drawn, in document order. Empty when guides are off
 * (the default) or no layout is known. A page start inside a block (`offset` above 0) gets no guide.
 */
export function pageGuideBlockIds(layout: LayoutReport | null, enabled: boolean): string[] {
  if (!enabled || !layout) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const start of layout.starts) {
    if (start.offset !== 0 || seen.has(start.blockId)) continue;
    seen.add(start.blockId);
    out.push(start.blockId);
  }
  return out;
}
