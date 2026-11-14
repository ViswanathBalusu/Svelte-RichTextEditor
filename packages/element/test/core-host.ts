// A session host that mounts a headless editing core from the loaded content and attaches it
// through the session, as `src/editor.ts` does for the core (without the shell). Shared by the
// element's Node.js tests that need the real core against backend-mock.
import { DocumentCore } from '@docedit/engine/headless';
import type { Content } from '@docedit/protocol';
import { hostApi } from '../src/host-api.ts';
import type { EditorHandle, SessionHost } from '../src/session.ts';

const schedule = (run: () => void) => queueMicrotask(run);

export function coreHost(): SessionHost & { cores: DocumentCore[] } {
  const cores: DocumentCore[] = [];
  return {
    cores,
    emit() {},
    async mount(content: Content) {
      const core = new DocumentCore({
        doc: { cdm: content.cdm, requires: [...content.requires], doc: content.doc },
        schedule,
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
        api: hostApi(core),
      };
      return handle;
    },
  };
}

/** Waits until `done()` holds, letting timers and microtasks run. */
export async function until(done: () => boolean, what: string, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
