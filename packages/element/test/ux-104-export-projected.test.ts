// UX-104 criterion 4: the export dialog says that hidden parts are left out when the export will be
// projected (ADR 0019). The element supplies `ExportService.projected`: true when the document the
// editor holds has a placeholder for a hidden region. The dialog statement is checked in
// packages/ui/test/export-diagnostics.test.ts and in the browser run named in the story.
import { describe, expect, it } from 'vitest';
import { exportService, hasHiddenRegion } from '../src/export-service.ts';

const visible = {
  doc: { content: [{ type: 'definitions' }, { type: 'body', content: [{ type: 'paragraph' }] }] },
};
const projected = {
  doc: {
    content: [
      { type: 'definitions' },
      { type: 'body', content: [{ type: 'paragraph' }, { type: 'hidden_region' }] },
    ],
  },
};

describe('a projected export (UX-104 criterion 4)', () => {
  it('finds the placeholder of a hidden region in the body, and nothing else', () => {
    expect(hasHiddenRegion(visible)).toBe(false);
    expect(hasHiddenRegion(projected)).toBe(true);
    expect(hasHiddenRegion({})).toBe(false);
  });

  it('the service reports projected from the document it is given, and not at all without one', () => {
    let content = visible;
    const service = exportService({
      source: () => null,
      projected: () => hasHiddenRegion(content),
    });
    expect(service.projected?.get()).toBe(false);
    content = projected;
    expect(service.projected?.get()).toBe(true);
    expect(exportService({ source: () => null }).projected).toBeUndefined();
  });
});
