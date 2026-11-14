// The edit-header command for a person who may not change stories (FE-056 criterion 6; 07 §7).
// The command itself is disabled, says why, and opens no panel. Headless: no DOM.
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { spikeDocument } from '../src/spike-document.ts';
import { editorAccess, ownerAccess } from './fixtures.ts';
import { microtask } from './support.ts';

function core(): DocumentCore {
  return new DocumentCore({ doc: spikeDocument(), access: ownerAccess(), schedule: microtask });
}

describe('editHeader by rights (FE-056 criterion 6)', () => {
  it('is disabled with no-access for a person who may only view the story', () => {
    const c = core();
    c.setAccess(editorAccess());
    expect(c.queryCommand('editHeader')).toEqual({
      enabled: false,
      active: false,
      reason: 'no-access',
    });
    expect(c.query('hasHeader')).toBe(false);
    const before = c.panel.get();
    expect(c.run('editHeader')).toBe(false);
    expect(c.panel.get()).toEqual(before);
  });

  it('is enabled and opens the panel for a person who may change the story', () => {
    const c = core();
    expect(c.queryCommand('editHeader').enabled).toBe(true);
    expect(c.query('hasHeader')).toBe(true);
    expect(c.run('editHeader')).toBe(true);
    expect(c.panel.get()?.kind).toBe('story');
  });

  it('follows a change of rights without a reload', () => {
    const c = core();
    c.setAccess(editorAccess());
    expect(c.queryCommand('editHeader').enabled).toBe(false);
    c.setAccess(ownerAccess());
    expect(c.queryCommand('editHeader').enabled).toBe(true);
    c.setAccess(editorAccess({ rev: 2 }));
    expect(c.run('editHeader')).toBe(false);
    expect(c.panel.get()).toBeNull();
  });
});
