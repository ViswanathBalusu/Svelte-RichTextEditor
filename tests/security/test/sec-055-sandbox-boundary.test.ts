/**
 * SEC-055: the boundary of a sandboxed third-party extension (13 §7.2; UX-060; ADR 0393), tried by
 * the security lane as a hostile extension would try it. Lane w8, 2026-11-18.
 *
 * What runs here, in Node.js, and what does not:
 *
 * - The host side of the message channel (`createSandboxBridge`) is driven with hostile envelopes at
 *   every write level: calls beyond the declared level (criterion 2), method names that reach the
 *   API's own members or the prototype chain, envelopes that carry more than the schema allows, and
 *   attempts to raise the level by message. The API behind the bridge is a recorder, so a call that
 *   gets through is seen.
 * - The frame is mounted by the real `mountSandboxFrame` over a stand-in document, with a real
 *   `MessageChannel`. The test reads the attributes the host gives the iframe (criterion 1) and
 *   plays the extension's side of the channel: forged keys, forged requests, and a request beyond
 *   its level.
 * - Source guards fail if a later change adds a sandbox token that gives the frame the host's
 *   origin or rights, adds a `message` listener on the host window, or lets the bridge reach the
 *   editor other than through the document API.
 *
 * What needs a browser, and is not shown by this file: that the frame has an opaque origin, no
 * token, storage, cookie or host DOM, and no network (criterion 3). That is shown by
 * packages/ui/e2e/ux-060-sandbox-frame.spec.ts in Chromium, Firefox and WebKit, where a hostile
 * extension tries each of them; the story's Evidence names the run. The guards of typing behind a
 * write (criterion 4) are shown by packages/element/test/ux-060-sandbox-guards.test.ts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSandboxBridge,
  parseAccess,
  parseRequest,
  type SandboxAccess,
  type SandboxEventMessage,
  type SandboxLogEntry,
  type SandboxReply,
} from '../../../packages/ui/src/extensions/sandbox-protocol.ts';

const EXT = fileURLToPath(new URL('../../../packages/ui/src/extensions/', import.meta.url));
const PANES = fileURLToPath(new URL('../../../packages/ui/src/panes/', import.meta.url));
const read = (p: string) => readFileSync(p, 'utf8');

const READS = [
  'range',
  'selection',
  'current',
  'release',
  'blocks',
  'text',
  'marks',
  'comments',
  'suggestions',
];
const RANGE = { id: 'r1', from: 1, to: 4 };
/** One valid call of each write method of the table. */
const WRITES: Array<[string, unknown[]]> = [
  ['insertBlocks', [RANGE, {}]],
  ['replaceRange', [RANGE, 'x']],
  ['deleteRange', [RANGE]],
  ['setMark', [RANGE, 'bold']],
  ['insertExtensionBlock', [RANGE, {}]],
  ['updateExtensionBlock', ['b1', {}]],
];
const VALID_READS: Array<[string, unknown[]]> = [
  ['range', [1, 2]],
  ['selection', []],
  ['text', [RANGE]],
  ['blocks', [RANGE]],
];

/** An API that records every call. Its members are those of `ExtensionDocumentApi`. */
function recorder() {
  const calls: string[] = [];
  const target: Record<string, unknown> = {};
  for (const name of [
    ...READS,
    ...WRITES.map(([n]) => n),
    'on',
    'dispose',
    'subscribe',
    'secret',
    'token',
  ])
    target[name] = (...args: unknown[]) => {
      calls.push(name);
      return name === 'on' ? () => calls.push('off') : (args[0] ?? null);
    };
  return { api: target as never, calls };
}

function harness(access: SandboxAccess, suggesting = false) {
  const { api, calls } = recorder();
  const replies: Array<SandboxReply | SandboxEventMessage> = [];
  const log: SandboxLogEntry[] = [];
  const bridge = createSandboxBridge({
    extension: 'ext.hostile',
    api,
    access,
    suggesting: () => suggesting,
    send: (m) => replies.push(m),
    log: (e) => log.push(e),
  });
  const send = (method: string, args: unknown[], id = 1) =>
    bridge.receive({ v: 1, id, method, args });
  return { bridge, calls, replies, log, send };
}

const WRITE_NAMES = WRITES.map(([n]) => n);

describe('SEC-055 criterion 2: a call beyond the declared access is refused', () => {
  it('write: none refuses every write method, logs it, and calls nothing', () => {
    const h = harness({ read: 'view', write: 'none' });
    for (const [method, args] of WRITES) h.send(method, args);
    expect(h.calls).toEqual([]);
    expect(h.log.filter((l) => l.kind === 'refused').map((l) => l.method)).toEqual(WRITE_NAMES);
    for (const r of h.replies)
      expect(r).toMatchObject({ ok: false, error: { code: 'access_denied' } });
    expect(h.replies).toHaveLength(WRITES.length);
  });

  it('write: suggest refuses every write while the editor is not suggesting, and passes them while it is', () => {
    const idle = harness({ read: 'view', write: 'suggest' }, false);
    for (const [method, args] of WRITES) idle.send(method, args);
    expect(idle.calls).toEqual([]);
    expect(idle.log.map((l) => l.code)).toEqual(WRITES.map(() => 'access_denied'));
    const live = harness({ read: 'view', write: 'suggest' }, true);
    for (const [method, args] of WRITES) live.send(method, args);
    expect(live.calls).toEqual(WRITE_NAMES);
  });

  it('reads are open at every level, and a write at write: edit is forwarded (the control for the refusals)', () => {
    for (const write of ['none', 'suggest', 'edit'] as const) {
      const h = harness({ read: 'view', write });
      for (const [method, args] of VALID_READS) h.send(method, args);
      expect(h.calls, write).toEqual(VALID_READS.map(([m]) => m));
    }
    const edit = harness({ read: 'view', write: 'edit' });
    for (const [method, args] of WRITES) edit.send(method, args);
    expect(edit.calls).toEqual(WRITE_NAMES);
  });

  it('a method that is not in the table never reaches the API, whatever its name', () => {
    const names = [
      'dispose',
      'on',
      'subscribeAll',
      'secret',
      'token',
      'constructor',
      '__proto__',
      'prototype',
      'toString',
      'valueOf',
      'hasOwnProperty',
      'call',
      'then',
      'apply',
      'bind',
      'ReplaceRange',
      'replacerange',
      ' replaceRange',
      'replaceRange ',
      'replaceRange\u0000',
      'replaceRange​',
      'insert​Blocks',
      '',
      'a'.repeat(100_000),
    ];
    for (const write of ['none', 'suggest', 'edit'] as const) {
      const h = harness({ read: 'view', write }, true);
      for (const [i, m] of names.entries()) h.send(m, [RANGE, 'x'], i);
      expect(h.calls, write).toEqual([]);
      expect(h.log).toHaveLength(names.length);
      expect(new Set(h.log.map((l) => l.code))).toEqual(new Set(['unknown_method']));
    }
  });

  it('a message cannot raise the level: the access is fixed when the bridge is made', () => {
    const h = harness({ read: 'view', write: 'none' });
    // Members that try to carry a level, and methods that sound like one.
    h.bridge.receive({
      v: 1,
      id: 1,
      method: 'replaceRange',
      args: [RANGE, 'x'],
      access: { read: 'view', write: 'edit' },
    });
    h.bridge.receive({ v: 1, id: 2, method: 'setAccess', args: [{ write: 'edit' }] });
    h.bridge.receive({ v: 1, id: 3, method: 'access', args: [] });
    h.bridge.receive({ v: 1, id: 4, method: 'subscribe', args: ['__proto__'] });
    h.send('replaceRange', [RANGE, 'x'], 5);
    expect(h.calls).toEqual([]);
    expect(h.replies.filter((r) => 'ok' in r && r.ok)).toEqual([]);
  });

  it('a subscription to an event that does not exist is an error, not a handle on the API', () => {
    const h = harness({ read: 'view', write: 'none' });
    for (const e of ['constructor', 'dispose', '__proto__', 'blocks.deleted ', 'x']) {
      h.send('subscribe', [e]);
    }
    // `on` is called only for a real event name; the others fail inside the bridge.
    expect(h.calls).toEqual([]);
    expect(h.replies.every((r) => 'ok' in r && r.ok === false)).toBe(true);
  });

  it('the manifest cannot declare a level the editor does not offer', () => {
    const bad: unknown[] = [
      undefined,
      null,
      'edit',
      [],
      {},
      { read: 'view' },
      { write: 'edit' },
      { read: 'edit', write: 'edit' },
      { read: 'all', write: 'none' },
      { read: 'view', write: 'admin' },
      { read: 'view', write: 'EDIT' },
      { read: 'view', write: ['edit'] },
      { read: 'view', write: true },
      { read: ['view'], write: 'none' },
    ];
    for (const raw of bad)
      expect(parseAccess(raw), JSON.stringify(raw)).toMatchObject({ ok: false });
    expect(parseAccess({ read: 'view', write: 'edit', extra: 1 })).toEqual({
      ok: true,
      access: { read: 'view', write: 'edit' },
    });
    // The manifest is the host's own object, never the extension's: `parseAccess` reads inherited
    // members too, which is harmless there, so no assertion is made about them.
  });
});

describe('SEC-055 criterion 1: the channel carries only validated messages', () => {
  const hostile: unknown[] = [
    null,
    undefined,
    0,
    1,
    'range',
    true,
    [],
    [1, 'range', []],
    {},
    { v: 1 },
    { v: 2, id: 1, method: 'range', args: [1, 2] },
    { v: '1', id: 1, method: 'range', args: [1, 2] },
    { v: 1, id: -1, method: 'range', args: [1, 2] },
    { v: 1, id: 1.5, method: 'range', args: [1, 2] },
    { v: 1, id: Number.MAX_SAFE_INTEGER + 2, method: 'range', args: [1, 2] },
    { v: 1, id: '1', method: 'range', args: [1, 2] },
    { v: 1, id: 1, method: 5, args: [] },
    { v: 1, id: 1, method: 'range', args: 'x' },
    { v: 1, id: 1, method: 'range', args: { 0: 1, 1: 2, length: 2 } },
    { v: 1, id: 1, method: 'range', args: [1, 2], extra: true },
    { v: 1, id: 1, method: 'range', args: [1, 2], __proto__: { x: 1 }, access: 'edit' },
    // The arguments of a valid method that do not match its check.
    { v: 1, id: 1, method: 'range', args: [1] },
    { v: 1, id: 1, method: 'range', args: ['1', 2] },
    { v: 1, id: 1, method: 'range', args: [1, 2, 3] },
    { v: 1, id: 1, method: 'range', args: [1.5, 2] },
    { v: 1, id: 1, method: 'replaceRange', args: [{ id: 'r', from: 'a', to: 2 }, 'x'] },
    { v: 1, id: 1, method: 'replaceRange', args: [RANGE, 5] },
    { v: 1, id: 1, method: 'replaceRange', args: [null, 'x'] },
    { v: 1, id: 1, method: 'replaceRange', args: [[RANGE], 'x'] },
    { v: 1, id: 1, method: 'setMark', args: [RANGE, 'bold', 5] },
    { v: 1, id: 1, method: 'subscribe', args: [5] },
  ];

  it('an envelope or arguments that do not match the schema get no reply, call nothing, and are logged as ignored', () => {
    const h = harness({ read: 'view', write: 'edit' }, true);
    for (const m of hostile) h.bridge.receive(m);
    expect(h.calls).toEqual([]);
    expect(h.replies).toEqual([]);
    expect(h.log).toHaveLength(hostile.length);
    expect(new Set(h.log.map((l) => l.kind))).toEqual(new Set(['ignored']));
    expect(new Set(h.log.map((l) => l.code))).toEqual(new Set(['bad_message']));
  });

  it('parseRequest keeps exactly the four members', () => {
    expect(parseRequest({ v: 1, id: 0, method: 'range', args: [1, 2] })).toEqual({
      v: 1,
      id: 0,
      method: 'range',
      args: [1, 2],
    });
    expect(parseRequest({ v: 1, id: 0, method: 'range', args: [], x: 1 })).toBeNull();
  });

  it('a huge or deep message never throws out of the bridge', () => {
    const h = harness({ read: 'view', write: 'edit' }, true);
    let deep: unknown = 'x';
    for (let i = 0; i < 5_000; i++) deep = { a: deep };
    expect(() => {
      h.send('replaceRange', [RANGE, 'x'.repeat(5_000_000)]);
      h.bridge.receive({ v: 1, id: 2, method: 'insertBlocks', args: [RANGE, deep] });
      h.bridge.receive({ v: 1, id: 3, method: 'range', args: new Array(1_000_000).fill(1) });
    }).not.toThrow();
    // The size is not limited yet (finding 2 of the review); the calls that match the schema go through.
    expect(h.calls).toEqual(['replaceRange', 'insertBlocks']);
  });

  it('a throwing API answers failed and the bridge keeps working', () => {
    const { api } = recorder();
    (api as unknown as Record<string, unknown>)['text'] = () => {
      throw new Error('guard says no');
    };
    const replies: unknown[] = [];
    const bridge = createSandboxBridge({
      extension: 'e',
      api,
      access: { read: 'view', write: 'none' },
      suggesting: () => false,
      send: (m) => replies.push(m),
      log: () => {},
    });
    bridge.receive({ v: 1, id: 1, method: 'text', args: [RANGE] });
    bridge.receive({ v: 1, id: 2, method: 'selection', args: [] });
    expect(replies).toEqual([
      { v: 1, id: 1, ok: false, error: { code: 'failed', message: 'guard says no' } },
      { v: 1, id: 2, ok: true, result: null },
    ]);
  });

  it('after dispose the bridge ignores everything and the API is ended once', () => {
    const h = harness({ read: 'view', write: 'edit' }, true);
    h.bridge.dispose();
    h.bridge.dispose();
    h.send('replaceRange', [RANGE, 'x']);
    expect(h.calls).toEqual(['dispose']);
    expect(h.replies).toEqual([]);
  });
});

/** The part of a `MessagePort` this test uses (this project has no DOM library). */
interface Port {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

/** The mounted frame, over a stand-in document and a real `MessageChannel`. */
describe('SEC-055 criterion 1: the host gives the frame the sandbox and one private channel', () => {
  afterEach(() => vi.unstubAllGlobals());

  interface FakeIframe {
    attrs: Map<string, string>;
    listeners: Map<string, Array<() => void>>;
    posted: Array<{ message: unknown; targetOrigin: string; transfer: Port[] }>;
    removed: boolean;
    src: string;
    contentWindow: { postMessage: (m: unknown, o: string, t: Port[]) => void };
    setAttribute(k: string, v: string): void;
    addEventListener(t: string, f: () => void): void;
    remove(): void;
    focus(): void;
  }

  async function mount(access: SandboxAccess, suggesting = false) {
    const el: FakeIframe = {
      attrs: new Map(),
      listeners: new Map(),
      posted: [],
      removed: false,
      src: '',
      contentWindow: {
        postMessage: (message, targetOrigin, transfer) =>
          el.posted.push({ message, targetOrigin, transfer }),
      },
      setAttribute(k, v) {
        this.attrs.set(k, v);
      },
      addEventListener(t, f) {
        this.listeners.set(t, [...(this.listeners.get(t) ?? []), f]);
      },
      remove() {
        this.removed = true;
      },
      focus() {},
    };
    const appended: unknown[] = [];
    const windowListeners: string[] = [];
    vi.stubGlobal('document', { createElement: (tag: string) => (tag === 'iframe' ? el : null) });
    vi.stubGlobal('window', {
      addEventListener: (t: string) => windowListeners.push(t),
    });
    // A computed specifier keeps the type-check of this project (no DOM library) out of the module.
    const mod = (await import(/* @vite-ignore */ pathToFileURL(EXT + 'sandbox-frame.ts').href)) as {
      mountSandboxFrame: (o: Record<string, unknown>) => {
        ready: Promise<void>;
        dispose(): void;
      };
    };
    const { api, calls } = recorder();
    const log: SandboxLogEntry[] = [];
    const keys: unknown[] = [];
    const frame = mod.mountSandboxFrame({
      container: { append: (x: unknown) => appended.push(x) },
      frameUrl: 'https://host.example/sandbox-frame.html',
      entryUrl: 'https://ext.example/hostile.js',
      extension: 'ext.hostile',
      title: 'Hostile',
      api,
      access,
      suggesting: () => suggesting,
      log: (e: SandboxLogEntry) => log.push(e),
      onKey: (k: unknown) => keys.push(k),
    });
    for (const f of el.listeners.get('load') ?? []) f();
    await frame.ready;
    const port = el.posted[0]!.transfer[0]!;
    const inbox: unknown[] = [];
    port.onmessage = (e) => inbox.push(e.data);
    const settle = () => new Promise((r) => setTimeout(r, 150));
    return { el, frame, appended, windowListeners, calls, log, keys, port, inbox, settle };
  }

  it('sets sandbox="allow-scripts" and nothing that gives the frame the host origin or rights', async () => {
    const m = await mount({ read: 'view', write: 'none' });
    expect(m.el.attrs.get('sandbox')).toBe('allow-scripts');
    // No permission policy, no allow list: the frame is given no camera, no clipboard, no payment.
    expect(m.el.attrs.has('allow')).toBe(false);
    expect(m.el.attrs.get('referrerpolicy')).toBe('no-referrer');
    expect(m.el.src).toBe('https://host.example/sandbox-frame.html');
    expect(m.appended).toEqual([m.el]);
    m.frame.dispose();
    expect(m.el.removed).toBe(true);
  });

  it('listens on no window: the host registers no `message` listener, and the one channel is private', async () => {
    const m = await mount({ read: 'view', write: 'none' });
    expect(m.windowListeners).toEqual([]);
    expect(m.el.posted).toHaveLength(1);
    const first = m.el.posted[0]!;
    expect(first.message).toEqual({
      v: 1,
      type: 'init',
      entry: 'https://ext.example/hostile.js',
      extension: 'ext.hostile',
    });
    // One port goes to the frame's window; the host keeps the other.
    expect(first.transfer).toHaveLength(1);
    m.frame.dispose();
  });

  it('answers the extension over the channel and refuses a write beyond its level, with the API untouched', async () => {
    const m = await mount({ read: 'view', write: 'none' });
    m.port.postMessage({ v: 1, id: 7, method: 'text', args: [RANGE] });
    m.port.postMessage({ v: 1, id: 8, method: 'replaceRange', args: [RANGE, 'hack'] });
    m.port.postMessage({ v: 1, id: 9, method: 'dispose', args: [] });
    m.port.postMessage({
      v: 1,
      id: 10,
      method: 'replaceRange',
      args: [RANGE, 'x'],
      access: 'edit',
    });
    await vi.waitFor(() => expect(m.inbox).toHaveLength(3));
    expect(m.calls).toEqual(['text']);
    expect(m.inbox).toEqual([
      { v: 1, id: 7, ok: true, result: RANGE },
      {
        v: 1,
        id: 8,
        ok: false,
        error: { code: 'access_denied', message: expect.stringContaining('no write') },
      },
      { v: 1, id: 9, ok: false, error: { code: 'unknown_method', message: expect.any(String) } },
    ]);
    expect(m.log.map((l) => [l.kind, l.code])).toEqual([
      ['refused', 'access_denied'],
      ['refused', 'unknown_method'],
      ['ignored', 'bad_message'],
    ]);
    m.frame.dispose();
  });

  it('forwards only F6 and a bare Escape out of the frame; every other key is ignored and logged', async () => {
    const m = await mount({ read: 'view', write: 'none' });
    const key = (k: string, extra: Record<string, unknown> = {}) =>
      m.port.postMessage({ type: 'key', key: k, ...extra });
    key('F6');
    key('F6', { ctrlKey: true, shiftKey: true });
    key('Escape');
    key('Escape', { ctrlKey: true });
    key('Escape', { altKey: true });
    key('Tab');
    key('a');
    key('F5');
    key('Enter', { ctrlKey: true });
    m.port.postMessage({ type: 'key' });
    m.port.postMessage({ type: 'key', key: 6 });
    await vi.waitFor(() => expect(m.log).toHaveLength(8));
    expect(m.keys).toEqual([
      { key: 'F6', ctrlKey: false, shiftKey: false, altKey: false },
      { key: 'F6', ctrlKey: true, shiftKey: true, altKey: false },
      { key: 'Escape', ctrlKey: false, shiftKey: false, altKey: false },
    ]);
    expect(m.log).toHaveLength(8);
    expect(m.calls).toEqual([]);
    m.frame.dispose();
  });

  it('after dispose the channel is closed: a late request reaches nothing', async () => {
    const m = await mount({ read: 'view', write: 'edit' }, true);
    m.frame.dispose();
    m.port.postMessage({ v: 1, id: 1, method: 'replaceRange', args: [RANGE, 'late'] });
    await m.settle();
    expect(m.calls).toEqual(['dispose']);
  });
});

describe('SEC-055: source guards on the boundary', () => {
  const files = [
    ...readdirSync(EXT)
      .filter((f) => f.startsWith('sandbox-'))
      .map((f) => EXT + f),
    PANES + 'SandboxPane.svelte',
  ];

  it('no sandbox source names a token that would give the frame the host origin or rights', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
    const code = (p: string) =>
      read(p)
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
    for (const f of files)
      for (const token of [
        'allow-same-origin',
        'allow-top-navigation',
        'allow-popups',
        'allow-forms',
        'allow-modals',
        'allow-downloads',
        'allow-storage-access',
        'allow-presentation',
        'allow-pointer-lock',
        'allow-orientation-lock',
      ])
        expect(code(f), `${f} must not contain ${token}`).not.toContain(token);
    // The one setting of the attribute, and its value.
    const sets = [
      ...read(EXT + 'sandbox-frame.ts').matchAll(/setAttribute\(\s*'sandbox'\s*,\s*([^)]*)\)/g),
    ];
    expect(sets.map((s) => s[1])).toEqual(["'allow-scripts'"]);
  });

  it('the host side registers no `message` listener on a window and never uses `eval` or `Function`', () => {
    for (const name of ['sandbox-frame.ts', 'sandbox-protocol.ts', 'sandbox-extension.ts']) {
      const text = read(EXT + name);
      expect(text, name).not.toMatch(/addEventListener\(\s*['"]message['"]/);
      expect(text, name).not.toMatch(/\beval\s*\(|new Function\s*\(/);
      expect(text, name).not.toContain('innerHTML');
    }
  });

  it('the bridge reaches the editor only through the document API of UX-053', () => {
    const text = read(EXT + 'sandbox-protocol.ts');
    const imports = [...text.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
    expect(imports).toEqual(['./document-api.ts']);
  });
});
