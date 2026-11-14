/**
 * Math display with KaTeX (FE-069) and the math editor, MathLive (FE-070), both loaded lazily.
 *
 * - KaTeX renders by DOM construction (`katex.render`), with `trust` off and in strict mode. Its
 *   `@font-face` rules would be ignored inside the shadow root (02 §3), so they are registered on
 *   the document with the FontFace API; the rest of its CSS is adopted as a constructable sheet.
 *   Hash-derived aliases (FE-061) are not applied in the spike.
 * - MathLive registers the global custom elements `math-field`, `math-span` and `math-div` when it
 *   loads. Its markup goes through `MathfieldElement.createHTML`, which the component points at its
 *   own Trusted Types policy.
 */
import { adoptExtraSheet } from '../styles.ts';
import { mathEditorHTML, POLICY_NAMES } from '../trusted-types.ts';

export interface MathItem {
  latex: string;
  display?: boolean;
}

export interface MathReport {
  rendered: number;
  errors: string[];
  stylePath: string;
  fontFaces: number;
  fontsLoaded: boolean;
  /** What the feature changed on the host document (spike S2: global side effects). */
  globals: HostGlobals;
}

/** The parts of the host document that a feature may change: font families, sheets, body classes. */
export interface HostGlobals {
  addedFontFamilies: string[];
  documentSheetsBefore: number;
  documentSheetsAfter: number;
  bodyClassesAfter: string;
}

function fontFamilies(): Set<string> {
  return new Set(Array.from(document.fonts, (f) => f.family.replace(/^["']|["']$/g, '')));
}

function globalsSince(families: Set<string>, sheets: number): HostGlobals {
  return {
    addedFontFamilies: [...fontFamilies()].filter((f) => !families.has(f)).sort(),
    documentSheetsBefore: sheets,
    documentSheetsAfter: document.adoptedStyleSheets.length,
    bodyClassesAfter: document.body.className,
  };
}

let katexFaces: FontFace[] | null = null;

/** Moves the `@font-face` rules of a stylesheet to the document; returns the rest of the CSS. */
function moveFontFaces(cssText: string): { rest: string; faces: FontFace[] } {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(cssText);
  const faces: FontFace[] = [];
  const rest: string[] = [];
  for (const rule of Array.from(sheet.cssRules)) {
    if (rule instanceof CSSFontFaceRule) {
      const s = rule.style;
      const family = s
        .getPropertyValue('font-family')
        .trim()
        .replace(/^["']|["']$/g, '');
      const face = new FontFace(family, s.getPropertyValue('src'), {
        style: s.getPropertyValue('font-style') || 'normal',
        weight: s.getPropertyValue('font-weight') || 'normal',
        display: 'block',
      });
      document.fonts.add(face);
      faces.push(face);
    } else {
      rest.push(rule.cssText);
    }
  }
  return { rest: rest.join('\n'), faces };
}

export async function showMath(
  root: ShadowRoot,
  host: HTMLElement,
  items: readonly MathItem[],
  options: { throwOnError?: boolean; nonce?: string | undefined } = {},
): Promise<MathReport> {
  const families = fontFamilies();
  const sheets = document.adoptedStyleSheets.length;
  const [{ default: katex }, { default: css }] = await Promise.all([
    import('katex'),
    import('katex/dist/katex.min.css?inline'),
  ]);
  let stylePath = 'already';
  if (!katexFaces) {
    const moved = moveFontFaces(css);
    katexFaces = moved.faces;
    stylePath = adoptExtraSheet(root, moved.rest, options.nonce);
  }
  const report: MathReport = {
    rendered: 0,
    errors: [],
    stylePath,
    fontFaces: katexFaces.length,
    fontsLoaded: false,
    globals: globalsSince(families, sheets),
  };
  for (const item of items) {
    const el = document.createElement(item.display ? 'div' : 'span');
    el.className = 'de-math';
    try {
      katex.render(item.latex, el, {
        displayMode: item.display ?? false,
        throwOnError: options.throwOnError ?? true,
        trust: false,
        strict: 'error',
        output: 'htmlAndMathml',
      });
      report.rendered++;
    } catch (e) {
      // FE-069: a visible placeholder with the source; nothing throws.
      el.className = 'de-math de-math-error';
      el.textContent = item.latex;
      report.errors.push(e instanceof Error ? e.message : String(e));
    }
    host.append(el);
  }
  await Promise.allSettled(katexFaces.map((f) => f.load()));
  report.fontsLoaded = katexFaces.every((f) => f.status === 'loaded');
  report.globals = globalsSince(families, sheets);
  return report;
}

export interface MathEditorOptions {
  fontsDirectory: string;
  /** Route MathLive's markup through the component's policy (`docedit-math`). */
  useCreateHTML?: boolean;
}

export interface MathEditorReport {
  ok: boolean;
  error: string | null;
  value: string;
  tags: Record<string, boolean>;
  policy: string | null;
  globals: HostGlobals | null;
}

/**
 * The part of MathLive's API used here. TypeScript resolves `mathlive` with the `node` condition to
 * its server-side typings, which lack the element, so the shape is declared locally.
 */
interface MathfieldLike extends HTMLElement {
  value: string;
  executeCommand(command: unknown): boolean;
}

interface MathfieldConstructor {
  new (): MathfieldLike;
  fontsDirectory: string | null;
  soundsDirectory: string | null;
  createHTML: (html: string) => unknown;
}

export async function openMathEditor(
  host: HTMLElement,
  latex: string,
  options: MathEditorOptions,
): Promise<MathEditorReport> {
  const report: MathEditorReport = {
    ok: false,
    error: null,
    value: '',
    tags: {},
    policy: null,
    globals: null,
  };
  const families = fontFamilies();
  const sheets = document.adoptedStyleSheets.length;
  try {
    const { MathfieldElement } = (await import('mathlive')) as unknown as {
      MathfieldElement: MathfieldConstructor;
    };
    MathfieldElement.fontsDirectory = options.fontsDirectory;
    MathfieldElement.soundsDirectory = null;
    if (options.useCreateHTML ?? true) {
      MathfieldElement.createHTML = (html: string) => mathEditorHTML(html);
      report.policy = POLICY_NAMES.mathEditor;
    }
    const field = new MathfieldElement();
    field.value = latex;
    host.append(field);
    await customElements.whenDefined('math-field');
    for (const tag of ['math-field', 'math-span', 'math-div'])
      report.tags[tag] = customElements.get(tag) !== undefined;
    field.focus();
    field.executeCommand(['insert', '+1']);
    report.value = field.value;
    // Let MathLive finish loading its fonts before reading what it changed on the document.
    await document.fonts.ready;
    await new Promise((r) => setTimeout(r, 300));
    report.globals = globalsSince(families, sheets);
    report.ok = true;
  } catch (e) {
    report.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
  return report;
}
