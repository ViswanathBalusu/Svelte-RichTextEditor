/**
 * EXP-113 criterion 4 (Node.js only). The accessibility checker asks the export service for its
 * list of pictures without alternative text, and gets it: `exportAltList` reads the
 * `image_without_alt` findings of `exports.preflight`, which the editor builds with the shared
 * preflight of `@docedit/export-latex` (`packages/element/src/export-preflight.ts`). Here the
 * service is that same shared preflight over the envelope, so the list is the converter's.
 */
import { describe, expect, it } from 'vitest';
import { preflight } from '../../export-latex/src/preflight.ts';
import { doc, nid, para, type J } from '../../export-latex/test/docs.ts';
import type { ExportDiagnostic, ExportService } from '../src/core-api.ts';
import { checkDocument } from '../src/shell/accessibility-check.ts';
import { checkViewOfContent } from '../src/shell/accessibility-content.ts';
import { exportAltList } from '../src/shell/accessibility-run.ts';

function picture(alt: string | undefined): J {
  return {
    type: 'image',
    attrs: { asset: 'pic1', width: 720, height: 720, ...(alt === undefined ? {} : { alt }) },
  };
}

function inlinePara(...inline: J[]): J {
  return {
    type: 'paragraph',
    attrs: { id: nid('p') },
    content: [{ type: 'text', text: 'See ' }, ...inline],
  };
}

function figure(alt: string | undefined): J {
  return {
    type: 'figure',
    attrs: {
      id: nid('f'),
      asset: 'pic1',
      width: 1440,
      height: 1440,
      ...(alt === undefined ? {} : { alt }),
    },
    content: [],
  };
}

const envelope = doc([
  figure(undefined),
  inlinePara(picture(undefined), picture(undefined)),
  para('Plain paragraph.'),
  figure('A chart'),
  inlinePara(picture('   ')),
  inlinePara(picture('A diagram')),
]);

/** An export service whose preflight is the shared one, as the editor wires it. */
function service(withPreflight = true): Pick<ExportService, 'preflight'> {
  return withPreflight
    ? {
        preflight: (): ExportDiagnostic[] =>
          preflight(envelope).map((w) => ({
            severity: 'warning',
            code: w.code,
            blockId: w.blockId,
            message: w.message,
          })),
      }
    : {};
}

describe('EXP-113 criterion 4: the checker asks the export for the list', () => {
  it('gets each picture without alternative text, with the block identifiers of the checker', async () => {
    const list = await exportAltList({ exports: service() as ExportService });
    expect(list).not.toBeNull();
    // Two pictures in one paragraph count twice; the figure and the blank picture once each.
    expect(list!.count).toBe(4);
    const checked = (
      checkDocument(checkViewOfContent(envelope).blocks).groups.find((g) => g.kind === 'alt-text')
        ?.issues ?? []
    ).map((i) => i.blockId);
    expect([...list!.blockIds].sort()).toEqual([...new Set(checked)].sort());
  });

  it('gives null when the editor has no export service, or one without a preflight', async () => {
    expect(await exportAltList({})).toBeNull();
    expect(await exportAltList({ exports: service(false) as ExportService })).toBeNull();
  });

  it('gives null when the preflight fails, so the checker keeps its own list', async () => {
    const failing = {
      preflight: (): never => {
        throw new Error('no preflight');
      },
    } as unknown as ExportService;
    expect(await exportAltList({ exports: failing })).toBeNull();
  });

  it('counts nothing for a document whose pictures all have alternative text', async () => {
    const ok = {
      preflight: (): ExportDiagnostic[] => [],
    } as unknown as ExportService;
    expect(await exportAltList({ exports: ok })).toEqual({ count: 0, blockIds: [] });
  });
});
