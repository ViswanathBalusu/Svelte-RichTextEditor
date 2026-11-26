/**
 * The signature and initials fields on the body web view (FRW-046 criterion 1; lane w4): a field the
 * participant may sign is a button that says so in words, and activating it by click or by keyboard
 * asks the shell for the signing step; a signed field says "Signed"; a field of another role says
 * "Not signed" and cannot be activated. Runs through `pnpm vitest run --project browser <this file>`
 * in Chromium, Firefox and WebKit; skipped in Node.js, which has no DOM.
 */
import type { userEvent as BrowserUserEvent } from 'vitest/browser';
import { beforeAll, describe, expect, it } from 'vitest';
import { participantAccess } from '../../test/frw-fields-fixture.ts';
import {
  INITIALS_TENANT,
  SIGN_LANDLORD,
  SIGN_TENANT,
  SIGNED_TENANT,
  withSignatures,
} from '../../test/frw-046-fixture.ts';
import { EditorCore, loadFormViews } from './web.ts';

// The drawing of the fields and the forms part of the core load on first use (FND-008).
beforeAll(() => loadFormViews());

const isBrowser = typeof document !== 'undefined';
const userEvent: typeof BrowserUserEvent | undefined = isBrowser
  ? (await import('vitest/browser')).userEvent
  : undefined;

function mounted(roles: readonly string[] = ['role_tenant']) {
  const host = document.createElement('div');
  document.body.append(host);
  const core = new EditorCore({
    doc: withSignatures(),
    mode: 'fill',
    access: participantAccess(roles),
    schedule: (run) => queueMicrotask(run),
  });
  const unmount = core.mountBody(host);
  const button = (id: string): HTMLButtonElement => {
    const el = host.querySelector<HTMLButtonElement>(`[data-field="${id}"] button`);
    if (!el) throw new Error(`no button for the field ${id}`);
    return el;
  };
  return {
    core,
    host,
    button,
    user: userEvent!,
    cleanup() {
      unmount();
      core.destroy();
      host.remove();
    },
  };
}

describe.skipIf(!isBrowser)('signature and initials fields (FRW-046 criterion 1)', () => {
  it('is a button that says what it does, and a click asks for the signing step', async () => {
    const m = mounted();
    try {
      const el = m.button(SIGN_TENANT);
      expect(el.textContent).toBe('Sign signature');
      expect(el.disabled).toBe(false);
      expect(el.getAttribute('aria-label')).toBe('Tenant signature: sign signature');
      expect(m.core.signRequest.get()).toBeNull();
      await m.user.click(el);
      expect(m.core.signRequest.get()).toMatchObject({ id: SIGN_TENANT, kind: 'signature' });
      // The initials say initials.
      expect(m.button(INITIALS_TENANT).textContent).toBe('Sign initials');
    } finally {
      m.cleanup();
    }
  });

  it('is reached with Tab and activated with Enter and with Space', async () => {
    const m = mounted();
    try {
      m.button(SIGN_TENANT).focus();
      expect(document.activeElement).toBe(m.button(SIGN_TENANT));
      await m.user.keyboard('{Enter}');
      expect(m.core.signRequest.get()).toMatchObject({ n: 1, id: SIGN_TENANT });
      m.core.clearSignRequest();
      await m.user.keyboard(' ');
      expect(m.core.signRequest.get()).toMatchObject({ n: 2, id: SIGN_TENANT });
    } finally {
      m.cleanup();
    }
  });

  it('says "Signed" for a signed field and "Not signed" for a field of another role, in words', async () => {
    const m = mounted();
    try {
      const signed = m.button(SIGNED_TENANT);
      expect(signed.textContent).toBe('Signed');
      expect(signed.disabled).toBe(true);
      expect(
        m.host.querySelector(`[data-field="${SIGNED_TENANT}"]`)?.hasAttribute('data-signed'),
      ).toBe(true);
      const other = m.button(SIGN_LANDLORD);
      expect(other.textContent).toBe('Not signed (another signer)');
      expect(other.disabled).toBe(true);
      other.click();
      expect(m.core.signRequest.get()).toBeNull();
    } finally {
      m.cleanup();
    }
  });

  it('is not offered to a participant who holds no role', () => {
    const m = mounted([]);
    try {
      expect(m.button(SIGN_TENANT).disabled).toBe(true);
    } finally {
      m.cleanup();
    }
  });
});
