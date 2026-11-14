/**
 * SPDX 2.3 documents in JSON (SEC-051; ADR 0044 §3): the bill of materials of each release
 * artefact. Output is deterministic: elements are sorted, identifiers are derived from names and
 * versions, the namespace from the content, and the creation time is passed in (SOURCE_DATE_EPOCH
 * in the pipeline).
 */
import { createHash } from 'node:crypto';
import { parseSpdx } from '../licence-policy.ts';

export type SpdxChecksumAlgorithm = 'SHA1' | 'SHA256' | 'SHA384' | 'SHA512';

export interface SpdxChecksum {
  algorithm: SpdxChecksumAlgorithm;
  checksumValue: string;
}

export interface SpdxExternalRef {
  referenceCategory: 'PACKAGE-MANAGER' | 'SECURITY' | 'PERSISTENT-ID' | 'OTHER';
  referenceType: string;
  referenceLocator: string;
}

export interface SpdxPackage {
  SPDXID: string;
  name: string;
  versionInfo?: string;
  packageFileName?: string;
  downloadLocation: string;
  filesAnalyzed: boolean;
  packageVerificationCode?: { packageVerificationCodeValue: string };
  checksums?: SpdxChecksum[];
  homepage?: string;
  licenseConcluded: string;
  licenseDeclared: string;
  copyrightText: string;
  supplier?: string;
  externalRefs?: SpdxExternalRef[];
  primaryPackagePurpose?: 'APPLICATION' | 'LIBRARY' | 'CONTAINER' | 'FILE' | 'ARCHIVE' | 'OTHER';
  summary?: string;
  comment?: string;
}

export interface SpdxFile {
  SPDXID: string;
  fileName: string;
  checksums: SpdxChecksum[];
  licenseConcluded?: string;
  copyrightText?: string;
  comment?: string;
}

export type SpdxRelationshipType =
  'DESCRIBES' | 'CONTAINS' | 'DEPENDS_ON' | 'GENERATED_FROM' | 'DESCENDANT_OF' | 'OTHER';

export interface SpdxRelationship {
  spdxElementId: string;
  relationshipType: SpdxRelationshipType;
  relatedSpdxElement: string;
  comment?: string;
}

export interface SpdxLicenceRef {
  licenseId: string;
  extractedText: string;
  name?: string;
  seeAlsos?: string[];
}

export interface SpdxDocument {
  spdxVersion: 'SPDX-2.3';
  dataLicense: 'CC0-1.0';
  SPDXID: 'SPDXRef-DOCUMENT';
  name: string;
  documentNamespace: string;
  creationInfo: { created: string; creators: string[]; comment?: string };
  comment?: string;
  packages: SpdxPackage[];
  files?: SpdxFile[];
  relationships: SpdxRelationship[];
  hasExtractedLicensingInfos?: SpdxLicenceRef[];
}

export const NOASSERTION = 'NOASSERTION';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** An SPDX identifier: the readable parts, sanitised, and a short hash so that two never collide. */
export function spdxId(kind: string, ...parts: string[]): string {
  const readable = parts
    .join('-')
    .replace(/[^A-Za-z0-9.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `SPDXRef-${kind}-${readable}-${sha256(`${kind}\u0000${parts.join('\u0000')}`).slice(0, 8)}`;
}

/** A package URL for an npm package (purl-spec: the scope's `@` is percent-encoded). */
export function npmPurl(name: string, version: string): string {
  const slash = name.indexOf('/');
  const path =
    name.startsWith('@') && slash > 1
      ? `%40${encodeURIComponent(name.slice(1, slash))}/${encodeURIComponent(name.slice(slash + 1))}`
      : encodeURIComponent(name);
  return `pkg:npm/${path}@${encodeURIComponent(version)}`;
}

/** The registry tarball address pnpm resolves for a package (the default registry; .npmrc sets none). */
export function npmTarballUrl(name: string, version: string): string {
  const base = name.includes('/') ? name.split('/')[1]! : name;
  return `https://registry.npmjs.org/${name}/-/${base}-${version}.tgz`;
}

/** SPDX 2.3 §7.9: SHA-1 over the sorted, concatenated SHA-1 values of the package's files. */
export function verificationCode(fileSha1s: readonly string[]): string {
  return createHash('sha1')
    .update(
      [...fileSha1s]
        .map((s) => s.toLowerCase())
        .sort()
        .join(''),
    )
    .digest('hex');
}

/** An SPDX licence expression as declared, or NOASSERTION when the text is not one. */
export function licenceExpression(text: string | undefined | null): string {
  if (!text || text === 'UNKNOWN' || text === 'UNLICENSED') return NOASSERTION;
  const trimmed = text.trim().replace(/^\((.*)\)$/, '$1');
  return parseSpdx(trimmed) ? trimmed : NOASSERTION;
}

const ORDER = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export interface DocumentInput {
  name: string;
  namespaceBase: string;
  created: string;
  creators: string[];
  /** The packages the document describes (the artefacts); listed first. */
  describes: SpdxPackage[];
  packages: SpdxPackage[];
  files?: SpdxFile[];
  relationships: SpdxRelationship[];
  licenceRefs?: SpdxLicenceRef[];
  comment?: string;
}

/** Assembles a document with a stable order and a namespace derived from its content. */
export function buildDocument(input: DocumentInput): SpdxDocument {
  const describedIds = new Set(input.describes.map((p) => p.SPDXID));
  const others = input.packages
    .filter((p) => !describedIds.has(p.SPDXID))
    .sort((a, b) => ORDER(a.SPDXID, b.SPDXID));
  const seen = new Set<string>();
  const relationships = [
    ...input.describes.map((p): SpdxRelationship => ({
      spdxElementId: 'SPDXRef-DOCUMENT',
      relationshipType: 'DESCRIBES',
      relatedSpdxElement: p.SPDXID,
    })),
    ...input.relationships,
  ]
    .filter((r) => {
      const k = `${r.spdxElementId} ${r.relationshipType} ${r.relatedSpdxElement}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort(
      (a, b) =>
        ORDER(a.spdxElementId, b.spdxElementId) ||
        ORDER(a.relationshipType, b.relationshipType) ||
        ORDER(a.relatedSpdxElement, b.relatedSpdxElement),
    );
  const doc: SpdxDocument = {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: input.name,
    documentNamespace: '',
    creationInfo: { created: input.created, creators: [...input.creators] },
    ...(input.comment ? { comment: input.comment } : {}),
    packages: [...input.describes, ...others],
    ...(input.files?.length
      ? { files: [...input.files].sort((a, b) => ORDER(a.fileName, b.fileName)) }
      : {}),
    relationships,
    ...(input.licenceRefs?.length
      ? {
          hasExtractedLicensingInfos: [...input.licenceRefs].sort((a, b) =>
            ORDER(a.licenseId, b.licenseId),
          ),
        }
      : {}),
  };
  const base = input.namespaceBase.replace(/\/+$/, '');
  doc.documentNamespace = `${base}/${encodeURIComponent(input.name)}-${sha256(stringify(doc)).slice(0, 32)}`;
  return doc;
}

export function stringify(doc: SpdxDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

const ID = /^SPDXRef-[A-Za-z0-9.-]+$/;
const HEX = { SHA1: 40, SHA256: 64, SHA384: 96, SHA512: 128 } as const;

function licenceProblems(where: string, value: string | undefined, refs: Set<string>): string[] {
  if (value === undefined) return [];
  if (value === NOASSERTION || value === 'NONE') return [];
  if (!parseSpdx(value)) return [`${where}: "${value}" is not an SPDX licence expression`];
  const missing = [...value.matchAll(/LicenseRef-[A-Za-z0-9.-]+/g)]
    .map((m) => m[0])
    .filter((r) => !refs.has(r));
  return missing.map((r) => `${where}: ${r} is used but not defined in hasExtractedLicensingInfos`);
}

function checksumProblems(where: string, list: readonly SpdxChecksum[] | undefined): string[] {
  const out: string[] = [];
  for (const c of list ?? []) {
    const len = HEX[c.algorithm];
    if (!len || !new RegExp(`^[0-9a-f]{${len}}$`).test(c.checksumValue))
      out.push(`${where}: ${c.algorithm} checksum "${c.checksumValue}" is malformed`);
  }
  return out;
}

/**
 * Structural checks of SPDX 2.3 §6 to §11 that matter here: required fields, identifier syntax
 * and uniqueness, licence expressions and their references, checksums, relationships that point at
 * elements of the document. It is not the SPDX project's validator.
 */
export function validateDocument(doc: SpdxDocument): string[] {
  const problems: string[] = [];
  if (doc.spdxVersion !== 'SPDX-2.3') problems.push('spdxVersion must be SPDX-2.3');
  if (doc.dataLicense !== 'CC0-1.0') problems.push('dataLicense must be CC0-1.0');
  if (doc.SPDXID !== 'SPDXRef-DOCUMENT')
    problems.push('the document SPDXID must be SPDXRef-DOCUMENT');
  if (!doc.name) problems.push('the document has no name');
  if (!/^[a-z][a-z0-9+.-]*:\/\/[^#\s]+$/i.test(doc.documentNamespace))
    problems.push(
      `documentNamespace "${doc.documentNamespace}" is not an absolute URI without a fragment`,
    );
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(doc.creationInfo.created))
    problems.push(`creationInfo.created "${doc.creationInfo.created}" is not YYYY-MM-DDThh:mm:ssZ`);
  if (!doc.creationInfo.creators.length) problems.push('creationInfo.creators is empty');
  for (const c of doc.creationInfo.creators)
    if (!/^(Tool|Organization|Person): \S/.test(c))
      problems.push(`creator "${c}" has no Tool:, Organization: or Person: prefix`);
  const refs = new Set((doc.hasExtractedLicensingInfos ?? []).map((r) => r.licenseId));
  for (const r of doc.hasExtractedLicensingInfos ?? []) {
    if (!/^LicenseRef-[A-Za-z0-9.-]+$/.test(r.licenseId))
      problems.push(`licence reference "${r.licenseId}" is malformed`);
    if (!r.extractedText) problems.push(`licence reference ${r.licenseId} has no extractedText`);
  }
  const ids = new Set<string>(['SPDXRef-DOCUMENT']);
  const addId = (id: string, where: string) => {
    if (!ID.test(id)) problems.push(`${where}: SPDXID "${id}" is malformed`);
    if (ids.has(id)) problems.push(`${where}: SPDXID ${id} is not unique`);
    ids.add(id);
  };
  for (const p of doc.packages) {
    const where = `package ${p.name}${p.versionInfo ? `@${p.versionInfo}` : ''}`;
    addId(p.SPDXID, where);
    if (!p.name) problems.push(`${where}: no name`);
    if (!p.downloadLocation) problems.push(`${where}: no downloadLocation`);
    if (!p.copyrightText) problems.push(`${where}: no copyrightText`);
    if (p.filesAnalyzed && !p.packageVerificationCode)
      problems.push(`${where}: filesAnalyzed is true but there is no packageVerificationCode`);
    problems.push(
      ...licenceProblems(`${where} licenseConcluded`, p.licenseConcluded, refs),
      ...licenceProblems(`${where} licenseDeclared`, p.licenseDeclared, refs),
      ...checksumProblems(where, p.checksums),
    );
    for (const ref of p.externalRefs ?? [])
      if (ref.referenceType === 'purl' && !/^pkg:[a-z]+\/\S+@\S+$/.test(ref.referenceLocator))
        problems.push(`${where}: purl "${ref.referenceLocator}" is malformed`);
  }
  for (const f of doc.files ?? []) {
    const where = `file ${f.fileName}`;
    addId(f.SPDXID, where);
    if (!f.fileName.startsWith('./')) problems.push(`${where}: fileName must start with ./`);
    if (!f.checksums.some((c) => c.algorithm === 'SHA1'))
      problems.push(`${where}: no SHA1 checksum`);
    problems.push(
      ...checksumProblems(where, f.checksums),
      ...licenceProblems(`${where} licenseConcluded`, f.licenseConcluded, refs),
    );
  }
  if (
    !doc.relationships.some(
      (r) => r.spdxElementId === 'SPDXRef-DOCUMENT' && r.relationshipType === 'DESCRIBES',
    )
  )
    problems.push('no DESCRIBES relationship from the document');
  for (const r of doc.relationships)
    for (const id of [r.spdxElementId, r.relatedSpdxElement])
      if (!ids.has(id) && id !== NOASSERTION && id !== 'NONE')
        problems.push(
          `relationship ${r.spdxElementId} ${r.relationshipType} ${r.relatedSpdxElement}: ${id} is not in the document`,
        );
  return problems;
}
