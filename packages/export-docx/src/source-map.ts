/**
 * The source map (ADR 0017, part 1): where every imported node came from, its canonical hash as
 * imported, and the identity-bound values of its element. It lives outside the document, as an
 * immutable asset next to the original package (EXP-116), so copies of a node never inherit it.
 * It holds content hashes and the identity values of hidden content, so it is a server-only asset
 * (owner decision 1, default; SR-C1).
 *
 * Offsets are byte offsets into the uncompressed part, so any language can use the map. Names are
 * spelt as in element trees (names.ts).
 */

import type { IdentityEntry } from './tree.ts';

export interface NodeSource {
  part: string;
  /** Byte range of the original element. */
  start: number;
  end: number;
  /** nodeHash() of the node as imported. */
  hash: string;
  /** Identity-bound attributes of the element (name to value). */
  identity?: Record<string, string>;
  /** Identity-bound attributes taken out of the preserved tree at import (EXP-116), with their paths. */
  identityTree?: IdentityEntry[];
  /** For a paragraph (or a preserved paragraph) that held a section's properties: the page setup and the section's start value. */
  sectPr?: { pageSetup: string; start: string | null };
  /** For a preserved paragraph that holds section properties: their byte range, patched when the page setup changes. */
  sectPrRange?: [number, number];
  /** Shape of the original element the writer keeps when it regenerates it: `no-tblPr` for a table without properties. */
  flags?: string[];
}

export interface DefSource {
  part: string;
  start: number;
  end: number;
  hash: string;
  identity?: Record<string, string>;
  /** Identity-bound child elements (a style's `w:rsid`), kept here instead of in the document (EXP-116). */
  identityElements?: Array<{ name: string; attrs: Record<string, string> }>;
  /** Identity-bound attributes taken out of the preserved tree at import (EXP-116), with their paths. */
  identityTree?: IdentityEntry[];
  /** Page setups: whether the section was the first one, and its start value (sections after the first). */
  first?: boolean;
  startValue?: string | null;
  /** Page setups: whether the sectPr was the body's last child. */
  final?: boolean;
  /** Styles: the Word style id. */
  wordId?: string;
}

/**
 * Material between the blocks of a container (bookmarks, comment ranges, whitespace), as byte
 * ranges. A gap belongs to the block after it, so it moves with that block; the gap of a deleted
 * block passes to the next block that survives.
 */
export interface ContainerSource {
  part: string;
  /** Node ids of the container's children in original order. */
  order: string[];
  /** gaps[i] is the material before order[i]. */
  gaps: Array<[number, number]>;
  /** Material after the last child (before the body's final sectPr, if any). */
  trailing: [number, number];
  /** Body only: the final sectPr and the material after it. */
  sectPr?: [number, number];
  tail?: [number, number];
  /** Where the container's content starts and ends in the part. */
  contentStart: number;
  contentEnd: number;
}

export interface SuggestionSource {
  /** Name of the original element (`w:ins` or `w:del`). */
  element: string;
  /** Its attributes (`w:id`, `w:author`, `w:date`), so a regenerated revision keeps them (SR-M14). */
  attrs: Record<string, string>;
}

/**
 * A node the import created without a single original element: a synthetic node (`synthetic`), or
 * a shared preserved tree (`preserved_def`), whose trees came from the elements of its holders.
 */
export interface DerivedSource {
  /** nodeHash() of the node as imported. */
  hash: string;
  /** Shared trees: the nearest identified nodes that refer to the tree, in document order. Their own entries give the locations. */
  holders?: string[];
}

export interface SourceMap {
  /**
   * 2: names with registered prefixes (CDM-051), shared trees, `origin`, payload digests.
   * 3: an entry for every identified node (EXP-116): section breaks in `breaks`, nodes without an
   * original element in `derived`.
   */
  v: 3;
  /** CANONICAL_FORM_VERSION the hashes were taken under; a migration must recompute them (SR-M19). */
  canonicalForm: number;
  cdm: number;
  /** The original package, kept as an immutable asset (EXP-108). */
  package: { sha256: string; size: number };
  mainPart: string;
  stylesPart: string | null;
  /** Blocks and stories. The writer reads every entry here as a block it may copy. */
  nodes: Record<string, NodeSource>;
  /** Style and page setup definitions. */
  defs: Record<string, DefSource>;
  /**
   * Section breaks: the paragraph-level `w:sectPr` each one came from. Kept apart from `nodes`,
   * because the element lies inside its holder paragraph and is not a block of its own.
   */
  breaks: Record<string, NodeSource>;
  /** Nodes without a single original element: everything in `synthetic`, and shared trees. */
  derived: Record<string, DerivedSource>;
  containers: Record<string, ContainerSource>;
  suggestions: Record<string, SuggestionSource>;
  /** CDM style id to Word style id. */
  styles: Record<string, string>;
  /** Story id to its part and the main part's relationship id for it. */
  stories: Record<string, { part: string; relId: string }>;
  /** Nodes and definitions the importer added without a source element; the writer leaves them out while unchanged. */
  synthetic: string[];
  /** Fragment assets this import created; the writer puts back no other (owner decision 2; SR-C2). */
  fragments: string[];
  /** SHA-256 of every preserved payload this import created (integrity.ts; owner decision 2). */
  payloads: string[];
}
