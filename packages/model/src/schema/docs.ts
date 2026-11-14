/**
 * Generates the attribute tables of the CDM (CDM-002: "each attribute has a row giving its type,
 * range, length, pattern and default"; CDM-006: the tables used by documentation).
 */
import type {
  CdmDefinition,
  Grammar,
  MarkDef,
  NodeDef,
  ProjectionNodeDef,
} from '../definition/grammar.ts';
import { refPattern } from '../validate/grammar-check.ts';

function typeName(g: Grammar): string {
  switch (g.kind) {
    case 'string':
      return 'string';
    case 'integer':
      return 'integer';
    case 'boolean':
      return 'boolean';
    case 'enum':
      return 'enumeration';
    case 'ref':
      return `reference (${g.to})`;
    case 'object':
      return 'object';
    case 'array':
      return `array of ${typeName(g.items)}`;
    case 'json':
      return g.objectOnly ? 'JSON object' : 'JSON';
    case 'elementTree':
      return 'element tree';
  }
}

function constraint(g: Grammar): string {
  const esc = (s: string) => s.replace(/\|/g, '\\|');
  switch (g.kind) {
    case 'string': {
      const parts = [`length ${g.minLength ?? 0} to ${g.maxLength}`];
      if (g.pattern) parts.push(`pattern \`${esc(g.pattern)}\``);
      return parts.join('; ');
    }
    case 'integer':
      return `${g.min} to ${g.max}`;
    case 'enum':
      return g.values.map((v) => `\`${v}\``).join(', ');
    case 'ref':
      return `pattern \`${esc(refPattern(g.to))}\``;
    case 'object':
      return Object.entries(g.properties)
        .map(([k, v]) =>
          `\`${k}\`${(g.required ?? []).includes(k) ? '' : '?'}: ${typeName(v)} ${constraint(v)}`.trim(),
        )
        .join('; ');
    case 'array':
      return `${g.minItems ?? 0} to ${g.maxItems} items; items: ${constraint(g.items)}`;
    case 'json':
      return `at most ${g.maxBytes} bytes, depth ${g.maxDepth}, integers only${g.keyPattern ? `; keys \`${esc(g.keyPattern)}\`` : ''}`;
    case 'elementTree':
      return `at most ${g.maxBytes} bytes, depth ${g.maxDepth}; names with a registered prefix, or in Clark notation for other namespaces${g.noRef ? '' : '; or `{ "ref": id }` of a shared tree'}`;
    case 'boolean':
      return '';
  }
}

function table(def: NodeDef | MarkDef | ProjectionNodeDef): string[] {
  const rows = Object.entries(def.attrs).map(([k, a]) => {
    const notes = [
      a.presence === 'required' ? 'required in a stored document' : '',
      a.feature ? `feature \`${a.feature}\`` : '',
      ...Object.entries(a.valueFeatures ?? {}).map(
        ([value, feature]) => `value \`${value}\` needs feature \`${feature}\``,
      ),
      ...Object.entries(a.reportAs ?? {}).map(([kind, inv]) =>
        kind === '*' ? `grammar problems are ${inv}` : `${kind} problems are ${inv}`,
      ),
      a.doc,
    ]
      .filter(Boolean)
      .join('; ')
      .replace(/\|/g, '\\|');
    return `| \`${k}\` | ${typeName(a.grammar)}${a.grammar.nullable ? ' or null' : ''} | ${constraint(a.grammar).replace(/\n/g, ' ')} | \`${JSON.stringify(a.default)}\` | ${notes} |`;
  });
  if (!rows.length) return ['No attributes.'];
  return [
    '| Attribute | Type | Range, length or pattern | Default | Notes |',
    '|---|---|---|---|---|',
    ...rows,
  ];
}

export function generateDocs(def: CdmDefinition): string {
  const out: string[] = [
    `# CDM ${def.cdm} attributes (${def.status})`,
    '',
    'Generated from `packages/model/src/definition` by `pnpm generate`. Do not edit by hand. The rules behind the values are in docs/adr/0018-cdm-attribute-grammars.md; the canonical form omits every attribute equal to its default (03 §2).',
    '',
    '## Features',
    '',
    ...def.features.map((f) => `- \`${f.name}\`: ${f.doc}`),
    '',
    '## Nodes',
    '',
  ];
  for (const n of def.nodes) {
    const facts = [
      n.content ? `content \`${n.content}\`` : 'no content',
      n.group ? `groups \`${n.group}\`` : '',
      n.inline ? 'inline' : '',
      n.atom ? 'atom' : '',
      n.isolating ? 'isolating' : '',
      n.selectable === false ? 'not selectable' : '',
      n.marks !== undefined ? `node marks on children: \`${n.marks}\`` : '',
      n.feature ? `feature \`${n.feature}\`` : '',
    ].filter(Boolean);
    out.push(
      `### \`${n.name}\``,
      '',
      `${n.doc} (${n.spec})`,
      '',
      `${facts.join('; ')}.`,
      '',
      ...table(n),
      '',
    );
  }
  out.push('## Marks', '', 'In schema order; the order is part of the canonical form.', '');
  def.marks.forEach((m, i) => {
    const facts = [
      `position ${i + 1}`,
      m.excludes === '' ? 'excludes nothing' : '',
      m.inclusive === false ? 'not inclusive' : '',
      m.feature ? `feature \`${m.feature}\`` : '',
    ].filter(Boolean);
    out.push(
      `### \`${m.name}\``,
      '',
      `${m.doc} (${m.spec})`,
      '',
      `${facts.join('; ')}.`,
      '',
      ...table(m),
      '',
    );
  });
  const projection = def.projection ?? [];
  if (projection.length) {
    out.push(
      '## Projections',
      '',
      "Nodes that only a reader's projection contains (ADR 0019). A stored document or a commit never contains them, and `model.validate()` refuses them (I1). The projection schema is the CDM schema plus these nodes (spec/cdm/cdm-1.projection.json).",
      '',
    );
    for (const p of projection) {
      const facts = [
        `in the content of ${p.allowedIn.map((h) => `\`${h}\``).join(', ')}`,
        p.atom ? 'atom' : '',
        p.selectable === true ? 'selectable whole' : '',
        p.content === undefined ? 'no position inside it' : '',
      ].filter(Boolean);
      out.push(
        `### \`${p.name}\``,
        '',
        `${p.doc} (${p.spec})`,
        '',
        `${facts.join('; ')}.`,
        '',
        ...table(p),
        '',
      );
    }
  }
  return out.join('\n');
}
