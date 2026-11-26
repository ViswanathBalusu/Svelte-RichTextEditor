/**
 * The host side of a sandboxed extension's messages (UX-060; 13 §7.2; ADR 0393). A tier 2
 * extension runs in a sandboxed iframe and has no handle on the editor: it sends requests over a
 * private message channel, and this bridge answers them with the document API of UX-053, after
 * three checks.
 *
 * - The envelope and the arguments must match the schema below. Anything else is ignored: no
 *   reply, no effect, one log entry of kind `ignored`.
 * - The method must be in the table. A method outside it is refused as `unknown_method`.
 * - The call must be within the declared `access` (ADR 0393): `read` is `view`; `write` is `none`
 *   (no write method), `suggest` (writes only while the editor is in suggestion mode, so they
 *   arrive as suggestions) or `edit`. A call beyond it is refused as `access_denied` and logged
 *   as `refused`.
 *
 * Writes that pass these checks go to the same `ExtensionDocumentApi` a tier 1 extension has, so
 * they go through the guards of typing as the current user (UX-053, ADR 0234 B1). The bridge
 * adds no right of its own and holds no state but the subscriptions.
 *
 * No DOM here: the file is plain TypeScript and runs in Node.js tests.
 */
import type { ExtensionDocumentApi, ExtEventName } from './document-api.ts';

export type SandboxWriteLevel = 'none' | 'suggest' | 'edit';
/** What a tier 2 extension declares in `access` (ADR 0234 B3; levels fixed by ADR 0393). */
export interface SandboxAccess {
  readonly read: 'view';
  readonly write: SandboxWriteLevel;
}

export type SandboxErrorCode = 'access_denied' | 'unknown_method' | 'invalid_arguments' | 'failed';

/** A request from the frame. `v` is the protocol version of the channel. */
export interface SandboxRequest {
  readonly v: 1;
  readonly id: number;
  readonly method: string;
  readonly args: readonly unknown[];
}
export type SandboxReply =
  | { readonly v: 1; readonly id: number; readonly ok: true; readonly result: unknown }
  | {
      readonly v: 1;
      readonly id: number;
      readonly ok: false;
      readonly error: { readonly code: SandboxErrorCode; readonly message: string };
    };
export interface SandboxEventMessage {
  readonly v: 1;
  readonly type: 'event';
  readonly event: ExtEventName;
  readonly payload: unknown;
}

/** One line of the log of refused or ignored messages (UX-060 criteria 2 and 3). */
export interface SandboxLogEntry {
  readonly extension: string;
  readonly kind: 'refused' | 'ignored';
  readonly method: string | null;
  readonly code: SandboxErrorCode | 'bad_message';
  readonly message: string;
}

export interface SandboxBridgeOptions {
  /** The manifest identifier, for the log. */
  readonly extension: string;
  /** The extension's own document API (one per extension, as tier 1 gets). */
  readonly api: ExtensionDocumentApi;
  readonly access: SandboxAccess;
  /** Whether the editor is in suggestion mode now. Asked on each write of a `suggest` extension. */
  readonly suggesting: () => boolean;
  /** Sends a reply or an event to the frame. */
  readonly send: (message: SandboxReply | SandboxEventMessage) => void;
  readonly log: (entry: SandboxLogEntry) => void;
  /**
   * Leave the API alive when the bridge is disposed (a panel's frame closes and opens again while
   * the extension stays installed, UX-060); the host ends the API when it removes the extension.
   */
  readonly keepApi?: boolean;
}

const EVENTS: ReadonlySet<string> = new Set<ExtEventName>([
  'blocks.added',
  'blocks.changed',
  'blocks.deleted',
  'selection.changed',
  'suggestions.changed',
  'comments.changed',
]);

type Check = (value: unknown) => boolean;
const isObject: Check = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt: Check = (v) => typeof v === 'number' && Number.isSafeInteger(v);
const isString: Check = (v) => typeof v === 'string';
const isRange: Check = (v) =>
  isObject(v) &&
  isString((v as Record<string, unknown>)['id']) &&
  isInt((v as Record<string, unknown>)['from']) &&
  isInt((v as Record<string, unknown>)['to']);
const optional =
  (check: Check): Check =>
  (v) =>
    v === undefined || check(v);

interface MethodSpec {
  readonly kind: 'read' | 'write' | 'subscribe';
  /** One check per argument; a trailing `optional` one may be absent. */
  readonly args: readonly Check[];
}

const METHODS: Readonly<Record<string, MethodSpec>> = {
  range: { kind: 'read', args: [isInt, isInt] },
  selection: { kind: 'read', args: [] },
  current: { kind: 'read', args: [isRange] },
  release: { kind: 'read', args: [isRange] },
  blocks: { kind: 'read', args: [isRange] },
  text: { kind: 'read', args: [isRange] },
  marks: { kind: 'read', args: [isRange] },
  comments: { kind: 'read', args: [isRange] },
  suggestions: { kind: 'read', args: [isRange] },
  subscribe: { kind: 'subscribe', args: [isString] },
  unsubscribe: { kind: 'subscribe', args: [isString] },
  insertBlocks: { kind: 'write', args: [isRange, isObject] },
  replaceRange: { kind: 'write', args: [isRange, isString] },
  deleteRange: { kind: 'write', args: [isRange] },
  setMark: { kind: 'write', args: [isRange, isString, optional(isObject)] },
  insertExtensionBlock: { kind: 'write', args: [isRange, isObject] },
  updateExtensionBlock: { kind: 'write', args: [isString, isObject] },
  insertExtensionInline: { kind: 'write', args: [isRange, isObject] },
};

/** Reads the envelope of a request, or null when it does not match the schema. */
export function parseRequest(raw: unknown): SandboxRequest | null {
  if (!isObject(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (m['v'] !== 1 || !isInt(m['id']) || (m['id'] as number) < 0) return null;
  if (typeof m['method'] !== 'string' || !Array.isArray(m['args'])) return null;
  // No member besides the four: an envelope that carries more is not ours.
  if (Object.keys(m).some((k) => k !== 'v' && k !== 'id' && k !== 'method' && k !== 'args'))
    return null;
  return { v: 1, id: m['id'] as number, method: m['method'], args: m['args'] as unknown[] };
}

/** Reads the `access` a manifest declares; a missing or unknown level is refused, never guessed. */
export function parseAccess(
  raw: unknown,
):
  | { readonly ok: true; readonly access: SandboxAccess }
  | { readonly ok: false; readonly message: string } {
  if (!isObject(raw)) return { ok: false, message: 'a tier 2 extension must declare `access`' };
  const a = raw as Record<string, unknown>;
  if (a['read'] !== 'view') return { ok: false, message: '`access.read` must be "view"' };
  const w = a['write'];
  if (w !== 'none' && w !== 'suggest' && w !== 'edit')
    return { ok: false, message: '`access.write` must be "none", "suggest" or "edit"' };
  return { ok: true, access: { read: 'view', write: w } };
}

export interface SandboxBridge {
  /** Handles one message from the frame. Never throws. */
  receive(raw: unknown): void;
  /** Ends every subscription and the API. Later messages are ignored. */
  dispose(): void;
}

export function createSandboxBridge(options: SandboxBridgeOptions): SandboxBridge {
  const { api, access, extension } = options;
  const subscriptions = new Map<string, () => void>();
  let disposed = false;

  const reply = (m: SandboxReply): void => {
    try {
      options.send(m);
    } catch {
      // A frame that is gone cannot be answered; nothing else to do.
    }
  };
  const fail = (
    id: number,
    method: string,
    code: SandboxErrorCode,
    message: string,
    kind: 'refused' | 'ignored' = 'refused',
  ): void => {
    options.log({ extension, kind, method, code, message });
    reply({ v: 1, id, ok: false, error: { code, message } });
  };

  function call(method: string, args: readonly unknown[]): unknown {
    const a = api as unknown as Record<string, (...x: unknown[]) => unknown>;
    switch (method) {
      case 'subscribe': {
        const event = args[0] as string;
        if (!EVENTS.has(event)) throw new RangeError(`no such event: ${event}`);
        if (!subscriptions.has(event)) {
          const off = api.on(event as ExtEventName, (payload) =>
            options.send({ v: 1, type: 'event', event: event as ExtEventName, payload }),
          );
          subscriptions.set(event, off);
        }
        return null;
      }
      case 'unsubscribe': {
        const event = args[0] as string;
        subscriptions.get(event)?.();
        subscriptions.delete(event);
        return null;
      }
      default: {
        const fn = a[method];
        if (typeof fn !== 'function') throw new RangeError(`no such method: ${method}`);
        return fn.apply(api, args as unknown[]);
      }
    }
  }

  return {
    receive(raw) {
      if (disposed) return;
      const req = parseRequest(raw);
      if (req === null) {
        options.log({
          extension,
          kind: 'ignored',
          method: null,
          code: 'bad_message',
          message: 'the message does not match the schema',
        });
        return;
      }
      const spec = Object.hasOwn(METHODS, req.method) ? METHODS[req.method] : undefined;
      if (spec === undefined) {
        fail(
          req.id,
          req.method,
          'unknown_method',
          `${req.method} is not a method of the extension API`,
        );
        return;
      }
      const checks = spec.args;
      const valid =
        req.args.length <= checks.length && checks.every((check, i) => check(req.args[i]));
      if (!valid) {
        options.log({
          extension,
          kind: 'ignored',
          method: req.method,
          code: 'bad_message',
          message: 'the arguments do not match the schema',
        });
        return;
      }
      if (spec.kind === 'write') {
        if (access.write === 'none') {
          fail(req.id, req.method, 'access_denied', 'this extension declared no write access');
          return;
        }
        if (access.write === 'suggest' && !options.suggesting()) {
          fail(
            req.id,
            req.method,
            'access_denied',
            'this extension may only suggest, and the editor is not in suggestion mode',
          );
          return;
        }
      }
      try {
        const result = call(req.method, req.args);
        reply({ v: 1, id: req.id, ok: true, result: result === undefined ? null : result });
      } catch (e) {
        reply({
          v: 1,
          id: req.id,
          ok: false,
          error: { code: 'failed', message: e instanceof Error ? e.message : String(e) },
        });
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const off of subscriptions.values()) off();
      subscriptions.clear();
      if (options.keepApi !== true) api.dispose();
    },
  };
}
