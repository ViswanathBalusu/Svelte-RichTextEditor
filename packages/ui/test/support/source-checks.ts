/**
 * Source checks that CI runs through the Node.js tests (UX-064, criteria 1 and 6):
 *
 * - no user-visible literal in a component: a text node, or the value of `aria-label`, `title`,
 *   `placeholder`, `alt` and the other ARIA attributes people read, written as text instead of a
 *   string key;
 * - no physical-direction CSS property (`left`, `margin-right`, `text-align: left` and the rest)
 *   in the shell's styles, unless the exception is listed.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'svelte/compiler';

export const VISIBLE_ATTRIBUTES = [
  'aria-label',
  'title',
  'placeholder',
  'alt',
  'aria-description',
  'aria-roledescription',
  'aria-valuetext',
  'aria-placeholder',
];

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly where: string;
}

const LETTER = /\p{L}/u;

function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

type AstNode = { type?: string; start?: number; [key: string]: unknown };

/** Literal user-visible text in one component's markup. */
export function literalStrings(file: string, source: string): Finding[] {
  const ast = parse(source, { modern: true }) as unknown as { fragment: AstNode };
  const findings: Finding[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const n = node as AstNode;
    if (n.type === 'Text' && typeof n['data'] === 'string' && LETTER.test(n['data'])) {
      findings.push({
        file,
        line: lineOf(source, n.start ?? 0),
        text: n['data'].trim(),
        where: 'text node',
      });
      return;
    }
    if (n.type === 'Attribute' && typeof n['name'] === 'string') {
      const name = n['name'].toLowerCase();
      const value = n['value'];
      if (VISIBLE_ATTRIBUTES.includes(name) && Array.isArray(value)) {
        for (const part of value as AstNode[])
          if (part.type === 'Text' && typeof part['data'] === 'string' && LETTER.test(part['data']))
            findings.push({
              file,
              line: lineOf(source, part.start ?? 0),
              text: part['data'],
              where: `${name} attribute`,
            });
      }
      return;
    }
    for (const [key, value] of Object.entries(n)) {
      if (key === 'start' || key === 'end' || key === 'metadata') continue;
      if (value && typeof value === 'object') visit(value);
    }
  };
  visit(ast.fragment);
  return findings;
}

export interface CssFinding {
  readonly file: string;
  readonly line: number;
  readonly declaration: string;
}

/** Physical properties and values that do not mirror (02 §11; 13 §8). */
const PHYSICAL = [
  /(^|[^-\w])(left|right)\s*:/,
  /\b(margin|padding|border|inset|scroll-margin|scroll-padding)-(left|right)\b/,
  /\bborder-(top|bottom)-(left|right)-radius\b/,
  /\btext-align\s*:\s*(left|right)\b/,
  /\bfloat\s*:\s*(left|right)\b/,
  /\bclear\s*:\s*(left|right)\b/,
  /\bresize\s*:\s*horizontal\b/,
];

/** Physical-direction declarations in one stylesheet, ignoring comments. */
export function physicalDeclarations(
  file: string,
  css: string,
  exceptions: readonly string[] = [],
): CssFinding[] {
  const out: CssFinding[] = [];
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  withoutComments.split('\n').forEach((line, i) => {
    const text = line.trim();
    if (!text || exceptions.includes(text)) return;
    if (PHYSICAL.some((re) => re.test(text))) out.push({ file, line: i + 1, declaration: text });
  });
  return out;
}

/** Files under a directory with one of the extensions, relative to `base`. */
export function filesUnder(dir: string, extensions: readonly string[], base: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path, extensions, base));
    else if (extensions.some((e) => name.endsWith(e))) out.push(relative(base, path));
  }
  return out.sort();
}

export function read(path: string): string {
  return readFileSync(path, 'utf8');
}
