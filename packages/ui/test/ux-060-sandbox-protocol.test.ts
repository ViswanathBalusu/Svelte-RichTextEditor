/**
 * UX-060: the host side of a sandboxed extension's messages (criteria 2, 3 and 4). The bridge is
 * plain TypeScript, so it is tested here with a recording stand-in for the document API of
 * UX-053. The frame, the isolation and the keyboard are in e2e/ux-060-sandbox-frame.spec.ts.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type {
  ExtEventMap,
  ExtEventName,
  ExtensionDocumentApi,
} from '../src/extensions/document-api.ts';
import {
  createSandboxBridge,
  parseAccess,
  parseRequest,
  type SandboxAccess,
  type SandboxEventMessage,
  type SandboxLogEntry,
  type SandboxReply,
} from '../src/extensions/sandbox-protocol.ts';

const RANGE = { id: 'r1', from: 1, to: 4 };

function fixture(access: SandboxAccess, suggesting = false) {
  const calls: Array<[string, unknown[]]> = [];
  const handlers = new Map<string, (e: unknown) => void>();
  let disposed = 0;
  const record =
    (name: string, result: unknown = null) =>
    (...args: unknown[]) => {
      calls.push([name, args]);
      return result;
    };
  const api = {
    range: record('range', RANGE),
    selection: record('selection', RANGE),
    current: record('current', { from: 1, to: 4, stale: false, detached: false }),
    release: record('release'),
    blocks: record('blocks', []),
    text: record('text', 'abc'),
    marks: record('marks', []),
    comments: record('comments', []),
    suggestions: record('suggestions', []),
    insertBlocks: record('insertBlocks', { ok: true }),
    replaceRange: record('replaceRange', {
      ok: false,
      reason: 'permission_denied',
      message: 'not here',
    }),
    deleteRange: record('deleteRange', { ok: true }),
    setMark: record('setMark', { ok: true }),
    insertExtensionBlock: record('insertExtensionBlock', { ok: true, id: 'b1' }),
    updateExtensionBlock: record('updateExtensionBlock', { ok: true, id: 'b1' }),
    on<E extends ExtEventName>(event: E, handler: (e: ExtEventMap[E]) => void) {
      handlers.set(event, handler as (e: unknown) => void);
      return () => handlers.delete(event);
    },
    dispose() {
      disposed += 1;
    },
  } as unknown as ExtensionDocumentApi;
  const sent: Array<SandboxReply | SandboxEventMessage> = [];
  const log: SandboxLogEntry[] = [];
  const bridge = createSandboxBridge({
    extension: 'ext.test',
    api,
    access,
    suggesting: () => suggesting,
    send: (m) => sent.push(m),
    log: (e) => log.push(e),
  });
  const ask = (id: number, method: string, ...args: unknown[]) =>
    bridge.receive({ v: 1, id, method, args });
  return { bridge, calls, sent, log, handlers, ask, disposed: () => disposed };
}

describe('UX-060 the bridge answers within the declared access', () => {
  it('forwards reads with every access, and returns the API result', () => {
    for (const write of ['none', 'suggest', 'edit'] as const) {
      const f = fixture({ read: 'view', write });
      f.ask(1, 'text', RANGE);
      f.ask(2, 'range', 1, 4);
      expect(f.sent).toEqual([
        { v: 1, id: 1, ok: true, result: 'abc' },
        { v: 1, id: 2, ok: true, result: RANGE },
      ]);
      expect(f.log).toEqual([]);
    }
  });

  it('refuses every write of an extension that declared none, logs it and calls nothing', () => {
    const f = fixture({ read: 'view', write: 'none' });
    f.ask(1, 'replaceRange', RANGE, 'x');
    f.ask(2, 'deleteRange', RANGE);
    f.ask(3, 'insertBlocks', RANGE, { cdm: 1 });
    f.ask(4, 'setMark', RANGE, 'bold');
    f.ask(5, 'insertExtensionBlock', RANGE, { extension: 'ext.test', payload: {} });
    f.ask(6, 'updateExtensionBlock', 'b1', { payload: 1 });
    expect(f.calls).toEqual([]);
    expect(f.sent.map((m) => (m as { error?: { code: string } }).error?.code)).toEqual(
      Array(6).fill('access_denied'),
    );
    expect(f.log).toHaveLength(6);
    expect(f.log.every((e) => e.kind === 'refused' && e.code === 'access_denied')).toBe(true);
    expect(f.log[0]).toMatchObject({ extension: 'ext.test', method: 'replaceRange' });
  });

  it('lets an extension that may only suggest write while the editor is suggesting, and not otherwise', () => {
    const direct = fixture({ read: 'view', write: 'suggest' }, false);
    direct.ask(1, 'replaceRange', RANGE, 'x');
    expect(direct.calls).toEqual([]);
    expect(direct.sent[0]).toMatchObject({ ok: false, error: { code: 'access_denied' } });
    expect(direct.log[0]).toMatchObject({ kind: 'refused', method: 'replaceRange' });

    const suggesting = fixture({ read: 'view', write: 'suggest' }, true);
    suggesting.ask(1, 'replaceRange', RANGE, 'x');
    expect(suggesting.calls).toEqual([['replaceRange', [RANGE, 'x']]]);
  });

  it('forwards the writes of an extension with edit access to the same API, and passes the guards’ refusal through', () => {
    const f = fixture({ read: 'view', write: 'edit' });
    f.ask(1, 'replaceRange', RANGE, 'x');
    f.ask(2, 'setMark', RANGE, 'bold', { weight: 700 });
    f.ask(3, 'setMark', RANGE, 'italic');
    f.ask(4, 'insertExtensionBlock', RANGE, { extension: 'ext.test', payload: {} });
    expect(f.calls.map((c) => c[0])).toEqual([
      'replaceRange',
      'setMark',
      'setMark',
      'insertExtensionBlock',
    ]);
    // The API's own refusal (a scope the user may not edit) is the result the extension sees.
    expect(f.sent[0]).toEqual({
      v: 1,
      id: 1,
      ok: true,
      result: { ok: false, reason: 'permission_denied', message: 'not here' },
    });
    expect(f.log).toEqual([]);
  });

  it('refuses a method that is not in the table, whatever its name', () => {
    const f = fixture({ read: 'view', write: 'edit' });
    for (const [i, name] of [
      'dispose',
      'on',
      'constructor',
      '__proto__',
      'toString',
      'nope',
    ].entries())
      f.ask(i, name);
    expect(f.calls).toEqual([]);
    expect(f.disposed()).toBe(0);
    expect(
      f.sent.every((m) => (m as { error?: { code: string } }).error?.code === 'unknown_method'),
    ).toBe(true);
    expect(f.log).toHaveLength(6);
  });

  it('turns a throw of the API into a failed reply and keeps going', () => {
    const f = fixture({ read: 'view', write: 'edit' });
    const throwing = createSandboxBridge({
      extension: 'ext.test',
      api: {
        range() {
          throw new RangeError('outside the document');
        },
        dispose() {},
      } as unknown as ExtensionDocumentApi,
      access: { read: 'view', write: 'none' },
      suggesting: () => false,
      send: (m) => f.sent.push(m),
      log: () => {},
    });
    throwing.receive({ v: 1, id: 9, method: 'range', args: [0, 99] });
    expect(f.sent[0]).toEqual({
      v: 1,
      id: 9,
      ok: false,
      error: { code: 'failed', message: 'outside the document' },
    });
  });
});

describe('UX-060 messages that do not match the schema are ignored', () => {
  const bad: unknown[] = [
    null,
    undefined,
    'text',
    42,
    [],
    {},
    { v: 2, id: 1, method: 'text', args: [RANGE] },
    { v: 1, id: -1, method: 'text', args: [RANGE] },
    { v: 1, id: 1.5, method: 'text', args: [RANGE] },
    { v: 1, id: '1', method: 'text', args: [RANGE] },
    { v: 1, id: 1, method: 7, args: [] },
    { v: 1, id: 1, method: 'text', args: 'x' },
    { v: 1, id: 1, method: 'text', args: [RANGE], extra: true },
    { v: 1, id: 1, method: 'text', args: [] },
    { v: 1, id: 1, method: 'text', args: [{ id: 'r', from: 'a', to: 2 }] },
    { v: 1, id: 1, method: 'text', args: [RANGE, RANGE] },
    { v: 1, id: 1, method: 'replaceRange', args: [RANGE, 5] },
    { v: 1, id: 1, method: 'range', args: [1.5, 2] },
  ];

  it('gives no reply and calls nothing, and logs each one as ignored', () => {
    const f = fixture({ read: 'view', write: 'edit' });
    for (const m of bad) f.bridge.receive(m);
    expect(f.sent).toEqual([]);
    expect(f.calls).toEqual([]);
    expect(f.log).toHaveLength(bad.length);
    expect(f.log.every((e) => e.kind === 'ignored' && e.code === 'bad_message')).toBe(true);
  });

  it('never throws and never calls a write for an extension without write access (property)', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const f = fixture({ read: 'view', write: 'none' });
        f.bridge.receive(value);
        expect(
          f.calls.filter(
            ([n]) =>
              ![
                'range',
                'selection',
                'current',
                'release',
                'blocks',
                'text',
                'marks',
                'comments',
                'suggestions',
              ].includes(n),
          ),
        ).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });

  it('reads an envelope only with exactly its four members', () => {
    expect(parseRequest({ v: 1, id: 0, method: 'text', args: [] })).toEqual({
      v: 1,
      id: 0,
      method: 'text',
      args: [],
    });
    expect(parseRequest({ v: 1, id: 0, method: 'text', args: [], x: 1 })).toBeNull();
  });
});

describe('UX-060 events and the end of the extension', () => {
  it('delivers an event once subscribed, stops on unsubscribe, and ends everything on dispose', () => {
    const f = fixture({ read: 'view', write: 'none' });
    f.ask(1, 'subscribe', 'blocks.changed');
    f.handlers.get('blocks.changed')?.({ seq: 3, origin: 'remote', ids: ['a'] });
    expect(f.sent).toEqual([
      { v: 1, id: 1, ok: true, result: null },
      {
        v: 1,
        type: 'event',
        event: 'blocks.changed',
        payload: { seq: 3, origin: 'remote', ids: ['a'] },
      },
    ]);
    f.ask(2, 'subscribe', 'not.an.event');
    expect(f.sent[2]).toMatchObject({ ok: false, error: { code: 'failed' } });
    f.ask(3, 'unsubscribe', 'blocks.changed');
    expect(f.handlers.has('blocks.changed')).toBe(false);
    f.ask(4, 'subscribe', 'selection.changed');
    f.bridge.dispose();
    expect(f.handlers.size).toBe(0);
    expect(f.disposed()).toBe(1);
    const before = f.sent.length;
    f.ask(5, 'text', RANGE);
    expect(f.sent.length).toBe(before);
    f.bridge.dispose();
    expect(f.disposed()).toBe(1);
  });
});

describe('UX-060 the access a manifest declares', () => {
  it('accepts the levels of ADR 0393 and refuses any other', () => {
    expect(parseAccess({ read: 'view', write: 'none' })).toEqual({
      ok: true,
      access: { read: 'view', write: 'none' },
    });
    for (const write of ['suggest', 'edit'])
      expect(parseAccess({ read: 'view', write })).toMatchObject({ ok: true });
    for (const bad of [
      undefined,
      null,
      'edit',
      {},
      { read: 'view' },
      { read: 'edit', write: 'none' },
      { read: 'view', write: 'admin' },
    ])
      expect(parseAccess(bad).ok).toBe(false);
  });
});
