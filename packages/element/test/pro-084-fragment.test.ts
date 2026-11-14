// PRO-084 criteria 2 to 4 (lane V-PRO-069-085): the element's `getSelectionContent` and
// `insertContent` reach the headless editing core, both directly (`hostApi`) and through the
// element's path (`elementMethods`). The guards and the CDM checks are the engine's (FE-027); this
// file tests that the element forwards them and reports what they answer, in Node.js.
import { DocumentCore, type CdmFragment } from '@docedit/engine/headless';
import { SPIKE_IDS, spikeDocument } from '@docedit/engine/testing';
import type { Access } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { NOT_LOADED_INSERT, elementMethods, hostApi } from '../src/host-api.ts';

const schedule = (run: () => void) => queueMicrotask(run);
const EDIT = ['view', 'comment', 'suggest', 'edit'] as const;
const READ = ['view', 'comment'] as const;

/** An editor of the spike document: the body, not the restricted region (07 §4). */
function editorAccess(): Access {
  return {
    rev: 1,
    asOfSeq: 0,
    docRole: 'editor',
    caps: [...EDIT],
    scopes: {
      doc: ['view'],
      body: [...EDIT],
      defs: ['view'],
      [`story:${SPIKE_IDS.header}`]: ['view'],
      [`region:${SPIKE_IDS.region}`]: [...READ],
    },
    leases: {},
    fill: null,
    restrictions: [],
  };
}

/** A reader: view and comment only, everywhere. */
function readerAccess(): Access {
  return {
    ...editorAccess(),
    docRole: 'commenter',
    caps: [...READ],
    scopes: { doc: ['view'], body: [...READ], defs: ['view'] },
  };
}

/**
 * The last paragraph of the spike document as a fragment: the selection of one block. A selection
 * over the whole document is refused by the structure guard, so the tests insert one block.
 */
function lastParagraph(core: DocumentCore): CdmFragment {
  core.exec('selectAll');
  const f = core.getSelectionContent();
  return { ...f, content: [f.content[f.content.length - 1]!] };
}

/** The text of a fragment's blocks, one line per block. */
const fragmentText = (f: CdmFragment): string =>
  f.content.map((n) => (n.content ?? []).map((c) => c.text ?? '').join('')).join('\n');

describe('getSelectionContent through the element path (PRO-084 criterion 2)', () => {
  it('returns the selected blocks as a CDM fragment, and null with no document', () => {
    const core = new DocumentCore({ doc: spikeDocument(), access: editorAccess(), schedule });
    const methods = elementMethods(() => ({ editor: { api: hostApi(core) } }));
    expect(core.exec('selectAll')).toBe(true);
    const f = methods.getSelectionContent();
    expect(f).not.toBeNull();
    expect(f!.cdm).toBe(1);
    expect(fragmentText(f!)).toContain('Last paragraph.');
    // Plain JSON: a copy the host can keep.
    expect(JSON.parse(JSON.stringify(f))).toEqual(f);
    expect(elementMethods(() => null).getSelectionContent()).toBeNull();
  });
});

describe('insertContent through the element path (PRO-084 criteria 3 and 4)', () => {
  it('inserts a fragment at the selection through the guards, and changes only the visible document', async () => {
    const fragment = lastParagraph(
      new DocumentCore({ doc: spikeDocument(), access: editorAccess(), schedule }),
    );

    const target = new DocumentCore({ doc: spikeDocument(), access: editorAccess(), schedule });
    const api = hostApi(target);
    const methods = elementMethods(() => ({ editor: { api } }));
    const count = (): number =>
      JSON.stringify(target.getContent().doc).split('Last paragraph.').length - 1;
    const before = count();
    const result = methods.insertContent(fragment);
    expect(result.ok).toBe(true);
    // The visible document holds one more copy of the block; the confirmed one is unchanged until it
    // is sent (PRO-083), which is the same rule as typing.
    expect(count()).toBe(before + 1);
    const confirmed = await api.getContent();
    expect(confirmed.seq).toBe(0);
  });

  it('refuses a fragment of another CDM version and changes nothing', async () => {
    const target = new DocumentCore({ doc: spikeDocument(), access: editorAccess(), schedule });
    const api = hostApi(target);
    const methods = elementMethods(() => ({ editor: { api } }));
    target.exec('selectAll');
    const before = JSON.stringify(target.getContent().doc);
    const other: CdmFragment = {
      cdm: 999,
      requires: [],
      defs: [],
      content: [],
      openStart: 0,
      openEnd: 0,
    };
    const result = methods.insertContent(other);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unsupported');
    expect(JSON.stringify(target.getContent().doc)).toBe(before);
  });

  it('refuses at a place the user may not edit, and says why', () => {
    const fragment = lastParagraph(
      new DocumentCore({ doc: spikeDocument(), access: editorAccess(), schedule }),
    );

    const reader = new DocumentCore({ doc: spikeDocument(), access: readerAccess(), schedule });
    const methods = elementMethods(() => ({ editor: { api: hostApi(reader) } }));
    reader.exec('selectAll');
    const before = JSON.stringify(reader.getContent().doc);
    const result = methods.insertContent(fragment);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('refused');
      expect(result.message).not.toBe('');
    }
    expect(JSON.stringify(reader.getContent().doc)).toBe(before);
  });

  it('reports a refusal with no document loaded', () => {
    const fragment: CdmFragment = {
      cdm: 1,
      requires: [],
      defs: [],
      content: [],
      openStart: 0,
      openEnd: 0,
    };
    expect(elementMethods(() => null).insertContent(fragment)).toBe(NOT_LOADED_INSERT);
    expect(NOT_LOADED_INSERT.ok).toBe(false);
  });
});
