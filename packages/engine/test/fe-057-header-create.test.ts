/**
 * Starting to edit a header that does not exist yet creates its default story (FE-057 criterion 2;
 * lane V-FE-049-064). The creation is one transaction through the guard, and the header panel then
 * opens on the new story. A person without the right to change the structure gets no story.
 *
 * Run with `pnpm vitest run --project node packages/engine/test/fe-057-header-create.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { contractDocument, editorAccess, ownerAccess } from './fixtures.ts';
import { microtask } from './support.ts';

/** The header stories of the document, with their identifiers. */
function headers(c: DocumentCore): string[] {
  const out: string[] = [];
  internals(c).state.doc.forEach((node) => {
    if (node.type.name === 'story' && node.attrs['kind'] === 'header')
      out.push(String(node.attrs['id']));
  });
  return out;
}

/** The default header identifier named by the page setup. */
function headerDefaultOf(c: DocumentCore): unknown {
  let value: unknown = undefined;
  internals(c).state.doc.forEach((node) => {
    if (node.type.name !== 'defs') return;
    node.forEach((child) => {
      if (child.type.name === 'page_setup') value = child.attrs['headerDefault'];
    });
  });
  return value;
}

describe('editing a header that does not exist yet (FE-057 criterion 2)', () => {
  it('creates the default header story, names it in the page setup and opens the panel on it', () => {
    const c = new DocumentCore({
      doc: contractDocument(),
      access: ownerAccess(),
      schedule: microtask,
    });
    expect(headers(c)).toEqual([]);
    expect(c.run('editHeader')).toBe(true);

    const created = headers(c);
    expect(created).toHaveLength(1);
    expect(headerDefaultOf(c)).toBe(created[0]);
    const panel = c.panel.get();
    expect(panel).toEqual({ kind: 'story', id: created[0], label: 'Header' });
    // The story holds one empty paragraph and the body is unchanged.
    const doc = internals(c).state.doc;
    let text = '';
    doc.forEach((node) => {
      if (node.type.name === 'story' && node.attrs['kind'] === 'header') text = node.textContent;
    });
    expect(text).toBe('');
    // A second edit opens the same story; no second header is made.
    expect(c.run('editHeader')).toBe(true);
    expect(headers(c)).toEqual(created);
  });

  it('refuses the creation for a person who may not change the structure, and makes no story', () => {
    const c = new DocumentCore({
      doc: contractDocument(),
      access: editorAccess(),
      schedule: microtask,
    });
    expect(c.run('editHeader')).toBe(false);
    expect(headers(c)).toEqual([]);
    expect(headerDefaultOf(c)).toBeNull();
    expect(c.panel.get()).toBeNull();
  });
});
