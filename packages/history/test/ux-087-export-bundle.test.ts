// The export bundle format and its offline verifier (UX-087 criterion 3, UX-088 criteria 2 to 4):
// the archive, the manifest and parts.json, the check of every file against the manifest and
// against its documented format, the history verified with the chain verifier, the counts and
// heads, secrets, and the command-line tool with its exit codes. The bundles are built here from
// the log fixtures of the other history tests; the service writes the same layout
// (services/document-service/test/control-plane/ux-087-088-bundle-export.test.ts).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXIT } from '../src/chain.ts';
import {
  BUNDLE_FORMAT_ID,
  FILE_FORMATS,
  PARTS_FORMAT,
  type BundleKind,
  type Manifest,
  type PartsIndex,
  decodeUtf8,
  manifestFile,
  packFiles,
  sha256Of,
  unpackFiles,
  verifyExportBundle,
} from '../src/export-bundle.ts';
import { DOC, bundleOf } from './bundle.ts';
import { LogBuilder, typeAt } from './fixtures.ts';

const enc = new TextEncoder();
const text = (v: unknown): Uint8Array => enc.encode(JSON.stringify(v));
const lines = (rows: unknown[]): Uint8Array =>
  enc.encode(rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));

interface Built {
  parts: Map<string, Uint8Array>;
  index: Uint8Array;
}

/** Packs the files into one part with its manifest, and writes parts.json. */
async function bundle(
  kind: BundleKind,
  files: Array<{ path: string; bytes: Uint8Array; records?: number }>,
  counts: Manifest['counts'],
  heads: Manifest['chainHeads'],
): Promise<Built> {
  const listed = [];
  for (const f of files) listed.push(await manifestFile(f.path, f.bytes, f.records));
  const manifest: Manifest = {
    format: BUNDLE_FORMAT_ID,
    kind,
    tenant: 'tenant-1',
    createdAt: '2026-11-26T10:00:00Z',
    requestedBy: 'admin-1',
    part: { index: 1, count: 1 },
    files: listed,
    counts,
    chainHeads: heads,
  };
  const manifestBytes = text(manifest);
  const archive = packFiles([{ path: 'manifest.json', bytes: manifestBytes }, ...files]);
  const index: PartsIndex = {
    format: PARTS_FORMAT,
    kind,
    tenant: 'tenant-1',
    count: 1,
    parts: [
      {
        name: 'part-0001.tar',
        sha256: await sha256Of(archive),
        size: archive.length,
        manifestSha256: await sha256Of(manifestBytes),
        documents: 1,
      },
    ],
  };
  return { parts: new Map([['part-0001.tar', archive]]), index: text(index) };
}

const RECORD = {
  id: DOC,
  title: 'Lease',
  state: 'active',
  classification: null,
  cdm: 1,
  requires: [],
  historyVisibility: 'full',
  properties: {},
  createdBy: 'u1',
  createdAt: '2026-11-26T09:00:00Z',
  head: 3,
};
const INCLUSION = {
  format: 'docedit-inclusion/1',
  document: DOC,
  content: { seq: 3 },
  history: { commits: 3, payloads: 'hash-only' },
  retention: { source: 'default', effective: null },
  holds: [],
  thinned: [],
  evidence: 'none',
};
const THREAD = {
  id: 't1',
  scope: 'body',
  state: 'open',
  target: { block: 'p1' },
  createdBy: 'u1',
  createdAt: 1,
  comments: [{ id: 'c1' }, { id: 'c2' }],
};

async function discovery(): Promise<{ built: Built; files: Map<string, Uint8Array> }> {
  const b = new LogBuilder();
  for (let i = 0; i < 3; i++) b.add((d) => typeAt(d, 'pIntro0000000001', 0, `row ${i} `));
  const log = await bundleOf(b.log);
  const base = `documents/${DOC}`;
  const files = [
    { path: `${base}/document.json`, bytes: text(RECORD) },
    { path: `${base}/content.json`, bytes: text({ cdm: 1, requires: [], doc: { type: 'doc' } }) },
    { path: `${base}/history.json`, bytes: text(log) },
    {
      path: `${base}/comments.ndjson`,
      bytes: lines([THREAD]),
      records: 1,
    },
    {
      path: `${base}/versions.ndjson`,
      bytes: lines([{ seq: 2, kind: 'named', createdBy: 'u1', createdAt: 1 }]),
      records: 1,
    },
    { path: `${base}/inclusion.json`, bytes: text(INCLUSION) },
  ];
  const built = await bundle(
    'discovery',
    files,
    { documents: 1, commits: 3, threads: 1, comments: 2, versions: 1, grants: 0 },
    { [DOC]: { seq: log.head.seq, chainHead: log.head.chainHead } },
  );
  return { built, files: new Map(files.map((f) => [f.path, f.bytes])) };
}

/** Changes the files of the one part and writes a manifest, parts.json and part that agree. */
async function repack(
  built: Built,
  change: (files: Map<string, Uint8Array>, manifest: Manifest) => void,
): Promise<Built> {
  const files = new Map(
    unpackFiles(built.parts.get('part-0001.tar')!)!.map((f) => [f.path, f.bytes] as const),
  );
  const manifest = JSON.parse(decodeUtf8(files.get('manifest.json')!)) as Manifest;
  files.delete('manifest.json');
  change(files, manifest);
  manifest.files = [];
  for (const [path, bytes] of files) manifest.files.push(await manifestFile(path, bytes));
  const manifestBytes = text(manifest);
  const archive = packFiles([
    { path: 'manifest.json', bytes: manifestBytes },
    ...[...files].map(([path, bytes]) => ({ path, bytes })),
  ]);
  const index = JSON.parse(decodeUtf8(built.index)) as PartsIndex;
  index.parts[0] = {
    ...index.parts[0]!,
    sha256: await sha256Of(archive),
    size: archive.length,
    manifestSha256: await sha256Of(manifestBytes),
  };
  return { parts: new Map([['part-0001.tar', archive]]), index: text(index) };
}

const LINE = new RegExp(String.fromCharCode(92) + 'r?' + String.fromCharCode(92) + 'n');

describe('the archive of a part', () => {
  it('packs and unpacks files byte for byte, including empty files and non-ASCII names', () => {
    const files = [
      { path: 'a.json', bytes: enc.encode('{"é":1}') },
      { path: 'empty', bytes: new Uint8Array(0) },
      { path: 'big.bin', bytes: new Uint8Array(1500).fill(7) },
    ];
    const back = unpackFiles(packFiles(files))!;
    expect(back.map((f) => f.path)).toEqual(['a.json', 'empty', 'big.bin']);
    expect(back.map((f) => f.bytes)).toEqual(files.map((f) => f.bytes));
  });

  it('refuses a path of more than 100 bytes and reads a cut or damaged archive as none', () => {
    expect(() => packFiles([{ path: 'x'.repeat(101), bytes: new Uint8Array(1) }])).toThrow();
    const archive = packFiles([{ path: 'a', bytes: new Uint8Array(600).fill(1) }]);
    expect(unpackFiles(archive.subarray(0, 700))).toBeNull();
    const damaged = archive.slice();
    damaged[10] = 0x7a;
    expect(unpackFiles(damaged)).toBeNull();
  });
});

describe('verifying a discovery bundle offline (UX-087 criterion 3)', () => {
  it('finds an unchanged bundle intact: hashes, counts, chain and heads', async () => {
    const { built } = await discovery();
    const report = await verifyExportBundle(built);
    expect(report.problems).toEqual([]);
    expect(report.status).toBe('intact');
    expect(report.kind).toBe('discovery');
    expect(report.counts).toMatchObject({ documents: 1, commits: 3, threads: 1, comments: 2 });
    expect(report.histories[DOC]).toMatchObject({ status: 'intact', commits: 3, head: 3 });
  });

  it('finds a part that was changed after parts.json was written', async () => {
    const { built } = await discovery();
    const part = built.parts.get('part-0001.tar')!.slice();
    part[700] = (part[700] ?? 0) ^ 1;
    const report = await verifyExportBundle({
      parts: new Map([['part-0001.tar', part]]),
      index: built.index,
    });
    expect(report.status).toBe('altered');
    expect(report.problems.some((p) => p.check === 'parts')).toBe(true);
  });

  it('finds a file changed with the part and parts.json left as they were written', async () => {
    const { built } = await discovery();
    const files = unpackFiles(built.parts.get('part-0001.tar')!)!;
    const swapped = files.map((f) =>
      f.path.endsWith('content.json')
        ? { ...f, bytes: text({ cdm: 1, requires: [], doc: {} }) }
        : f,
    );
    const part = packFiles(swapped);
    const index = JSON.parse(decodeUtf8(built.index)) as PartsIndex;
    index.parts[0]!.sha256 = await sha256Of(part);
    index.parts[0]!.size = part.length;
    const report = await verifyExportBundle({
      parts: new Map([['part-0001.tar', part]]),
      index: text(index),
    });
    expect(report.status).toBe('altered');
    expect(report.problems.find((p) => p.check === 'file')?.at).toContain('content.json');
  });

  it('finds a record of the log changed with every hash of the bundle recomputed', async () => {
    const { built } = await discovery();
    const changed = await repack(built, (files) => {
      const path = `documents/${DOC}/history.json`;
      const log = JSON.parse(decodeUtf8(files.get(path)!));
      log.commits[1].meta.user = 'someone-else';
      files.set(path, text(log));
    });
    const report = await verifyExportBundle(changed);
    expect(report.status).toBe('altered');
    expect(report.problems.some((p) => p.check === 'history')).toBe(true);
    expect(report.histories[DOC]?.status).toBe('altered');
  });

  it('finds a file that lacks a member its documented format requires (UX-088 criterion 2)', async () => {
    const { built } = await discovery();
    const changed = await repack(built, (files) => {
      files.set(`documents/${DOC}/inclusion.json`, text({ format: 'docedit-inclusion/1' }));
      files.set(`documents/${DOC}/comments.ndjson`, lines([{ id: 't1', comments: [] }]));
    });
    const report = await verifyExportBundle(changed);
    const at = report.problems.filter((p) => p.check === 'format').map((p) => p.at);
    expect(at).toContain(`documents/${DOC}/inclusion.json`);
    expect(at).toContain(`documents/${DOC}/comments.ndjson`);
    expect(report.problems.find((p) => p.reason.includes('`holds`'))).toBeDefined();
  });

  it('finds an asset that is not the content its name gives', async () => {
    const { built } = await discovery();
    const changed = await repack(built, (files, manifest) => {
      manifest.kind = 'tenant';
      files.set(`assets/${'a'.repeat(64)}`, enc.encode('not that hash'));
    });
    // The index says discovery, so the asset is also out of place; the hash check comes first.
    const report = await verifyExportBundle(changed);
    expect(report.problems.map((p) => p.reason).join(' ')).toContain('no documented format');
    const index = JSON.parse(decodeUtf8(changed.index)) as PartsIndex;
    index.kind = 'tenant';
    const asTenant = await verifyExportBundle({ parts: changed.parts, index: text(index) });
    expect(
      asTenant.problems.some((p) => p.at.startsWith('assets/') && p.reason.includes('content')),
    ).toBe(true);
  });

  it('finds a head in the manifest that is not the head of the log', async () => {
    const { built } = await discovery();
    const changed = await repack(built, (_files, manifest) => {
      manifest.chainHeads[DOC] = { seq: 2, chainHead: manifest.chainHeads[DOC]!.chainHead };
    });
    const report = await verifyExportBundle(changed);
    expect(report.problems.map((p) => p.check)).toContain('chain-head');
    expect(report.status).toBe('altered');
  });

  it('finds counts that are not what the files hold (UX-088 criterion 3)', async () => {
    const { built } = await discovery();
    const changed = await repack(built, (_files, manifest) => {
      manifest.counts.comments = 5;
    });
    const report = await verifyExportBundle(changed);
    expect(report.problems.find((p) => p.check === 'counts')?.reason).toContain('comments');
    expect(report.status).toBe('incomplete');
  });

  it('reports a missing part, a file that is not in the manifest and a path with no documented format', async () => {
    const { built } = await discovery();
    const missing = await verifyExportBundle({ parts: new Map(), index: built.index });
    expect(missing.status).toBe('incomplete');
    expect(missing.problems[0]).toMatchObject({ check: 'parts', reason: 'the part is missing' });

    const extra = await repack(built, (files) => {
      files.set('notes/unlisted.txt', enc.encode('x'));
    });
    const report = await verifyExportBundle(extra);
    expect(report.problems.map((p) => p.check)).toContain('format');
  });
});

describe('secrets and formats (UX-088 criteria 2 and 4)', () => {
  it('finds a secret member or value in a tenant file, and none in content that has a member named d', async () => {
    const { built } = await discovery();
    const withSecret = await repack(built, (files) => {
      files.set(
        `documents/${DOC}/inclusion.json`,
        text({ ...INCLUSION, webhook: { secret: 'x' } }),
      );
    });
    const bad = await verifyExportBundle(withSecret);
    expect(bad.problems.filter((p) => p.check === 'secret').map((p) => p.at)).toEqual([
      `documents/${DOC}/inclusion.json/webhook/secret`,
    ]);

    // A member named `d` in a document is the document's own business; a secret value is not.
    const fine = await repack(built, (files) => {
      files.set(
        `documents/${DOC}/content.json`,
        text({ cdm: 1, requires: [], doc: { attrs: { d: 'M0 0' } } }),
      );
    });
    expect((await verifyExportBundle(fine)).problems).toEqual([]);
    const value = await repack(built, (files) => {
      files.set(
        `documents/${DOC}/content.json`,
        text({ cdm: 1, requires: [], doc: { text: 'whsec_abcdef' } }),
      );
    });
    expect((await verifyExportBundle(value)).problems.map((p) => p.check)).toEqual(['secret']);
  });

  it('documents every format the verifier knows, with a version, in docs/export-bundle-formats.md', () => {
    const doc = readFileSync(
      fileURLToPath(new URL('../../../docs/export-bundle-formats.md', import.meta.url)),
      'utf8',
    );
    for (const f of FILE_FORMATS) {
      expect(f.id, f.path).toMatch(/^docedit-[a-z-]+\/[1-9][0-9]*$/);
      expect(doc, `${f.id} is documented`).toContain(f.id);
      expect(doc, `${f.path} is documented`).toContain(f.path);
    }
    // Each member the verifier requires is named in the row of its format.
    for (const f of FILE_FORMATS) {
      const row = doc.split(LINE).find((l) => l.startsWith(`| \`${f.id}\``));
      if (f.encoding === 'binary') continue;
      expect(row, `${f.id} has a row`).toBeDefined();
      for (const m of f.members) expect(row, `${f.id} names \`${m}\``).toContain(`\`${m}\``);
    }
    expect(doc).toContain(BUNDLE_FORMAT_ID);
    expect(doc).toContain(PARTS_FORMAT);
  });
});

describe('the command-line tool', () => {
  const tool = fileURLToPath(new URL('../scripts/verify-bundle.ts', import.meta.url));
  const write = (built: Built): string => {
    const dir = mkdtempSync(join(tmpdir(), 'ux-087-'));
    writeFileSync(join(dir, 'parts.json'), built.index);
    for (const [name, bytes] of built.parts) writeFileSync(join(dir, name), bytes);
    return dir;
  };
  const run = (dir: string) => spawnSync(process.execPath, [tool, dir], { encoding: 'utf8' });

  it('exits 0 on an intact bundle and prints one JSON report with no document text', async () => {
    const { built } = await discovery();
    const r = run(write(built));
    expect(r.status).toBe(EXIT.intact);
    const report = JSON.parse(r.stdout.trim());
    expect(report).toMatchObject({ status: 'intact', kind: 'discovery', parts: 1 });
    expect(r.stdout).not.toContain('row 0');
  });

  it('exits 1 on a changed bundle, 2 on a missing part and 3 when parts.json is not there', async () => {
    const { built } = await discovery();
    const changed = await repack(built, (files) => {
      const path = `documents/${DOC}/history.json`;
      const log = JSON.parse(decodeUtf8(files.get(path)!));
      log.commits[0].meta.user = 'someone-else';
      files.set(path, text(log));
    });
    expect(run(write(changed)).status).toBe(EXIT.altered);

    const dir = write(built);
    writeFileSync(join(dir, 'parts.json'), built.index);
    const noPart = mkdtempSync(join(tmpdir(), 'ux-087-'));
    writeFileSync(join(noPart, 'parts.json'), built.index);
    expect(run(noPart).status).toBe(EXIT.incomplete);
    expect(run(mkdtempSync(join(tmpdir(), 'ux-087-'))).status).toBe(EXIT.unreadable);
  });
});
