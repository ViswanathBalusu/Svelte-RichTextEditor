/**
 * The converter (09 §1): a CDM envelope (the requester's projection, ADR 0019), a font manifest,
 * the job's assets and options in; a LaTeX bundle out. Pure: no clock, no randomness, no
 * environment, so the same input gives a byte-identical bundle (EXP-002).
 *
 * The shared semantics come from `@docedit/model` (ADR 0032): the cascade (`resolveParagraph`,
 * `resolveRun`), every label (`computeLabels`, with the counter effects of hidden regions),
 * paragraph gaps (`paragraphGap`), kept spaces (`spaceRuns`), dates (`dateFieldText`) and
 * references (`referenceText`). The converter keeps no second copy of any of them.
 */
import {
  computeLabels,
  sha256Hex,
  sha256HexBytes,
  styleTable,
  type CdmEnvelope,
  type TreeNode,
} from '@docedit/model';
import type { Bundle, BundleManifest, ConvertOptions, Diagnostic, SourceMap } from './bundle.ts';
import { bundleHashInput, canonicalJson } from './bundle-hash.ts';
import { block, closeLists, flowBlocks, newFlow } from './blocks.ts';
import { appendCertificate } from './certificate.ts';
import { settleSuggestions } from './suggestions.ts';
import { computeCitations } from './citations.ts';
import {
  attr,
  diag,
  enumOf,
  line,
  str,
  type Ctx,
  type FamilyInfo,
  type J,
  type Out,
} from './context.ts';
import {
  dimen,
  EMPTY,
  enumLookup,
  fontFile,
  int,
  join,
  kvValue,
  lit,
  tex,
  text,
  type Tex,
} from './emit.ts';
import { ALLOW_LIST } from './math/allow-list.ts';
import { mergeRanges, type CodeRange } from './fonts/coverage.ts';
import { LANGUAGES } from './languages.ts';
import { pageSetups, setupIndex, setupTex, storiesTex } from './page.ts';
import { preflight } from './preflight.ts';
import { styleMacro } from './props.ts';

/** The house class version (EXP-015): raised with every change to docedit.cls or docedit.lua. */
export const CLASS_VERSION = '0.2.14';

/** A TeX Live image digest (EXP-073): `sha256:` and 64 lowercase hex digits. */
export const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** Features this converter reads (03 §2: a reader that lacks one MUST refuse the document). */
export const SUPPORTED_FEATURES: readonly string[] = ['fields', 'extensions', 'preserve'];

const t = lit;

const TAGGING: Readonly<Record<string, Tex>> = { on: t('on'), draft: t('draft'), off: t('off') };
const STANDARDS: Readonly<Record<string, Tex>> = {
  'ua-2+a-4f': t('pdfstandard={ua-2,a-4f}, '),
  'ua-2': t('pdfstandard=ua-2, '),
  'a-4f': t('pdfstandard=a-4f, '),
  none: EMPTY,
};
const RENDERERS: Readonly<Record<string, Tex>> = { node: t('node'), harf: t('harf') };
const LAYOUTS: Readonly<Record<string, Tex>> = {
  off: t('off'),
  block: t('block'),
  line: t('line'),
};

/** Walks every node of the document in document order. */
function walk(node: J, f: (n: J, parents: readonly J[]) => void, parents: J[] = []): void {
  f(node, parents);
  parents.push(node);
  for (const c of node.content ?? []) walk(c, f, parents);
  parents.pop();
}

function familiesOf(options: ConvertOptions): { map: Map<string, FamilyInfo>; def: FamilyInfo } {
  const map = new Map<string, FamilyInfo>();
  options.fonts.families.forEach((family, i) => {
    const faces = [family.regular, family.bold, family.italic, family.boldItalic];
    const coverage = faces.every((f) => f.coverage)
      ? mergeRanges(faces.flatMap((f) => f.coverage!))
      : null;
    map.set(family.name, { n: i + 1, family, coverage });
  });
  const def = map.get(options.fonts.defaultFamily) ?? [...map.values()][0];
  if (!def) throw new RangeError('the font manifest has no family');
  return { map, def };
}

function fallbackCoverage(options: ConvertOptions): CodeRange[][] | null {
  const chain = options.fonts.fallback ?? [options.fonts.math];
  return chain.every((f) => f.coverage) ? chain.map((f) => f.coverage!) : null;
}

/** The source map (EXP-012). */
function sourceMap(ctx: Ctx): SourceMap {
  const lines: SourceMap['lines'] = [];
  ctx.out.owners.forEach((owner, i) => {
    const last = lines[lines.length - 1];
    if (last && last.block === owner && last.to === i) last.to = i + 1;
    else lines.push({ from: i + 1, to: i + 1, block: owner });
  });
  const fields = ctx.fieldIds.length > 1 ? { fields: ctx.fieldIds } : {};
  const tables = ctx.tableRows.size ? { tables: Object.fromEntries(ctx.tableRows) } : {};
  return {
    version: 1,
    blocks: ctx.blocks,
    kinds: ctx.kinds,
    owners: ctx.owners,
    lines,
    setups: ctx.setups,
    ...fields,
    ...tables,
  };
}

export async function convert(input: CdmEnvelope, options: ConvertOptions): Promise<Bundle> {
  // The certificate of completion (FRW-050) is appended to the body before anything reads it, so
  // that the checks and the numbering see it like the rest of the document.
  const envelope = options.certificate
    ? ({
        ...input,
        doc: appendCertificate(
          input.doc as unknown as Record<string, unknown>,
          options.certificate,
        ),
      } as unknown as CdmEnvelope)
    : input;
  const o = {
    tagging: options.tagging ?? 'on',
    pdfStandard: options.pdfStandard ?? 'ua-2+a-4f',
    renderer: options.renderer ?? 'node',
    layout: options.layout ?? 'line',
    profile: options.profile ?? 'final',
    fields: options.fields ?? 'flatten',
    suggestions: options.suggestions ?? null,
  } as const;
  const imageDigest = options.imageDigest ?? null;
  if (imageDigest !== null && !IMAGE_DIGEST_PATTERN.test(imageDigest))
    throw new RangeError(
      'the image digest must be "sha256:" and 64 lowercase hex digits (EXP-073)',
    );
  const diagnostics: Diagnostic[] = [];
  for (const feature of envelope.requires ?? []) {
    if (!SUPPORTED_FEATURES.includes(feature))
      diagnostics.push({
        severity: 'error',
        code: 'unsupported_feature',
        blockId: null,
        message: `the document requires "${feature}", which this converter cannot read (03 §2)`,
      });
  }
  const doc = settleSuggestions(envelope.doc as unknown as J, o.suggestions, diagnostics);
  const table = styleTable(doc as unknown as TreeNode);
  const labels = computeLabels(doc as unknown as TreeNode, {
    table,
    ...(options.counterEffects ? { effects: options.counterEffects } : {}),
  });
  const fam = familiesOf(options);
  const defs = (doc.content ?? []).find((c) => c.type === 'defs');
  const body = (doc.content ?? []).find((c) => c.type === 'body');
  const stories = new Map<string, J>();
  for (const c of doc.content ?? [])
    if (c.type === 'story' && typeof c.attrs?.['id'] === 'string') stories.set(c.attrs['id'], c);
  const sources = new Map<string, J>();
  for (const d of defs?.content ?? [])
    if (d.type === 'source_def' && typeof d.attrs?.['id'] === 'string')
      sources.set(d.attrs['id'], d);

  const ctx: Ctx = {
    options,
    o,
    doc,
    table,
    labels,
    families: fam.map,
    defaultFamily: fam.def,
    fallbackCoverage: fallbackCoverage(options),
    assets: options.assets ?? {},
    diagnostics,
    warned: new Set(),
    blocks: [null],
    kinds: [''],
    owners: [null],
    tableRows: new Map(),
    out: { lines: [], owners: [], current: null },
    anchors: new Map(),
    refTargets: new Set(),
    styleMacros: new Map(),
    styleLines: [],
    tabLists: new Map(),
    borderLists: new Map(),
    styleRefs: new Map(),
    seqCursor: new Map(),
    assetFiles: new Map(),
    redactions: [],
    languages: new Map(),
    captionLists: new Map(),
    formFields: new Map(),
    fieldIds: [null],
    setups: [],
    projection: false,
    captionHolders: new Map(),
    citations: { byNode: new Map(), entries: [] },
    markedStyles: new Map(),
    state: { columns: 1, setup: 0 },
  };
  for (const p of labels.problems) diag(ctx, 'warning', p.code, null, p.message);
  // The preflight is the one check of the document's own text and pictures (EXP-003, EXP-026, EXP-113).
  // A table in a multi-column section, a header or a footer is reported once, by the table writer
  // when it sets the box (tables.ts), so the job does not carry the same warning twice.
  for (const w of preflight(envelope, options.fonts))
    if (w.code !== 'table_cannot_span_pages')
      diag(
        ctx,
        w.code === 'glyph_missing' && o.profile === 'final' ? 'error' : 'warning',
        w.code,
        w.blockId,
        w.message,
      );

  // Pre-scan, in document order: anchors, reference targets, styleRef styles, caption lists,
  // form fields by key, citations, and whether this is a projection.
  const citations: Array<{ node: J; blockId: string | null }> = [];
  let projection = false;
  const pageRefs = new Set<string>();
  walk(doc, (n, parents) => {
    if (n.type === 'hidden_region') projection = true;
    if (n.type === 'anchor') {
      const name = str(attr(n, 'name'));
      if (name && !ctx.anchors.has(name)) ctx.anchors.set(name, ctx.anchors.size + 1);
    } else if (n.type === 'field') {
      const kind = str(attr(n, 'kind'));
      const target = str(attr(n, 'target'));
      const format = str(attr(n, 'format'));
      if (kind === 'ref' && target && format !== null && /page/i.test(format)) pageRefs.add(target);
      if (kind === 'styleRef' && target?.startsWith('style:')) {
        const style = target.slice('style:'.length);
        if (!ctx.markedStyles.has(style)) ctx.markedStyles.set(style, ctx.markedStyles.size + 1);
      }
    } else if (n.type === 'toc') {
      const of = str(attr(n, 'of'));
      if (of && of !== 'headings' && !ctx.captionLists.has(of))
        ctx.captionLists.set(of, ctx.captionLists.size + 1);
    } else if (n.type === 'form_field') {
      const key = str(attr(n, 'key'));
      if (key) ctx.formFields.set(key, n);
    } else if (n.type === 'citation') {
      const holder = [...parents].reverse().find((p) => typeof p.attrs?.['id'] === 'string');
      citations.push({ node: n, blockId: str(holder?.attrs?.['id']) });
    }
  });
  for (const target of pageRefs) {
    if (target.startsWith('bookmark:')) {
      const a = ctx.anchors.get(target.slice('bookmark:'.length));
      if (a !== undefined) ctx.anchors.set(`ref:${target}`, a);
    } else ctx.anchors.set(`ref:${target}`, ctx.anchors.size + 1);
  }
  for (const [holder, list] of labels.sequences)
    ctx.captionHolders.set(holder, [
      ...new Set(list.map((s) => s.name).filter((x): x is string => x !== null)),
    ]);
  const bibliography = (body?.content ?? [])
    .flatMap((b) => (b.type === 'region' ? (b.content ?? []) : [b]))
    .find((b) => b.type === 'bibliography');
  const include = str(attr(bibliography, 'include')) === 'all' ? 'all' : 'cited';
  const cites = computeCitations({ diagnostics, table, doc }, citations, sources, include);
  (ctx as { projection: boolean }).projection = projection;
  (ctx as { citations: Ctx['citations'] }).citations = {
    byNode: cites.byNode,
    entries: cites.entries,
  };

  // Body first, so that styles, tab lists, languages and setups are known for the preamble.
  const setups = pageSetups(ctx);
  const bodySetup = str(attr(body, 'pageSetup'));
  const firstSetup = bodySetup && setups.has(bodySetup) ? bodySetup : [...setups.keys()][0];
  if (firstSetup) {
    ctx.state.setup = setupIndex(ctx, firstSetup);
    ctx.state.columns = Math.max(1, Math.min(16, Number(setups.get(firstSetup)?.['columns'] ?? 1)));
  } else
    diag(
      ctx,
      'warning',
      'page_setup_missing',
      null,
      'the document has no page setup; A4 with 1-inch margins is used',
    );
  const flow = newFlow('body', null, null);
  for (const node of body?.content ?? []) block(ctx, flow, node);
  closeLists(ctx, flow, () => false);
  line(ctx, t('\\DEendsections'));
  const bodyOut = ctx.out;
  // Table of contents entries take the TOC1 to TOC9 styles when the document has them.
  for (let level = 1; level <= 9; level++) {
    const s = ctx.table.styles.has(`TOC${level}`) ? styleMacro(ctx, `TOC${level}`) : null;
    if (s) ctx.styleLines.push(tex`\DEtocstyle{${int(level)}}{${s.macro}}`);
  }
  // One macro per style the document defines, used or not (09 §2, EXP-013 criterion 1). This runs
  // after the body and the TOC, so the styles in use keep the macro names they already had.
  for (const id of ctx.table.styles.keys()) styleMacro(ctx, id);

  // Page setups and the stories they name.
  ctx.out = { lines: [], owners: [], current: null };
  const setupLines: Tex[] = ctx.setups.map((id, k) => setupTex(ctx, k, setups.get(id) ?? {}));
  if (ctx.setups.length === 0) setupLines.push(setupTex(ctx, 0, {}));
  storiesTex(ctx, stories, (f, nodes) => flowBlocks(ctx, f, nodes));
  const storyOut = ctx.out;

  // The preamble.
  ctx.out = { lines: [], owners: [], current: null };
  const settings = (defs?.content ?? []).find((d) => d.type === 'settings')?.attrs ?? {};
  const docLang = str(settings['lang']);
  const lang = docLang && Object.hasOwn(LANGUAGES, docLang) ? LANGUAGES[docLang]! : null;
  if (docLang && !lang)
    diag(
      ctx,
      'warning',
      'language_unknown',
      null,
      `the document language "${docLang.slice(0, 64)}" has no entry; English is used`,
    );
  const pdfLang = lang?.tag ?? t('en');
  // tagpdf names its user namespace with \int_rand (TeX's \uniformdeviate), which is seeded from
  // the clock; a fixed seed keeps the PDF byte-identical from run to run (09 §9.4, EXP-076).
  line(ctx, t('\\setrandomseed 20261106\\relax'));
  if (o.tagging !== 'none') {
    const wantsUa = o.pdfStandard.startsWith('ua-2');
    const standard =
      wantsUa && o.tagging !== 'on'
        ? enumLookup(STANDARDS, 'a-4f', EMPTY).tex
        : enumOf(ctx, STANDARDS, o.pdfStandard, EMPTY, null, 'a PDF standard');
    if (wantsUa && o.tagging !== 'on')
      diag(
        ctx,
        'warning',
        'standard_needs_tagging',
        null,
        'PDF/UA-2 needs full tagging; only PDF/A-4f is declared',
      );
    line(
      ctx,
      tex`\DocumentMetadata{lang=${pdfLang}, pdfversion=2.0, ${standard}tagging=${enumOf(ctx, TAGGING, o.tagging, t('on'), null, 'a tagging mode')}, testphase={table}}`,
    );
  }
  line(
    ctx,
    tex`\documentclass[renderer=${enumOf(ctx, RENDERERS, o.renderer, t('node'), null, 'a renderer')},layout=${enumOf(ctx, LAYOUTS, o.layout, t('line'), null, 'a layout mode')},glyphs=${o.profile === 'preview' ? t('report') : t('strict')}]{docedit}`,
  );
  line(ctx, t('\\input{styles.tex}'));
  const hyphenation = settings['hyphenation'] === true;
  if (hyphenation || ctx.languages.size > 0) {
    line(ctx, tex`\DEbabel{${lang?.name ?? t('english')}}{${lang?.ini ?? t('en')}}`);
    for (const [tag, k] of ctx.languages) {
      const l = LANGUAGES[tag]!;
      line(ctx, tex`\DEdeflang{${int(k)}}{${l.name}}{${l.ini}}{${l.tag}}`);
    }
  }
  if (hyphenation) line(ctx, t('\\DEhyphenation'));
  // The classification marking (EXP-089), escaped through the text emitter; empty means none.
  if (options.classification) line(ctx, tex`\DEdefclassification{${text(options.classification)}}`);
  for (const s of setupLines) line(ctx, s);
  line(ctx, tex`\DEgeometry{${int(firstSetup ? ctx.setups.indexOf(firstSetup) : 0)}}`);
  for (const [, k] of ctx.markedStyles) line(ctx, tex`\DEdefmark{${int(k)}}`);
  for (const [, k] of ctx.captionLists) line(ctx, tex`\DEdeflist{${int(k)}}`);
  line(ctx, tex`\hypersetup{pdftitle=${kvValue(options.title ?? 'Document')}}`);
  const preamble = ctx.out;

  // Assemble main.tex: preamble, stories, then the document.
  const all: Out = { lines: [], owners: [], current: null };
  const append = (o2: Out): void => {
    all.lines.push(...o2.lines);
    all.owners.push(...o2.owners);
  };
  append(preamble);
  append(storyOut);
  ctx.out = all;
  line(ctx, t('\\begin{document}'));
  line(ctx, tex`\DEstartsetup{${int(firstSetup ? ctx.setups.indexOf(firstSetup) : 0)}}`);
  append(bodyOut);
  ctx.out = all;
  line(ctx, t('\\end{document}'));

  // styles.tex: the fallback chain, the families, the math font, then styles and tab lists.
  const styleHead: Tex[] = [
    t('% styles.tex: generated by @docedit/export-latex; macro names are generated.'),
  ];
  for (const face of options.fonts.fallback ?? [options.fonts.math])
    styleHead.push(tex`\DEfallback{${fontFile(face.file)}}`);
  options.fonts.families.forEach((f, i) =>
    styleHead.push(
      tex`\DEdeffamily{${int(i + 1)}}{${int(f.lineHeight)}}{${fontFile(f.regular.file)}}{${fontFile(f.bold.file)}}{${fontFile(f.italic.file)}}{${fontFile(f.boldItalic.file)}}`,
    ),
  );
  const main = fam.def.family;
  styleHead.push(
    tex`\DEmainfamily{${fontFile(main.regular.file)}}{${fontFile(main.bold.file)}}{${fontFile(main.italic.file)}}{${fontFile(main.boldItalic.file)}}`,
  );
  styleHead.push(tex`\DEmathfont{${fontFile(options.fonts.math.file)}}`);
  styleHead.push(tex`\DEdefaulttab{${int(table.settings.defaultTabStop)}}`);
  styleHead.push(tex`\DEdefaultfamily{${int(fam.def.n)}}`);

  const map = sourceMap(ctx);
  const files: Record<string, string> = {
    'main.tex': ctx.out.lines.join('\n') + '\n',
    'styles.tex': join([...styleHead, ...ctx.styleLines], t('\n')) + '\n',
    'map.json': JSON.stringify(map) + '\n',
  };
  for (const [name, value] of Object.entries(options.classFiles)) files[name] = value;
  const assets: Record<string, Uint8Array> = {};
  const assetHashes: Record<string, string> = {};
  for (const [name, bytes] of ctx.assetFiles) {
    if (bytes) {
      assets[name] = bytes;
      assetHashes[name] = await sha256HexBytes(bytes);
    } else assetHashes[name] = name.slice('assets/'.length, 'assets/'.length + 64);
  }

  const hashes: Record<string, string> = {};
  for (const name of Object.keys(files).sort()) hashes[name] = await sha256Hex(files[name]!);
  for (const name of Object.keys(assetHashes).sort()) hashes[name] = assetHashes[name]!;
  const sortedHashes: Record<string, string> = {};
  for (const name of Object.keys(hashes).sort()) sortedHashes[name] = hashes[name]!;
  const faces = (f: { regular: unknown; bold: unknown; italic: unknown; boldItalic: unknown }) =>
    [f.regular, f.bold, f.italic, f.boldItalic] as { file: string; sha256: string }[];
  const manifest: BundleManifest = {
    bundleVersion: 1,
    seq: options.seq ?? null,
    chainHead: options.chainHead ?? null,
    imageDigest,
    cdm: envelope.cdm,
    classVersion: CLASS_VERSION,
    mathGate: {
      version: ALLOW_LIST.version,
      katex: ALLOW_LIST.katex,
      fingerprint: ALLOW_LIST.fingerprint,
    },
    fonts: [
      ...options.fonts.families.map((f) => ({
        family: f.name,
        files: faces(f).map((x) => ({ file: x.file, sha256: x.sha256 })),
        licence: f.licence,
        role: 'text',
      })),
      {
        family: options.fonts.math.name,
        files: [{ file: options.fonts.math.file, sha256: options.fonts.math.sha256 }],
        licence: options.fonts.math.licence,
        role: 'math',
      },
      ...(options.fonts.fallback ?? []).map((f) => ({
        family: f.name,
        files: [{ file: f.file, sha256: f.sha256 }],
        licence: f.licence,
        role: 'fallback',
      })),
    ],
    options: {
      profile: o.profile,
      tagging: o.tagging,
      pdfStandard: o.pdfStandard,
      renderer: o.renderer,
      layout: o.layout,
      fields: o.fields,
      suggestions: o.suggestions ?? 'none',
      title: options.title ?? 'Document',
      timeZone: options.timeZone ?? '',
      instant: options.instant ?? '',
      ...(options.classification ? { classification: options.classification } : {}),
      ...(options.certificate ? { certificate: 'on' } : {}),
    },
    redactions: ctx.redactions,
    files: sortedHashes,
    bundleHash: '',
  };
  // The options join the hash (EXP-005): an option that reaches no file still changes it.
  manifest.bundleHash = await sha256Hex(
    bundleHashInput(sortedHashes, await sha256Hex(canonicalJson(manifest.options))),
  );
  files['manifest.json'] = JSON.stringify(manifest, null, 2) + '\n';
  return {
    files,
    assets,
    map,
    manifest,
    diagnostics,
    ok: !diagnostics.some((d) => d.severity === 'error'),
  };
}

export { dimen };
