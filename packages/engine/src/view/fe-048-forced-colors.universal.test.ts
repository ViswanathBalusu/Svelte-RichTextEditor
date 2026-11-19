/**
 * The comment decorations under `forced-colors: active` (FE-048 criterion 7; FE-019). The range keeps
 * its dotted underline and the block its dashed outline: the cues are line styles, not colours, so
 * the system colour palette does not remove them.
 *
 * Vitest's browser mode has no media emulation, so this file runs under its own config, which sets
 * `forcedColors: 'active'` on the Playwright context:
 *   pnpm vitest run --config tests/w1-FE-048/vitest.forced-colors.config.ts
 * In the root `browser` project the suite is skipped, because forced colours are not active there.
 */
import { describe, expect, it, vi } from 'vitest';
import type { CdmEnvelope, CdmJsonNode } from '../api.ts';
import { COMMENT_BLOCK_CLASS, COMMENT_RANGE_CLASS } from '../comment-decorations.ts';
import { internals } from '../testing.ts';
import { LAYOUT_IDS, layoutEnvelope, posOfNode } from '../../test/layout-doc.ts';
import { EditorCore } from './web.ts';
import elementCss from '../../../element/src/styles/element.css?raw';

const hasDom = typeof document !== 'undefined';
const forced = hasDom && window.matchMedia('(forced-colors: active)').matches;
const EDIT = ['view', 'comment', 'suggest', 'edit'] as const;

describe.skipIf(!forced)('comment decorations under forced colours (FE-048 criterion 7)', () => {
  it('keeps the dotted underline of a range and the dashed outline of a block', async () => {
    const style = document.createElement('style');
    style.textContent = elementCss;
    document.head.append(style);
    const host = document.createElement('div');
    document.body.append(host);
    const doc = {
      cdm: 1,
      requires: [],
      doc: layoutEnvelope() as unknown as CdmJsonNode,
    } as CdmEnvelope;
    const core = new EditorCore({
      doc,
      access: {
        rev: 1,
        asOfSeq: 0,
        docRole: 'owner',
        caps: [...EDIT, 'structure', 'manage'],
        scopes: { doc: [...EDIT], body: [...EDIT], defs: [...EDIT] },
        leases: {},
        fill: null,
        restrictions: [],
      },
      schedule: (run) => queueMicrotask(run),
    });
    const unmount = core.mountBody(host);
    try {
      const surface = document.querySelector<HTMLElement>('.de-editing-surface');
      if (!surface) throw new Error('the body surface was not mounted');
      const first = posOfNode(internals(core).state.doc, LAYOUT_IDS.pA) + 1;
      core.setThreadRange('on-text', { from: first, to: first + 4 }, 0);
      core.reportThread('on-figure', { seq: 0, block: LAYOUT_IDS.figure });
      await vi.waitFor(() => {
        expect(surface.querySelectorAll(`.${COMMENT_RANGE_CLASS}`)).toHaveLength(1);
        expect(surface.querySelectorAll(`.${COMMENT_BLOCK_CLASS}`)).toHaveLength(1);
      });
      const range = getComputedStyle(surface.querySelector(`.${COMMENT_RANGE_CLASS}`)!);
      expect(range.textDecorationLine).toContain('underline');
      expect(range.textDecorationStyle).toBe('dotted');
      const block = getComputedStyle(surface.querySelector(`.${COMMENT_BLOCK_CLASS}`)!);
      expect(block.outlineStyle).toBe('dashed');
      expect(parseFloat(block.outlineWidth)).toBeGreaterThan(0);
    } finally {
      unmount();
      core.destroy();
      host.remove();
      style.remove();
    }
  });
});
