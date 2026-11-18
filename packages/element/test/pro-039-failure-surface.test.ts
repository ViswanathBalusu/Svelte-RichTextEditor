// PRO-039 criteria 2 to 4: a document that cannot be opened is shown with a message and one action,
// and nothing is retried by itself (05 §5.8; owner decision 45). Node.js: the view is plain data, the
// DOM and the timers are stood in for, and the session is the real one with a backend that refuses.
import { PortError, type ErrorCode } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { retryAfterMsOf } from '../src/errors.ts';
import {
  failureKind,
  failureView,
  mountFailure,
  type FailureDom,
  type FailureInfo,
  type FailureNode,
  type FailureTimers,
} from '../src/failure.ts';
import { Session } from '../src/session.ts';
import { EN } from '../src/strings.ts';
import { fakeEditor, recordingHost } from './support.ts';

/** A node that records what the surface does to it. */
class Node implements FailureNode {
  className = '';
  textContent: string | null = null;
  disabled?: boolean;
  attributes = new Map<string, string>();
  children: Node[] = [];
  removed = false;
  clicks: Array<() => void> = [];
  readonly tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  append(...children: Node[]) {
    this.children.push(...children);
  }
  addEventListener(_type: 'click', listener: () => void) {
    this.clicks.push(listener);
  }
  remove() {
    this.removed = true;
  }
  click() {
    for (const l of this.clicks) l();
  }
}

const dom: FailureDom = { createElement: (tag) => new Node(tag) };

function fakeTimers() {
  const pending: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const timers: FailureTimers = {
    setTimeout(fn, ms) {
      const t = { fn, ms, cleared: false };
      pending.push(t);
      return t;
    },
    clearTimeout(handle) {
      (handle as { cleared: boolean }).cleared = true;
    },
  };
  return { timers, pending };
}

function mount(code: ErrorCode, retryAfterMs: number | null, timers: FailureTimers) {
  const roots: Node[] = [];
  const actions: string[] = [];
  const surface = mountFailure(
    { prepend: (n) => roots.push(n as Node) },
    failureView(code, retryAfterMs),
    (id) => actions.push(id),
    dom,
    timers,
  );
  return { surface, root: roots[0] as Node, actions };
}

describe('the view of a failed load (criteria 2 to 4)', () => {
  it('shows forbidden as no access, with one action that asks for the document again', () => {
    const v = failureView('forbidden', null);
    expect(v.kind).toBe('no-access');
    expect(v.title).toBe(EN.failure.noAccessTitle);
    expect(v.message).toBe(EN.failure.noAccessMessage);
    expect(v.action).toEqual({ id: 'retry', label: EN.failure.retry, enabledAfterMs: 0 });
  });

  it.each(['unsupported_version', 'unsupported_engine', 'unsupported_cdm', 'unsupported_feature'])(
    'tells the user that the component must be updated for %s, and loads the page again',
    (code) => {
      const v = failureView(code as ErrorCode, null);
      expect(v.kind).toBe('update');
      expect(v.message).toMatch(/Update the component/);
      expect(v.action.id).toBe('reload-page');
      expect(v.action.enabledAfterMs).toBe(0);
    },
  );

  it('says how long to wait for rate_limited and quota_exceeded, and keeps the action off until then', () => {
    const wait = failureView('rate_limited', 2_500);
    expect(wait.kind).toBe('wait');
    expect(wait.message).toBe('Too many requests were sent. You can try again in 3 seconds.');
    expect(wait.action.enabledAfterMs).toBe(2_500);
    const quota = failureView('quota_exceeded', 60_000);
    expect(quota.kind).toBe('quota');
    expect(quota.title).toBe(EN.failure.quotaTitle);
    expect(quota.message).toMatch(/quota .* used up/);
    expect(quota.message).toContain('in 60 seconds');
    expect(quota.action.enabledAfterMs).toBe(60_000);
    // Without a wait from the server, no number is invented.
    expect(failureView('rate_limited', null).message).toBe(EN.failure.waitMessageUnknown);
    expect(failureView('quota_exceeded', null).message).toBe(EN.failure.quotaMessageUnknown);
    expect(failureView('rate_limited', null).action.enabledAfterMs).toBe(0);
  });

  it('shows any other fatal failure with a general message', () => {
    for (const code of ['unavailable', 'not_found', 'internal'] as const)
      expect(failureKind(code)).toBe('other');
    expect(failureView('internal', null).title).toBe(EN.failure.otherTitle);
  });

  it('reads the wait a refusal asked for', () => {
    expect(retryAfterMsOf(new PortError('rate_limited', 'x', { retryAfterMs: 1_500 }))).toBe(1_500);
    expect(retryAfterMsOf(new PortError('forbidden', 'x'))).toBeNull();
    expect(retryAfterMsOf(new Error('x'))).toBeNull();
    expect(retryAfterMsOf({ retryAfterMs: -1 })).toBeNull();
  });
});

describe('the message in the editor area', () => {
  it('is an alert with a title, a message and one button, put first in the root', () => {
    const { timers } = fakeTimers();
    const { root, surface } = mount('forbidden', null, timers);
    expect(root.className).toBe('de-failure');
    expect(root.attributes.get('role')).toBe('alert');
    expect(root.attributes.get('data-code')).toBe('forbidden');
    expect(root.children.map((c) => [c.tag, c.className])).toEqual([
      ['p', 'de-failure-title'],
      ['p', 'de-failure-message'],
      ['button', 'de-failure-action'],
    ]);
    expect(root.children[0]!.textContent).toBe(EN.failure.noAccessTitle);
    expect(root.children[2]!.attributes.get('type')).toBe('button');
    expect(surface.element).toBe(root);
  });

  it('runs the action when the button is chosen, and nothing before', () => {
    const { timers, pending } = fakeTimers();
    const { root, actions } = mount('forbidden', null, timers);
    expect(actions).toEqual([]);
    expect(pending).toHaveLength(0);
    root.children[2]!.click();
    expect(actions).toEqual(['retry']);
    const update = mount('unsupported_cdm', null, timers);
    update.root.children[2]!.click();
    expect(update.actions).toEqual(['reload-page']);
  });

  it('keeps the button disabled for the wait of a refused request, and enables it after', () => {
    const { timers, pending } = fakeTimers();
    const { root, actions } = mount('rate_limited', 4_000, timers);
    const button = root.children[2]!;
    expect(button.disabled).toBe(true);
    button.click();
    expect(actions).toEqual([]);
    expect(pending.map((t) => t.ms)).toEqual([4_000]);
    pending[0]!.fn();
    expect(button.disabled).toBe(false);
    button.click();
    expect(actions).toEqual(['retry']);
  });

  it('is taken out with its timer', () => {
    const { timers, pending } = fakeTimers();
    const { root, surface } = mount('quota_exceeded', 10_000, timers);
    surface.remove();
    expect(root.removed).toBe(true);
    expect(pending[0]!.cleared).toBe(true);
  });
});

describe('Session reports a failed load to the host (criteria 2 to 4)', () => {
  async function failWith(error: Error) {
    const editor = fakeEditor();
    const host = recordingHost(editor);
    const failures: FailureInfo[] = [];
    let opened = 0;
    const session = new Session({
      docId: 'd1',
      backend: async () => {
        opened++;
        throw error;
      },
      ownsBackend: true,
      host: { ...host, failed: (info) => failures.push(info) },
    });
    await session.start();
    return { session, host, failures, opened: () => opened };
  }

  it.each([
    ['forbidden', undefined],
    ['unsupported_version', undefined],
    ['unsupported_feature', undefined],
    ['rate_limited', 3_000],
    ['quota_exceeded', 45_000],
  ] as const)(
    '%s: de-error first, then the failure with its wait, and no second attempt',
    async (code, retryAfterMs) => {
      const error = new PortError(code, 'refused', retryAfterMs ? { retryAfterMs } : {});
      const { session, host, failures, opened } = await failWith(error);
      expect(session.phase).toBe('failed');
      expect(host.events.map((e) => e.name)).toEqual(['de-error']);
      expect((host.events[0]!.detail as { code: string; fatal: boolean }).fatal).toBe(true);
      expect(failures).toEqual([{ code, retryAfterMs: retryAfterMs ?? null }]);
      // Nothing is retried: the backend was asked for once.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(opened()).toBe(1);
    },
  );

  it('does not report a failure for the codes that ask the host for a new token', async () => {
    const { host, failures } = await failWith(new PortError('token_expired', 'old'));
    expect(host.events.map((e) => e.name)).toEqual(['de-auth-required']);
    expect(failures).toEqual([]);
  });
});
