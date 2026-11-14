/**
 * KaTeX as the first step of the math gate (09 §6.3): a strict parse with `trust` off and a macro
 * expansion limit. What KaTeX rejects is rejected. KaTeX runs without a DOM: only its parser is
 * called (`__parse`), which builds a tree and renders nothing.
 */
import katex from 'katex';

/** The macro expansion limit of the gate's KaTeX parse. */
export const KATEX_MAX_EXPAND = 1000;

interface KatexParser {
  __parse(expression: string, options: Record<string, unknown>): unknown;
  version: string;
}

const parser = katex as unknown as KatexParser;

export const KATEX_VERSION: string = parser.version;

/** Null when KaTeX accepts the expression in strict mode, else KaTeX's message. */
export function katexRejects(latex: string, display: boolean): string | null {
  try {
    parser.__parse(latex, {
      displayMode: display,
      strict: 'error',
      trust: false,
      maxExpand: KATEX_MAX_EXPAND,
      throwOnError: true,
      globalGroup: false,
    });
    return null;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return message.replace(/\s+/g, ' ').slice(0, 200);
  }
}
