/**
 * The visual field of the math editor, MathLive (FE-070). This module is loaded on demand by
 * `math-editor.ts` and by nothing else, so MathLive and the global custom elements it registers
 * (`math-field`, `math-span`, `math-div`) arrive with the first use of the editor.
 *
 * - MathLive's markup goes through `MathfieldElement.createHTML`, which is pointed at the
 *   component's Trusted Types policy (`docedit-math`; trusted-types.ts).
 * - The virtual keyboard and the menus are switched off: their markup is written by ten
 *   `innerHTML` assignments that bypass `createHTML` and would raise Trusted Types violations
 *   (spike S2 report, section on MathLive). The person types, or uses the LaTeX source field.
 * - Sounds are not loaded. Fonts come from the host's directory when it gave one.
 * - Escape is taken before MathLive sees it, so that it closes the dialog from inside the field.
 */
import type { MathFieldHandle, MathFieldOptions } from '@docedit/ui';
import { on } from 'svelte/events';
import { mathEditorHTML } from './trusted-types.ts';

/**
 * The part of MathLive's API used here. TypeScript resolves `mathlive` with the `node` condition to
 * its server-side typings, which lack the element, so the shape is declared locally.
 */
interface MathfieldLike extends HTMLElement {
  value: string;
  readOnly: boolean;
  menuItems: readonly unknown[];
  mathVirtualKeyboardPolicy: string;
}

interface MathfieldConstructor {
  new (): MathfieldLike;
  fontsDirectory: string | null;
  soundsDirectory: string | null;
  createHTML: (html: string) => unknown;
}

export interface MathFieldEnvironment {
  /** The directory (with or without a trailing slash) of the font files; null leaves MathLive's own. */
  fontsUrl: string | null;
}

export async function mountMathField(
  container: HTMLElement,
  options: MathFieldOptions,
  environment: MathFieldEnvironment,
): Promise<MathFieldHandle> {
  const { MathfieldElement } = (await import('mathlive')) as unknown as {
    MathfieldElement: MathfieldConstructor;
  };
  MathfieldElement.fontsDirectory = environment.fontsUrl
    ? environment.fontsUrl.replace(/\/+$/, '')
    : null;
  MathfieldElement.soundsDirectory = null;
  MathfieldElement.createHTML = (html: string) => mathEditorHTML(html);
  const field = new MathfieldElement();
  field.setAttribute('aria-label', options.label);
  field.value = options.latex;
  const stops = [on(field, 'input', () => options.onInput(field.value))];
  // Capture phase on the host: it runs before MathLive's own handler inside its shadow root.
  stops.push(
    on(
      field,
      'keydown',
      (event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        options.onEscape();
      },
      { capture: true },
    ),
  );
  container.append(field);
  await customElements.whenDefined('math-field');
  // These need the field to be mounted, which appending it does.
  field.mathVirtualKeyboardPolicy = 'manual';
  field.menuItems = [];
  field.readOnly = options.readOnly;
  return {
    get value() {
      return field.value;
    },
    setValue(latex) {
      field.value = latex;
    },
    focus() {
      field.focus();
    },
    destroy() {
      for (const stop of stops) stop();
      field.remove();
    },
  };
}
