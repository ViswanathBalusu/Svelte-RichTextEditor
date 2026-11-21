/**
 * The document of the SEC-005 wire suites: the `all-constructs` canonical fixture of CDM-011, which
 * holds every node type and every mark type of the schema, placed in a real document.
 *
 * Five node types name a stored object (`image`, `figure` and its `caption`, `preserved_block`,
 * `preserved_inline`: an asset, or the asset that holds a preserved fragment; I4), and a new
 * document has none. So the document is created without them, one upload is declared for each
 * stored object the fixture names (`POST /documents/{id}/assets`, by the user who will attack) and
 * settled ready, as the asset worker leaves it, and the whole fixture, renamed to those assets, is
 * put in place with `PUT /documents/{id}/content`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import type { Harness } from './harness.ts';

export interface Json {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: Json[];
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  text?: string;
  [key: string]: unknown;
}

/** The attributes that name a stored object: an asset, or the asset that holds a preserved fragment. */
const STORED = ['asset', 'fallbackAsset', 'fragment'] as const;

/**
 * The content without what needs an uploaded asset or a preserved fragment (I4). A node that names
 * one is removed, and an `origin` that names a fragment is cleared.
 */
export function withoutStoredObjects(node: Json): Json | null {
  const attrs = node.attrs ?? {};
  for (const name of STORED) if (typeof attrs[name] === 'string') return null;
  const out: Json = { ...node };
  const origin = attrs['origin'];
  if (origin && typeof origin === 'object' && 'fragment' in origin)
    out.attrs = { ...attrs, origin: null };
  if (node.content)
    out.content = node.content
      .map((child) => withoutStoredObjects(child))
      .filter((child): child is Json => child !== null);
  return out;
}

/** The identifiers of the stored objects a piece of content names. */
export function storedObjects(node: Json, found = new Set<string>()): Set<string> {
  const attrs = node.attrs ?? {};
  for (const name of STORED) {
    const v = attrs[name];
    if (typeof v === 'string') found.add(v);
  }
  const origin = attrs['origin'] as { fragment?: unknown } | null | undefined;
  if (origin && typeof origin.fragment === 'string') found.add(origin.fragment);
  for (const child of node.content ?? []) storedObjects(child, found);
  return found;
}

/** The same content with every stored object renamed: `ids` maps the fixture's name to an asset. */
export function withStoredObjects(node: Json, ids: ReadonlyMap<string, string>): Json {
  const out: Json = { ...node };
  if (node.attrs) {
    const attrs: Record<string, unknown> = { ...node.attrs };
    for (const name of STORED) {
      const v = attrs[name];
      if (typeof v === 'string') attrs[name] = ids.get(v) ?? v;
    }
    const origin = attrs['origin'] as { fragment?: unknown } | null | undefined;
    if (origin && typeof origin.fragment === 'string')
      attrs['origin'] = { ...origin, fragment: ids.get(origin.fragment) ?? origin.fragment };
    out.attrs = attrs;
  }
  if (node.content) out.content = node.content.map((child) => withStoredObjects(child, ids));
  return out;
}

/** The node types that name a stored object, or sit inside one that does (a figure's caption). */
export const NEED_STORED: readonly string[] = [
  'caption',
  'figure',
  'image',
  'preserved_block',
  'preserved_inline',
];

/** The features the fixture requires, which a client must announce to open it. */
export const FEATURES = ['presence', 'regions', 'extensions', 'fields', 'preserve'];

/** The fixture as it is stored in the repository. */
export const RAW = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../../../packages/model/fixtures/canonical/inputs/all-constructs.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
) as Record<string, unknown> & { doc: Json };

/** What a document is created with: the fixture without its stored objects. */
export const WITHOUT_STORED: Record<string, unknown> = {
  ...RAW,
  doc: withoutStoredObjects(RAW.doc),
};

/** The stored objects the whole fixture names; each becomes an uploaded asset of a test. */
export const STORED_OBJECTS: readonly string[] = [...storedObjects(RAW.doc)];

export interface Placed {
  doc: string;
  /** The envelope now stored: the whole fixture with its stored objects renamed. */
  envelope: Record<string, unknown> & { doc: Json };
  /** The head after the fixture was put in place. */
  seq: number;
  etag: string;
}

/**
 * A new document of tenant `a` that holds the whole fixture. `uploader` is the `sub` who declares
 * the uploads, so that this user may also name the assets in commits (BE-044).
 */
export async function placeWholeFixture(h: Harness, uploader: string): Promise<Placed> {
  const doc = await h.createDocument(h.a, WITHOUT_STORED);
  const token = await h.mintToken(h.a, uploader, { [doc]: 'owner' });
  const ids = new Map<string, string>();
  for (const name of STORED_OBJECTS) {
    const declared = await h.call('POST', `/v1/documents/${doc}/assets`, {
      token,
      body: { filename: 'stored.png', mime: 'image/png', size: 10 },
    });
    expect(declared.status, declared.text).toBe(201);
    const id = (declared.json as { asset: string }).asset;
    await h.parts.assetRegistry.settleReady(
      h.a.id,
      id,
      {
        sha256: 'a'.repeat(64),
        bytes: 10,
        contentType: 'image/png',
        objectKey: `k/${id}`,
        width: 10,
        height: 10,
        frames: null,
        renditions: [],
      },
      Date.now(),
    );
    ids.set(name, id);
  }
  const envelope = { ...RAW, doc: withStoredObjects(RAW.doc, ids) };
  const head = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey });
  const put = await h.call('PUT', `/v1/documents/${doc}/content`, {
    token: h.a.apiKey,
    body: envelope,
    headers: { 'If-Match': head.headers.get('etag') ?? '' },
  });
  expect(put.status, put.text).toBe(204);
  const now = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey });
  return {
    doc,
    envelope,
    seq: (now.json as { seq: number }).seq,
    etag: now.headers.get('etag') ?? '',
  };
}
