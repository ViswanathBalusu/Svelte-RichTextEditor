/**
 * The page of e2e/ux-060-sandbox-frame.spec.ts: a stand-in for the host page, holding secrets a
 * sandboxed extension must not reach, and the real `ExtensionHost` with `sandboxedExtension`
 * (UX-060). The document API is a recording stand-in; the isolation, the message checks and the
 * keyboard are the real code in a real browser.
 */
import type { ExtensionDocumentApi } from '../../src/extensions/document-api.ts';
import { ExtensionHost, type ExtensionReport } from '../../src/extensions/host.ts';
import type { SandboxLogEntry } from '../../src/extensions/sandbox-protocol.ts';
import {
  sandboxedExtension,
  type SandboxedActivationApi,
} from '../../src/extensions/sandbox-extension.ts';

const calls: Array<[string, ...unknown[]]> = [];
const logs: SandboxLogEntry[] = [];
const reports: ExtensionReport[] = [];
const keys: Array<{ key: string; ctrl: boolean; shift: boolean; alt: boolean }> = [];
let suggesting = false;
let disposed = 0;

// What a hostile extension would want: the host's token in storage, a cookie and a global.
try {
  localStorage.setItem('token', 'host-secret');
  document.cookie = 'session=host-cookie; path=/';
} catch {
  // A browser that blocks storage on this page: the test then proves less, and says so by failing.
}
(window as unknown as { hostToken: string }).hostToken = 'host-secret';

function record<T>(name: string, result: T): (...args: unknown[]) => T {
  return (...args) => {
    calls.push([name, ...args]);
    return result;
  };
}

function makeApi(): ExtensionDocumentApi {
  return {
    range: (from: number, to: number) => {
      calls.push(['range', from, to]);
      return { id: `r${from}-${to}`, from, to };
    },
    selection: record('selection', { id: 's', from: 0, to: 0 }),
    current: record('current', { from: 1, to: 4, stale: false, detached: false }),
    release: record('release', undefined),
    blocks: record('blocks', []),
    text: record('text', 'host text'),
    marks: record('marks', []),
    comments: record('comments', []),
    suggestions: record('suggestions', []),
    insertBlocks: record('insertBlocks', { ok: true }),
    replaceRange: record('replaceRange', { ok: true }),
    deleteRange: record('deleteRange', { ok: true }),
    setMark: record('setMark', { ok: true }),
    insertExtensionBlock: record('insertExtensionBlock', { ok: true, id: 'b1' }),
    updateExtensionBlock: record('updateExtensionBlock', { ok: true, id: 'b1' }),
    insertExtensionInline: record('insertExtensionInline', { ok: true }),
    on: () => () => undefined,
    dispose: () => {
      disposed += 1;
    },
  } as unknown as ExtensionDocumentApi;
}

const host = new ExtensionHost<SandboxedActivationApi>({
  apiVersions: ['1'],
  createApi: (_id, track) => ({ document: makeApi(), onRemove: track }),
  onError: (r) => reports.push(r),
});

// Keys that reach the page itself. A key pressed in the frame must never get here.
const pageKeys: string[] = [];
document.addEventListener('keydown', (e) => pageKeys.push(e.key));

const api = {
  install(manifests: Array<Record<string, unknown>>): void {
    host.sync(
      manifests.map((manifest) =>
        sandboxedExtension({
          manifest,
          frameUrl: '/sandbox-frame.html',
          container: () => document.getElementById('panel')!,
          suggesting: () => suggesting,
          log: (e) => logs.push(e),
          onKey: (k) =>
            keys.push({ key: k.key, ctrl: k.ctrlKey, shift: k.shiftKey, alt: k.altKey }),
        }),
      ),
    );
  },
  remove(): void {
    host.sync([]);
  },
  setSuggesting(value: boolean): void {
    suggesting = value;
  },
  calls,
  logs,
  reports,
  keys,
  pageKeys,
  disposed: () => disposed,
  frameCount: () => document.querySelectorAll('iframe').length,
  sandboxAttribute: () => document.querySelector('iframe')?.getAttribute('sandbox') ?? null,
};
(window as unknown as { sandboxTest: typeof api }).sandboxTest = api;
