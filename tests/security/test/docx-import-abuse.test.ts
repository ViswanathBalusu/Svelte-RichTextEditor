/**
 * SEC-039: an uploaded Word file cannot reach the network, run code or impersonate a colleague.
 *
 * The attacks are built from the sample package of export-docx (docx4j/sample-docx.docx) and run
 * through the real importer (importDocx). Each test states the criterion it proves:
 *
 * - criterion 1: a document type declaration, an external entity or an entity-expansion bomb is
 *   refused;
 * - criterion 2: external relationships (remote images, attached templates, hyperlinks) are not
 *   fetched, checked with a canary HTTP server on 127.0.0.1 that counts every request;
 * - criterion 3: a macro-enabled main part, or a package with a vbaProject.bin part, is refused;
 * - criterion 5: a tracked change whose author is named like a user becomes a `word:` label, and no
 *   mark carries that bare identifier as its user;
 * - criterion 6: entry names with path traversal, and archives beyond the limits on compression
 *   ratio, entry count and total uncompressed size, are rejected by importDocx (the count and size
 *   limits are lowered through opts.limits so that the sample itself is over them).
 *
 * Criterion 4 (embedded objects are dropped with a warning) no longer holds: under A2 they are kept
 * as opaque preserved content (10 section 3.5 as edited). Criterion 7 (the fuzz target of SEC-059)
 * is not covered here.
 */
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_ZIP_LIMITS,
  ImportError,
  ZipError,
  entryData,
  importDocx,
  readZip,
  writeZip,
  type ZipWriteEntry,
} from '../../../packages/export-docx/src/index.ts';

const SAMPLE = fileURLToPath(
  new URL('../../../packages/export-docx/corpus/docx4j/sample-docx.docx', import.meta.url),
);
const sample = (): Uint8Array => new Uint8Array(readFileSync(SAMPLE));

const MAIN_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const MACRO_TYPE = 'application/vnd.ms-word.document.macroEnabled.main+xml';
const DOC_RELS = 'word/_rels/document.xml.rels';

/**
 * The sample package with each part passed through `edit(name, text)`. A return of undefined keeps
 * the part raw; a string replaces its text; an extra entry is appended with `extra`.
 */
function rebuild(
  bytes: Uint8Array,
  edit: (name: string, text: string) => string | undefined,
  extra: ZipWriteEntry[] = [],
): Uint8Array {
  const zip = readZip(bytes);
  const entries: ZipWriteEntry[] = zip.entries.map((e) => {
    const text = new TextDecoder().decode(entryData(zip, e));
    const next = edit(e.name, text);
    if (next === undefined) return { name: e.name, copyOf: e, from: zip };
    return { name: e.name, data: new TextEncoder().encode(next), like: e };
  });
  return writeZip([...entries, ...extra]);
}

/** Replaces `needle` in a part, failing the test fixture if it is absent. */
function replaceIn(text: string, needle: string | RegExp, with_: string): string {
  const next = text.replace(needle, with_);
  if (next === text) throw new Error(`the fixture does not contain ${String(needle)}`);
  return next;
}

/** Inserts `snippet` after the body's opening tag of the main part. */
function withBody(bytes: Uint8Array, snippet: string): Uint8Array {
  return rebuild(bytes, (name, text) =>
    name === 'word/document.xml' ? replaceIn(text, '<w:body>', `<w:body>${snippet}`) : undefined,
  );
}

async function importOutcome(
  bytes: Uint8Array,
): Promise<{ ok: boolean; error?: unknown; value?: Awaited<ReturnType<typeof importDocx>> }> {
  try {
    return { ok: true, value: await importDocx(bytes) };
  } catch (error) {
    return { ok: false, error };
  }
}

describe('SEC-039 criterion 1: XML with a document type declaration is refused', () => {
  const DTD_CASES: Record<string, string> = {
    'an internal entity declaration': '<!DOCTYPE w:document [<!ENTITY x "y">]>',
    'an external system entity': '<!DOCTYPE w:document [<!ENTITY x SYSTEM "file:///etc/hosts">]>',
    'an entity-expansion bomb':
      '<!DOCTYPE w:document [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]>',
  };

  for (const [label, dtd] of Object.entries(DTD_CASES)) {
    it(`refuses the main part with ${label}`, async () => {
      const bytes = rebuild(sample(), (name, text) =>
        name === 'word/document.xml'
          ? text.replace(/^(<\?xml[^>]*\?>\s*)?/, (m) => `${m}${dtd}`)
          : undefined,
      );
      const outcome = await importOutcome(bytes);
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toBeInstanceOf(ImportError);
    });
  }

  it('control: the same sample without a DTD imports', async () => {
    expect((await importOutcome(sample())).ok).toBe(true);
  });
});

describe('SEC-039 criterion 2: external relationships are not fetched', () => {
  let canary: Server;
  let base = '';
  let hits = 0;

  beforeAll(async () => {
    canary = createServer((_req, res) => {
      hits++;
      res.statusCode = 200;
      res.end('canary');
    });
    await new Promise<void>((resolve) => canary.listen(0, '127.0.0.1', resolve));
    const address = canary.address();
    if (typeof address !== 'object' || address === null) throw new Error('canary has no address');
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => canary.close(() => resolve()));
  });

  it('control: the canary counts a request that is actually made', async () => {
    hits = 0;
    await fetch(`${base}/control`);
    expect(hits).toBe(1);
  });

  it('imports a file whose relationships point at the canary, and the canary sees no request', async () => {
    hits = 0;
    const rels = [
      `<Relationship Id="rIdCanaryImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${base}/image.png" TargetMode="External"/>`,
      `<Relationship Id="rIdCanaryTpl" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="${base}/template.dotm" TargetMode="External"/>`,
      `<Relationship Id="rIdCanaryLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${base}/link" TargetMode="External"/>`,
    ].join('');
    const bytes = rebuild(sample(), (name, text) =>
      name === DOC_RELS
        ? replaceIn(text, '</Relationships>', `${rels}</Relationships>`)
        : undefined,
    );
    // Refusal or acceptance are both allowed; the criterion is about the request, not the verdict.
    await importOutcome(bytes);
    expect(hits).toBe(0);
  });
});

describe('SEC-039 criterion 3: macro-enabled files are refused', () => {
  it('control: the sample imports', async () => {
    expect((await importOutcome(sample())).ok).toBe(true);
  });

  it('refuses a main part declared as macro-enabled', async () => {
    const bytes = rebuild(sample(), (name, text) =>
      name === '[Content_Types].xml' ? replaceIn(text, MAIN_TYPE, MACRO_TYPE) : undefined,
    );
    const outcome = await importOutcome(bytes);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBeInstanceOf(ImportError);
    expect((outcome.error as Error).message).toMatch(/macro-enabled/);
  });

  it('refuses a package that carries a vbaProject.bin part under a normal main type', async () => {
    const bytes = rebuild(sample(), () => undefined, [
      { name: 'word/vbaProject.bin', data: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]) },
    ]);
    const outcome = await importOutcome(bytes);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBeInstanceOf(ImportError);
    expect((outcome.error as Error).message).toMatch(/macro-enabled/);
  });
});

describe('SEC-039 criterion 5: a tracked change author is a label, not a user', () => {
  it('imports the author as a word: label and never as a bare user identifier', async () => {
    const existingUser = 'u_alice_0000000000000000';
    const bytes = withBody(
      sample(),
      `<w:p><w:ins w:id="9001" w:author="${existingUser}" w:date="2026-11-01T00:00:00Z"><w:r><w:t>tracked</w:t></w:r></w:ins></w:p>`,
    );
    const outcome = await importOutcome(bytes);
    expect(outcome.ok).toBe(true);
    const marks: { type?: string; attrs?: Record<string, unknown> }[] = [];
    const stack: unknown[] = [outcome.value!.envelope.doc];
    while (stack.length) {
      const n = stack.pop() as { marks?: unknown[]; content?: unknown[] };
      for (const m of (n.marks ?? []) as { type?: string; attrs?: Record<string, unknown> }[])
        marks.push(m);
      for (const c of n.content ?? []) stack.push(c);
    }
    const suggestion = marks.find(
      (m) => m.type === 'ins' && m.attrs?.['user'] === `word:${existingUser}`,
    );
    expect(suggestion).toBeDefined();
    expect(marks.some((m) => m.attrs?.['user'] === existingUser)).toBe(false);
  });
});

describe('SEC-039 criterion 6: archives with traversal names or a bomb ratio are rejected', () => {
  it('refuses a compression ratio beyond the limit before any part is read', async () => {
    const zeros = new Uint8Array(64 * 1024 * 1024);
    const src = readZip(sample());
    const bomb = writeZip([
      ...src.entries.map((e) => ({ name: e.name, copyOf: e, from: src })),
      { name: 'word/media/bomb.bin', data: zeros },
    ]);
    const outcome = await importOutcome(bomb);
    expect(outcome.ok).toBe(false);
    expect((outcome.error as Error).message).toMatch(/ratio/);
  }, 60_000);

  // SEC-039 criterion 6: the zip reader refuses a name with a parent-directory segment (zip.ts,
  // escapesPackage), so the file is rejected rather than having the entry ignored.
  it('refuses an entry whose name climbs out of the package', async () => {
    const bytes = rebuild(sample(), () => undefined, [
      { name: '../escape.xml', data: new TextEncoder().encode('<x/>') },
    ]);
    const outcome = await importOutcome(bytes);
    expect(outcome.ok).toBe(false);
  });

  // The entry-count and total-size limits, run through importDocx with opts.limits. The limits are
  // set from the sample itself: one below its entry count (or its declared uncompressed total) is
  // refused, and exactly its count (or total) is the control that imports.
  const sampleShape = (): { count: number; total: number } => {
    const zip = readZip(sample());
    return { count: zip.entries.length, total: zip.entries.reduce((s, e) => s + e.size, 0) };
  };

  it('refuses an archive with more entries than the limit', async () => {
    const { count } = sampleShape();
    expect(count).toBeGreaterThan(1);
    const control = await importDocx(sample(), {
      limits: { ...DEFAULT_ZIP_LIMITS, maxEntries: count },
    }).then(
      () => true,
      () => false,
    );
    expect(control).toBe(true);
    const error = await importDocx(sample(), {
      limits: { ...DEFAULT_ZIP_LIMITS, maxEntries: count - 1 },
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ImportError);
    expect((error as ImportError).cause).toBeInstanceOf(ZipError);
    expect((error as Error).message).toMatch(/more than the limit/);
  });

  it('refuses an archive whose declared uncompressed size is beyond the limit', async () => {
    const { total } = sampleShape();
    expect(total).toBeGreaterThan(1);
    const control = await importDocx(sample(), {
      limits: { ...DEFAULT_ZIP_LIMITS, maxTotalSize: total },
    }).then(
      () => true,
      () => false,
    );
    expect(control).toBe(true);
    const error = await importDocx(sample(), {
      limits: { ...DEFAULT_ZIP_LIMITS, maxTotalSize: total - 1 },
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ImportError);
    expect((error as ImportError).cause).toBeInstanceOf(ZipError);
    expect((error as Error).message).toMatch(/uncompressed size exceeds the limit/);
  });
});
