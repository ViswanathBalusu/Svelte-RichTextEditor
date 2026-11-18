// Opening a story's panel for a person who may not change stories (FE-056 criterion 6; 07 §7).
// The core opens no panel and says so, so that the command can be disabled. Headless: no DOM.
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { SPIKE_IDS, spikeDocument } from '../src/spike-document.ts';
import { editorAccess, ownerAccess } from './fixtures.ts';
import { microtask } from './support.ts';

function core(): DocumentCore {
  return new DocumentCore({ doc: spikeDocument(), access: ownerAccess(), schedule: microtask });
}

describe('opening a story panel by rights (FE-056 criterion 6)', () => {
  it('opens the panel for a person who may change the story', () => {
    const c = core();
    expect(c.openStory(SPIKE_IDS.header)).toBe(true);
    expect(c.panel.get()).toEqual({
      kind: 'story',
      id: SPIKE_IDS.header,
      label: 'Header',
      part: 'header',
      variant: 'default',
    });
  });

  it('opens no panel for a person who may only view the story', () => {
    const c = core();
    c.setAccess(editorAccess());
    const before = c.panel.get();
    expect(c.openStory(SPIKE_IDS.header)).toBe(false);
    expect(c.panel.get()).toEqual(before);
  });

  it('follows a change of rights without a reload: refused, then allowed, then refused again', () => {
    const c = core();
    c.setAccess(editorAccess());
    expect(c.openStory(SPIKE_IDS.header)).toBe(false);
    c.setAccess(ownerAccess());
    expect(c.openStory(SPIKE_IDS.header)).toBe(true);
    c.closePanel();
    c.setAccess(editorAccess({ rev: 2 }));
    expect(c.openStory(SPIKE_IDS.header)).toBe(false);
    expect(c.panel.get()).toBeNull();
  });
});
