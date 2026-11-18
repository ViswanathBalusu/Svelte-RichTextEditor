/**
 * The hook the web view draws equations through (FE-069; 02 §6, §3).
 *
 * The engine does not carry a maths renderer. The element gives the view a drawer built on KaTeX
 * (`packages/element/src/equation-drawer.ts`), so the renderer, its fonts and its style sheet stay
 * in the element's own chunks. The drawer replaces what `container` holds with the equation for
 * `latex`, as inline maths or, when `display` is true, as display maths. It must build its output
 * with DOM calls, never from an HTML string, and it must not throw: a source it cannot draw becomes
 * a placeholder that shows the source. Without a drawer the view shows the LaTeX source as text.
 */
export type EquationDrawer = (container: HTMLElement, latex: string, display: boolean) => void;
