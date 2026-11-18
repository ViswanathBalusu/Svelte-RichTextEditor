/**
 * The reference of the embedding contract (UX-090, criterion 3; 13 §11.1; 05 §8): every attribute,
 * property, method and event of `<doc-editor>`, the command identifiers its `exec` and
 * `queryCommand` accept, and the configuration, with the version of the contract and the release.
 * It is read from the source (the TypeScript compiler's syntax tree, no type checking), not typed
 * again: `doc-editor.ts` for the members and the attributes, `events.ts` for the events,
 * `config.schema.json` for the configuration, `version.ts` for the versions, and the command
 * registry for the identifiers. `generate.ts` writes it to `spec/embedding/`.
 *
 * Pure: the caller reads the files and passes their text. Refuses (`problems`) when the sources do
 * not have the shape it reads, so that a rename cannot silently empty the reference.
 */
import ts from 'typescript';

export const REFERENCE_JSON = 'spec/embedding/embedding-reference.json';
export const REFERENCE_MARKDOWN = 'spec/embedding/embedding-reference.md';

/** Standard custom element reactions: called by the browser, not by a host. Listed apart. */
const REACTIONS = new Set([
  'connectedCallback',
  'connectedMoveCallback',
  'disconnectedCallback',
  'attributeChangedCallback',
  'adoptedCallback',
]);

export interface Member {
  readonly name: string;
  readonly kind: 'property' | 'method';
  readonly static: boolean;
  readonly access: 'read' | 'read/write' | 'call';
  /** The type of a property, or the signature of a method. */
  readonly signature: string;
  readonly summary: string;
}

export interface EventEntry {
  readonly name: string;
  readonly detail: string;
  readonly summary: string;
}

export interface CommandInfo {
  readonly id: string;
  readonly group: string;
  readonly capability: string;
  readonly keys: readonly string[];
  readonly aliases: readonly string[];
}

export interface ConfigKey {
  readonly name: string;
  readonly type: string;
  readonly default: string | null;
  readonly summary: string;
}

export interface ReferenceInput {
  readonly docEditorSource: string;
  readonly eventsSource: string;
  readonly versionSource: string;
  /** `register.ts`, which names the default tag. */
  readonly registerSource: string;
  readonly configSchema: unknown;
  readonly commands: readonly CommandInfo[];
}

export interface Reference {
  readonly tag: string;
  readonly embeddingVersion: string;
  readonly release: string;
  readonly attributes: readonly string[];
  readonly members: readonly Member[];
  readonly reactions: readonly string[];
  readonly events: readonly EventEntry[];
  readonly commands: readonly CommandInfo[];
  readonly config: readonly ConfigKey[];
}

export interface ReferenceResult {
  readonly problems: readonly string[];
  readonly reference: Reference;
  readonly artifacts: readonly { readonly path: string; readonly text: string }[];
}

function parse(text: string, name: string): ts.SourceFile {
  return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** The first paragraph of the node's doc comment, on one line. */
function summary(node: ts.Node): string {
  const docs = (node as { jsDoc?: ts.JSDoc[] }).jsDoc;
  const last = docs?.[docs.length - 1];
  if (!last?.comment) return '';
  const text = ts.getTextOfJSDocComment(last.comment) ?? '';
  return text
    .split(/\n\s*\n/)[0]!
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === kind);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function extractMembers(
  source: string,
  className: string,
): { members: Member[]; reactions: string[]; problems: string[] } {
  const sf = parse(source, 'doc-editor.ts');
  const problems: string[] = [];
  const cls = sf.statements.find(
    (s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && s.name?.text === className,
  );
  if (!cls) return { members: [], reactions: [], problems: [`class ${className} not found`] };
  const members = new Map<string, Member>();
  const reactions: string[] = [];
  for (const m of cls.members) {
    if (ts.isConstructorDeclaration(m) || ts.isClassStaticBlockDeclaration(m)) continue;
    if (!m.name || ts.isPrivateIdentifier(m.name)) continue;
    if (
      hasModifier(m, ts.SyntaxKind.PrivateKeyword) ||
      hasModifier(m, ts.SyntaxKind.ProtectedKeyword)
    )
      continue;
    const name = m.name.getText(sf);
    const isStatic = hasModifier(m, ts.SyntaxKind.StaticKeyword);
    if (!isStatic && REACTIONS.has(name)) {
      reactions.push(name);
      continue;
    }
    const key = `${isStatic ? 'static ' : ''}${name}`;
    if (ts.isMethodDeclaration(m)) {
      const params = m.parameters.map((p) => oneLine(p.getText(sf))).join(', ');
      const ret = m.type ? oneLine(m.type.getText(sf)) : 'unknown';
      members.set(key, {
        name,
        kind: 'method',
        static: isStatic,
        access: 'call',
        signature: `${name}(${params}): ${ret}`,
        summary: summary(m),
      });
    } else if (ts.isPropertyDeclaration(m)) {
      members.set(key, {
        name,
        kind: 'property',
        static: isStatic,
        access: hasModifier(m, ts.SyntaxKind.ReadonlyKeyword) ? 'read' : 'read/write',
        signature: m.type ? oneLine(m.type.getText(sf)) : 'unknown',
        summary: summary(m),
      });
    } else if (ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) {
      const before = members.get(key);
      const type = ts.isGetAccessorDeclaration(m) ? m.type : m.parameters[0]?.type;
      members.set(key, {
        name,
        kind: 'property',
        static: isStatic,
        access: before ? 'read/write' : ts.isGetAccessorDeclaration(m) ? 'read' : 'read/write',
        signature: type ? oneLine(type.getText(sf)) : (before?.signature ?? 'unknown'),
        summary: before?.summary || summary(m),
      });
    }
  }
  if (members.size === 0) problems.push(`class ${className} has no public member`);
  return { members: [...members.values()], reactions, problems };
}

export function extractAttributes(source: string): { attributes: string[]; problems: string[] } {
  const sf = parse(source, 'doc-editor.ts');
  for (const s of sf.statements) {
    if (!ts.isVariableStatement(s)) continue;
    for (const d of s.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || d.name.text !== 'OBSERVED_ATTRIBUTES' || !d.initializer)
        continue;
      let init: ts.Expression = d.initializer;
      if (ts.isAsExpression(init)) init = init.expression;
      if (ts.isArrayLiteralExpression(init))
        return {
          attributes: init.elements.filter(ts.isStringLiteralLike).map((e) => e.text),
          problems: [],
        };
    }
  }
  return { attributes: [], problems: ['OBSERVED_ATTRIBUTES not found'] };
}

export function extractEvents(source: string): { events: EventEntry[]; problems: string[] } {
  const sf = parse(source, 'events.ts');
  const problems: string[] = [];
  const map = sf.statements.find(
    (s): s is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(s) && s.name.text === 'DocEditorEventMap',
  );
  if (!map) return { events: [], problems: ['interface DocEditorEventMap not found'] };
  const events: EventEntry[] = [];
  for (const m of map.members) {
    if (!ts.isPropertySignature(m) || !m.type) continue;
    events.push({
      name: ts.isStringLiteral(m.name) ? m.name.text : m.name.getText(sf),
      detail: oneLine(m.type.getText(sf)),
      summary: summary(m),
    });
  }
  // EVENT_NAMES lists the same events, in the same order (events.ts).
  const names = sf.statements.flatMap((s) =>
    ts.isVariableStatement(s)
      ? s.declarationList.declarations.flatMap((d) => {
          if (!ts.isIdentifier(d.name) || d.name.text !== 'EVENT_NAMES' || !d.initializer)
            return [];
          let init: ts.Expression = d.initializer;
          while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init)) init = init.expression;
          return ts.isArrayLiteralExpression(init)
            ? init.elements.filter(ts.isStringLiteralLike).map((e) => e.text)
            : [];
        })
      : [],
  );
  if (names.length === 0) problems.push('EVENT_NAMES not found');
  else if (names.join() !== events.map((e) => e.name).join())
    problems.push('EVENT_NAMES and DocEditorEventMap list different events');
  return { events, problems };
}

function configKeys(schema: unknown): { keys: ConfigKey[]; problems: string[] } {
  const props = (schema as { properties?: Record<string, Record<string, unknown>> }).properties;
  if (!props) return { keys: [], problems: ['the configuration schema has no properties'] };
  const keys = Object.entries(props).map(([name, p]) => {
    const type = Array.isArray(p['enum'])
      ? (p['enum'] as unknown[]).map((v) => JSON.stringify(v)).join(' | ')
      : typeof p['type'] === 'string'
        ? p['type']
        : p['oneOf'] || p['anyOf']
          ? 'see the schema'
          : 'unknown';
    return {
      name,
      type,
      default: 'default' in p ? JSON.stringify(p['default']) : null,
      summary: oneLine(String(p['description'] ?? '')),
    };
  });
  return { keys, problems: [] };
}

function version(source: string, name: string): string | null {
  return new RegExp(`export const ${name}\\s*=\\s*'([^']+)'`).exec(source)?.[1] ?? null;
}

const cell = (text: string) => text.replace(/\|/g, '\\|');

export function buildEmbeddingReference(input: ReferenceInput): ReferenceResult {
  const problems: string[] = [];
  const m = extractMembers(input.docEditorSource, 'DocEditorElement');
  const a = extractAttributes(input.docEditorSource);
  const e = extractEvents(input.eventsSource);
  const c = configKeys(input.configSchema);
  problems.push(...m.problems, ...a.problems, ...e.problems, ...c.problems);
  const embeddingVersion = version(input.versionSource, 'EMBEDDING_VERSION');
  const release = version(input.versionSource, 'RELEASE');
  if (!embeddingVersion || !release)
    problems.push('version.ts has no EMBEDDING_VERSION or RELEASE');
  if (input.commands.length === 0) problems.push('no command identifiers were given');
  const tag = /DEFAULT_TAG\s*=\s*'([^']+)'/.exec(input.docEditorSource)?.[1] ?? 'doc-editor';
  const reference: Reference = {
    tag: tag ?? '',
    embeddingVersion: embeddingVersion ?? '',
    release: release ?? '',
    attributes: a.attributes,
    members: m.members,
    reactions: m.reactions,
    events: e.events,
    commands: [...input.commands].sort((x, y) => x.id.localeCompare(y.id)),
    config: c.keys,
  };

  const md: string[] = [
    '# Embedding reference of `<doc-editor>`',
    '',
    `Embedding API version ${reference.embeddingVersion} (major 0: not frozen), release ${reference.release}. Generated by \`packages/ui/scripts/generate.ts\` from \`packages/element/src\` and the command registry; never edited by hand. The integration guide (\`apps/reference-host/docs/integration-guide.md\`) explains how to use it. All names are working names (SPK-007).`,
    '',
    '## Attributes',
    '',
    'Set on the element in markup or with `setAttribute`. Changing one reconciles the editor (02 section 2.1).',
    '',
    ...reference.attributes.map((x) => `- \`${x}\``),
    '',
    '## Properties and methods',
    '',
    '| Name | Kind | Access | Type or signature | What it does |',
    '|---|---|---|---|---|',
    ...reference.members.map(
      (x) =>
        `| \`${x.static ? 'static ' : ''}${x.name}\` | ${x.kind} | ${x.access} | \`${cell(x.signature)}\` | ${cell(x.summary)} |`,
    ),
    '',
    `The standard custom element reactions (${reference.reactions.map((r) => `\`${r}\``).join(', ')}) are called by the browser, not by a host.`,
    '',
    '## Events',
    '',
    'Raised on the element as `CustomEvent`s that bubble and are composed; `detail` is the type shown.',
    '',
    '| Event | Detail | When |',
    '|---|---|---|',
    ...reference.events.map(
      (x) => `| \`${x.name}\` | \`${cell(x.detail)}\` | ${cell(x.summary)} |`,
    ),
    '',
    '## Commands',
    '',
    'The identifiers `exec` and `queryCommand` accept, with their other accepted names and keys.',
    '',
    '| Identifier | Group | Capability | Keys | Other names |',
    '|---|---|---|---|---|',
    ...reference.commands.map(
      (x) =>
        `| \`${x.id}\` | ${x.group} | ${x.capability} | ${x.keys.map((k) => `\`${k}\``).join(', ')} | ${x.aliases.map((k) => `\`${k}\``).join(', ')} |`,
    ),
    '',
    '## Configuration',
    '',
    'The `config` property. Keys the component does not know are ignored, and a value of the wrong type leaves the default (05 section 8.1).',
    '',
    '| Key | Type | Default | What it does |',
    '|---|---|---|---|',
    ...reference.config.map(
      (x) =>
        `| \`${x.name}\` | ${cell(x.type)} | ${x.default === null ? 'none' : `\`${x.default}\``} | ${cell(x.summary)} |`,
    ),
    '',
  ];
  return {
    problems,
    reference,
    artifacts: [
      { path: REFERENCE_JSON, text: `${JSON.stringify(reference, null, 2)}\n` },
      { path: REFERENCE_MARKDOWN, text: md.join('\n') },
    ],
  };
}
