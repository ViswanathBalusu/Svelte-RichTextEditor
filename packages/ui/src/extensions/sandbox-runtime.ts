/**
 * The script that runs inside a sandboxed extension's iframe (UX-060; ADR 0393). Built as one
 * classic script (an IIFE, no imports) and served by the host as `sandbox-runtime.js` beside
 * `sandbox-frame.html`; see sandbox-frame.ts for the host side.
 *
 * It does four things and nothing else:
 *
 * 1. Waits for the host's `init` message, accepted only from `window.parent` and only with exactly
 *    one port. The port is the private channel; no other source is ever read.
 * 2. Loads the extension's entry as a classic script, so the host's policy for the frame decides
 *    which origins may supply code.
 * 3. Gives the extension `deExtension.activate(fn)`, which calls `fn` with a promise-based copy of
 *    the document API: each method sends one request over the port and settles with the reply.
 * 4. Sends the landmark keys (F6) and Escape to the host, because a key pressed in a frame does
 *    not reach the page (UX-023). The extension may stop one with `preventDefault`.
 *
 * It holds no secret: the frame has an opaque origin and the page's tokens are not in it.
 */
(() => {
  type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
  const pending = new Map<number, Pending>();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  let port: MessagePort | null = null;
  let next = 0;

  const send = (message: unknown): void => port?.postMessage(message);
  const request = (method: string, args: unknown[]): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (port === null) {
        reject(new Error('the extension is not connected'));
        return;
      }
      const id = next++;
      pending.set(id, { resolve, reject });
      send({ v: 1, id, method, args });
    });

  const METHODS = [
    'range',
    'selection',
    'current',
    'release',
    'blocks',
    'text',
    'marks',
    'comments',
    'suggestions',
    'insertBlocks',
    'replaceRange',
    'deleteRange',
    'setMark',
    'insertExtensionBlock',
    'updateExtensionBlock',
  ] as const;

  const api: Record<string, unknown> = {};
  for (const name of METHODS)
    api[name] = (...args: unknown[]): Promise<unknown> => request(name, args);
  api['on'] = (event: string, handler: (payload: unknown) => void): (() => void) => {
    let set = listeners.get(event);
    if (set === undefined) {
      set = new Set();
      listeners.set(event, set);
      void request('subscribe', [event]).catch(() => undefined);
    }
    set.add(handler);
    return () => {
      const current = listeners.get(event);
      if (current === undefined) return;
      current.delete(handler);
      if (current.size === 0) {
        listeners.delete(event);
        void request('unsubscribe', [event]).catch(() => undefined);
      }
    };
  };

  (window as unknown as { deExtension: unknown }).deExtension = {
    activate(fn: (api: unknown) => unknown): void {
      try {
        const result = fn(api);
        if (result instanceof Promise) result.catch((e: unknown) => console.error(e));
      } catch (e) {
        console.error(e);
      }
    },
  };

  const onPortMessage = (event: MessageEvent): void => {
    const d: unknown = event.data;
    if (typeof d !== 'object' || d === null) return;
    const m = d as Record<string, unknown>;
    if (m['v'] !== 1) return;
    if (m['type'] === 'event' && typeof m['event'] === 'string') {
      for (const handler of listeners.get(m['event']) ?? []) {
        try {
          handler(m['payload']);
        } catch (e) {
          console.error(e);
        }
      }
      return;
    }
    if (typeof m['id'] !== 'number') return;
    const p = pending.get(m['id']);
    if (p === undefined) return;
    pending.delete(m['id']);
    if (m['ok'] === true) p.resolve(m['result']);
    else {
      const err = (m['error'] ?? {}) as { code?: unknown; message?: unknown };
      const error = new Error(typeof err.message === 'string' ? err.message : 'refused');
      (error as Error & { code?: unknown }).code = err.code;
      p.reject(error);
    }
  };

  window.addEventListener('message', (event: MessageEvent) => {
    if (port !== null || event.source !== window.parent || event.ports.length !== 1) return;
    const d: unknown = event.data;
    if (typeof d !== 'object' || d === null) return;
    const m = d as Record<string, unknown>;
    if (m['v'] !== 1 || m['type'] !== 'init' || typeof m['entry'] !== 'string') return;
    port = event.ports[0] ?? null;
    if (port === null) return;
    port.onmessage = onPortMessage;
    const script = document.createElement('script');
    script.src = m['entry'];
    script.onerror = () => console.error('the extension could not be loaded');
    // This file runs only inside the sandbox frame, whose `document` is the frame's own, never the
    // host page's (the overlay guard of FE-020 is about the host document).
    const frameHead = document.head;
    frameHead.append(script);
  });

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.defaultPrevented || port === null) return;
    const landmark = e.key === 'F6';
    const escape = e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey;
    if (!landmark && !escape) return;
    e.preventDefault();
    send({
      type: 'key',
      key: e.key,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
    });
  });
})();

export {};
