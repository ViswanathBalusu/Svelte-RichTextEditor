// FE-007 criterion 3: when the server answers `read_only` to a commit, the save state the element
// reads is `readonly`. The session runs the real headless core against backend-mock, and the
// server's refusal comes from the mock's own room (the document is locked while the write is held),
// so the answer is the authority's and not a stand-in.
import { describe, expect, it } from 'vitest';
import { Session } from '../src/session.ts';
import { coreHost, until } from './core-host.ts';
import { backendFor, service } from './support.ts';

describe('FE-007 criterion 3: a read_only answer from the server reads as readonly', () => {
  it('reads readonly after the server refuses a commit with read_only, and not before', async () => {
    const { service: s, docId } = service();
    const host = coreHost();
    const session = new Session({
      docId,
      backend: backendFor(s, docId, 'editor', 'editor'),
      ownsBackend: false,
      host,
    });
    await session.start();
    expect(session.phase).toBe('ready');
    const editor = session.editor!;
    expect(editor.saveState.get()).toBe('saved');
    const core = host.cores[0]!;

    // The commit is held in the room; the document is then locked, so the room refuses it.
    const hold = s.holdWrites(docId);
    expect(core.pastePlainText('late ')).toBe(true);
    s.setDocumentState(docId, 'locked');
    await hold.release();

    await until(() => editor.saveState.get() === 'readonly', 'the read_only answer');
    expect(editor.saveState.get()).toBe('readonly');
    expect(core.saveState.get()).toBe('readonly');
    await session.close();
  });
});
