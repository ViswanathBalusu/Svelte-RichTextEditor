/**
 * The shell's math editor port over the core (FE-070; ui `MathEditorService`): the equation the
 * person selected, the request to open the editor, the right to change an equation, the limits of a
 * source, and its confirmation. The visual field is MathLive, a third-party piece that registers
 * the global custom elements `math-field`, `math-span` and `math-div`; `mount` loads it with a
 * dynamic `import()` of `math-field.ts`, so nothing registers them before the editor is first
 * needed (02 §2; FE-002 criterion 5).
 */
import type { EditorCore } from '@docedit/engine';
import type {
  EquationOutcome,
  EquationRef,
  MathEditorService,
  MathFieldHandle,
  MathFieldOptions,
} from '@docedit/ui';
import type * as MathFieldModule from './math-field.ts';

type MathField = typeof MathFieldModule;

export interface MathEditorOptions {
  /** The directory the host serves the math fonts from (`config.katexFontsUrl`); absent, none is set. */
  fontsUrl?: string | null | undefined;
  /** The module loader; a test gives its own. */
  load?: () => Promise<MathField>;
  /**
   * The math gate (EXP-049): null when the source passes, else the reason. The default is
   * `mathGateReason` of `@docedit/export-latex`, the function the authority and the converter use,
   * loaded on first use so that KaTeX's parser is not part of the first load. A test gives its own.
   */
  gate?: (latex: string, display: boolean) => string | null | Promise<string | null>;
}

const sharedGate = async (latex: string, display: boolean): Promise<string | null> =>
  (await import('@docedit/export-latex/math/gate')).mathGateReason(latex, display);

const KNOWN: ReadonlySet<string> = new Set(['too-long', 'too-deep', 'read-only', 'suggestion']);

export function mathEditorService(
  core: EditorCore,
  options: MathEditorOptions = {},
): MathEditorService {
  const load = options.load ?? (() => import('./math-field.ts'));
  const gate = options.gate ?? sharedGate;
  let last: EquationRef | null = null;
  let lastKey = 'null';
  const selected = (): EquationRef | null => {
    const now = core.selectedEquation();
    const key = JSON.stringify(now);
    if (key !== lastKey) {
      lastKey = key;
      last = now;
    }
    return last;
  };
  return {
    request: core.equationRequest,
    selected: { get: selected, subscribe: (listener) => core.revision.subscribe(listener) },
    edit: () => core.requestEquationEdit(),
    select: (pos) => core.selectEquation(pos),
    access: (pos) => core.equationAccess(pos),
    limits: core.equationLimits,
    check: (latex) => core.checkEquationSource(latex),
    async confirm(pos, latex): Promise<EquationOutcome> {
      // The shared gate runs before the request leaves: the editor refuses what the authority would.
      const refusal = await gate(latex, core.selectedEquation()?.display ?? false);
      if (refusal !== null) return { ok: false, reason: 'rejected', message: refusal };
      const answer = await core.confirmEquation(pos, latex);
      if (answer.ok) return answer;
      if (answer.reason === 'rejected')
        return {
          ok: false,
          reason: 'rejected',
          ...(answer.message === undefined ? {} : { message: answer.message }),
        };
      return {
        ok: false,
        reason: KNOWN.has(answer.reason) ? (answer.reason as 'too-long') : 'refused',
      };
    },
    async mount(container: HTMLElement, field: MathFieldOptions): Promise<MathFieldHandle> {
      const module = await load();
      return module.mountMathField(container, field, { fontsUrl: options.fontsUrl ?? null });
    },
  };
}
