/**
 * Documents and access objects the engine's tests use: the protocol contract document (an open and
 * a restricted region between body paragraphs, 07 §4), the spike document of S1 (definitions, a
 * header story, a footnote, a region and a field), a document with several paragraph styles, and a
 * reader's projection with a hidden region (ADR 0019).
 */
import { contractDocument, IDS } from '@docedit/protocol/contract';
import type { Access } from '@docedit/protocol';
import type { CdmEnvelope } from '../src/api.ts';
import { SPIKE_IDS, spikeDocument } from '../src/spike-document.ts';

export { contractDocument, IDS, SPIKE_IDS, spikeDocument };

/** The grant that opens the restricted region to `group:legal` (as in the contract suite). */
export const LEGAL_GRANT_FOR_TESTS = {
  region: IDS.locked,
  principal: 'group:legal',
  role: 'editor',
} as const;

const EDIT = ['view', 'comment', 'suggest', 'edit'] as const;
const READ = ['view', 'comment'] as const;

/**
 * An editor's access to the spike document (07 §4): the body, but not the restricted region,
 * the definitions or the header story.
 */
export function editorAccess(over: Partial<Access> = {}): Access {
  return {
    rev: 1,
    asOfSeq: 0,
    docRole: 'editor',
    caps: [...EDIT],
    scopes: {
      doc: ['view'],
      body: [...EDIT],
      defs: ['view'],
      [`story:${SPIKE_IDS.header}`]: ['view'],
      [`region:${SPIKE_IDS.region}`]: [...READ],
    },
    leases: {},
    fill: null,
    restrictions: [],
    ...over,
  };
}

/** A user who may edit only the region (07 §7: no definitions, page setup, headers or footers). */
export function regionOnlyAccess(): Access {
  return editorAccess({
    docRole: 'commenter',
    caps: [...READ],
    scopes: {
      doc: ['view'],
      body: [...READ],
      defs: ['view'],
      [`story:${SPIKE_IDS.header}`]: ['view'],
      [`region:${SPIKE_IDS.region}`]: [...EDIT],
    },
  });
}

/** An owner's access: everything, with `structure` and `manage`. */
export function ownerAccess(): Access {
  return editorAccess({
    docRole: 'owner',
    caps: [...EDIT, 'structure', 'manage'],
    scopes: {
      doc: [...EDIT],
      body: [...EDIT],
      defs: [...EDIT],
      [`story:${SPIKE_IDS.header}`]: [...EDIT],
      [`region:${SPIKE_IDS.region}`]: [...EDIT],
    },
  });
}

type JsonNode = { type: string; attrs?: Record<string, unknown>; content?: JsonNode[] };

/** The spike document as a reader sees it when the region is hidden (ADR 0019). */
export function projectedDocument(title: string | null = null): CdmEnvelope {
  const env = spikeDocument();
  const doc = structuredClone(env.doc) as JsonNode;
  const body = doc.content![doc.content!.length - 1]!;
  body.content = body.content!.map((n) =>
    n.type === 'region' ? { type: 'hidden_region', attrs: { id: SPIKE_IDS.region, title } } : n,
  );
  return { ...env, doc };
}

export const STYLE_IDS = {
  heading: 'pHeading00000001',
  quote: 'pQuote0000000001',
  plain: 'pPlain0000000001',
  region: 'rStyled000000001',
  inRegion: 'pInRegion0000001',
  after: 'pAfter0000000001',
} as const;

/**
 * Paragraph styles of the minimum demo (11 §3: Normal and two headings) plus a custom style without
 * `next` and a custom heading whose outline level comes through `basedOn` (03 §4.3).
 */
export function styledDocument(): CdmEnvelope {
  const style = (attrs: Record<string, unknown>) => ({ type: 'style_def', attrs });
  const p = (id: string, text: string, styleId: string | null = null) => ({
    type: 'paragraph',
    attrs: { id, style: styleId },
    content: [{ type: 'text', text }],
  });
  return {
    cdm: 1,
    requires: [],
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            { type: 'settings', attrs: { lang: 'en-GB', defaultParagraphStyle: 'Normal' } },
            style({ id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true }),
            style({
              id: 'Heading1',
              kind: 'paragraph',
              name: 'Heading 1',
              builtIn: true,
              basedOn: 'Normal',
              next: 'Normal',
              outlineLevel: 1,
            }),
            style({
              id: 'Heading2',
              kind: 'paragraph',
              name: 'Heading 2',
              builtIn: true,
              basedOn: 'Normal',
              next: 'Normal',
              outlineLevel: 2,
            }),
            style({ id: 'Quote', kind: 'paragraph', name: 'Quote', basedOn: 'Normal' }),
            style({ id: 'Chapter', kind: 'paragraph', name: 'Chapter', basedOn: 'Heading1' }),
            style({ id: 'Emphasis', kind: 'character', name: 'Emphasis' }),
            { type: 'page_setup', attrs: { id: 'ps1' } },
          ],
        },
        {
          type: 'body',
          attrs: { pageSetup: 'ps1' },
          content: [
            p(STYLE_IDS.heading, 'Introduction', 'Heading1'),
            p(STYLE_IDS.quote, 'A quotation', 'Quote'),
            p(STYLE_IDS.plain, 'Plain text'),
            {
              type: 'region',
              attrs: { id: STYLE_IDS.region, title: 'Clause', policy: 'restricted' },
              content: [p(STYLE_IDS.inRegion, 'Protected text')],
            },
            p(STYLE_IDS.after, 'After the region'),
          ],
        },
      ],
    },
  };
}

/** An editor's access to the styled document, without the restricted region. */
export function styledEditorAccess(): Access {
  return {
    rev: 1,
    asOfSeq: 0,
    docRole: 'editor',
    caps: [...EDIT],
    scopes: {
      doc: ['view'],
      body: [...EDIT],
      defs: ['view'],
      [`region:${STYLE_IDS.region}`]: [...READ],
    },
    leases: {},
    fill: null,
    restrictions: [],
  };
}
