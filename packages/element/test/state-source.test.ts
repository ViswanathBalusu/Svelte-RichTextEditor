// FE-023: the editing core owns the document state in plain TypeScript, and the shell's components
// hold only interface state in `$state`. This is a source check over the shell's `.svelte` files,
// not an ESLint rule (the workspace's ESLint configuration does not parse Svelte files; the same
// reason as test/source.test.ts). It reads every `$state` rune of the shell, with or without a type
// argument (`$state<T>(...)`, `$state.raw<T>(...)`) or a type annotation (`let x: T = $state()`),
// and refuses a declaration whose name, type or initialiser names the document, the transaction,
// the editor state or the core. A snapshot is allowed only in `$state.raw` (02 §4). A rune the
// scan cannot read as a declaration fails the test, so the scan cannot skip one silently.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packages = resolve(import.meta.dirname, '../..');
const uiSrc = join(packages, 'ui/src');

function svelteFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (name === 'node_modules') return [];
    return statSync(full).isDirectory()
      ? svelteFiles(full)
      : name.endsWith('.svelte')
        ? [full]
        : [];
  });
}

export interface StateDeclaration {
  file: string;
  name: string;
  raw: boolean;
  /** The type annotation and the type argument, joined; empty when there is neither. */
  type: string;
  initializer: string;
}

export interface StateScan {
  declarations: StateDeclaration[];
  /** `$state` runes the scan could not read as `let name (: T)? = $state(.raw)?(<T>)?(...)`. */
  unread: string[];
  /** Every `$state` rune in the shell's source, read or not. */
  runes: number;
}

const RUNE = /\$state\b(\.raw\b)?/g;
const LET = /\blet\s+([A-Za-z_$][\w$]*)\s*/g;

/** The index just past the bracket that closes the one at `start`, or -1. Strings are skipped. */
function closing(text: string, start: number): number {
  const open = text[start];
  const close = open === '<' ? '>' : open === '(' ? ')' : open === '{' ? '}' : ']';
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      const end = text.indexOf(c, i + 1);
      if (end < 0) return -1;
      i = end;
      continue;
    }
    // `=>` inside a type argument is an arrow, not a closing angle bracket.
    if (c === '>' && open === '<' && text[i - 1] === '=') continue;
    if (c === open) depth++;
    else if (c === close && --depth === 0) return i + 1;
  }
  return -1;
}

/** True when `text` holds no `;` or `=` (other than in `=>`) outside brackets and strings. */
function oneAnnotation(text: string): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      const end = text.indexOf(c, i + 1);
      if (end < 0) return false;
      i = end;
    } else if (c === '=' && text[i + 1] === '>') i++;
    else if (c === '(' || c === '[' || c === '{' || c === '<') depth++;
    else if (c === ')' || c === ']' || c === '}' || c === '>') depth--;
    else if (depth === 0 && (c === ';' || c === '=')) return false;
  }
  return depth === 0;
}

/** Reads every `$state` rune of one source text. */
export function scanStateSource(text: string, file: string): StateScan {
  const declarations: StateDeclaration[] = [];
  const unread: string[] = [];
  let runes = 0;
  for (const m of text.matchAll(RUNE)) {
    runes++;
    const at = m.index;
    const line = text.slice(0, at).split('\n').length;
    const where = `${file}:${line}`;
    // The declaration head: the last `let name` before the rune, then `(: T)? =`.
    const before = text.slice(0, at);
    const lets = [...before.matchAll(LET)];
    const head = lets.at(-1);
    const gap = head === undefined ? undefined : before.slice(head.index + head[0].length);
    const annotated = gap === undefined ? null : /^(?::([\s\S]*))?=\s*$/.exec(gap);
    // The gap must be one annotation: no `;` or `=` outside brackets, or the `let` found belongs
    // to an earlier statement and the rune is not a declaration this scan understands.
    if (head === undefined || annotated === null || !oneAnnotation(annotated[1] ?? '')) {
      unread.push(where);
      continue;
    }
    let i = at + m[0].length;
    let typeArgument = '';
    if (text[i] === '<') {
      const end = closing(text, i);
      if (end < 0) {
        unread.push(where);
        continue;
      }
      typeArgument = text.slice(i + 1, end - 1);
      i = end;
    }
    if (text[i] !== '(') {
      unread.push(where);
      continue;
    }
    const end = closing(text, i);
    if (end < 0) {
      unread.push(where);
      continue;
    }
    declarations.push({
      file,
      name: head[1] ?? '',
      raw: m[1] !== undefined,
      type: [annotated[1] ?? '', typeArgument]
        .map((t) => t.trim())
        .filter((t) => t !== '')
        .join(' ; '),
      initializer: text.slice(i + 1, end - 1).trim(),
    });
  }
  return { declarations, unread, runes };
}

/** Every `$state` and `$state.raw` declaration of the shell, generic or not. */
export function stateScan(): StateScan {
  const all: StateScan = { declarations: [], unread: [], runes: 0 };
  for (const full of svelteFiles(uiSrc)) {
    const scan = scanStateSource(
      readFileSync(full, 'utf8'),
      relative(uiSrc, full).replaceAll('\\', '/'),
    );
    all.declarations.push(...scan.declarations);
    all.unread.push(...scan.unread);
    all.runes += scan.runes;
  }
  return all;
}

/** Names, types and initialisers that would mean document or editor state, or the core. */
const FORBIDDEN = /doc|transaction|\btr\b|editor|\bcore\b|\.get\(\)/i;
/** A snapshot of a view, which 02 §4 allows only in `$state.raw`. */
const SNAPSHOT = /snapshot/i;

/** String literals hold a value, not a document: `'editor'` is a role, not the editor. */
function withoutStrings(text: string): string {
  return text.replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, "''");
}

function offends(d: StateDeclaration): boolean {
  const type = withoutStrings(d.type);
  const initializer = withoutStrings(d.initializer);
  if (FORBIDDEN.test(d.name) || FORBIDDEN.test(type) || FORBIDDEN.test(initializer)) return true;
  return !d.raw && (SNAPSHOT.test(d.name) || SNAPSHOT.test(type) || SNAPSHOT.test(initializer));
}

describe('FE-023: document state stays outside Svelte reactivity', () => {
  it('reads every $state rune of the shell as a declaration (the scan skips none)', () => {
    const scan = stateScan();
    expect(scan.unread).toEqual([]);
    expect(scan.declarations.length).toBe(scan.runes);
    expect(scan.runes).toBeGreaterThan(10);
  });

  it('reads generic and annotated declarations with their types (the scan is not vacuous)', () => {
    const { declarations } = stateScan();
    const find = (file: string, name: string) =>
      declarations.find((d) => d.file === file && d.name === name);
    expect(find('App.svelte', 'notice')).toMatchObject({ raw: true, type: 'Notice | null' });
    expect(find('components/ExportDialog.svelte', 'job')).toMatchObject({
      raw: true,
      type: 'ExportJobView | null',
      initializer: 'null',
    });
    expect(find('panes/PermissionsPane.svelte', 'grants')).toMatchObject({
      raw: true,
      type: 'GrantsSnapshot | null',
    });
    expect(find('App.svelte', 'menu')?.type).toContain('targets: ContextTarget[]');
    expect(find('App.svelte', 'pane')?.raw).toBe(true);
    expect(find('panes/OutlinePane.svelte', 'results')?.type).toBe('SearchResults | null');
  });

  it('the scanner reads the forms it must read', () => {
    const sample = [
      'let a = $state(0);',
      'let b = $state<Record<string, Map<string, number>>>({});',
      'let c = $state.raw<{ x: number; y: number } | null>(',
      '  null,',
      ');',
      'let d: (() => void) | null = $state(null);',
      'let e = $state.raw<(v: number) => string>(() => "");',
    ].join('\n');
    const scan = scanStateSource(sample, 'sample.svelte');
    expect(scan.unread).toEqual([]);
    expect(scan.declarations.map((d) => [d.name, d.raw, d.type, d.initializer])).toEqual([
      ['a', false, '', '0'],
      ['b', false, 'Record<string, Map<string, number>>', '{}'],
      ['c', true, '{ x: number; y: number } | null', 'null,'],
      ['d', false, '(() => void) | null', 'null'],
      ['e', true, '(v: number) => string', '() => ""'],
    ]);
    // A rune that is not a `let` declaration is reported, not skipped.
    const odd = scanStateSource('let x = 1;\nfoo = $state(0);\nconst y = $state.snapshot(z);', 's');
    expect(odd.unread).toEqual(['s:2', 's:3']);
    expect(odd.runes).toBe(2);
  });

  it('the check refuses the names and types it is meant to refuse', () => {
    const decl = (over: Partial<StateDeclaration>): StateDeclaration => ({
      file: 'x.svelte',
      name: 'value',
      raw: false,
      type: '',
      initializer: '0',
      ...over,
    });
    for (const name of ['doc', 'docState', 'transaction', 'editorState', 'core'])
      expect(offends(decl({ name })), name).toBe(true);
    for (const type of ['CdmDocument', 'EditorState | null', 'Transaction', 'EditorCore'])
      expect(offends(decl({ type })), type).toBe(true);
    expect(offends(decl({ initializer: 'core.selection.get()' }))).toBe(true);
    expect(offends(decl({ type: 'ViewSnapshot | null' }))).toBe(true);
    expect(offends(decl({ type: 'ViewSnapshot | null', raw: true }))).toBe(false);
    expect(offends(decl({ name: 'visibleCount', initializer: 'Number.POSITIVE_INFINITY' }))).toBe(
      false,
    );
    expect(offends(decl({ name: 'role', type: 'RegionRole', initializer: "'editor'" }))).toBe(
      false,
    );
  });

  it('holds no document, editor state, transaction or core in $state (criterion 1)', () => {
    const offenders = stateScan().declarations.filter(offends);
    expect(
      offenders.map(
        (d) => `${d.file}: ${d.name} = $state${d.raw ? '.raw' : ''}<${d.type}>(${d.initializer})`,
      ),
    ).toEqual([]);
  });
});
