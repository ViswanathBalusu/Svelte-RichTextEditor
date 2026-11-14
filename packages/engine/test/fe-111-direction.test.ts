/**
 * Right-to-left content in the web view (FE-111, criterion 1 in part): a paragraph's own `dir` is
 * written to its element, and only then. The browser's rendering and the base direction of the
 * editing surface (`settings.dir`, set in view/web.ts) are not run here; they need a browser.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { editingSchema } from '../src/schema.ts';

const paragraphSpec = editingSchema().nodes['paragraph']!.spec;
const toDOM = paragraphSpec.toDOM!;

function paragraph(attrs: Record<string, unknown>) {
  return editingSchema().nodes['paragraph']!.create({ id: 'p-1', ...attrs });
}

/** The attributes of the element a paragraph renders as (the first child of the DOM spec). */
function attrsOf(spec: ReturnType<typeof toDOM>): Record<string, unknown> {
  if (!Array.isArray(spec)) throw new Error('expected an array DOM spec');
  const second = spec[1];
  return second && typeof second === 'object' && !Array.isArray(second)
    ? (second as Record<string, unknown>)
    : {};
}

describe('a paragraph renders with its own direction (FE-111, criterion 1)', () => {
  it('writes the dir attribute of a paragraph that has one', () => {
    fc.assert(
      fc.property(fc.constantFrom('ltr', 'rtl'), (dir) => {
        const out = attrsOf(toDOM(paragraph({ dir })));
        expect(out['dir']).toBe(dir);
      }),
    );
  });

  it('writes no dir attribute for a paragraph without one, so it inherits the surface direction', () => {
    expect(attrsOf(toDOM(paragraph({ dir: null })))).not.toHaveProperty('dir');
  });
});
