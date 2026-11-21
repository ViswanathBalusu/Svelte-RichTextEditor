/**
 * The harness page for the web view (FND-007): one `<doc-editor>` from `@docedit/element` on a
 * corpus document, loaded the way the element's own demo pages load one (packages/element/demo):
 * through the in-memory backend (`@docedit/backend-mock`, the real authority in process), with
 * `backend` and `doc-id`. Query: `?doc=pages-100`; with `&fill=<role_def id>` the user is a
 * participant who holds that role, in the fill mode.
 *
 * The observers of pages/editor.html run before this module. Marks for the specs:
 * `harness:fetched` (the CDM is in the page), `harness:backend` (the in-memory backend holds the
 * document; this is test scaffolding a real host does not run, and the specs subtract it), and
 * `harness:element` (the element is created and connected).
 */
import '@docedit/element';
import type { DocEditorElement } from '@docedit/element';
import { MockService } from '@docedit/backend-mock';
import type { CdmEnvelope } from '@docedit/model';

interface PerfState {
  readyAt?: number;
  fetchedAt?: number;
  backendMs?: number;
  elementAt?: number;
  error?: string;
  documentBytes?: number;
  docId?: string;
  /** Main-thread time of each commit inside the in-page backend (the room's synchronous work). */
  submitMs: number[];
}

const perf = (globalThis as unknown as { __perf: PerfState }).__perf;
perf.submitMs = [];
const params = new URLSearchParams(location.search);
const name = params.get('doc') ?? 'pages-20';

type AnyFn = (...args: unknown[]) => unknown;

/** A proxy whose methods are bound to the target, with some members replaced. */
function wrap<T extends object>(target: T, replace: Record<string, unknown>): T {
  return new Proxy(target, {
    get(t, key) {
      if (typeof key === 'string' && key in replace) return replace[key];
      const v = Reflect.get(t, key, t) as unknown;
      return typeof v === 'function' ? (v as AnyFn).bind(t) : v;
    },
  });
}

/**
 * The in-memory backend answers a commit synchronously, inside the element's `submit` call, on
 * the page's main thread; a real backend is remote and answers later. Unless `?backend=inline`,
 * every commit is handed to the backend after the next frame has been produced, so that the room's
 * own work (its full validation of the document, spike S3) is not counted as keystroke-to-paint
 * latency of the client. Its time is recorded in `submitMs`.
 */
function remoteLike<B extends { sync: object }>(backend: B): B {
  const mode = params.get('backend');
  if (mode === 'inline') return backend;
  const sync = backend.sync as { open: AnyFn };
  const open = async (...args: unknown[]): Promise<unknown> => {
    const channel = (await sync.open(...args)) as {
      submit: (c: unknown) => Promise<unknown>;
    } & object;
    const submit = (commit: unknown): Promise<unknown> =>
      new Promise((resolve, reject) => {
        // `?backend=hold`: the commit is never answered, as with a server that has not replied
        // yet, so that no backend work at all runs on the page's main thread.
        if (mode === 'hold') {
          perf.submitMs.push(0);
          return;
        }
        requestAnimationFrame(() =>
          setTimeout(() => {
            const t0 = performance.now();
            const p = channel.submit(commit);
            perf.submitMs.push(performance.now() - t0);
            p.then(resolve, reject);
          }, 0),
        );
      });
    return wrap(channel, { submit });
  };
  return wrap(backend, { sync: wrap(sync, { open }) });
}

async function start(): Promise<void> {
  const res = await fetch(`/corpus/${name}.cdm.json`);
  if (!res.ok) throw new Error(`corpus document ${name}: HTTP ${res.status}`);
  const text = await res.text();
  perf.documentBytes = text.length;
  const envelope = JSON.parse(text) as CdmEnvelope;
  performance.mark('harness:fetched');
  perf.fetchedAt = performance.now();

  const t0 = performance.now();
  const service = new MockService();
  // `?fill=<role_def id>`: the user is a participant who holds that role and may only fill, and the
  // element is in the fill mode (FRW-023 criterion 6). Otherwise an editor of the document.
  const fillRole = params.get('fill');
  const user = fillRole
    ? { sub: 'perf', name: 'Harness user', fill: { roles: [fillRole] } }
    : { sub: 'perf', name: 'Harness user' };
  const docId = service.createDocument(envelope);
  const backend = remoteLike(service.backend(user, { [docId]: fillRole ? 'filler' : 'editor' }));
  perf.backendMs = performance.now() - t0;
  perf.docId = docId;
  performance.mark('harness:backend');

  const el = document.createElement('doc-editor') as DocEditorElement;
  el.addEventListener('de-ready', () => {
    performance.mark('harness:ready');
    perf.readyAt = performance.now();
  });
  el.addEventListener('de-error', (e) => {
    perf.error = `de-error: ${JSON.stringify((e as CustomEvent).detail)}`;
  });
  el.backend = backend;
  if (fillRole) el.setAttribute('mode', 'fill');
  el.setAttribute('doc-id', docId);
  document.body.append(el);
  perf.elementAt = performance.now();
  performance.mark('harness:element');
}

start().catch((e: unknown) => {
  perf.error = e instanceof Error ? e.message : String(e);
});
