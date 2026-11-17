/**
 * UX-053: the document API an extension receives is typed in `@docedit/ui` and built in
 * `@docedit/engine`, two packages that do not depend on each other. This test holds them together
 * at the type level (the type-check fails if the engine's API stops fitting the ui's) and, at run
 * time, checks that a core's API is accepted where the shell expects it.
 */
import { DocumentCore, type ExtensionDocumentApi as EngineApi } from '@docedit/engine/headless';
import type { ExtensionDocumentApi as UiApi } from '@docedit/ui';
import { spikeDocument } from '@docedit/engine/testing';
import { describe, expect, it } from 'vitest';

// Compile-time: each side is assignable to the other, so neither can drift without a type error.
type Same = EngineApi extends UiApi ? (UiApi extends EngineApi ? true : false) : false;
const same: Same = true;

describe('UX-053: the engine and the ui agree on the document API', () => {
  it('fits both ways at the type level', () => {
    expect(same).toBe(true);
  });

  it('is built by a core and used through the ui type', () => {
    const core = new DocumentCore({ doc: spikeDocument(), schedule: (run) => queueMicrotask(run) });
    const api: UiApi = core.extensionApi({ maxRanges: 2 });
    const r = api.selection();
    expect(api.current(r)).toMatchObject({ stale: false, detached: false });
    api.dispose();
    core.destroy();
  });
});
