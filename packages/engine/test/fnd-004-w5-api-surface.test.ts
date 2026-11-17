/**
 * FND-004 criterion 2, first half (02 §5.1; ADR 0003; lane w5): no ProseMirror type appears in the
 * public types of the document API (`src/api.ts`).
 *
 * The check uses the TypeScript type checker, not a scan of import lines: it starts from every
 * export of the file and follows members, parameters, results, type arguments, unions and base
 * types, through the engine's own files, until it reaches a type declared in a `prosemirror-*`
 * package. So a ProseMirror type that reaches the API through another file of the engine is found
 * too. The test runs with `pnpm test`, a step of `pnpm check` and of CI, so the build fails.
 *
 * A probe shows that the check does fail: a virtual file that extends the API with members whose
 * types hold a ProseMirror type directly, in a result, and through a file of the engine.
 */
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const pkg = resolve(import.meta.dirname, '..');
const slash = (p: string) => p.replace(/\\/g, '/');
const API = slash(join(pkg, 'src', 'api.ts'));
const PROBE = slash(join(pkg, 'src', '__api_surface_probe__.ts'));
const PROSEMIRROR = /\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(prosemirror-[a-z-]+)\//;

interface Finding {
  /** The path of names from an export to the type, for example `DocumentApi.outline()`. */
  readonly at: string;
  /** The ProseMirror type, as `package:Name`. */
  readonly type: string;
}

function programFor(probeText?: string): ts.Program {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    join(pkg, 'tsconfig.json'),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
      },
    },
  );
  if (!parsed) throw new Error('cannot read the tsconfig.json of the engine');
  const host = ts.createCompilerHost(parsed.options);
  if (probeText !== undefined) {
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (name, lang, ...rest) =>
      slash(name) === PROBE
        ? ts.createSourceFile(name, probeText, lang)
        : getSourceFile(name, lang, ...rest);
    host.fileExists = (name) => slash(name) === PROBE || ts.sys.fileExists(name);
    host.readFile = (name) => (slash(name) === PROBE ? probeText : ts.sys.readFile(name));
  }
  return ts.createProgram({
    rootNames: [probeText !== undefined ? PROBE : API],
    options: parsed.options,
    host,
  });
}

/** The ProseMirror types reachable from the exports of `file`. */
function prosemirrorTypesOf(program: ts.Program, file: string): Finding[] {
  const checker = program.getTypeChecker();
  const source = program.getSourceFiles().find((f) => slash(f.fileName) === file);
  if (!source) throw new Error(`${file} is not in the program`);
  const module = checker.getSymbolAtLocation(source);
  if (!module) throw new Error(`${file} is not a module`);

  const found: Finding[] = [];
  const seen = new Set<ts.Type>();

  /** `package:Name` when the symbol is declared in a ProseMirror package; null otherwise. */
  const prosemirrorName = (symbol: ts.Symbol | undefined): string | null => {
    for (const d of symbol?.declarations ?? []) {
      const m = PROSEMIRROR.exec(slash(d.getSourceFile().fileName));
      if (m) return `${m[1]}:${symbol!.getName()}`;
    }
    return null;
  };
  /** Types of the language's own library (Promise, Array, Map) are not followed into. */
  const isLibrary = (symbol: ts.Symbol | undefined): boolean =>
    (symbol?.declarations ?? []).some((d) => program.isSourceFileDefaultLibrary(d.getSourceFile()));

  const visitSignature = (s: ts.Signature, at: string): void => {
    for (const p of s.getParameters()) visit(checker.getTypeOfSymbol(p), `${at}(${p.getName()})`);
    visit(s.getReturnType(), `${at}()`);
    for (const tp of s.getTypeParameters() ?? []) {
      const c = tp.getConstraint();
      if (c) visit(c, `${at}<${tp.symbol.getName()}>`);
    }
  };

  const visit = (type: ts.Type, at: string): void => {
    if (seen.has(type)) return;
    seen.add(type);
    const name = prosemirrorName(type.aliasSymbol) ?? prosemirrorName(type.getSymbol());
    if (name) {
      found.push({ at, type: name });
      return;
    }
    for (const a of type.aliasTypeArguments ?? []) visit(a, `${at}<>`);
    if (type.isUnionOrIntersection()) {
      for (const t of type.types) visit(t, at);
      return;
    }
    if (type.flags & ts.TypeFlags.Object) {
      const object = type as ts.ObjectType;
      if (object.objectFlags & ts.ObjectFlags.Reference)
        for (const a of checker.getTypeArguments(object as ts.TypeReference)) visit(a, `${at}<>`);
    }
    if (type.flags & ts.TypeFlags.TypeParameter) {
      const c = (type as ts.TypeParameter).getConstraint();
      if (c) visit(c, at);
      return;
    }
    if (type.flags & ts.TypeFlags.Index) return visit((type as ts.IndexType).type, at);
    if (type.flags & ts.TypeFlags.IndexedAccess) {
      const t = type as ts.IndexedAccessType;
      visit(t.objectType, at);
      visit(t.indexType, at);
      return;
    }
    if (type.flags & ts.TypeFlags.Conditional) {
      const t = type as ts.ConditionalType;
      visit(t.checkType, at);
      visit(t.extendsType, at);
      visit(checker.getTypeAtLocation(t.root.node.trueType), at);
      visit(checker.getTypeAtLocation(t.root.node.falseType), at);
      return;
    }
    if (isLibrary(type.getSymbol())) return;
    for (const b of type.getBaseTypes() ?? []) visit(b, at);
    for (const p of type.getProperties()) visit(checker.getTypeOfSymbol(p), `${at}.${p.getName()}`);
    for (const s of type.getCallSignatures()) visitSignature(s, at);
    for (const s of type.getConstructSignatures()) visitSignature(s, `new ${at}`);
    for (const info of checker.getIndexInfosOfType(type)) visit(info.type, `${at}[]`);
  };

  for (const exported of checker.getExportsOfModule(module)) {
    const symbol =
      exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    const name = exported.getName();
    const direct = prosemirrorName(symbol);
    if (direct) {
      found.push({ at: name, type: direct });
      continue;
    }
    if (symbol.flags & ts.SymbolFlags.Type) visit(checker.getDeclaredTypeOfSymbol(symbol), name);
    if (symbol.flags & ts.SymbolFlags.Value) visit(checker.getTypeOfSymbol(symbol), name);
  }
  return found;
}

describe('the document API has no ProseMirror type in its public types (FND-004 criterion 2)', () => {
  it('finds none from any export of src/api.ts, followed through the engine', () => {
    const program = programFor();
    // Non-vacuity: the API is in the program and exports its interface.
    const checker = program.getTypeChecker();
    const source = program.getSourceFiles().find((f) => slash(f.fileName) === API)!;
    const names = checker
      .getExportsOfModule(checker.getSymbolAtLocation(source)!)
      .map((s) => s.getName());
    expect(names).toContain('DocumentApi');
    expect(names.length).toBeGreaterThan(10);
    expect(prosemirrorTypesOf(program, API)).toEqual([]);
  });

  it('fails when a ProseMirror type is put on the surface, directly or through another file', () => {
    const probe = [
      "import type { Node } from 'prosemirror-model';",
      "import type { EditorState } from 'prosemirror-state';",
      "import type { DocumentApi } from './api.ts';",
      "import type { Internals } from './internals.ts';",
      'export interface Leaky extends DocumentApi {',
      '  direct: Node;',
      '  nested(): Promise<readonly { state: EditorState }[]>;',
      '}',
      '/** A type of the engine that is not the API and holds the ProseMirror state. */',
      'export type ThroughTheEngine = { open(): Internals };',
      'export type Clean = { text: string; at: number };',
    ].join('\n');
    const found = prosemirrorTypesOf(programFor(probe), PROBE);
    const at = (prefix: string) => found.filter((f) => f.at.startsWith(prefix));
    expect(at('Leaky.direct').map((f) => f.type)).toEqual(['prosemirror-model:Node']);
    expect(at('Leaky.nested').map((f) => f.type)).toEqual(['prosemirror-state:EditorState']);
    expect(at('ThroughTheEngine').map((f) => f.type)).toContain('prosemirror-model:Schema');
    // A type is reported once, where it is first met: EditorState is under `Leaky.nested` above.
    expect(at('Clean')).toEqual([]);
    // Nothing of the API itself is reported under the probe's interface either.
    expect(found.every((f) => /^(Leaky\.(direct|nested)|ThroughTheEngine)/.test(f.at))).toBe(true);
  });
});
