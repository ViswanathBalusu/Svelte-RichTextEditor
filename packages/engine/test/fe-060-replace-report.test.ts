/**
 * FE-060 criterion 3, the core's part: the `replaced` view carries the counts of each Replace and
 * Replace all, and they equal the matches that were really changed and left alone. The shell turns
 * the view into its report (`packages/ui/test/fe-060-replace-report.test.ts`).
 */
import type { Node as PMNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { REMOTE } from '../src/meta.ts';
import { internals } from '../src/testing.ts';
import { STYLE_IDS, styledDocument, styledEditorAccess } from './fixtures.ts';

function endOf(doc: PMNode, id: string): number {
  let at = -1;
  doc.descendants((node, pos) => {
    if (at < 0 && node.attrs['id'] === id) at = pos + 1 + node.content.size;
    return at < 0;
  });
  if (at < 0) throw new Error(`no node ${id}`);
  return at;
}

function core(): DocumentCore {
  const c = new DocumentCore({ doc: styledDocument(), access: styledEditorAccess() });
  const ic = internals(c);
  // One more "text" in the editable paragraph and two more in the locked region, by remote commits.
  ic.dispatch(
    ic.state.tr.insertText(' text', endOf(ic.state.doc, STYLE_IDS.plain)).setMeta(REMOTE, true),
  );
  ic.dispatch(
    ic.state.tr
      .insertText(' text text', endOf(ic.state.doc, STYLE_IDS.inRegion))
      .setMeta(REMOTE, true),
  );
  return c;
}

describe('the replaced view (FE-060 criterion 3)', () => {
  it('is empty before anything is replaced', () => {
    const c = core();
    expect(c.replaced.get()).toBeNull();
    c.destroy();
  });

  it('reports the real counts of Replace all with skipped matches', () => {
    const c = core();
    c.findText('text');
    const total = c.findState.get().count;
    const report = c.replaceAll('words');
    expect(report.replaced).toBeGreaterThan(0);
    expect(report.skipped).toBe(3);
    expect(report.replaced + report.skipped).toBe(total);
    expect(c.replaced.get()).toEqual({ n: 1, all: true, ...report });
    // The matches left are exactly the skipped ones.
    expect(c.findState.get().count).toBe(report.skipped);
    c.destroy();
  });

  it('reports nothing skipped when every match was replaced', () => {
    const c = core();
    c.findText('Plain');
    const total = c.findState.get().count;
    const report = c.replaceAll('simple');
    expect(report).toEqual({ replaced: total, skipped: 0 });
    expect(c.replaced.get()).toEqual({ n: 1, all: true, replaced: total, skipped: 0 });
    c.destroy();
  });

  it('numbers each report, so the same counts twice are two reports', () => {
    const c = core();
    c.findText('text');
    c.replaceAll('words');
    const first = c.replaced.get();
    c.findText('text');
    c.replaceAll('words');
    const second = c.replaced.get();
    expect(second?.replaced).toBe(0);
    expect(second?.skipped).toBe(first?.skipped);
    expect(second?.n).toBe((first?.n ?? 0) + 1);
    c.destroy();
  });

  it('reports a single Replace in a locked region as zero replaced and one skipped', () => {
    const c = core();
    c.findText('text');
    // Step to a match in the locked region: the last one.
    c.findPrevious();
    const report = c.replaceCurrent('words');
    expect(report).toEqual({ replaced: 0, skipped: 1 });
    expect(c.replaced.get()).toEqual({ n: 1, all: false, replaced: 0, skipped: 1 });
    c.destroy();
  });

  it('does not report when there is no match', () => {
    const c = core();
    c.findText('no such words anywhere');
    c.replaceAll('x');
    expect(c.replaced.get()).toBeNull();
    c.destroy();
  });
});
