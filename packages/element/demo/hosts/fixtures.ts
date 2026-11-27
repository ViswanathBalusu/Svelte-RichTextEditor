/**
 * What every framework host of the host matrix shares (FE-124 criterion 1): it loads the element's
 * bundle on demand, makes a document and an in-memory backend, and reports what happened on
 * `globalThis.__host` for the test to read. The element's events bubble and are composed, so the
 * document hears `de-ready` and `de-error` whatever the framework does with the tag. The framework code that follows only renders a
 * `<doc-editor>` with the document and the backend, and a button of its own to show that the
 * framework is alive beside the editor.
 */
import { MockService } from '@docedit/backend-mock';
import { spikeDocument } from '@docedit/engine/spike-document';
import type { CdmEnvelope } from '@docedit/model';

export interface HostStatus {
  framework: string;
  version: string;
  /** The element's bundle was imported. */
  loaded: boolean;
  /** The framework has rendered its own UI. */
  rendered: boolean;
  /** The element raised `de-ready`. */
  ready: boolean;
  error: string | null;
}

export interface HostFixtures {
  readonly status: HostStatus;
  readonly docId: string;
  readonly backend: unknown;
}

/** Loads the element and makes the fixtures; the status is on `globalThis.__host`. */
export async function startHost(framework: string, version: string): Promise<HostFixtures> {
  const status: HostStatus = {
    framework,
    version,
    loaded: false,
    rendered: false,
    ready: false,
    error: null,
  };
  Object.assign(globalThis, { __host: status });
  globalThis.addEventListener('error', (e) => {
    status.error ??= e.message;
  });
  document.addEventListener('de-ready', () => {
    status.ready = true;
  });
  document.addEventListener('de-error', (e) => {
    status.error = JSON.stringify((e as CustomEvent).detail);
  });
  try {
    // A variable, so that neither TypeScript nor the bundler looks for the file at build time.
    const bundle = '/assets/doc-editor.js';
    await import(/* @vite-ignore */ bundle);
    status.loaded = true;
  } catch (e) {
    status.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
  const service = new MockService();
  const docId = service.createDocument(spikeDocument() as unknown as CdmEnvelope);
  return { status, docId, backend: service.backend({ sub: 'host' }, { [docId]: 'editor' }) };
}
