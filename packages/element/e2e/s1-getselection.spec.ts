/**
 * Spike S1 (SPK-014): the side effect on the host page of ProseMirror's shadow-root selection
 * handling (02 §8; FE-066, FE-116, FE-117). When a shadow root has no `getSelection` method,
 * prosemirror-view 1.42.9 assigns one to `ShadowRoot.prototype` (EditorView.root); the function
 * ignores `this` and returns `document.getSelection()`. Recorded per browser in both modes:
 * `library` (ProseMirror's own behaviour) and `instance` (the component defines the method on its
 * own shadow root first, so the prototype is untouched).
 */
import { expect, test } from '@playwright/test';
import { SPIKE_IDS, openS1, record } from './helpers.ts';

interface Observation {
  before: { ownProperty: boolean; type: string };
  after: {
    prototypeOwn: boolean;
    prototypeNative: boolean | null;
    prototypeEnumerable: boolean | null;
    hostRootType: string;
    hostRootReturnsDocumentSelection: boolean | null;
    editorRootOwn: boolean;
    shim: string | null;
  };
}

for (const shim of ['library', 'instance'] as const) {
  test(`getSelection on the host page with the ${shim} shim`, async ({ page, browserName }) => {
    const h = await openS1(page, `?shim=${shim}`);
    await h.caretIn(SPIKE_IDS.after, 'end');
    await page.keyboard.type('!');
    expect(await h.nodeText(SPIKE_IDS.after)).toBe('Remote target paragraph.!');
    const seen: Observation = await page.evaluate(() => {
      const s1 = (
        window as unknown as { __s1: { before: Observation['before']; probeRoot: ShadowRoot } }
      ).__s1;
      const proto = ShadowRoot.prototype as ShadowRoot & { getSelection?: () => Selection | null };
      const desc = Object.getOwnPropertyDescriptor(proto, 'getSelection');
      const hostRoot = s1.probeRoot as ShadowRoot & { getSelection?: () => Selection | null };
      const el = document.querySelector('doc-editor') as HTMLElement & {
        spike(): Promise<unknown>;
      };
      const editorRoot = el.shadowRoot!;
      return {
        before: s1.before,
        after: {
          prototypeOwn: desc !== undefined,
          prototypeNative: desc ? /\[native code\]/.test(String(desc.value ?? desc.get)) : null,
          prototypeEnumerable: desc ? desc.enumerable === true : null,
          hostRootType: typeof hostRoot.getSelection,
          hostRootReturnsDocumentSelection:
            typeof hostRoot.getSelection === 'function'
              ? hostRoot.getSelection() === document.getSelection()
              : null,
          editorRootOwn: Object.prototype.hasOwnProperty.call(editorRoot, 'getSelection'),
          shim: null,
        },
      };
    });
    seen.after.shim = await page.evaluate(
      () =>
        (window as unknown as { h: { core: { selectionShimResult: string | null } } }).h.core
          .selectionShimResult,
    );
    record(`getselection-${shim}`, seen);

    const nativeShadowSelection = browserName === 'chromium';
    if (nativeShadowSelection) {
      // Chromium and Edge implement ShadowRoot.prototype.getSelection: nothing is patched.
      expect(seen.before.type).toBe('function');
      expect(seen.after).toMatchObject({
        prototypeOwn: true,
        prototypeNative: true,
        editorRootOwn: false,
        shim: 'native',
      });
    } else if (shim === 'library') {
      // Firefox and WebKit: ProseMirror defines the method on the prototype, for every shadow root.
      expect(seen.before).toEqual({ ownProperty: false, type: 'undefined' });
      expect(seen.after).toMatchObject({
        prototypeOwn: true,
        prototypeNative: false,
        prototypeEnumerable: true,
        hostRootType: 'function',
        hostRootReturnsDocumentSelection: true,
        editorRootOwn: false,
        shim: 'none',
      });
    } else {
      // The component's own instance method: the host page's shadow roots are untouched.
      expect(seen.before).toEqual({ ownProperty: false, type: 'undefined' });
      expect(seen.after).toMatchObject({
        prototypeOwn: false,
        hostRootType: 'undefined',
        hostRootReturnsDocumentSelection: null,
        editorRootOwn: true,
        shim: 'instance',
      });
    }
  });
}
