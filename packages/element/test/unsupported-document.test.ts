/**
 * FE-030 criterion 5 (element side): a document whose `requires` lists a feature this build lacks
 * is refused by the core (UnsupportedDocumentError, engine test/schema.test.ts). The session then
 * raises one fatal `de-error` with the registry code and a message that names the problem, and no
 * editor is left mounted with the content. Runs in Node.js with the mock backend.
 */
import { UnsupportedDocumentError } from '@docedit/engine';
import type { Content } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import type { DocEditorEventMap, DocEditorEventName } from '../src/events.ts';
import { Session, type SessionHost } from '../src/session.ts';
import { backendFor, names, type Recorded, service } from './support.ts';

const immediate = (run: () => void) => queueMicrotask(run);

function refusingHost(error: Error): SessionHost & {
  events: Recorded[];
  mounted: Content[];
} {
  const events: Recorded[] = [];
  const mounted: Content[] = [];
  return {
    events,
    mounted,
    emit<K extends DocEditorEventName>(name: K, detail: DocEditorEventMap[K]) {
      events.push({ name, detail: structuredClone(detail) });
    },
    async mount(content) {
      mounted.push(content);
      throw error;
    },
  };
}

describe('FE-030 a document this build cannot open', () => {
  it('raises one fatal de-error with the feature named, and leaves no editor mounted', async () => {
    const { service: s, docId } = service();
    const host = refusingHost(
      new UnsupportedDocumentError(
        'unsupported_feature',
        'the document needs the feature x-future, which this editor does not support',
        ['x-future'],
      ),
    );
    const session = new Session({
      docId,
      backend: backendFor(s, docId, 'editor', 'editor'),
      ownsBackend: false,
      host,
      scheduler: immediate,
    });
    await session.start();

    expect(session.phase).toBe('failed');
    expect(names(host.events)).toEqual(['de-error']);
    const detail = host.events[0]!.detail as { code: string; message: string; fatal: boolean };
    expect(detail.code).toBe('unsupported_feature');
    expect(detail.fatal).toBe(true);
    expect(detail.message).toContain('x-future');
    // The core refused the document: the session never opened a channel for it.
    expect(host.mounted).toHaveLength(1);
    expect(session.editor).toBeNull();
    await session.close();
    await s.dispose();
  });

  it('reports an unsupported CDM version with its own registry code, also fatal', async () => {
    const { service: s, docId } = service();
    const host = refusingHost(
      new UnsupportedDocumentError('unsupported_cdm', 'the document uses CDM version 9'),
    );
    const session = new Session({
      docId,
      backend: backendFor(s, docId, 'editor', 'editor'),
      ownsBackend: false,
      host,
      scheduler: immediate,
    });
    await session.start();
    const detail = host.events[0]!.detail as { code: string; fatal: boolean };
    expect([host.events.length, detail.code, detail.fatal]).toEqual([1, 'unsupported_cdm', true]);
    await session.close();
    await s.dispose();
  });
});
