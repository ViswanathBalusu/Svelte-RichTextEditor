/**
 * CDM plus original package plus source map to DOCX, by patching the original package (ADR 0017,
 * part 1; EXP-118, EXP-119).
 *
 * - Every part the edits do not reach is copied raw: same compressed bytes, same CRC.
 * - In a modelled part, a node whose canonical hash equals its import hash is copied by byte range
 *   from the original part, gaps between blocks included. Only edited nodes are regenerated, from
 *   the model plus their preserved residue (props.ts), plus their identity-bound values from the
 *   source map.
 * - Preserved atoms are written from their fragments wherever they now are: a relationship the
 *   fragment refers to is reused while it still resolves in the part, and otherwise added and
 *   renumbered; content whose part belongs to one reference (a chart, an embedded object) gets its
 *   own copy of the part when the atom was copied (EXP-119).
 * - Relationships that only deleted content referred to are removed, and so are the parts that are
 *   then unreachable.
 *
 * Only payloads the import created are written back (owner decision 2, default; integrity.ts):
 * an unknown tree is left out, and an unknown atom is written as its fallback text.
 */
import {
  sha256HexBytes,
  utf8,
  type JsonEnvelope,
  type JsonMark,
  type JsonNode,
} from '@docedit/model';
import { CDM1, indexDefinition, type JsonValue } from '@docedit/model/definition';
import { type Asset, type Fragment, readFragment } from './assets.ts';
import { IMAGE_EXTENSIONS, docPrIds, newDrawing, patchDrawing } from './drawing.ts';
import {
  type ByteEdit,
  type ParsedFragment,
  addToStartTag,
  applyEdits,
  parseFragment,
  relationshipAttributes,
  setAttribute,
} from './fragments.ts';
import { NodeHasher } from './hash.ts';
import { gridElement } from './import.ts';
import { type Untrusted, untrustedCount, untrustedPayloads } from './integrity.ts';
import { SUGGESTION_MARKS, formattingKey, marksToValues } from './marks.ts';
import { NS, REL, RUN_CONTENT, UNIQUE_TARGET_TYPES, w } from './ooxml.ts';
import {
  type ContentTypes,
  type Relationship,
  type Relationships,
  parseContentTypes,
  parseRelationships,
  referencedRelIds,
  relsPartName,
  resolveTarget,
} from './opc.ts';
import { type Origin, isOrigin, modelledHash } from './origin.ts';
import {
  type LensContext,
  type MergedItem,
  type Values,
  PPR,
  RPR,
  SECTPR,
  SECTPR_FIRST,
  TBLPR,
  TCPR,
  TRPR,
  isRaw,
  mergeContainer,
} from './props.ts';
import { sharedTrees } from './share.ts';
import type { NodeSource, SourceMap } from './source-map.ts';
import {
  NamespaceWriter,
  type TreeBody,
  type TreeElement,
  canonicalTree,
  restoreIdentity,
  elementsOf,
  isTreeRef,
} from './tree.ts';
import { decodeUtf8 } from './utf8.ts';
import { escapeAttr, escapeText, parseXml } from './xml.ts';
import {
  type ZipArchive,
  type ZipEntry,
  type ZipWriteEntry,
  entryData,
  readZip,
  writeZip,
} from './zip.ts';

export class ExportError extends Error {
  override name = 'ExportError';
}

export interface AssetSource {
  get(id: string): Asset | undefined;
}

export type PartOutcome = 'copied' | 'patched' | 'removed' | 'added';

export interface ExportResult {
  bytes: Uint8Array;
  /** What happened to each part of the package. */
  parts: Record<string, PartOutcome>;
  /** Nodes written from the model instead of copied. */
  regenerated: string[];
  warnings: string[];
  /** Preserved payloads left out because the import did not create them (owner decision 2). */
  untrusted: number;
}

type Chunk = Uint8Array | string;

interface PartOut {
  part: string;
  bytes: Uint8Array;
  ns: NamespaceWriter;
  /** Prefix of the WordprocessingML namespace at the part's root. */
  wp: string;
  /** The default namespace at the part's root, if any. */
  defaultNs: string | undefined;
  rels: Relationships;
}

interface Holder {
  ps: string;
  start: string | null;
  index: number;
}

interface SectionPlan {
  holders: Map<string, Holder>;
  /** Section breaks whose preceding block holds no section properties: they get an empty paragraph to hold them. */
  orphanBreaks: Map<string, Holder>;
  final: Holder;
}

interface NewRel {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

interface AddedPart {
  copyOf?: ZipEntry;
  from?: ZipArchive;
  data?: Uint8Array;
  contentType: string | null;
}

const ix = indexDefinition(CDM1);

/** Node attributes with the schema defaults filled in, as the lenses expect. */
function withDefaults(node: JsonNode): Values {
  const def = ix.nodes.get(node.type);
  const out: Values = {};
  for (const [k, a] of Object.entries(def?.attrs ?? {}))
    out[k] = (node.attrs?.[k] ?? a.default) as JsonValue;
  return out;
}

const W_PPR = w('pPr');
const W_SECTPR = w('sectPr');
const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

class Writer {
  readonly zip: ZipArchive;
  readonly changed = new Map<string, Uint8Array>();
  readonly removed = new Set<string>();
  readonly added = new Map<string, AddedPart>();
  readonly newRels = new Map<string, NewRel[]>();
  readonly regenerated: string[] = [];
  readonly warnings: string[] = [];
  readonly defs = new Map<string, JsonNode>();
  readonly ctx: LensContext;
  private readonly hasher = new NodeHasher();
  private readonly synthetic: Set<string>;
  private readonly usedRevisionIds = new Set<string>();
  private nextRevisionId = 900_000;
  private readonly shared: Map<string, JsonValue>;
  private readonly sharedOwners = new Map<string, JsonNode>();
  private untrusted!: Untrusted;
  private readonly allowedFragments: ReadonlySet<string>;
  /** The node that keeps a fragment's own relationships; any other use is a copy (EXP-119). */
  private readonly primary = new Map<string, object>();
  private readonly docPr = new Map<string, number>();
  /** Picture parts written for assets, by asset id. */
  private readonly media = new Map<string, string>();
  private readonly headerRow = new WeakMap<JsonNode, boolean>();
  private ct: ContentTypes;

  readonly env: JsonEnvelope;
  readonly sm: SourceMap;
  readonly assets: AssetSource;
  /** Nodes regenerated even when unchanged, with their ancestors (the regeneration stress test). */
  private readonly force = new Set<string>();

  constructor(
    env: JsonEnvelope,
    original: Uint8Array,
    sm: SourceMap,
    assets: AssetSource,
    opts: ExportOptions,
  ) {
    this.env = env;
    this.sm = sm;
    this.assets = assets;
    this.zip = readZip(original);
    this.synthetic = new Set(sm.synthetic);
    this.allowedFragments = new Set(sm.fragments);
    this.shared = sharedTrees(env);
    this.ct = parseContentTypes(this.read('[Content_Types].xml'));
    if (opts.regenerate?.size) {
      const mark = (n: JsonNode): boolean => {
        let hit = typeof n.attrs?.['id'] === 'string' && opts.regenerate!.has(n.attrs['id']);
        for (const c of n.content ?? []) if (mark(c)) hit = true;
        if (hit && typeof n.attrs?.['id'] === 'string') this.force.add(n.attrs['id']);
        return hit;
      };
      for (const n of env.doc.content ?? []) mark(n);
    }
    const defs = env.doc.content?.find((n) => n.type === 'defs');
    for (const d of defs?.content ?? []) {
      if (typeof d.attrs?.['id'] === 'string') this.defs.set(d.attrs['id'], d);
      if (d.type === 'preserved_def' && typeof d.attrs?.['id'] === 'string')
        this.sharedOwners.set(d.attrs['id'], d);
    }
    const toCdm = new Map<string, { id: string; kind: string }>();
    for (const [id, wordId] of Object.entries(sm.styles)) {
      const def = this.defs.get(id);
      if (def) toCdm.set(wordId, { id, kind: String(def.attrs?.['kind'] ?? 'paragraph') });
    }
    const storyByRel = new Map(Object.entries(sm.stories).map(([id, s]) => [s.relId, id]));
    this.ctx = {
      styleToCdm: (wordId, kind) => {
        const s = toCdm.get(wordId);
        return s && s.kind === kind ? s.id : null;
      },
      styleToWord: (id) => sm.styles[id] ?? null,
      storyForRel: (rel) => storyByRel.get(rel) ?? null,
      relForStory: (id) => sm.stories[id]?.relId ?? null,
    };
  }

  read(name: string): Uint8Array {
    const e = this.zip.byName.get(name);
    if (!e) throw new ExportError(`the original package has no part ${name}`);
    return entryData(this.zip, e);
  }

  hash(node: JsonNode): Promise<string> {
    return this.hasher.hash(node);
  }

  async unchanged(node: JsonNode, src: { hash: string } | undefined): Promise<boolean> {
    return !!src && src.hash === (await this.hash(node));
  }

  partOut(part: string, bytes: Uint8Array): PartOut {
    const doc = parseXml(bytes);
    const ns = new NamespaceWriter(doc.root.scope);
    return {
      part,
      bytes,
      ns,
      wp: ns.rootPrefix(NS.w) ?? 'w',
      defaultNs: doc.root.scope.get(''),
      rels: parseRelationships(
        part,
        this.zip.byName.has(relsPartName(part)) ? this.read(relsPartName(part)) : undefined,
      ),
    };
  }

  async run(): Promise<ExportResult> {
    this.untrusted = await untrustedPayloads(this.env, new Set(this.sm.payloads));
    const left = untrustedCount(this.untrusted);
    if (left)
      this.warnings.push(
        `${left} preserved payload(s) did not come from the import and were left out (owner decision 2)`,
      );
    await this.planFragments();
    await this.checkDefinitions();
    const body = this.env.doc.content?.find((n) => n.type === 'body');
    if (!body) throw new ExportError('the document has no body');
    await this.mainPart(body);
    for (const story of this.env.doc.content?.filter((n) => n.type === 'story') ?? [])
      await this.story(story);
    this.writeNewRelationships();
    for (const [part, bytes] of [...this.changed])
      if (!part.endsWith('.rels') && part !== '[Content_Types].xml')
        this.cleanUpRelationships(part, bytes);
    this.writeContentTypes();
    return this.pack();
  }

  /** The prototype writes the body and the stories; it refuses edits to definitions it cannot patch yet. */
  async checkDefinitions(): Promise<void> {
    for (const [id, def] of this.defs) {
      if (def.type === 'page_setup' || def.type === 'preserved_def') continue;
      const src = this.sm.defs[id];
      if (!src) {
        if (def.type === 'style_def' && !this.synthetic.has(id))
          throw new ExportError(`new style ${id}: the patching writer does not add styles yet`);
        continue;
      }
      if (!(await this.unchanged(def, src)))
        throw new ExportError(
          `style ${id} was edited: the patching writer does not patch styles.xml yet`,
        );
    }
  }

  // -------------------------------------------------------------------------------------------
  // Preserved data.

  /** A tree, with a shared one resolved; null when it did not come from the import. */
  tree(value: JsonValue | undefined): TreeBody | null {
    if (value === null || value === undefined) return null;
    if (isTreeRef(value)) {
      const def = this.sharedOwners.get(value.ref);
      if (!def || this.untrusted.definition.has(def)) return null;
      return (this.shared.get(value.ref) ?? null) as TreeBody | null;
    }
    return value as unknown as TreeBody;
  }

  /**
   * The preserved tree of a node, with the identity-bound attributes the source map holds put back
   * (EXP-116): the document keeps none of them, so the writer restores them from the source.
   */
  preservedOf(node: JsonNode): TreeBody | null {
    if (this.untrusted.attribute.has(node)) return null;
    const tree = this.tree(node.attrs?.['preserved'] as JsonValue | undefined);
    const id = node.attrs?.['id'];
    const src = typeof id === 'string' ? (this.sm.nodes[id] ?? this.sm.defs[id]) : undefined;
    // A node whose only identity-bound values are in the source map still gets them back.
    if (!tree && !src?.identityTree?.length) return null;
    return restoreIdentity(tree ?? {}, src?.identityTree);
  }

  originOf(node: JsonNode): Origin | null {
    const o = node.attrs?.['origin'];
    if (!isOrigin(o) || this.untrusted.origin.has(node) || !this.allowedFragments.has(o.fragment))
      return null;
    return o;
  }

  /** A preserved atom's fragment, or null when the import did not create it for this document. */
  atomFragment(node: JsonNode): string | null {
    const f = node.attrs?.['fragment'];
    if (typeof f !== 'string' || this.untrusted.atom.has(node) || !this.allowedFragments.has(f))
      return null;
    return f;
  }

  /**
   * Decides which use of each fragment keeps its relationships (EXP-119): a use the writer copies
   * verbatim from the original part (a preserved block in place, an atom in an unedited
   * paragraph), else the first use in document order. Every other use is a copy.
   */
  async planFragments(): Promise<void> {
    const firsts = new Map<string, object>();
    const verbatim = new Map<string, object>();
    const fragmentOf = (n: JsonNode): string | null => {
      const f =
        n.type === 'preserved_block' || n.type === 'preserved_inline'
          ? n.attrs?.['fragment']
          : isOrigin(n.attrs?.['origin'])
            ? (n.attrs['origin'] as unknown as Origin).fragment
            : null;
      return typeof f === 'string' ? f : null;
    };
    const walk = async (n: JsonNode, part: string, copied: boolean): Promise<void> => {
      const id = typeof n.attrs?.['id'] === 'string' ? n.attrs['id'] : null;
      const src = id ? this.sm.nodes[id] : undefined;
      let inVerbatim = copied;
      if (!copied && src && src.part === part && !this.force.has(id!))
        inVerbatim =
          n.type === 'preserved_block' ||
          ((n.type === 'paragraph' || n.type.startsWith('table')) &&
            (await this.unchanged(n, src)));
      const f = fragmentOf(n);
      if (f) {
        if (!firsts.has(f)) firsts.set(f, n);
        if (inVerbatim && !verbatim.has(f)) verbatim.set(f, n);
      }
      for (const c of n.content ?? []) await walk(c, part, inVerbatim);
    };
    for (const n of this.env.doc.content ?? []) {
      if (n.type === 'body') await walk(n, this.sm.mainPart, false);
      else if (n.type === 'story') {
        const s = this.sm.stories[String(n.attrs?.['id'])];
        if (s) await walk(n, s.part, false);
      }
    }
    for (const [f, n] of firsts) this.primary.set(f, verbatim.get(f) ?? n);
  }

  // -------------------------------------------------------------------------------------------
  // Parts.

  async mainPart(body: JsonNode): Promise<void> {
    const part = this.sm.mainPart;
    const bytes = this.read(part);
    const po = this.partOut(part, bytes);
    const cs = this.sm.containers['body'];
    if (!cs) throw new ExportError('the source map has no body container');
    const plan = this.sectionPlan(body);
    const chunks: Chunk[] = [bytes.subarray(0, cs.contentStart)];
    chunks.push(...(await this.container('body', body.content ?? [], po, plan)));
    chunks.push(...(await this.finalSectPr(plan.final, po)));
    if (cs.tail) chunks.push(bytes.subarray(cs.tail[0], cs.tail[1]));
    chunks.push(bytes.subarray(cs.contentEnd));
    this.setPart(part, bytes, join(chunks));
  }

  async story(story: JsonNode): Promise<void> {
    const id = String(story.attrs?.['id']);
    const s = this.sm.stories[id];
    if (!s)
      throw new ExportError(
        `story ${id} has no source part: the patching writer does not add stories yet`,
      );
    // Patched even when unchanged: the result must then equal the original byte for byte (R0).
    const bytes = this.read(s.part);
    const po = this.partOut(s.part, bytes);
    const cs = this.sm.containers[id]!;
    const empty: SectionPlan = {
      holders: new Map(),
      orphanBreaks: new Map(),
      final: { ps: '', start: null, index: 0 },
    };
    const chunks: Chunk[] = [
      bytes.subarray(0, cs.contentStart),
      ...(await this.container(id, story.content ?? [], po, empty)),
      bytes.subarray(cs.contentEnd),
    ];
    this.setPart(s.part, bytes, join(chunks));
  }

  setPart(part: string, original: Uint8Array, bytes: Uint8Array): void {
    if (!sameBytes(original, bytes)) this.changed.set(part, bytes);
  }

  // -------------------------------------------------------------------------------------------
  // Sections.

  sectionPlan(body: JsonNode): SectionPlan {
    const children = body.content ?? [];
    const plan: SectionPlan = {
      holders: new Map(),
      orphanBreaks: new Map(),
      final: { ps: '', start: null, index: 0 },
    };
    const ps: string[] = [String(body.attrs?.['pageSetup'])];
    const starts: Array<string | null> = [null];
    const breaks: number[] = [];
    children.forEach((c, i) => {
      if (c.type !== 'section_break') return;
      breaks.push(i);
      ps.push(String(c.attrs?.['pageSetup']));
      starts.push(String(c.attrs?.['start'] ?? 'nextPage'));
    });
    breaks.forEach((i, j) => {
      const holder: Holder = { ps: ps[j]!, start: starts[j]!, index: j };
      const prev = children[i - 1];
      const prevId = String(prev?.attrs?.['id']);
      // A paragraph holds the properties; so does a preserved paragraph that held them at import.
      const holds =
        prev &&
        (prev.type === 'paragraph' ||
          (prev.type === 'preserved_block' && !!this.sm.nodes[prevId]?.sectPrRange));
      if (holds) plan.holders.set(prevId, holder);
      else plan.orphanBreaks.set(String(children[i]!.attrs?.['id']), holder);
    });
    plan.final = { ps: ps[breaks.length]!, start: starts[breaks.length]!, index: breaks.length };
    return plan;
  }

  /** The sectPr of a section: copied from the original while its page setup is unchanged. */
  async sectPr(h: Holder, po: PartOut): Promise<string> {
    const ps = this.defs.get(h.ps);
    if (!ps) throw new ExportError(`page setup ${h.ps} does not exist`);
    const src = this.sm.defs[h.ps];
    if (
      src &&
      src.part === po.part &&
      (await this.unchanged(ps, src)) &&
      src.first === (h.index === 0) &&
      (h.index === 0 || src.startValue === h.start)
    )
      return decodeUtf8(po.bytes, src.start, src.end);
    const preserved = this.preservedOf(ps);
    const values = { ...withDefaults(ps), start: h.start ?? 'nextPage' };
    const items = mergeContainer(
      h.index === 0 ? SECTPR_FIRST : SECTPR,
      values,
      elementsOf(preserved?.children),
      this.ctx,
      [],
    );
    const local = new Map<string, string>();
    const decls: string[] = [];
    const attrs = po.ns.attributes(
      { ...(src?.identity ?? {}), ...(preserved?.attrs ?? {}) },
      local,
      decls,
    );
    return `<${po.wp}:sectPr${decls.join('')}${attrs}>${this.items(items, po, local)}</${po.wp}:sectPr>`;
  }

  async finalSectPr(h: Holder, po: PartOut): Promise<Chunk[]> {
    const cs = this.sm.containers['body']!;
    if (this.synthetic.has(h.ps) && !cs.sectPr) {
      const ps = this.defs.get(h.ps);
      if (ps && Object.keys(ps.attrs ?? {}).length === 1) return [];
    }
    return [await this.sectPr(h, po)];
  }

  // -------------------------------------------------------------------------------------------
  // Containers and blocks.

  async container(
    key: string,
    children: readonly JsonNode[],
    po: PartOut,
    plan: SectionPlan,
  ): Promise<Chunk[]> {
    const cs = this.sm.containers[key];
    const out: Chunk[] = [];
    const leading = new Map<string, Array<[number, number]>>();
    let trailing: Array<[number, number]> = [];
    if (cs && cs.part === po.part) {
      const present = new Set(children.map((c) => String(c.attrs?.['id'])));
      let pending: Array<[number, number]> = [];
      cs.order.forEach((id, i) => {
        const g = [...pending, cs.gaps[i]!];
        if (present.has(id)) {
          leading.set(id, g);
          pending = [];
        } else pending = g;
      });
      trailing = [...pending, cs.trailing];
    }
    for (const c of children) {
      const id = String(c.attrs?.['id']);
      if (c.type === 'section_break') {
        const h = plan.orphanBreaks.get(id);
        if (h)
          out.push(
            `<${po.wp}:p><${po.wp}:pPr>${await this.sectPr(h, po)}</${po.wp}:pPr></${po.wp}:p>`,
          );
        continue;
      }
      for (const g of leading.get(id) ?? []) out.push(po.bytes.subarray(g[0], g[1]));
      out.push(...(await this.block(c, po, plan)));
    }
    for (const g of trailing) out.push(po.bytes.subarray(g[0], g[1]));
    return out;
  }

  async block(node: JsonNode, po: PartOut, plan: SectionPlan): Promise<Chunk[]> {
    const id = String(node.attrs?.['id']);
    const src = this.sm.nodes[id];
    const local = src && src.part === po.part && !this.force.has(id);
    switch (node.type) {
      case 'paragraph': {
        const holder = plan.holders.get(id) ?? null;
        if (
          this.synthetic.has(id) &&
          !node.content?.length &&
          !holder &&
          Object.keys(node.attrs ?? {}).length === 1
        )
          return [];
        if (local && (await this.unchanged(node, src)) && (await this.sameHolder(src!, holder, po)))
          return [po.bytes.subarray(src!.start, src!.end)];
        return [await this.paragraph(node, src, holder, po)];
      }
      case 'table':
      case 'table_row':
      case 'table_cell': {
        // A row whose header status changed is written again, so its w:tblHeader follows headerRows.
        const header =
          node.type !== 'table_row' ||
          !this.headerRow.has(node) ||
          (src?.flags?.includes('header') ?? false) === this.headerRow.get(node);
        if (local && header && (await this.unchanged(node, src)))
          return [po.bytes.subarray(src!.start, src!.end)];
        return this.tableish(node, src, po, plan);
      }
      case 'region': {
        // A region imported from editable ranges (EXP-104) is a container of its own in the source
        // map. Unchanged, it is copied; changed, its blocks are written one by one, and the
        // markers around them stay where they were (they are in the body's gaps).
        // A region whose block is regenerated is in `force` as an ancestor; it is still written
        // from its container, so only the copy of the whole region is skipped then.
        if (!src || src.part !== po.part || !this.sm.containers[`region:${id}`])
          throw new ExportError(
            `the patching writer cannot write a region without a source (${id})`,
          );
        if (!this.force.has(id) && (await this.unchanged(node, src)))
          return [po.bytes.subarray(src.start, src.end)];
        return this.container(`region:${id}`, node.content ?? [], po, plan);
      }
      case 'preserved_block':
        return [await this.preservedBlock(node, local ? src : undefined, po, plan)];
      default:
        throw new ExportError(`the patching writer cannot write a ${node.type} block yet`);
    }
  }

  /** `src` is given when the block's original element is in this part, so it can be copied. */
  async preservedBlock(
    node: JsonNode,
    src: NodeSource | undefined,
    po: PartOut,
    plan: SectionPlan,
  ): Promise<Chunk> {
    const fragment = this.atomFragment(node);
    if (!fragment) return this.fallbackParagraph(node, po);
    if (src) {
      // Copied from the original part; a preserved paragraph that holds section properties gets
      // them patched when its page setup changed.
      const id = String(node.attrs?.['id']);
      const holder = plan.holders.get(id) ?? null;
      if (src.sectPrRange && holder && !(await this.sameHolder(src, holder, po))) {
        const [s, e] = src.sectPrRange;
        return join([
          po.bytes.subarray(src.start, s),
          await this.sectPr(holder, po),
          po.bytes.subarray(e, src.end),
        ]);
      }
      return po.bytes.subarray(src.start, src.end);
    }
    return this.placeFragment(fragment, po, node);
  }

  fallbackParagraph(node: JsonNode, po: PartOut): string {
    const text = typeof node.attrs?.['fallbackText'] === 'string' ? node.attrs['fallbackText'] : '';
    this.warnings.push(
      `preserved content "${String(node.attrs?.['label'])}" written as its fallback`,
    );
    return `<${po.wp}:p>${text ? `<${po.wp}:r><${po.wp}:t xml:space="preserve">${escapeText(text)}</${po.wp}:t></${po.wp}:r>` : ''}</${po.wp}:p>`;
  }

  async sameHolder(src: NodeSource, h: Holder | null, po: PartOut): Promise<boolean> {
    if (!src.sectPr || !h) return !src.sectPr && !h;
    if (src.sectPr.pageSetup !== h.ps || src.sectPr.start !== (h.index === 0 ? null : h.start))
      return false;
    const ps = this.defs.get(h.ps);
    const psSrc = this.sm.defs[h.ps];
    return !!ps && !!psSrc && psSrc.part === po.part && (await this.unchanged(ps, psSrc));
  }

  startTag(
    name: string,
    attrs: Record<string, string>,
    po: PartOut,
    local: Map<string, string>,
    close = false,
  ): string {
    const decls: string[] = [];
    const a = po.ns.attributes(attrs, local, decls);
    return `<${po.wp}:${name}${decls.join('')}${a}${close ? '/' : ''}>`;
  }

  items(items: readonly MergedItem[], po: PartOut, local: Map<string, string>): string {
    return items.map((m) => (isRaw(m) ? m.raw : po.ns.element(m, local))).join('');
  }

  async paragraph(
    node: JsonNode,
    src: NodeSource | undefined,
    holder: Holder | null,
    po: PartOut,
  ): Promise<string> {
    this.regenerated.push(String(node.attrs?.['id']));
    const preserved = this.preservedOf(node);
    const local = new Map<string, string>();
    const open = this.startTag(
      'p',
      { ...(src?.identity ?? {}), ...(preserved?.attrs ?? {}) },
      po,
      local,
    );
    const pPrHolder = preserved?.children?.find(
      (c): c is TreeElement => 'name' in c && c.name === W_PPR,
    );
    const extras: MergedItem[] = holder
      ? [{ name: W_SECTPR, raw: await this.sectPr(holder, po) }]
      : [];
    const items = mergeContainer(
      PPR,
      withDefaults(node),
      elementsOf(pPrHolder?.children),
      this.ctx,
      extras,
    );
    let pPr = '';
    if (items.length || pPrHolder?.attrs) {
      const pl = new Map(local);
      pPr = `${this.startTag('pPr', pPrHolder?.attrs ?? {}, po, pl)}${this.items(items, po, pl)}</${po.wp}:pPr>`;
    }
    return `${open}${pPr}${await this.inline(node.content ?? [], po, local)}</${po.wp}:p>`;
  }

  async tableish(
    node: JsonNode,
    src: NodeSource | undefined,
    po: PartOut,
    plan: SectionPlan,
  ): Promise<Chunk[]> {
    const id = String(node.attrs?.['id']);
    this.regenerated.push(id);
    const preserved = this.preservedOf(node);
    const local = new Map<string, string>();
    const name = node.type === 'table' ? 'tbl' : node.type === 'table_row' ? 'tr' : 'tc';
    const open = this.startTag(
      name,
      { ...(src?.identity ?? {}), ...(preserved?.attrs ?? {}) },
      po,
      local,
    );
    const head = (preserved?.children ?? []).filter((c): c is TreeElement => 'name' in c);
    const holder = (n: string): TreeElement | undefined => head.find((h) => h.name === w(n));
    const values = withDefaults(node);
    const out: Chunk[] = [open];
    const props = (spec: typeof TBLPR, n: string, always: boolean, extras: MergedItem[]): void => {
      const hd = holder(n);
      const items = mergeContainer(spec, values, elementsOf(hd?.children), this.ctx, extras);
      if (items.length || hd || always) {
        const pl = new Map(local);
        out.push(
          `${this.startTag(n, hd?.attrs ?? {}, po, pl)}${this.items(items, po, pl)}</${po.wp}:${n}>`,
        );
      }
    };
    if (node.type === 'table') {
      // The schema requires tblPr, but some generators leave it out; keep the original's shape.
      props(TBLPR, 'tblPr', !src?.flags?.includes('no-tblPr'), []);
      const grid = (node.attrs?.['grid'] ?? []) as number[];
      const full = holder('tblGrid');
      const fromModel = gridElement(grid);
      const keep =
        full &&
        canonicalTree({
          name: full.name,
          children: (full.children ?? []).map((c) =>
            'name' in c ? { name: c.name, attrs: { [w('w')]: c.attrs?.[w('w')] ?? '' } } : c,
          ),
        }) === canonicalTree(fromModel);
      out.push(po.ns.element(keep ? full! : fromModel, local));
      const headerRows = Number(node.attrs?.['headerRows'] ?? 0);
      (node.content ?? []).forEach((r, i) => this.headerRow.set(r, i < headerRows));
    } else if (node.type === 'table_row') {
      const ex = holder('tblPrEx');
      if (ex) out.push(po.ns.element(ex, local));
      const extras: MergedItem[] = [];
      const residue = elementsOf(holder('trPr')?.children);
      if (this.headerRow.get(node) && !residue.some((r) => r.name === w('tblHeader')))
        extras.push({ name: w('tblHeader'), raw: `<${po.wp}:tblHeader/>` });
      for (const m of node.marks ?? [])
        if (m.type === 'ins' || m.type === 'del')
          extras.push({ name: w(m.type), raw: this.revisionTag(m, po, local, true) });
      props(TRPR, 'trPr', false, extras);
    } else props(TCPR, 'tcPr', false, []);
    out.push(...(await this.container(id, node.content ?? [], po, plan)));
    out.push(`</${po.wp}:${name}>`);
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // Inline content.

  async inline(
    content: readonly JsonNode[],
    po: PartOut,
    local: Map<string, string>,
  ): Promise<string> {
    const out: string[] = [];
    let ins: JsonMark | null = null;
    let del: JsonMark | null = null;
    const close = (): void => {
      if (del) out.push(`</${po.wp}:del>`);
      if (ins) out.push(`</${po.wp}:ins>`);
      ins = del = null;
    };
    let i = 0;
    while (i < content.length) {
      const node = content[i]!;
      const rm = marksToValues(node.marks);
      if (
        rm.ins?.attrs?.['id'] !== (ins as JsonMark | null)?.attrs?.['id'] ||
        rm.del?.attrs?.['id'] !== (del as JsonMark | null)?.attrs?.['id']
      ) {
        close();
        if (rm.ins) out.push(this.revisionTag(rm.ins, po, local));
        if (rm.del) out.push(this.revisionTag(rm.del, po, local));
        ins = rm.ins;
        del = rm.del;
      }
      const inDel = !!rm.del;
      if (node.type === 'text' || node.type === 'tab' || node.type === 'break') {
        const key = formattingKey(node.marks);
        const parts: string[] = [];
        let j = i;
        while (j < content.length) {
          const n = content[j]!;
          if (n.type !== 'text' && n.type !== 'tab' && n.type !== 'break') break;
          if (formattingKey(n.marks) !== key || !sameSuggestions(n.marks, node.marks)) break;
          parts.push(this.runContent(n, inDel, po));
          j++;
        }
        out.push(`<${po.wp}:r>${this.rPr(node.marks, po, local)}${parts.join('')}</${po.wp}:r>`);
        i = j;
        continue;
      }
      if (node.type === 'image') out.push(await this.image(node, po, local));
      else if (node.type === 'preserved_inline') out.push(this.preservedInline(node, po, local));
      else throw new ExportError(`the patching writer cannot write a ${node.type} inline node yet`);
      i++;
    }
    close();
    return out.join('');
  }

  runContent(n: JsonNode, inDel: boolean, po: PartOut): string {
    if (n.type === 'tab') return `<${po.wp}:tab/>`;
    if (n.type === 'break') {
      const kind = n.attrs?.['kind'];
      return kind === 'page' || kind === 'column'
        ? `<${po.wp}:br ${po.wp}:type="${kind}"/>`
        : `<${po.wp}:br/>`;
    }
    const text = n.text ?? '';
    const tag = inDel ? 'delText' : 't';
    const space = /^\s|\s$|\s\s/.test(text) ? ' xml:space="preserve"' : '';
    return `<${po.wp}:${tag}${space}>${escapeText(text)}</${po.wp}:${tag}>`;
  }

  rPr(marks: readonly JsonMark[] | undefined, po: PartOut, local: Map<string, string>): string {
    const rm = marksToValues(marks);
    const pm = (marks ?? []).find((m) => m.type === 'preserved');
    const props =
      pm && !this.untrusted.mark.has(pm) ? this.tree(pm.attrs?.['props'] as JsonValue) : null;
    const items = mergeContainer(RPR, rm.values, elementsOf(props?.children), this.ctx, []);
    if (!items.length && !props?.attrs) return '';
    const pl = new Map(local);
    return `${this.startTag('rPr', props?.attrs ?? {}, po, pl)}${this.items(items, po, pl)}</${po.wp}:rPr>`;
  }

  revisionTag(mark: JsonMark, po: PartOut, local: Map<string, string>, empty = false): string {
    const id = String(mark.attrs?.['id']);
    const src = this.sm.suggestions[id];
    const attrs: Record<string, string> = { ...(src?.attrs ?? {}) };
    const idAttr = w('id');
    // A revision written twice (a split paragraph) needs a fresh w:id for the second element.
    if (!attrs[idAttr] || this.usedRevisionIds.has(attrs[idAttr]!))
      attrs[idAttr] = String(this.nextRevisionId++);
    this.usedRevisionIds.add(attrs[idAttr]!);
    if (!attrs[w('author')])
      attrs[w('author')] = String(mark.attrs?.['user'] ?? '').replace(/^word:/, '');
    return this.startTag(mark.type === 'ins' ? 'ins' : 'del', attrs, po, new Map(local), empty);
  }

  preservedInline(node: JsonNode, po: PartOut, local: Map<string, string>): string {
    if (this.untrusted.atom.has(node)) return this.fallbackRun(node, po, local);
    const tree = this.tree(node.attrs?.['tree'] as JsonValue | undefined);
    if (tree) {
      const kids = elementsOf(tree.children);
      const xml = kids.map((k) => po.ns.element(k, local)).join('');
      const run = kids.length > 0 && kids.every((k) => RUN_CONTENT.has(k.name));
      return run ? `<${po.wp}:r>${this.rPr(node.marks, po, local)}${xml}</${po.wp}:r>` : xml;
    }
    const fragment = this.atomFragment(node);
    if (!fragment) return this.fallbackRun(node, po, local);
    const xml = this.placeFragment(fragment, po, node);
    const f = this.fragment(fragment);
    return f.meta.wrap === 'run'
      ? `<${po.wp}:r>${this.rPr(node.marks, po, local)}${xml}</${po.wp}:r>`
      : xml;
  }

  fallbackRun(node: JsonNode, po: PartOut, local: Map<string, string>): string {
    const text = typeof node.attrs?.['fallbackText'] === 'string' ? node.attrs['fallbackText'] : '';
    this.warnings.push(
      `preserved content "${String(node.attrs?.['label'])}" written as its fallback`,
    );
    if (!text) return '';
    return `<${po.wp}:r>${this.rPr(node.marks, po, local)}<${po.wp}:t xml:space="preserve">${escapeText(text)}</${po.wp}:t></${po.wp}:r>`;
  }

  /**
   * A picture: written back from its original drawing while unedited; patched to its new size,
   * alternative text or picture when edited; written new when it has no trusted origin.
   */
  async image(node: JsonNode, po: PartOut, local: Map<string, string>): Promise<string> {
    const rPr = this.rPr(node.marks, po, local);
    const origin = this.originOf(node);
    if (origin) {
      if ((await modelledHash(node)) === origin.hash)
        return `<${po.wp}:r>${rPr}${this.placeFragment(origin.fragment, po, node)}</${po.wp}:r>`;
      const f = this.fragment(origin.fragment);
      const xml = this.placeFragment(origin.fragment, po, node, async (pf) => {
        const pictureRel = await this.pictureChanged(f, node);
        return {
          patch: (edits) =>
            patchDrawing(pf, node, pictureRel ? this.mediaRel(node, po) : null, edits),
        };
      });
      return `<${po.wp}:r>${rPr}${await xml}</${po.wp}:r>`;
    }
    const relId = this.mediaRel(node, po);
    const tree = newDrawing(node, relId, this.nextDocPr(po));
    return `<${po.wp}:r>${rPr}${po.ns.element(tree, local)}</${po.wp}:r>`;
  }

  /** Whether an imported picture now shows a different picture than its fragment's. */
  async pictureChanged(f: Fragment, node: JsonNode): Promise<boolean> {
    const asset = this.assets.get(String(node.attrs?.['asset']));
    if (!asset) return false;
    const zip = readZip(this.asset(this.fragmentIdOf(f)).bytes);
    for (const p of f.meta.parts) {
      const e = zip.byName.get(`parts/${p.name}`);
      if (
        e &&
        /\/media\//.test(p.name) &&
        (await sha256HexBytes(entryData(zip, e))) === asset.sha256
      )
        return false;
    }
    return true;
  }

  private readonly fragmentIds = new WeakMap<Fragment, string>();
  /** Parsed fragments by asset id: an asset is immutable, so one parse serves the whole export. */
  private readonly fragments = new Map<string, Fragment>();
  fragment(id: string): Fragment {
    const known = this.fragments.get(id);
    if (known) return known;
    const f = readFragment(this.asset(id).bytes);
    this.fragments.set(id, f);
    this.fragmentIds.set(f, id);
    return f;
  }
  fragmentIdOf(f: Fragment): string {
    const id = this.fragmentIds.get(f);
    if (!id) throw new ExportError('unknown fragment');
    return id;
  }

  asset(id: string): Asset {
    const a = this.assets.get(id);
    if (!a) throw new ExportError(`asset ${id} is not attached`);
    return a;
  }

  // -------------------------------------------------------------------------------------------
  // Fragments, relationships and parts (EXP-119).

  nextDocPr(po: PartOut): number {
    let n = this.docPr.get(po.part);
    if (n === undefined) n = Math.max(0, ...docPrIds(decodeUtf8(po.bytes))) + 1;
    this.docPr.set(po.part, n + 1);
    return n;
  }

  /**
   * The XML of a fragment for its current place. A relationship it refers to is kept while it
   * still resolves in this part (for the use that keeps the fragment's relationships, or for a
   * target several references may share); otherwise it is added to the part, renumbered, and for a
   * target that belongs to one reference (a chart, an embedded object) the part is copied.
   */
  placeFragment(id: string, po: PartOut, owner: object): string;
  placeFragment(
    id: string,
    po: PartOut,
    owner: object,
    edit: (pf: ParsedFragment) => Promise<{ patch: (edits: ByteEdit[]) => string }>,
  ): Promise<string>;
  placeFragment(
    id: string,
    po: PartOut,
    owner: object,
    edit?: (pf: ParsedFragment) => Promise<{ patch: (edits: ByteEdit[]) => string }>,
  ): string | Promise<string> {
    const f = this.fragment(id);
    const primary = this.primary.get(id) === owner;
    const home = f.meta.part === po.part;
    const idMap = new Map<string, string>();
    for (const r of f.meta.rels) {
      const now = po.rels.byId.get(r.id);
      const resolves =
        !!now &&
        now.type === r.type &&
        now.target === r.target &&
        now.external === r.external &&
        (r.external || this.partExists(resolveTarget(po.part, r.target)));
      if (home && resolves && (primary || !UNIQUE_TARGET_TYPES.has(r.type))) continue;
      idMap.set(r.id, this.relFor(po, f, id, r, primary));
    }
    let pf: ParsedFragment | null = null;
    const parsed = (): ParsedFragment => (pf ??= parseFragment(f));
    const edits: ByteEdit[] = [];
    if (idMap.size)
      for (const { attr: a } of relationshipAttributes(parsed())) {
        const n = idMap.get(a.value);
        if (n) edits.push(setAttribute(a, n));
      }
    if (!primary)
      for (const el of parsed().elements)
        if (el.ns === NS.wp && el.local === 'docPr') {
          const a = el.attrs.find((x) => x.ns === '' && x.local === 'id');
          if (a) edits.push(setAttribute(a, String(this.nextDocPr(po))));
        }
    // Bindings the fragment needs that this part's root does not give.
    const decls: string[] = [];
    for (const [p, uri] of Object.entries(f.meta.namespaces)) {
      if ((p ? po.ns.rootUri(p) : po.defaultNs) === uri) continue;
      const own = parsed().root.nsDecls.some((d) => (d.prefix === 'xmlns' ? d.local : '') === p);
      if (!own) decls.push(p ? ` xmlns:${p}="${escapeAttr(uri)}"` : ` xmlns="${escapeAttr(uri)}"`);
    }
    if (decls.length) edits.push(addToStartTag(parsed().root, decls.join(''), parsed().bytes));
    if (edit) return edit(parsed()).then((e) => e.patch(edits));
    return edits.length ? applyEdits(parsed().bytes, edits) : f.xml;
  }

  partExists(name: string): boolean {
    return (this.zip.byName.has(name) && !this.removed.has(name)) || this.added.has(name);
  }

  /** A relationship of `po` for one of a fragment's relationships, added if needed. */
  relFor(
    po: PartOut,
    f: Fragment,
    fragmentId: string,
    r: Relationship | NewRel,
    primary: boolean,
  ): string {
    if (r.external) return this.addRel(po.part, r.type, r.target, true);
    const original = resolveTarget(f.meta.part, r.target);
    let target = original;
    const unique = UNIQUE_TARGET_TYPES.has(r.type);
    if (!this.partExists(original) || (unique && !primary))
      target = this.copyPart(f, fragmentId, original, unique && !primary);
    return this.addRel(po.part, r.type, relativeTarget(po.part, target), false);
  }

  /** Copies a part from a fragment into the package (under a new name when `fresh`), with its own related parts. */
  copyPart(f: Fragment, fragmentId: string, name: string, fresh: boolean): string {
    const zip = readZip(this.asset(fragmentId).bytes);
    const entry = zip.byName.get(`parts/${name}`);
    if (!entry)
      throw new ExportError(`fragment of "${f.meta.label}" does not hold the part ${name}`);
    const target = fresh || this.partExists(name) ? this.freshName(name) : name;
    const meta = f.meta.parts.find((p) => p.name === name);
    this.added.set(target, {
      copyOf: entry,
      from: zip,
      contentType: meta?.contentType ?? null,
    });
    const relsEntry = zip.byName.get(`parts/${relsPartName(name)}`);
    if (relsEntry) {
      const relsBytes = entryData(zip, relsEntry);
      const rels = parseRelationships(name, relsBytes);
      const edits: ByteEdit[] = [];
      for (const r of rels.list) {
        if (r.external) continue;
        const sub = resolveTarget(name, r.target);
        const subUnique = UNIQUE_TARGET_TYPES.has(r.type);
        if (!subUnique && this.partExists(sub)) continue;
        const copied = this.copyPart(f, fragmentId, sub, subUnique);
        const doc = parseXml(relsBytes);
        const el = doc.root.children.find((c) => c.kind === 'element' && c.start === r.start);
        const at =
          el && el.kind === 'element'
            ? el.attrs.find((a) => a.ns === '' && a.local === 'Target')
            : undefined;
        if (at) edits.push(setAttribute(at, relativeTarget(target, copied)));
      }
      this.added.set(relsPartName(target), {
        data: utf8(applyEdits(relsBytes, edits)),
        contentType: null,
      });
    }
    return target;
  }

  freshName(name: string): string {
    const slash = name.lastIndexOf('/');
    const dot = name.lastIndexOf('.');
    const stem = dot > slash ? name.slice(0, dot) : name;
    const ext = dot > slash ? name.slice(dot) : '';
    for (let k = 2; ; k++) {
      const candidate = `${stem}_${k}${ext}`;
      if (!this.zip.byName.has(candidate) && !this.added.has(candidate)) return candidate;
    }
  }

  /** A relationship of `part` (an existing one with the same type and target, or a new one). */
  addRel(part: string, type: string, target: string, external: boolean): string {
    const list = this.newRels.get(part) ?? [];
    const known = list.find(
      (r) => r.type === type && r.target === target && r.external === external,
    );
    if (known) return known.id;
    const relsName = relsPartName(part);
    const existing = parseRelationships(
      part,
      this.changed.get(relsName) ??
        (this.zip.byName.has(relsName) ? this.read(relsName) : undefined),
    );
    const taken = new Set([...existing.byId.keys(), ...list.map((r) => r.id)]);
    let n = 1;
    for (const id of taken) {
      const m = /^rId([0-9]+)$/.exec(id);
      if (m) n = Math.max(n, Number(m[1]) + 1);
    }
    while (taken.has(`rId${n}`)) n++;
    const id = `rId${n}`;
    list.push({ id, type, target, external });
    this.newRels.set(part, list);
    return id;
  }

  /** A new picture part and its relationship, for an image whose picture is not in the package. */
  mediaRel(node: JsonNode, po: PartOut): string {
    const asset = this.asset(String(node.attrs?.['asset']));
    let name = this.media.get(asset.id);
    if (!name) {
      const ext = IMAGE_EXTENSIONS[asset.contentType] ?? 'bin';
      let k = 1;
      while (this.partExists(`word/media/docedit${k}.${ext}`)) k++;
      name = `word/media/docedit${k}.${ext}`;
      this.added.set(name, { data: asset.bytes, contentType: asset.contentType });
      this.media.set(asset.id, name);
    }
    return this.addRel(po.part, REL.image, relativeTarget(po.part, name), false);
  }

  /** Writes the relationships added for each part into its relationship part (new or patched). */
  writeNewRelationships(): void {
    for (const [part, list] of this.newRels) {
      const relsName = relsPartName(part);
      const xml = list
        .map(
          (r) =>
            `<Relationship Id="${escapeAttr(r.id)}" Type="${escapeAttr(r.type)}" Target="${escapeAttr(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`,
        )
        .join('');
      if (this.zip.byName.has(relsName)) {
        const bytes = this.changed.get(relsName) ?? this.read(relsName);
        const at = parseRelationships(part, bytes).insertAt;
        this.changed.set(relsName, join([bytes.subarray(0, at), xml, bytes.subarray(at)]));
      } else
        this.added.set(relsName, {
          data: utf8(
            `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="${RELS_NS}">${xml}</Relationships>`,
          ),
          contentType: null,
        });
    }
  }

  /** Removes relationships only deleted content used, then the parts nothing reaches any more. */
  cleanUpRelationships(part: string, bytes: Uint8Array): void {
    const before = referencedRelIds(parseXml(this.read(part)).root);
    const after = referencedRelIds(parseXml(bytes).root);
    const gone = [...before].filter((id) => !after.has(id));
    if (!gone.length) return;
    const relsName = relsPartName(part);
    if (!this.zip.byName.has(relsName)) return;
    const relsBytes = this.changed.get(relsName) ?? this.read(relsName);
    const rels = parseRelationships(part, relsBytes);
    const ranges: Array<[number, number]> = [];
    const candidates: string[] = [];
    for (const id of gone) {
      const r = rels.byId.get(id);
      if (!r) continue;
      ranges.push([r.start, r.end]);
      if (!r.external) candidates.push(resolveTarget(part, r.target));
    }
    if (!ranges.length) return;
    this.changed.set(relsName, cut(relsBytes, ranges));
    this.removeUnreachable(candidates);
  }

  removeUnreachable(candidates: string[]): void {
    const targeted = (): Set<string> => {
      const out = new Set<string>();
      const relsParts = [...this.zip.entries.map((e) => e.name), ...[...this.added.keys()]].filter(
        (n) => n.endsWith('.rels') && !this.removed.has(n),
      );
      for (const name of relsParts) {
        const source = name === '_rels/.rels' ? '' : name.replace(/_rels\/([^/]+)\.rels$/, '$1');
        if (source && this.removed.has(source)) continue;
        const add = this.added.get(name);
        const bytes =
          this.changed.get(name) ??
          (add ? (add.data ?? entryData(add.from!, add.copyOf!)) : this.read(name));
        for (const r of parseRelationships(source, bytes).list)
          if (!r.external) out.add(resolveTarget(source, r.target));
      }
      return out;
    };
    let queue = candidates;
    while (queue.length) {
      const live = targeted();
      const next: string[] = [];
      for (const part of queue) {
        if (live.has(part) || this.removed.has(part) || !this.zip.byName.has(part)) continue;
        this.removed.add(part);
        const relsName = relsPartName(part);
        if (this.zip.byName.has(relsName)) {
          this.removed.add(relsName);
          for (const r of parseRelationships(part, this.read(relsName)).list)
            if (!r.external) next.push(resolveTarget(part, r.target));
        }
      }
      queue = next;
    }
  }

  /** Content types: overrides of removed parts go, overrides or defaults for added parts come. */
  writeContentTypes(): void {
    const name = '[Content_Types].xml';
    if (!this.removed.size && !this.added.size) return;
    const bytes = this.changed.get(name) ?? this.read(name);
    const ct = parseContentTypes(bytes);
    const ranges: Array<[number, number]> = [];
    for (const part of this.removed) {
      const r = ct.overrideRanges.get(part.toLowerCase());
      if (r) ranges.push(r);
    }
    const additions: string[] = [];
    const defaults = new Set(ct.defaults.keys());
    for (const [part, a] of this.added) {
      const dot = part.lastIndexOf('.');
      const ext = dot < 0 ? '' : part.slice(dot + 1).toLowerCase();
      if (ct.overrides.has(part.toLowerCase())) continue;
      const original = a.copyOf ? a.copyOf.name.replace(/^parts\//, '') : null;
      const type =
        (original ? this.ct.overrides.get(original.toLowerCase()) : undefined) ?? a.contentType;
      if (type && (!defaults.has(ext) || ct.defaults.get(ext) !== type) && ext !== 'rels')
        additions.push(
          `<Override PartName="/${escapeAttr(part)}" ContentType="${escapeAttr(type)}"/>`,
        );
      else if (!type && ext === 'rels' && !defaults.has('rels')) {
        additions.push(
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
        );
        defaults.add('rels');
      }
    }
    if (!ranges.length && !additions.length) return;
    let out = cut(bytes, ranges);
    if (additions.length) {
      const at = parseXml(out).root.endTagStart;
      out = join([out.subarray(0, at), additions.join(''), out.subarray(at)]);
    }
    this.changed.set(name, out);
  }

  pack(): ExportResult {
    const entries: ZipWriteEntry[] = [];
    const parts: Record<string, PartOutcome> = {};
    for (const e of this.zip.entries) {
      if (this.removed.has(e.name)) {
        parts[e.name] = 'removed';
        continue;
      }
      const data = this.changed.get(e.name);
      if (data) {
        entries.push({ name: e.name, data, like: e });
        parts[e.name] = 'patched';
      } else {
        entries.push({ name: e.name, copyOf: e, from: this.zip });
        parts[e.name] = 'copied';
      }
    }
    for (const [name, a] of this.added) {
      if (a.copyOf && a.from) entries.push({ name, copyOf: a.copyOf, from: a.from });
      else entries.push({ name, data: a.data ?? new Uint8Array() });
      parts[name] = 'added';
    }
    return {
      bytes: writeZip(entries, this.zip.comment),
      parts,
      regenerated: this.regenerated,
      warnings: this.warnings,
      untrusted: untrustedCount(this.untrusted),
    };
  }
}

/** A relationship target relative to its source part (ECMA-376 Part 2 §9.3). */
export function relativeTarget(source: string, target: string): string {
  const from = source.split('/').slice(0, -1);
  const to = target.split('/');
  let k = 0;
  while (k < from.length && k < to.length - 1 && from[k] === to[k]) k++;
  return [...from.slice(k).map(() => '..'), ...to.slice(k)].join('/');
}

function sameSuggestions(
  a: readonly JsonMark[] | undefined,
  b: readonly JsonMark[] | undefined,
): boolean {
  const key = (m: readonly JsonMark[] | undefined): string =>
    (m ?? [])
      .filter((x) => SUGGESTION_MARKS.has(x.type))
      .map((x) => `${x.type}:${String(x.attrs?.['id'])}`)
      .sort()
      .join(',');
  return key(a) === key(b);
}

function join(chunks: Chunk[]): Uint8Array {
  const parts = chunks.map((c) => (typeof c === 'string' ? utf8(c) : c));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Removes byte ranges (whole elements) from a part. */
function cut(bytes: Uint8Array, ranges: Array<[number, number]>): Uint8Array {
  const sorted = [...ranges].sort((x, y) => x[0] - y[0]);
  const chunks: Uint8Array[] = [];
  let pos = 0;
  for (const [s, e] of sorted) {
    chunks.push(bytes.subarray(pos, s));
    pos = e;
  }
  chunks.push(bytes.subarray(pos));
  return join(chunks);
}

export interface ExportOptions {
  /** Regenerate these nodes (and their ancestors) even when unchanged; for testing regeneration. */
  regenerate?: ReadonlySet<string>;
}

/** Writes a DOCX from an imported, possibly edited, document by patching its original package. */
export async function exportDocx(
  envelope: JsonEnvelope,
  original: Uint8Array,
  sourceMap: SourceMap,
  assets: AssetSource,
  opts: ExportOptions = {},
): Promise<ExportResult> {
  return new Writer(envelope, original, sourceMap, assets, opts).run();
}
