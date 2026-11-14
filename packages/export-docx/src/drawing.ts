/**
 * Inline pictures (EXP-091; ADR 0017): a new `w:drawing` for a picture the model holds, and the
 * patch of an imported picture whose modelled attributes were edited, which keeps everything else
 * of the original drawing (effects, cropping, locks, identifiers).
 */
import type { JsonNode } from '@docedit/model';
import { EMU_PER_TWIP, NS } from './ooxml.ts';
import { pname } from './names.ts';
import {
  type ByteEdit,
  type ParsedFragment,
  addToStartTag,
  applyEdits,
  setAttribute,
} from './fragments.ts';
import type { TreeElement } from './tree.ts';
import { type XmlElement, attr, escapeAttr } from './xml.ts';

const PIC_URI = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const wp = (l: string): string => pname(NS.wp, l);
const a = (l: string): string => pname(NS.a, l);
const pic = (l: string): string => pname(NS.pic, l);

/** File extensions and content types the writer gives new picture parts. */
export const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/svg+xml': 'svg',
  'image/x-emf': 'emf',
  'image/x-wmf': 'wmf',
  'image/webp': 'webp',
};

const emu = (twips: number): string => String(Math.round(twips * EMU_PER_TWIP));

/** A new inline picture as an element tree (names as names.ts spells them). */
export function newDrawing(node: JsonNode, relId: string, docPrId: number): TreeElement {
  const attrs = node.attrs ?? {};
  const cx = emu(Number(attrs['width'] ?? 1));
  const cy = emu(Number(attrs['height'] ?? 1));
  const alt = typeof attrs['alt'] === 'string' ? attrs['alt'] : '';
  const docPr: Record<string, string> = { id: String(docPrId), name: `Picture ${docPrId}` };
  if (alt) docPr['descr'] = alt;
  return {
    name: pname(NS.w, 'drawing'),
    children: [
      {
        name: wp('inline'),
        attrs: { distT: '0', distB: '0', distL: '0', distR: '0' },
        children: [
          { name: wp('extent'), attrs: { cx, cy } },
          { name: wp('effectExtent'), attrs: { l: '0', t: '0', r: '0', b: '0' } },
          { name: wp('docPr'), attrs: docPr },
          {
            name: wp('cNvGraphicFramePr'),
            children: [{ name: a('graphicFrameLocks'), attrs: { noChangeAspect: '1' } }],
          },
          {
            name: a('graphic'),
            children: [
              {
                name: a('graphicData'),
                attrs: { uri: PIC_URI },
                children: [
                  {
                    name: pic('pic'),
                    children: [
                      {
                        name: pic('nvPicPr'),
                        children: [
                          { name: pic('cNvPr'), attrs: { id: '0', name: `Picture ${docPrId}` } },
                          { name: pic('cNvPicPr') },
                        ],
                      },
                      {
                        name: pic('blipFill'),
                        children: [
                          { name: a('blip'), attrs: { [pname(NS.r, 'embed')]: relId } },
                          { name: a('stretch'), children: [{ name: a('fillRect') }] },
                        ],
                      },
                      {
                        name: pic('spPr'),
                        children: [
                          {
                            name: a('xfrm'),
                            children: [
                              { name: a('off'), attrs: { x: '0', y: '0' } },
                              { name: a('ext'), attrs: { cx, cy } },
                            ],
                          },
                          {
                            name: a('prstGeom'),
                            attrs: { prst: 'rect' },
                            children: [{ name: a('avLst') }],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

const find = (pf: ParsedFragment, ns: string, local: string): XmlElement | undefined =>
  pf.elements.find((e) => e.ns === ns && e.local === local);

/**
 * Patches an imported drawing to the picture's current size, alternative text and picture
 * relationship. Attributes the model does not hold are left as they are.
 */
export function patchDrawing(
  pf: ParsedFragment,
  node: JsonNode,
  relId: string | null,
  extra: readonly ByteEdit[] = [],
): string {
  const attrs = node.attrs ?? {};
  const edits: ByteEdit[] = [...extra];
  const cx = emu(Number(attrs['width'] ?? 1));
  const cy = emu(Number(attrs['height'] ?? 1));
  const setOrAdd = (el: XmlElement | undefined, ns: string, local: string, value: string): void => {
    if (!el) return;
    const at = el.attrs.find((x) => x.ns === ns && x.local === local);
    if (at) edits.push(setAttribute(at, value));
    else edits.push(addToStartTag(el, ` ${local}="${escapeAttr(value)}"`, pf.bytes));
  };
  setOrAdd(find(pf, NS.wp, 'extent'), '', 'cx', cx);
  setOrAdd(find(pf, NS.wp, 'extent'), '', 'cy', cy);
  const xfrm = pf.elements.find(
    (e) =>
      e.ns === NS.a && e.local === 'xfrm' && e.parent?.ns === NS.pic && e.parent.local === 'spPr',
  );
  const ext = xfrm?.children.find(
    (c): c is XmlElement => c.kind === 'element' && c.ns === NS.a && c.local === 'ext',
  );
  setOrAdd(ext, '', 'cx', cx);
  setOrAdd(ext, '', 'cy', cy);
  const docPr = find(pf, NS.wp, 'docPr');
  const alt = typeof attrs['alt'] === 'string' ? attrs['alt'] : '';
  if (docPr) {
    const descr = docPr.attrs.find((x) => x.ns === '' && x.local === 'descr');
    if (descr) edits.push(setAttribute(descr, alt));
    else if (alt) edits.push(addToStartTag(docPr, ` descr="${escapeAttr(alt)}"`, pf.bytes));
  }
  if (relId) {
    const blip = find(pf, NS.a, 'blip');
    const embed = blip?.attrs.find((x) => x.ns === NS.r && x.local === 'embed');
    if (embed) edits.push(setAttribute(embed, relId));
  }
  return applyEdits(pf.bytes, dedupe(edits));
}

/** Later edits of the same range win (an `r:embed` renumbered and then replaced). */
function dedupe(edits: ByteEdit[]): ByteEdit[] {
  const byRange = new Map<string, ByteEdit>();
  for (const e of edits) byRange.set(`${e.start}:${e.end}`, e);
  return [...byRange.values()];
}

/** The `wp:docPr` identifiers of a part, so that new drawings get unused ones. */
export function docPrIds(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/<[A-Za-z0-9_]+:docPr\s[^>]*?\bid="([0-9]+)"/g))
    out.push(Number(m[1]));
  return out;
}

/** The picture's relationship id in an imported drawing. */
export function blipEmbed(pf: ParsedFragment): string | undefined {
  const blip = find(pf, NS.a, 'blip');
  return blip ? attr(blip, NS.r, 'embed') : undefined;
}
