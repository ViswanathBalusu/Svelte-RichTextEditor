// UX-041 through the real path: a Session hands the backend's proofing port to the editing core when
// the backend has one, and nothing when it has none (criterion 5). The port has no feature name
// (13 §6.1), so its presence is the only sign. The core is the headless one, mounted as
// `src/editor.ts` mounts it. Node.js only.
import { MockService } from '@docedit/backend-mock';
import { DocumentCore } from '@docedit/engine/headless';
import type { Backend, ProofingBlock, ProofingPort } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import type { EditorHandle, SessionHost } from '../src/session.ts';
import { Session } from '../src/session.ts';
import { LEGAL_GRANT, contractDocument } from './support.ts';

function host(): SessionHost & { cores: DocumentCore[] } {
  const cores: DocumentCore[] = [];
  return {
    cores,
    emit() {},
    async mount(content) {
      const core = new DocumentCore({
        doc: { cdm: content.cdm, requires: [...content.requires], doc: content.doc },
        schedule: (run) => queueMicrotask(run),
      });
      cores.push(core);
      const handle: EditorHandle = {
        attach: (channel, at) => core.attach(channel, at),
        setAccess: (access) => core.setAccess(access),
        saveState: core.saveState,
        confirmedSeq: core.confirmedSeq,
        access: core.permissions,
        status: null,
        recovered: null,
        problem: null,
        focus() {},
        destroy: () => core.destroy(),
      };
      return handle;
    },
  };
}

async function start(withPort: ProofingPort | null) {
  const service = new MockService();
  const docId = service.createDocument(contractDocument(), { grants: [LEGAL_GRANT] });
  const backend: Backend = service.backend({ sub: 'rita' }, { [docId]: 'editor' });
  if (withPort) Object.defineProperty(backend, 'proofing', { value: withPort });
  const h = host();
  const session = new Session({
    docId,
    backend,
    ownsBackend: true,
    host: h,
    scheduler: (run) => queueMicrotask(run),
  });
  await session.start();
  expect(session.phase).toBe('ready');
  return { session, core: h.cores[0]!, docId };
}

describe('the backend proofing port reaches the core (UX-041)', () => {
  it('sends the document text with the document id, and shows a finding', async () => {
    const seen: Array<{ docId: string; blocks: readonly ProofingBlock[] }> = [];
    const { session, core, docId } = await start({
      check: (request) => {
        seen.push(request);
        const block = request.blocks.find((b) => b.text.includes('Hello'));
        return Promise.resolve(
          block
            ? [
                {
                  blockId: block.blockId,
                  from: 0,
                  to: 5,
                  kind: 'spelling',
                  message: 'Unknown word',
                  suggestions: ['Hallo'],
                },
              ]
            : [],
        );
      },
      addWord: () => Promise.resolve(),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(seen[0]?.docId).toBe(docId);
    expect(core.proofing.get().available).toBe(true);
    expect(core.proofingFindings().map((f) => f.text)).toEqual(['Hello']);
    session.close();
  });

  it('leaves proofing off when the backend has no proofing port', async () => {
    const { session, core } = await start(null);
    expect(core.proofing.get().available).toBe(false);
    expect(core.proofingFindings()).toEqual([]);
    session.close();
  });
});
