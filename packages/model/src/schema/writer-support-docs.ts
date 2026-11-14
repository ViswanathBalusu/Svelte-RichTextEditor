/**
 * The published writer-support table (03 §10; CDM-046), generated from the data in
 * src/definition/writer-support.ts, as Markdown for people and JSON for the converters' preflight.
 */
import type { CdmDefinition } from '../definition/grammar.ts';
import {
  FIELD_KIND_SUPPORT,
  MARK_SUPPORT,
  NODE_SUPPORT,
  PAGE_SETUP_FEATURES,
  PAGE_SETUP_SUPPORT,
  type WriterSupport,
} from '../definition/writer-support.ts';

const LABEL: Record<WriterSupport['latex'], string> = {
  supported: 'Supported',
  partial: 'Partial',
  fallback: 'Fallback',
  notApplicable: 'Not applicable',
};

interface Section {
  title: string;
  key: 'nodes' | 'marks' | 'fieldKinds' | 'pageSetup';
  rows: Array<[string, WriterSupport]>;
}

function sections(def: CdmDefinition): Section[] {
  const pick = (rec: Readonly<Record<string, WriterSupport>>, keys: readonly string[]) =>
    keys.flatMap((k): Array<[string, WriterSupport]> =>
      Object.hasOwn(rec, k) ? [[k, rec[k]!]] : [],
    );
  const kinds = def.nodes.find((n) => n.name === 'field')?.attrs['kind']?.grammar;
  return [
    {
      title: 'Nodes',
      key: 'nodes',
      rows: pick(
        NODE_SUPPORT,
        def.nodes.map((n) => n.name),
      ),
    },
    {
      title: 'Marks',
      key: 'marks',
      rows: pick(
        MARK_SUPPORT,
        def.marks.map((m) => m.name),
      ),
    },
    {
      title: 'Field kinds',
      key: 'fieldKinds',
      rows: pick(FIELD_KIND_SUPPORT, kinds?.kind === 'enum' ? kinds.values : []),
    },
    {
      title: 'Page-setup features',
      key: 'pageSetup',
      rows: pick(PAGE_SETUP_SUPPORT, Object.keys(PAGE_SETUP_FEATURES)),
    },
  ];
}

export function generateWriterSupportJson(def: CdmDefinition): unknown {
  const out: Record<string, unknown> = {
    cdm: def.cdm,
    status: def.status,
    levels: ['supported', 'partial', 'fallback', 'notApplicable'],
    pageSetupFeatures: PAGE_SETUP_FEATURES,
  };
  for (const s of sections(def)) out[s.key] = Object.fromEntries(s.rows);
  return out;
}

export function generateWriterSupportDocs(def: CdmDefinition): string {
  const esc = (s: string) => s.replace(/\|/g, '\\|');
  const out: string[] = [
    `# CDM ${def.cdm} writer support (${def.status})`,
    '',
    'Generated from `packages/model/src/definition/writer-support.ts` by `pnpm generate`. Do not edit by hand. What the LaTeX (PDF) writer and the DOCX writer do with each construct of the model (03 §10). No construct says "no": a construct enters the model only when LaTeX can typeset it and DOCX can approximate it (03 §1 principle 4). Rows whose source is `proposed` have no row in 03 §10; they are proposed in docs/adr/0031-cdm-1-model-completion.md.',
    '',
  ];
  for (const s of sections(def)) {
    out.push(
      `## ${s.title}`,
      '',
      '| Construct | LaTeX (PDF) | DOCX | Notes | Source |',
      '|---|---|---|---|---|',
    );
    for (const [name, w] of s.rows) {
      const what =
        s.title === 'Page-setup features'
          ? `\`${name}\` (${(PAGE_SETUP_FEATURES[name] ?? []).map((a) => `\`${a}\``).join(', ')})`
          : `\`${name}\``;
      out.push(
        `| ${what} | ${LABEL[w.latex]} | ${LABEL[w.docx]} | ${esc((w.notes ?? []).join(' '))} | ${esc(w.source)} |`,
      );
    }
    out.push('');
  }
  return out.join('\n');
}
