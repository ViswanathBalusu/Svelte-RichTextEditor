/**
 * The origin check (SEC-054; 10 §3.8; ADR 0044 §6): the built editor bundle may load code only from
 * its own files. It parses every script of the build output and reports
 *
 * - `remote-import`: a static or dynamic import, or `importScripts`, of an absolute or
 *   protocol-relative address;
 * - `computed-import`: a dynamic import or `importScripts` whose address is computed at run time;
 * - `remote-address`: a script, style, font or WebAssembly address on another origin anywhere in a
 *   string of a script, in a stylesheet (`@import`, `url()`) or in a page (`<script src>`,
 *   `<link href>`, `<base href>`, frames), and any address of a public code or font service;
 * - `eval`: `eval`, the `Function` constructor, timers given a string, and imports of `data:` or
 *   `blob:` code.
 *
 * Each finding names the package that wrote the code, through the source maps (bundle.ts). A
 * finding passes only when scripts/supply-chain/origin-exceptions.json records a reviewed exception
 * for that package and rule, with a reason, a decision and an expiry, as the licence gate does.
 * WebAssembly compiled at run time and other remote addresses (documentation links, XML namespaces)
 * are listed as observations: they load no code from another origin.
 *
 * Usage: node scripts/supply-chain/origin-check.ts <bundle directory> --package <package directory>
 *          [--exclude <path>]... [--exceptions <file>] [--json <report file>]
 */
import ts from 'typescript';
import { readFileSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyseBundle, packageAt, type BundleContents } from './bundle.ts';

export type Rule =
  'remote-import' | 'computed-import' | 'computed-script' | 'remote-address' | 'eval';

export interface Finding {
  rule: Rule;
  file: string;
  /** 0-based, as in source maps. */
  line: number;
  column: number;
  detail: string;
  package: string | null;
}

export interface Observation {
  kind: 'wasm' | 'remote-url';
  file: string;
  line: number;
  column: number;
  detail: string;
  package: string | null;
}

export interface OriginException {
  package: string;
  rule: Rule;
  /** A path prefix inside the bundle; the exception applies only there. */
  file?: string;
  /** Text the finding's detail must contain, so that the exception excuses one address only. */
  detail?: string;
  reason: string;
  decision: string;
  expires: string;
}

type Raw<T> = Omit<T, 'package'>;

/** Hosts that serve scripts, styles or fonts to pages: any address on them is a finding. */
export const CODE_HOSTS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'use.typekit.net',
  'p.typekit.net',
  'kit.fontawesome.com',
  'use.fontawesome.com',
  'cdn.jsdelivr.net',
  'fastly.jsdelivr.net',
  'unpkg.com',
  'cdnjs.cloudflare.com',
  'esm.sh',
  'esm.run',
  'cdn.skypack.dev',
  'ga.jspm.io',
  'jspm.dev',
  'ajax.googleapis.com',
  'code.jquery.com',
  'stackpath.bootstrapcdn.com',
  'maxcdn.bootstrapcdn.com',
  'cdn.tailwindcss.com',
  'polyfill.io',
  'cdn.polyfill.io',
  'www.googletagmanager.com',
  'www.google-analytics.com',
];

const URL_IN_TEXT =
  /(?:\b(?:https?|wss?):)?\/\/(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?::\d+)?(?:[/?#][^\s"'`<>()\\]*)?/g;
const LOADABLE = /\.(?:m?js|cjs|css|wasm|woff2?|ttf|otf|eot)(?:[?#]|$)/i;

/** Absolute (`https://…`) or protocol-relative (`//host/…`) addresses in a piece of text. */
export function remoteUrls(text: string): string[] {
  return [...text.matchAll(URL_IN_TEXT)]
    .map((m) => m[0])
    .filter((u) => !/^\/\/[^/]*\.(?:m?js|css)$/.test(u));
}

function host(url: string): string {
  return (/^(?:[a-z]+:)?\/\/([^/:?#]+)/i.exec(url)?.[1] ?? '').toLowerCase();
}

/** True when an address would load a script, style, font or WebAssembly from another origin. */
export function isLoadable(url: string): boolean {
  const path = url.replace(/^(?:[a-z]+:)?\/\/[^/?#]+/i, '');
  return LOADABLE.test(path) || CODE_HOSTS.includes(host(url));
}

const isRemote = (spec: string) => /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(spec);
const isGeneratedCode = (spec: string) => /^(?:data|blob):/i.test(spec);

function snippet(text: string, start: number, end: number): string {
  const s = text.slice(start, Math.min(end, start + 160)).replace(/\s+/g, ' ');
  return end - start > 160 ? `${s}…` : s;
}

const GLOBALS = new Set(['window', 'globalThis', 'self', 'top', 'parent', 'frames']);

function calleeName(e: ts.Expression): string | null {
  if (ts.isIdentifier(e)) return e.text;
  if (
    ts.isPropertyAccessExpression(e) &&
    ts.isIdentifier(e.expression) &&
    GLOBALS.has(e.expression.text)
  )
    return e.name.text;
  if (ts.isParenthesizedExpression(e)) {
    // Indirect eval: (0, eval)(code).
    const inner = e.expression;
    if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.CommaToken)
      return calleeName(inner.right);
    return calleeName(inner);
  }
  return null;
}

const literalText = (e: ts.Expression | undefined): string | null =>
  e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text : null;

/** `document.createElement('script')`, on any receiver. */
const isScriptElement = (e: ts.Expression): boolean =>
  ts.isCallExpression(e) &&
  ts.isPropertyAccessExpression(e.expression) &&
  e.expression.name.text === 'createElement' &&
  literalText(e.arguments[0]) === 'script';

/** Scans one script. Positions are relative to `text`; `lineOffset` shifts them (inline scripts). */
export function scanScript(
  text: string,
  file: string,
  lineOffset = 0,
): { findings: Raw<Finding>[]; observations: Raw<Observation>[] } {
  const findings: Raw<Finding>[] = [];
  const observations: Raw<Observation>[] = [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const at = (node: ts.Node) => {
    const start = node.getStart(sf);
    const { line, character } = sf.getLineAndCharacterOfPosition(start);
    return { line: line + lineOffset, column: character, detail: snippet(text, start, node.end) };
  };
  const add = (rule: Rule, node: ts.Node, detail?: string) => {
    const p = at(node);
    findings.push({ rule, file, line: p.line, column: p.column, detail: detail ?? p.detail });
  };
  // Specifiers already judged as imports; their text is not judged again as an address.
  const specifiers = new Set<ts.Node>();
  const importOf = (node: ts.Node, spec: ts.Expression | undefined) => {
    const lit = literalText(spec);
    if (spec && lit !== null) specifiers.add(spec);
    if (lit === null) add('computed-import', node);
    else if (isRemote(lit)) add('remote-import', node);
    else if (isGeneratedCode(lit)) add('eval', node);
  };
  // Names that hold a script element, so that a computed address given to one can be found.
  const scripts = new Set<string>();
  const isScript = (e: ts.Expression): boolean =>
    isScriptElement(e) || (ts.isIdentifier(e) && scripts.has(e.text));
  const visit = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      isScriptElement(n.initializer)
    )
      scripts.add(n.name.text);
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(n.left) &&
      n.left.name.text === 'src' &&
      isScript(n.left.expression) &&
      literalText(n.right) === null
    )
      add('computed-script', n);
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'setAttribute' &&
      isScript(n.expression.expression) &&
      literalText(n.arguments[0]) === 'src' &&
      literalText(n.arguments[1]) === null
    )
      add('computed-script', n);
    if (ts.isCallExpression(n)) {
      if (n.expression.kind === ts.SyntaxKind.ImportKeyword) importOf(n, n.arguments[0]);
      else {
        const name = calleeName(n.expression);
        if (name === 'eval' || name === 'execScript' || name === 'Function') add('eval', n);
        else if (name === 'importScripts') for (const a of n.arguments) importOf(n, a);
        else if ((name === 'setTimeout' || name === 'setInterval') && n.arguments[0]) {
          const first = n.arguments[0];
          if (ts.isStringLiteralLike(first) || ts.isTemplateExpression(first)) add('eval', n);
        }
      }
    } else if (ts.isNewExpression(n)) {
      if (calleeName(n.expression) === 'Function') add('eval', n);
    } else if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) {
      const lit = literalText(n.moduleSpecifier);
      specifiers.add(n.moduleSpecifier);
      if (lit !== null && isRemote(lit)) add('remote-import', n);
    } else if (
      ts.isPropertyAccessExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'WebAssembly' &&
      /^(?:instantiate|instantiateStreaming|compile|compileStreaming|Module)$/.test(n.name.text)
    ) {
      const p = at(n);
      observations.push({ kind: 'wasm', file, ...p });
    }
    if (
      !specifiers.has(n) &&
      (ts.isStringLiteral(n) ||
        ts.isNoSubstitutionTemplateLiteral(n) ||
        ts.isTemplateHead(n) ||
        ts.isTemplateMiddle(n) ||
        ts.isTemplateTail(n))
    ) {
      for (const url of remoteUrls(n.text)) {
        const p = at(n);
        if (isLoadable(url))
          findings.push({
            rule: 'remote-address',
            file,
            line: p.line,
            column: p.column,
            detail: url,
          });
        else
          observations.push({
            kind: 'remote-url',
            file,
            line: p.line,
            column: p.column,
            detail: url,
          });
      }
    }
  };
  // Depth first, in source order, without recursion: minified code nests deeper than the stack.
  const stack: ts.Node[] = [sf];
  while (stack.length) {
    const n = stack.pop()!;
    visit(n);
    const children: ts.Node[] = [];
    ts.forEachChild(n, (c) => {
      children.push(c);
    });
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
  }
  return { findings, observations };
}

/** Line and column of an offset (0-based). */
function position(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const line = before.split('\n').length - 1;
  return { line, column: offset - (before.lastIndexOf('\n') + 1) };
}

/** Comments replaced by spaces, so that offsets stay where they were. */
const blankComments = (css: string) =>
  css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));

export function scanStyle(text: string, file: string, lineOffset = 0): Raw<Finding>[] {
  const css = blankComments(text);
  const findings: Raw<Finding>[] = [];
  const patterns = [/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/gi, /url\(\s*["']?([^"')\s]+)/gi];
  const seen = new Set<number>();
  for (const re of patterns)
    for (const m of css.matchAll(re)) {
      const url = m[1]!;
      const offset = m.index + m[0].indexOf(url);
      if (seen.has(offset) || !isRemote(url)) continue;
      seen.add(offset);
      const p = position(css, offset);
      findings.push({
        rule: 'remote-address',
        file,
        line: p.line + lineOffset,
        column: p.column,
        detail: url,
      });
    }
  return findings;
}

export function scanHtml(
  text: string,
  file: string,
): { findings: Raw<Finding>[]; observations: Raw<Observation>[] } {
  const findings: Raw<Finding>[] = [];
  const observations: Raw<Observation>[] = [];
  const attr = (tag: string, name: string) =>
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  const elements: Array<[RegExp, string]> = [
    [/<script\b[^>]*>/gi, 'src'],
    [/<link\b[^>]*>/gi, 'href'],
    [/<base\b[^>]*>/gi, 'href'],
    [/<iframe\b[^>]*>/gi, 'src'],
    [/<embed\b[^>]*>/gi, 'src'],
    [/<object\b[^>]*>/gi, 'data'],
  ];
  for (const [re, name] of elements)
    for (const m of text.matchAll(re)) {
      const a = attr(m[0], name);
      const value = a?.[1] ?? a?.[2] ?? a?.[3];
      if (value && (isRemote(value) || /^(?:data|blob):/i.test(value))) {
        const p = position(text, m.index);
        findings.push({
          rule: isRemote(value) ? 'remote-address' : 'eval',
          file,
          ...p,
          detail: m[0],
        });
      }
    }
  for (const m of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/.test(m[1]!) || !m[2]!.trim()) continue;
    const start = m.index + m[0].indexOf('>') + 1;
    const r = scanScript(m[2]!, file, position(text, start).line);
    findings.push(...r.findings);
    observations.push(...r.observations);
  }
  for (const m of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    const start = m.index + m[0].indexOf('>') + 1;
    findings.push(...scanStyle(m[1]!, file, position(text, start).line));
  }
  for (const m of text.matchAll(/\bstyle\s*=\s*"([^"]*)"/gi)) {
    const p = position(text, m.index);
    findings.push(...scanStyle(m[1]!, file).map((f) => ({ ...f, line: p.line })));
  }
  return { findings, observations };
}

export function validExceptions(
  list: readonly OriginException[],
  today: string,
): { active: OriginException[]; problems: string[] } {
  const problems: string[] = [];
  const active: OriginException[] = [];
  for (const e of list) {
    const what = `exception for ${e.package} (${e.rule}${e.file ? `, ${e.file}` : ''})`;
    if (!e.reason || !e.decision || !/^\d{4}-\d{2}-\d{2}$/.test(e.expires ?? ''))
      problems.push(`${what} needs a reason, a decision record and an expiry date`);
    else if (e.expires < today) problems.push(`${what} expired on ${e.expires}`);
    else active.push(e);
  }
  return { active, problems };
}

const nameOf = (key: string | null) =>
  key ? key.slice(0, key.lastIndexOf('@') > 0 ? key.lastIndexOf('@') : undefined) : null;

export interface OriginReport {
  bundle: string;
  scanned: number;
  findings: Finding[];
  excused: Array<Finding & { exception: OriginException }>;
  observations: Observation[];
  unusedExceptions: OriginException[];
  problems: string[];
  ok: boolean;
}

export function checkOrigins(
  contents: BundleContents,
  exceptions: readonly OriginException[],
  today: string,
): OriginReport {
  const { active, problems } = validExceptions(exceptions, today);
  const findings: Finding[] = [];
  const excused: OriginReport['excused'] = [];
  const observations: Observation[] = [];
  const used = new Set<OriginException>();
  let scanned = 0;
  for (const f of contents.files) {
    const ext = extname(f.path).toLowerCase();
    if (ext === '.map') continue;
    const text = () => readFileSync(join(contents.root, f.path), 'utf8');
    let raw: { findings: Raw<Finding>[]; observations: Raw<Observation>[] } | null = null;
    if (['.js', '.mjs', '.cjs'].includes(ext)) raw = scanScript(text(), f.path);
    else if (ext === '.css') raw = { findings: scanStyle(text(), f.path), observations: [] };
    else if (ext === '.html' || ext === '.htm') raw = scanHtml(text(), f.path);
    else if (ext === '.wasm')
      raw = {
        findings: [],
        observations: [
          { kind: 'wasm', file: f.path, line: 0, column: 0, detail: 'WebAssembly module' },
        ],
      };
    if (!raw) continue;
    scanned++;
    for (const o of raw.observations)
      observations.push({ ...o, package: packageAt(contents, o.file, o.line, o.column) });
    for (const r of raw.findings) {
      const finding: Finding = { ...r, package: packageAt(contents, r.file, r.line, r.column) };
      const exception = active.find(
        (e) =>
          e.rule === finding.rule &&
          e.package === nameOf(finding.package) &&
          (!e.file || finding.file.startsWith(e.file)) &&
          (!e.detail || finding.detail.includes(e.detail)),
      );
      if (exception) {
        used.add(exception);
        excused.push({ ...finding, exception });
      } else findings.push(finding);
    }
  }
  const unusedExceptions = active.filter((e) => !used.has(e));
  return {
    bundle: contents.root,
    scanned,
    findings,
    excused,
    observations,
    unusedExceptions,
    problems: [
      ...problems,
      ...contents.problems,
      ...contents.unattributed.map((u) => `${u}: no package explains this file`),
    ],
    ok: findings.length === 0 && problems.length === 0,
  };
}

export function printOriginReport(r: OriginReport): void {
  const where = (f: { file: string; line: number; column: number; package: string | null }) =>
    `${f.file}:${f.line + 1}:${f.column + 1}${f.package ? ` (${f.package})` : ''}`;
  console.log(`origin check: ${r.scanned} files of ${r.bundle} scanned`);
  for (const e of r.excused)
    console.log(
      `  excused: ${e.rule} at ${where(e)}: ${e.detail} [${e.exception.decision}, until ${e.exception.expires}]`,
    );
  const wasm = r.observations.filter((o) => o.kind === 'wasm');
  const urls = new Set(r.observations.filter((o) => o.kind === 'remote-url').map((o) => o.detail));
  console.log(
    `  observed: ${wasm.length} WebAssembly module(s) or compile sites; ${urls.size} other remote address(es), none a script, style or font`,
  );
  for (const e of r.unusedExceptions)
    console.log(`  note: exception for ${e.package} (${e.rule}) matched nothing; remove it`);
  for (const p of r.problems) console.log(`  problem: ${p}`);
  if (r.findings.length) {
    console.error(`origin check: ${r.findings.length} finding(s):`);
    for (const f of r.findings) console.error(`  - ${f.rule} at ${where(f)}: ${f.detail}`);
  }
  console.log(`origin check: ${r.ok ? 'passed' : 'FAILED'}`);
}

function main(argv: string[]): number {
  const args = [...argv];
  const bundle = args.shift();
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args.splice(i, 2)[1] : undefined;
  };
  const pkg = opt('--package');
  const exceptionsFile = opt('--exceptions') ?? join(import.meta.dirname, 'origin-exceptions.json');
  const json = opt('--json');
  const excludes: string[] = [];
  for (let e = opt('--exclude'); e !== undefined; e = opt('--exclude')) excludes.push(e);
  if (!bundle || !pkg) {
    console.error(
      'usage: node scripts/supply-chain/origin-check.ts <bundle dir> --package <package dir> [--exclude <path>] [--exceptions <file>] [--json <file>]',
    );
    return 2;
  }
  const contents = analyseBundle(resolve(bundle), {
    ownPackageDir: resolve(pkg),
    exclude: (p) => excludes.includes(p),
  });
  const { exceptions } = JSON.parse(readFileSync(exceptionsFile, 'utf8')) as {
    exceptions: OriginException[];
  };
  const report = checkOrigins(contents, exceptions, new Date().toISOString().slice(0, 10));
  printOriginReport(report);
  if (json) writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
  return report.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
