/**
 * The state of a signature or initials field is told in words and a mark, not by colour alone
 * (FRW-048 criterion 4; lane w4). The four states are signed, to sign and required, to sign, and not
 * signed for another signer (and a field no one may sign). In the browser, without forced colours, the
 * words and the line style are checked in Chromium, Firefox and WebKit. Under `forced-colors: active`
 * (a Playwright context option, which Vitest's browser mode does not set by itself) the same fields
 * use system colours; that part is skipped unless forced colours are active, and runs with
 *   pnpm vitest run --config tests/w4-FRW-048/vitest.forced-colors.config.ts
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { participantAccess } from '../../test/frw-fields-fixture.ts';
import {
  INITIALS_TENANT,
  SIGN_LANDLORD,
  SIGN_READONLY,
  SIGN_TENANT,
  SIGNED_TENANT,
  withSignatures,
} from '../../test/frw-046-fixture.ts';
import { EditorCore, loadFormViews } from './web.ts';
import elementCss from '../../../element/src/styles/element.css?raw';

beforeAll(() => loadFormViews());

const isBrowser = typeof document !== 'undefined';
const forced = isBrowser && window.matchMedia('(forced-colors: active)').matches;
const REQUIRED = 'fSignRequired001';

function mounted() {
  const style = document.createElement('style');
  style.textContent = elementCss;
  document.head.append(style);
  const envelope = withSignatures() as unknown as {
    doc: { content: Array<{ type: string; content: Array<Record<string, unknown>> }> };
  };
  const paragraph = envelope.doc.content
    .find((n) => n.type === 'body')!
    .content.find(
      (n) => (n['attrs'] as { id?: string } | undefined)?.id === 'pSignatures00001',
    ) as {
    content: Array<Record<string, unknown>>;
  };
  paragraph.content.push({
    type: 'form_field',
    attrs: {
      id: REQUIRED,
      key: 'tenant.second',
      kind: 'signature',
      label: 'Second signature',
      assignee: 'role_tenant',
      value: null,
      required: true,
    },
  });
  const host = document.createElement('div');
  document.body.append(host);
  const core = new EditorCore({
    doc: envelope as unknown as ReturnType<typeof withSignatures>,
    mode: 'fill',
    access: participantAccess(['role_tenant']),
    schedule: (run) => queueMicrotask(run),
  });
  const unmount = core.mountBody(host);
  const button = (id: string): HTMLButtonElement => {
    const el = host.querySelector<HTMLButtonElement>(`[data-field="${id}"] button`);
    if (!el) throw new Error(`no button for the field ${id}`);
    return el;
  };
  return {
    button,
    host,
    cleanup() {
      unmount();
      core.destroy();
      host.remove();
      style.remove();
    },
  };
}

describe.skipIf(!isBrowser)(
  'the state of a signature field is told in words (FRW-048 criterion 4)',
  () => {
    it('says signed, to sign, required, another signer and not signable in the text of the button', () => {
      const m = mounted();
      try {
        expect(m.button(SIGNED_TENANT).textContent).toBe('Signed');
        expect(m.button(SIGN_TENANT).textContent).toBe('Sign signature');
        expect(m.button(INITIALS_TENANT).textContent).toBe('Sign initials');
        expect(m.button(REQUIRED).textContent).toBe('Sign signature (required)');
        expect(m.button(REQUIRED).getAttribute('aria-label')).toBe(
          'Second signature: sign signature (required)',
        );
        expect(m.button(SIGN_LANDLORD).textContent).toBe('Not signed (another signer)');
        expect(m.button(SIGN_READONLY).textContent).toBe('Not signed');
        const states = [SIGNED_TENANT, SIGN_TENANT, REQUIRED, SIGN_LANDLORD, SIGN_READONLY].map(
          (id) => m.button(id).getAttribute('data-state'),
        );
        expect(states).toEqual(['signed', 'open', 'open', 'other', 'closed']);
        // A required field that is signed no longer asks for a signature.
        const required = (id: string) => m.host.querySelector(`[data-field="${id}"]`)!;
        expect(required(REQUIRED).hasAttribute('data-required')).toBe(true);
        expect(required(SIGNED_TENANT).hasAttribute('data-required')).toBe(false);
      } finally {
        m.cleanup();
      }
    });

    it('repeats the state with a line style and a tick, so a state is not told by colour alone', () => {
      const m = mounted();
      try {
        const style = (id: string) => getComputedStyle(m.button(id));
        expect(style(SIGN_TENANT).borderTopStyle).toBe('dashed');
        expect(style(SIGNED_TENANT).borderTopStyle).toBe('solid');
        expect(style(SIGN_LANDLORD).borderTopStyle).toBe('dotted');
        expect(getComputedStyle(m.button(SIGNED_TENANT), '::before').content).toContain('✓');
        expect(getComputedStyle(m.button(SIGN_TENANT), '::before').content).not.toContain('✓');
      } finally {
        m.cleanup();
      }
    });
  },
);

describe.skipIf(!forced)('the signature fields under forced colours (FRW-048 criterion 4)', () => {
  it('use system colours and keep the line styles and words', () => {
    const m = mounted();
    try {
      const open = getComputedStyle(m.button(SIGN_TENANT));
      const other = getComputedStyle(m.button(SIGN_LANDLORD));
      // A system palette: the colours are the engine's own, not the document's, and the border is
      // visible with the style that tells the state.
      expect(open.borderTopStyle).toBe('dashed');
      expect(open.borderTopWidth).toBe('1px');
      expect(other.borderTopStyle).toBe('dotted');
      expect(open.borderTopColor).not.toBe('rgba(0, 0, 0, 0)');
      expect(open.color).toBe(open.borderTopColor);
      // The disabled button is drawn with the system's grey, which is not the colour of the enabled one.
      expect(other.color).not.toBe(open.color);
      expect(m.button(SIGN_LANDLORD).textContent).toBe('Not signed (another signer)');
    } finally {
      m.cleanup();
    }
  });
});
