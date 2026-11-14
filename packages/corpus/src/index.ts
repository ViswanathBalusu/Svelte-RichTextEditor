/**
 * `@docedit/corpus`: the shared document corpus (FND-006), for every performance, layout and export
 * test. Universal: it runs in Node.js and in browsers, with no file-system access.
 *
 * - `corpusVersion` and `corpusStamp()`: what a test result records, so that results are only
 *   compared when they ran against the same corpus.
 * - `manifest`: `out/manifest.json`, with every document's page estimate, hashes, counts, features,
 *   attached assets and the licence of every source.
 * - `loadDocument(name)`: the document as a CDM envelope with its images. It is rebuilt by the
 *   deterministic generator and checked against the manifest's canonical hash, so a test never runs
 *   against a document that differs from the published corpus, and the large documents work without
 *   being generated to disk first.
 *
 * The files themselves are in `out/` and exported as `@docedit/corpus/out/*`; `documentFile` gives
 * a document's path inside the package.
 */
import { documentHash, type CdmEnvelope, type JsonEnvelope } from '@docedit/model';
import manifestJson from '../out/manifest.json' with { type: 'json' };
import { assetFileName, buildDocument, corpusImages, formatJson } from './generate/index.ts';
import type {
  CorpusManifest,
  CorpusStamp,
  ManifestAsset,
  ManifestDocument,
} from './generate/manifest.ts';

export type {
  CorpusManifest,
  CorpusStamp,
  ManifestAsset,
  ManifestDocument,
  PageCount,
} from './generate/manifest.ts';
export type { CorpusVersion } from './generate/version.ts';

/** The manifest of the corpus in this package (`out/manifest.json`). */
export const manifest: CorpusManifest = manifestJson as unknown as CorpusManifest;

/** The corpus version. It changes whenever the generator or its output changes. */
export const corpusVersion: number = manifest.version;

/** The names of the corpus documents, in manifest order. */
export const documentNames: readonly string[] = manifest.documents.map((d) => d.name);

/**
 * What a test result records about the corpus it ran against (FND-006). Put it in the result file of
 * a benchmark, or in the test's metadata: `task.meta.corpus = corpusStamp()`.
 */
export function corpusStamp(): CorpusStamp {
  return { corpus: manifest.corpus, version: manifest.version, fingerprint: manifest.fingerprint };
}

/** A short label for logs and test annotations, such as "docedit-corpus 1 (528ab574)". */
export function corpusLabel(): string {
  return `${manifest.corpus} ${manifest.version} (${manifest.fingerprint.slice(0, 8)})`;
}

/** The manifest entry of one document. */
export function documentEntry(name: string): ManifestDocument {
  const entry = manifest.documents.find((d) => d.name === name);
  if (!entry)
    throw new RangeError(
      `no corpus document "${name}"; the corpus has ${documentNames.join(', ')}`,
    );
  return entry;
}

/** The path of a document's file inside the package, for `@docedit/corpus/<path>`. */
export function documentFile(name: string): string {
  return `out/${documentEntry(name).file}`;
}

/** The path of an asset's file inside the package. */
export function assetFile(id: string): string {
  return `out/${assetFileName(id)}`;
}

export interface CorpusAsset {
  entry: ManifestAsset;
  bytes: Uint8Array;
}

export interface LoadedDocument {
  name: string;
  entry: ManifestDocument;
  envelope: CdmEnvelope;
  /** The document's attached assets, for `validate(envelope, { attachedAssets })` (invariant I4). */
  attachedAssets: ReadonlySet<string>;
  assets: readonly CorpusAsset[];
  corpus: CorpusStamp;
}

export interface LoadOptions {
  /** Compare the document with the manifest's canonical hash (default true). */
  verify?: boolean;
}

/**
 * Loads a corpus document by name. Throws when the document does not match the manifest, which
 * means that the generator changed and `pnpm --filter @docedit/corpus generate` was not run.
 */
export async function loadDocument(
  name: string,
  options: LoadOptions = {},
): Promise<LoadedDocument> {
  const entry = documentEntry(name);
  const built = buildDocument(name);
  if (options.verify !== false) {
    const hash = await documentHash(built.envelope as unknown as JsonEnvelope);
    if (hash !== entry.documentHash)
      throw new Error(
        `corpus document "${name}" does not match the manifest of corpus version ${manifest.version} ` +
          `(hash ${hash}, manifest ${entry.documentHash}); run pnpm --filter @docedit/corpus generate`,
      );
  }
  const images = new Map(corpusImages().map((i) => [i.id, i.bytes]));
  const assets = entry.assets.map((id) => {
    const asset = manifest.assets.find((a) => a.id === id);
    const bytes = images.get(id);
    if (!asset || !bytes) throw new Error(`corpus asset ${id} of "${name}" is missing`);
    return { entry: asset, bytes };
  });
  return {
    name,
    entry,
    envelope: built.envelope,
    attachedAssets: new Set(entry.assets),
    assets,
    corpus: corpusStamp(),
  };
}

/** The exact text of a corpus file for an envelope (Prettier's JSON layout, final line feed). */
export function serializeDocument(envelope: CdmEnvelope): string {
  return formatJson(envelope);
}
