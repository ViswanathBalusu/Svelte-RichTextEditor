// FE-072 criterion 4: whether a diagnostic of the read view may open the editor. The read view has no
// editing core, so the right to edit is read from the access of a document channel that is opened
// and closed at once. The move of the caret and the switch of the view run in a browser
// (e2e/fe-072-open-in-editor.spec.ts).
import type { Access, Backend } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { mayEdit, mayEditDocument } from '../src/read-view.ts';

function access(caps: Access['caps'], scopes: Access['scopes'] = {}): Access {
  return {
    rev: 1,
    asOfSeq: 0,
    docRole: 'viewer',
    caps,
    scopes,
    leases: {},
    fill: null,
    restrictions: [],
  };
}

describe('mayEdit (FE-072 criterion 4)', () => {
  it('is true for a document-level edit capability', () => {
    expect(mayEdit(access(['view', 'edit']))).toBe(true);
  });

  it('is true when only a region grants edit', () => {
    expect(mayEdit(access(['view'], { 'region:r1': ['view', 'edit'] }))).toBe(true);
  });

  it('is false for view, comment, suggest and fill alone', () => {
    expect(mayEdit(access(['view', 'comment', 'suggest', 'fill']))).toBe(false);
    expect(mayEdit(access(['view'], { 'region:r1': ['view', 'comment'] }))).toBe(false);
  });
});

/** A backend whose `sync.open` hands out one channel and counts what happens to it. */
function backendWith(opened: Access | Error): { backend: Backend; log: string[] } {
  const log: string[] = [];
  const backend = {
    sync: {
      open: (docId: string) => {
        log.push(`open ${docId}`);
        if (opened instanceof Error) return Promise.reject(opened);
        return Promise.resolve({
          docId,
          opened: { access: opened },
          close: () => log.push('close'),
        });
      },
    },
  } as unknown as Backend;
  return { backend, log };
}

describe('mayEditDocument (FE-072 criterion 4)', () => {
  it('reads the access of the opened channel and closes the channel', async () => {
    const editor = backendWith(access(['view', 'edit']));
    await expect(mayEditDocument(editor.backend, 'doc-1')).resolves.toBe(true);
    expect(editor.log).toEqual(['open doc-1', 'close']);
    const viewer = backendWith(access(['view']));
    await expect(mayEditDocument(viewer.backend, 'doc-1')).resolves.toBe(false);
    expect(viewer.log).toEqual(['open doc-1', 'close']);
  });

  it('rejects when the channel cannot be opened, so that the editor is not opened', async () => {
    const { backend, log } = backendWith(new Error('no channel'));
    await expect(mayEditDocument(backend, 'doc-1')).rejects.toThrow('no channel');
    expect(log).toEqual(['open doc-1']);
  });
});
