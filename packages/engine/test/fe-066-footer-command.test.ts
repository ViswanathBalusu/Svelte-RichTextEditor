/**
 * The footer is reached as the header is (FE-066 criterion 6; FE-057): the command `editFooter` opens
 * the footer in the panel, creating its default story first when the document has none, and the
 * query `hasFooter` says whether the person may do it. A person who may not change the structure
 * gets no story and is told why.
 *
 * Run with `pnpm vitest run --project node packages/engine/test/fe-066-footer-command.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { contractDocument, editorAccess, ownerAccess } from './fixtures.ts';
import { microtask } from './support.ts';

/** The stories of one kind (`header` or `footer`) in the document, with their identifiers. */
function stories(c: DocumentCore, kind: 'header' | 'footer'): string[] {
  const out: string[] = [];
  internals(c).state.doc.forEach((node) => {
    if (node.type.name === 'story' && node.attrs['kind'] === kind)
      out.push(String(node.attrs['id']));
  });
  return out;
}

/** The default footer identifier the page setup names. */
function footerDefaultOf(c: DocumentCore): unknown {
  let value: unknown = undefined;
  internals(c).state.doc.forEach((node) => {
    if (node.type.name !== 'defs') return;
    node.forEach((child) => {
      if (child.type.name === 'page_setup') value = child.attrs['footerDefault'];
    });
  });
  return value;
}

describe('editing the footer (FE-066 criterion 6)', () => {
  it('creates the default footer story, names it in the page setup and opens the panel on it', () => {
    const c = new DocumentCore({
      doc: contractDocument(),
      access: ownerAccess(),
      schedule: microtask,
    });
    expect(stories(c, 'footer')).toEqual([]);
    expect(c.query('hasFooter')).toBe(true);
    expect(c.run('editFooter')).toBe(true);

    const created = stories(c, 'footer');
    expect(created).toHaveLength(1);
    expect(footerDefaultOf(c)).toBe(created[0]);
    expect(c.panel.get()).toEqual({
      kind: 'story',
      id: created[0],
      label: 'Footer',
      part: 'footer',
      variant: 'default',
    });
    // The header is not made by it, and a second command opens the same story.
    expect(stories(c, 'header')).toEqual([]);
    expect(c.run('editFooter')).toBe(true);
    expect(stories(c, 'footer')).toEqual(created);
  });

  it('is disabled with the reason `structure` for a person who may not create it, and makes no story', () => {
    const c = new DocumentCore({
      doc: contractDocument(),
      access: editorAccess(),
      schedule: microtask,
    });
    expect(c.query('hasFooter')).toBe(false);
    expect(c.queryReason('hasFooter')).toBe('structure');
    expect(c.run('editFooter')).toBe(false);
    expect(stories(c, 'footer')).toEqual([]);
    expect(footerDefaultOf(c)).toBeNull();
    expect(c.panel.get()).toBeNull();
  });

  it('is listed among the core queries, so the shell can enable the command', () => {
    const c = new DocumentCore({
      doc: contractDocument(),
      access: ownerAccess(),
      schedule: microtask,
    });
    expect(c.queryNames).toContain('hasFooter');
  });
});
