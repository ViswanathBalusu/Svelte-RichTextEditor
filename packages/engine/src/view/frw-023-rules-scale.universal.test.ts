/**
 * Keystroke to paint at the limits of 12 §5.1 (FRW-023 criterion 6; lane w4), in a real browser: a
 * document of 2,000 fields and 500 rules is mounted in the editor, a person types in a field, and the
 * time from the keystroke to the page being laid out again is taken. The rules that read the field
 * are evaluated and no others (`test/frw-023.incremental-rules.test.ts`).
 *
 * The figure is a measurement on the machine and browser that ran it, not on the reference machine
 * of 11 §5, and not a gate: the test fails only when the page is wrong. It prints one line, which the
 * story's Evidence quotes. Runs through `pnpm exec vitest run --project browser <this file>`; the
 * suite is skipped in Node.js, which has no DOM.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { participantAccess } from '../../test/frw-fields-fixture.ts';
import { scaleDocument, scaleId } from '../../test/frw-023-scale-fixture.ts';
import { loadParts } from '../parts.ts';
import { EditorCore, loadFormViews } from './web.ts';

// The drawing of the fields, the forms part and the rules language load on first use (FND-008).
beforeAll(() => Promise.all([loadFormViews(), loadParts(['authoring', 'rules'])]));

const isBrowser = typeof document !== 'undefined';

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

describe.skipIf(!isBrowser)(
  'typing in a document at the limits of the rules (FRW-023 criterion 6)',
  () => {
    it('shows and hides the field a rule names, and takes a measured time from the keystroke to layout', async () => {
      const host = document.createElement('div');
      document.body.append(host);
      const core = new EditorCore({
        doc: scaleDocument(),
        access: participantAccess(['role_tenant']),
        mode: 'fill',
        schedule: (run) => queueMicrotask(run),
      });
      const unmount = core.mountBody(host);
      const box = (id: string): HTMLElement =>
        host.querySelector<HTMLElement>(`[data-field="${id}"]`)!;
      try {
        expect(host.querySelectorAll('[data-field]').length).toBeGreaterThanOrEqual(2000);
        const shown = (id: string): boolean => getComputedStyle(box(id)).display !== 'none';

        // The first evaluation compiles the 500 rules; the keystrokes that follow do not.
        core.enterFieldValue(scaleId(0), 'show');
        void host.getBoundingClientRect();

        const sync: number[] = [];
        const frame: number[] = [];
        for (let n = 1; n <= 41; n++) {
          const hide = n % 2 === 1;
          const start = performance.now();
          core.enterFieldValue(scaleId(n), hide ? 'hide' : 'show');
          // A read of the layout forces the style and layout work the keystroke caused.
          void host.getBoundingClientRect();
          void box(scaleId(1000 + n)).offsetHeight;
          sync.push(performance.now() - start);
          expect(shown(scaleId(1000 + n)), `field ${n}`).toBe(!hide);
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => {
              frame.push(performance.now() - start);
              resolve();
            }),
          );
        }
        // The reported figures: the median of 41 keystrokes after a warm-up.
        const note = `FRW-023 criterion 6: 2000 fields, 500 rules, ${navigator.userAgent}: keystroke to layout median ${median(sync).toFixed(1)} ms, max ${Math.max(...sync).toFixed(1)} ms; to the next animation frame median ${median(frame).toFixed(1)} ms`;
        console.log(note);
        expect(sync.length).toBe(41);
      } finally {
        unmount();
        core.destroy();
        host.remove();
      }
    }, 120_000);
  },
);
