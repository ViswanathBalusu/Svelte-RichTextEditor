/**
 * Mounts a sandboxed extension's iframe (UX-060; 13 §7.2; ADR 0393). The frame is a page the
 * host serves from its own origin (`sandbox-frame.html` and `sandbox-runtime.js`, built from
 * `sandbox-runtime.ts`), loaded with `sandbox="allow-scripts"` and no other token, so that:
 *
 * - it has an opaque origin: no access to the host page's DOM, the editor's shadow root, the host's
 *   cookies, `localStorage`, `sessionStorage` or IndexedDB, and no way to navigate the top page,
 *   open a window or submit a form;
 * - its code (the extension's `entry` script) is loaded by the runtime and sees only a
 *   `deExtension` global, whose `activate` hands it a promise-based copy of the document API.
 *
 * Messages travel on one private `MessageChannel`. The host sends the channel's second port to the
 * frame once, with the frame's `contentWindow` as the only target, and listens on nothing else:
 * it registers no `window` message listener, so a message from any other window or frame never
 * reaches the bridge. Every message that does arrive on the port goes through the bridge's schema
 * and access checks (sandbox-protocol.ts).
 *
 * Keyboard: a keydown inside the frame never reaches the page. The runtime forwards the landmark
 * keys (F6, with any of Ctrl, Alt and Shift) and Escape, and this module hands each to `onKey`,
 * where the shell steps to the next landmark or closes the pane (UX-023). It forwards no other
 * key, so the extension's typing stays in its frame. (It dispatches no DOM event: FE-022.)
 *
 * The page that embeds the frame needs `frame-src` for the frame's origin. The frame page's own
 * response header should be `default-src 'none'; script-src 'self' <the origins of entries>`:
 * the extension then has no network, and no code but the runtime and its entry.
 */
import {
  createSandboxBridge,
  type SandboxAccess,
  type SandboxBridge,
  type SandboxLogEntry,
} from './sandbox-protocol.ts';
import type { ExtensionDocumentApi } from './document-api.ts';

export interface SandboxFrameOptions {
  /** Where the frame goes: the iframe element is appended to it. */
  readonly container: HTMLElement;
  /** The URL of the host's `sandbox-frame.html`. */
  readonly frameUrl: string;
  /** The URL of the extension's code, a classic script. */
  readonly entryUrl: string;
  /** The manifest identifier. */
  readonly extension: string;
  /** The accessible name of the frame: the panel's label. */
  readonly title: string;
  readonly api: ExtensionDocumentApi;
  readonly access: SandboxAccess;
  readonly suggesting: () => boolean;
  readonly log: (entry: SandboxLogEntry) => void;
  /** Receives a landmark key or Escape pressed in the frame (UX-023). */
  readonly onKey?: (key: SandboxKey) => void;
}

/** A key forwarded out of the frame: only F6 (landmarks) and a bare Escape. */
export interface SandboxKey {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

export interface SandboxFrame {
  readonly iframe: HTMLIFrameElement;
  /** Resolves when the frame has the channel and has been told to load the entry. */
  readonly ready: Promise<void>;
  /** Moves focus into the frame. */
  focus(): void;
  dispose(): void;
}

/** The keys the runtime may forward; the host re-checks them. */
export function isForwardedKey(key: unknown, ctrl: boolean, alt: boolean): boolean {
  if (key === 'Escape') return !ctrl && !alt;
  return key === 'F6';
}

export function mountSandboxFrame(options: SandboxFrameOptions): SandboxFrame {
  const iframe = document.createElement('iframe');
  // `allow-scripts` and nothing else. In particular never `allow-same-origin`, which would give
  // the frame the host's origin, and never `allow-top-navigation`, `allow-popups` or `allow-forms`.
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.setAttribute('title', options.title);
  iframe.setAttribute('data-sandbox-extension', options.extension);
  iframe.src = options.frameUrl;

  const channel = new MessageChannel();
  let bridge: SandboxBridge | null = createSandboxBridge({
    extension: options.extension,
    api: options.api,
    access: options.access,
    suggesting: options.suggesting,
    log: options.log,
    send: (message) => channel.port1.postMessage(message),
  });

  channel.port1.onmessage = (event: MessageEvent) => {
    const data: unknown = event.data;
    if (typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'key') {
      const k = data as { key?: unknown; ctrlKey?: unknown; shiftKey?: unknown; altKey?: unknown };
      if (
        isForwardedKey(k.key, k.ctrlKey === true, k.altKey === true) &&
        typeof k.key === 'string'
      ) {
        options.onKey?.({
          key: k.key,
          ctrlKey: k.ctrlKey === true,
          shiftKey: k.shiftKey === true,
          altKey: k.altKey === true,
        });
      } else {
        options.log({
          extension: options.extension,
          kind: 'ignored',
          method: null,
          code: 'bad_message',
          message: 'a key the host does not forward',
        });
      }
      return;
    }
    bridge?.receive(data);
  };

  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => (resolveReady = resolve));
  iframe.addEventListener(
    'load',
    () => {
      const target = iframe.contentWindow;
      if (target === null || bridge === null) return;
      // An opaque origin has no name to target, so the target origin is `*`; the receiver is the
      // frame's window and no other.
      target.postMessage(
        { v: 1, type: 'init', entry: options.entryUrl, extension: options.extension },
        '*',
        [channel.port2],
      );
      resolveReady();
    },
    { once: true },
  );
  options.container.append(iframe);

  return {
    iframe,
    ready,
    focus: () => iframe.focus(),
    dispose() {
      bridge?.dispose();
      bridge = null;
      channel.port1.onmessage = null;
      channel.port1.close();
      iframe.remove();
    },
  };
}
