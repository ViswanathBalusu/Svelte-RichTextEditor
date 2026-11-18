/**
 * UX-060 criterion 4: a write from a sandboxed extension passes through the same guards as typing,
 * as the current user. The bridge of `@docedit/ui` (the host side of the frame's messages) is put
 * in front of a real `DocumentCore`, the headless one of the engine, with the document API a tier 1
 * extension gets (`core.extensionApi`, UX-053). Messages are the ones the frame sends over its
 * channel. No stand-in sits between the bridge and the engine.
 */
import type { Access, Capability } from '@docedit/protocol';
import { DocumentCore, type CoreConfig, type ExtensionDocumentApi } from '@docedit/engine/headless';
import { SPIKE_IDS, internals, spikeDocument } from '@docedit/engine/testing';
import {
  createSandboxBridge,
  type SandboxAccess,
  type SandboxLogEntry,
} from '@docedit/ui/sandbox-protocol';
import { describe, expect, it } from 'vitest';

const EDIT = ['view', 'comment', 'suggest', 'edit'] as const;
const READ = ['view', 'comment'] as const;

function access(
  docRole: Access['docRole'],
  body: readonly Capability[],
  region: readonly Capability[],
): Access {
  return {
    rev: 1,
    asOfSeq: 0,
    docRole,
    caps: [...(body.includes('edit') ? EDIT : READ)],
    scopes: {
      doc: ['view'],
      body: [...body],
      defs: ['view'],
      [`story:${SPIKE_IDS.header}`]: ['view'],
      [`region:${SPIKE_IDS.region}`]: [...region],
    },
    leases: {},
    fill: null,
    restrictions: [],
  };
}

interface Reply {
  readonly id: number;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

function setup(level: SandboxAccess['write'], config: Partial<CoreConfig> = {}) {
  const core = new DocumentCore({
    doc: spikeDocument(),
    schedule: (run) => queueMicrotask(run),
    ...config,
  });
  const api: ExtensionDocumentApi = core.extensionApi({ maxRanges: 16 });
  const replies: Reply[] = [];
  const log: SandboxLogEntry[] = [];
  const bridge = createSandboxBridge({
    extension: 'ext.sandboxed',
    api,
    access: { read: 'view', write: level },
    suggesting: () => config.mode === 'review',
    send: (m) => {
      if ('id' in m) replies.push(m as Reply);
    },
    log: (e) => log.push(e),
  });
  let next = 1;
  /** One request from the frame; returns its reply. */
  const ask = (method: string, ...args: unknown[]): Reply => {
    const id = next++;
    bridge.receive({ v: 1, id, method, args });
    const reply = replies.find((r) => r.id === id);
    if (!reply) throw new Error(`no reply to ${method}`);
    return reply;
  };
  const state = () => internals(core).state;
  /** The start of the content of the paragraph with the given identifier. */
  const startOf = (id: string): number => {
    let found = -1;
    state().doc.descendants((node, pos) => {
      if (found < 0 && node.attrs['id'] === id) found = pos + 1;
      return found < 0;
    });
    if (found < 0) throw new Error(`no node ${id}`);
    return found;
  };
  const textOf = (id: string): string => state().doc.nodeAt(startOf(id) - 1)!.textContent;
  const rangeAt = (from: number, to: number) =>
    ask('range', from, to).result as { id: string; from: number; to: number };
  return { core, bridge, ask, log, state, startOf, textOf, rangeAt };
}

describe('UX-060 criterion 4: sandboxed writes meet the guards of typing', () => {
  it('writes where the user may edit, as typing would', () => {
    const t = setup('edit', { access: access('editor', EDIT, READ) });
    const from = t.startOf(SPIKE_IDS.intro);
    const before = t.textOf(SPIKE_IDS.intro);
    const reply = t.ask('replaceRange', t.rangeAt(from, from + 3), 'Zed');
    expect(reply).toMatchObject({ ok: true, result: { ok: true } });
    expect(t.textOf(SPIKE_IDS.intro)).toBe('Zed' + before.slice(3));
    expect(t.log).toEqual([]);
    t.core.destroy();
  });

  it('refuses a write in a scope the user may only read, changes nothing and returns permission_denied', () => {
    const t = setup('edit', { access: access('editor', EDIT, READ) });
    const from = t.startOf(SPIKE_IDS.legal);
    const before = t.state().doc;
    const range = t.rangeAt(from, from + 2);
    for (const [method, args] of [
      ['replaceRange', [range, 'zz']],
      ['deleteRange', [range]],
      ['setMark', [range, 'bold', { value: true }]],
    ] as const) {
      expect(t.ask(method, ...args)).toMatchObject({
        ok: true,
        result: { ok: false, reason: 'permission_denied' },
      });
    }
    expect(t.state().doc).toBe(before);
    t.core.destroy();
  });

  it('is as the current user: the same extension is refused for a user who may edit only the region', () => {
    const t = setup('edit', { access: access('commenter', READ, EDIT) });
    const intro = t.startOf(SPIKE_IDS.intro);
    const legal = t.startOf(SPIKE_IDS.legal);
    expect(t.ask('replaceRange', t.rangeAt(intro, intro + 2), 'no').result).toMatchObject({
      ok: false,
      reason: 'permission_denied',
    });
    expect(t.ask('replaceRange', t.rangeAt(legal, legal + 2), 'ok').result).toEqual({ ok: true });
    t.core.destroy();
  });

  it('refuses every write in a locked document', () => {
    const t = setup('edit', { access: access('editor', EDIT, READ) });
    t.core.setMode('view');
    const from = t.startOf(SPIKE_IDS.intro);
    const before = t.state().doc;
    expect(t.ask('replaceRange', t.rangeAt(from, from + 2), 'x').result).toMatchObject({
      ok: false,
      reason: 'permission_denied',
    });
    expect(t.state().doc).toBe(before);
    t.core.destroy();
  });

  it('records a write as a suggestion in suggestion mode and leaves the text in place', () => {
    const t = setup('suggest', {
      access: access('editor', EDIT, READ),
      user: 'writer',
      mode: 'review',
    });
    const from = t.startOf(SPIKE_IDS.intro);
    const original = t.textOf(SPIKE_IDS.intro);
    const reply = t.ask('replaceRange', t.rangeAt(from, from + 5), 'Hello');
    expect(reply).toMatchObject({ ok: true, result: { ok: true } });
    const runs = t.ask('marks', t.rangeAt(from, from + 40)).result as Array<{
      marks: Array<{ type: string }>;
    }>;
    expect(runs.flatMap((r) => r.marks.map((m) => m.type))).toEqual(
      expect.arrayContaining(['ins', 'del']),
    );
    expect(t.textOf(SPIKE_IDS.intro)).toContain(original.slice(0, 5));
    t.core.destroy();
  });

  it('a suggest-only extension is refused by the bridge when the editor is not suggesting', () => {
    const t = setup('suggest', { access: access('editor', EDIT, READ) });
    const from = t.startOf(SPIKE_IDS.intro);
    const before = t.state().doc;
    expect(t.ask('replaceRange', t.rangeAt(from, from + 2), 'x')).toMatchObject({
      ok: false,
      error: { code: 'access_denied' },
    });
    expect(t.state().doc).toBe(before);
    expect(t.log.map((e) => e.kind)).toEqual(['refused']);
    t.core.destroy();
  });

  it('a stale range is refused as a conflict, as for a tier 1 extension', () => {
    const t = setup('edit', { access: access('editor', EDIT, READ) });
    const from = t.startOf(SPIKE_IDS.intro);
    const range = t.rangeAt(from, from + 3);
    expect(t.ask('replaceRange', range, 'one').result).toEqual({ ok: true });
    expect(t.ask('replaceRange', range, 'two').result).toMatchObject({
      ok: false,
      reason: 'conflict',
    });
    t.core.destroy();
  });
});
