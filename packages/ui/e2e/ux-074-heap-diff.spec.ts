/**
 * Heap snapshot diff of the shell across repeated pane use (UX-074, criterion 2; lane V-UX-061-075,
 * round 5). Two heap snapshots are taken through the Chrome DevTools Protocol, after a warm-up and
 * after further open-and-close cycles of the five panes. The objects are grouped by node type and
 * name, and the groups whose count or retained self size grew are reported, largest growth first.
 * The test records the diff; it does not assert criterion 2, which needs the growth to level off.
 *
 * Chromium only. Each snapshot is written to the scratchpad folder named by DOCEDIT_HEAP_DIR (or the
 * test output folder), so that the snapshots can be opened in DevTools for a closer look.
 *
 * Run with `DOCEDIT_UI_PORT=57294 pnpm exec playwright test -c packages/ui/playwright.config.ts ux-074-heap-diff --project=chromium`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type CDPSession, type Page } from '@playwright/test';
import { expect, harness, open, test } from './helpers.ts';

const STYLES = [
  { id: 'Normal', name: 'Normal', kind: 'paragraph' as const },
  { id: 'Heading1', name: 'Heading 1', kind: 'paragraph' as const },
  { id: 'Strong', name: 'Strong', kind: 'character' as const },
  { id: 'Grid', name: 'Grid table', kind: 'table' as const },
];

const PANES = [
  'view.outline',
  'view.styles',
  'view.permissions',
  'view.recovered',
  'view.shortcuts',
] as const;

const WARM_PASSES = 5;
const CYCLES = 60;

interface Group {
  count: number;
  self: number;
}

/** Takes a heap snapshot after a full collection and returns its JSON text. */
async function takeSnapshot(cdp: CDPSession): Promise<string> {
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  const chunks: string[] = [];
  const listener = (event: { chunk: string }) => chunks.push(event.chunk);
  cdp.on('HeapProfiler.addHeapSnapshotChunk', listener);
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  cdp.off('HeapProfiler.addHeapSnapshotChunk', listener);
  return chunks.join('');
}

/** Counts the objects of a snapshot by node type and name, with their self sizes. */
function group(text: string): Map<string, Group> {
  const snap = JSON.parse(text) as {
    snapshot: { meta: { node_fields: string[]; node_types: [string[], ...unknown[]] } };
    nodes: number[];
    strings: string[];
  };
  const fields = snap.snapshot.meta.node_fields;
  const types = snap.snapshot.meta.node_types[0];
  const stride = fields.length;
  const iType = fields.indexOf('type');
  const iName = fields.indexOf('name');
  const iSize = fields.indexOf('self_size');
  const out = new Map<string, Group>();
  for (let i = 0; i < snap.nodes.length; i += stride) {
    const type = types[snap.nodes[i + iType]!] ?? 'unknown';
    const name = snap.strings[snap.nodes[i + iName]!] ?? '';
    const key = `${type} ${name}`.slice(0, 120);
    const size = snap.nodes[i + iSize]!;
    const g = out.get(key) ?? { count: 0, self: 0 };
    g.count += 1;
    g.self += size;
    out.set(key, g);
  }
  return out;
}

/** Groups whose count or self size grew between the two snapshots, largest self-size growth first. */
function growth(before: Map<string, Group>, after: Map<string, Group>) {
  const rows: Array<{ key: string; countDelta: number; selfDelta: number }> = [];
  for (const [key, b] of after) {
    const a = before.get(key) ?? { count: 0, self: 0 };
    const countDelta = b.count - a.count;
    const selfDelta = b.self - a.self;
    if (countDelta !== 0 || selfDelta !== 0) rows.push({ key, countDelta, selfDelta });
  }
  rows.sort((x, y) => y.selfDelta - x.selfDelta);
  return rows;
}

/** Opens a pane by its command, then closes it with its close button. */
async function openAndClose(page: Page, run: (id: string) => Promise<unknown>, id: string) {
  await run(id);
  const pane = page.locator('.de-pane');
  await expect(pane).toHaveCount(1);
  await pane
    .getByRole('button', { name: /^Close / })
    .first()
    .click();
  await expect(pane).toHaveCount(0);
}

test.describe('shell heap object diff across repeated pane use (UX-074, criterion 2)', () => {
  test.setTimeout(900_000);

  test('diffs the application objects after warm-up and after repeated open and close', async ({
    page,
    browserName,
  }, testInfo) => {
    test.skip(browserName !== 'chromium', 'heap snapshots come from the Chrome DevTools Protocol');
    const h = await open(page, { extended: true, styles: STYLES });
    const run = (id: string) => h.exec(id);
    const cdp = await page.context().newCDPSession(page);

    for (const id of PANES) await openAndClose(page, run, id);
    for (let pass = 0; pass < WARM_PASSES; pass++)
      for (const id of PANES) await openAndClose(page, run, id);
    const beforeText = await takeSnapshot(cdp);

    for (let cycle = 0; cycle < CYCLES; cycle++)
      for (const id of PANES) await openAndClose(page, run, id);
    const afterText = await takeSnapshot(cdp);

    const dir = process.env.DOCEDIT_HEAP_DIR ?? testInfo.outputDir;
    mkdirSync(dir, { recursive: true });
    const beforePath = join(dir, 'ux-074-before.heapsnapshot');
    const afterPath = join(dir, 'ux-074-after.heapsnapshot');
    writeFileSync(beforePath, beforeText);
    writeFileSync(afterPath, afterText);

    const rows = growth(group(beforeText), group(afterText));
    const top = rows.slice(0, 25);
    const totalSelfDelta = rows.reduce((sum, r) => sum + r.selfDelta, 0);
    testInfo.annotations.push({
      type: 'heap-diff',
      description: JSON.stringify({
        browser: 'chromium',
        warmPasses: WARM_PASSES,
        cycles: CYCLES,
        snapshots: [beforePath, afterPath],
        totalSelfDeltaBytes: totalSelfDelta,
        top,
      }),
    });
    console.log(
      `ux-074 heap diff: total self-size delta ${totalSelfDelta} B over ${rows.length} groups`,
    );
    for (const r of top) console.log(`  ${r.selfDelta} B, ${r.countDelta} objects: ${r.key}`);
    expect(rows.length).toBeGreaterThan(0);
    expect(await harness(page).commandIds()).toContain('view.outline');
  });
});
