// FRW-064 through the real service (lane w4): `GET /documents/{id}/field-values?format=csv` is the
// spreadsheet output of field values (owner decision 44; docs/adr/0410-w4-FRW-064-field-csv.md,
// proposed). A value that starts with `=`, `+`, `-` or `@` is written with one apostrophe in front,
// every other value as it is, and the JSON of the same route is unchanged. A spreadsheet application
// is run on the output when LibreOffice Calc is installed (the path is `DOCEDIT_SOFFICE`, or
// `soffice` on the path, or the default install folder on Windows): the file as written gives text
// cells, and the same file without the neutralising gives a formula, so the check can fail.
// Memory storage and, when the test environment is up, PostgreSQL in Podman.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const fid = (n: number) => `fc${String(n).padStart(14, '0')}`;

/** Key, kind and stored value of each field of the document. */
const FIELDS: ReadonlyArray<[string, string, unknown]> = [
  ['a.formula', 'text', '=1+1'],
  ['b.plus', 'text', '+2+3'],
  ['c.negative', 'number', '-12.50'],
  ['d.at', 'text', '@SUM(1)'],
  ['e.plain', 'text', 'Ada'],
  ['f.comma', 'text', '=a,b'],
  ['g.inside', 'text', 'x=1+1'],
  ['h.empty', 'text', null],
  ['i.checked', 'checkbox', true],
];

function document(): Record<string, unknown> {
  const d = structuredClone(documentWithRegions()) as {
    requires: string[];
    doc: { content: Array<{ type: string; content: unknown[] }> };
  };
  d.requires = ['fields'];
  d.doc.content[0]!.content.push({
    type: 'role_def',
    attrs: { id: 'tenant', name: 'Tenant', color: '#1F77B4' },
  });
  d.doc.content[1]!.content.push({
    type: 'paragraph',
    attrs: { id: 'pCsv000000000064', style: 'Normal' },
    content: FIELDS.flatMap(([key, kind, value], i) => [
      {
        type: 'form_field',
        attrs: { id: fid(i + 1), key, kind, label: key, assignee: 'tenant', value },
      },
      { type: 'text', text: ' ' },
    ]),
  });
  return d as unknown as Record<string, unknown>;
}

/** Splits RFC 4180 text into rows of cells. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += ch;
  }
  return rows;
}

function sofficePath(): string | null {
  const fromEnv = process.env['DOCEDIT_SOFFICE'];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['soffice'], {
    encoding: 'utf8',
  });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.split(/\r?\n/)[0]!.trim();
  const win = 'C:\\Program Files\\LibreOffice\\program\\soffice.exe';
  return existsSync(win) ? win : null;
}

/** The cells of the second column of a flat ODS that LibreOffice made from a CSV file. */
function convert(
  soffice: string,
  csv: string,
): Array<{ formula: boolean; type: string; text: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'docedit-frw064-'));
  try {
    const file = join(dir, 'in.csv');
    writeFileSync(file, csv, 'utf8');
    const profile = join(dir, 'profile');
    mkdirSync(profile);
    const r = spawnSync(
      soffice,
      [
        '--headless',
        '--norestore',
        `-env:UserInstallation=file:///${profile.replace(/\\/g, '/')}`,
        '--convert-to',
        'fods',
        '--outdir',
        join(dir, 'out'),
        file,
      ],
      { encoding: 'utf8', timeout: 120_000, windowsHide: true },
    );
    if (r.status !== 0) throw new Error(`soffice failed: ${r.stderr}`);
    const xml = readFileSync(join(dir, 'out', 'in.fods'), 'utf8');
    const rows = [...xml.matchAll(/<table:table-row[^>]*>([\s\S]*?)<\/table:table-row>/g)];
    return rows.map((row) => {
      const cells = [
        ...row[1]!.matchAll(/<table:table-cell([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-cell>)/g),
      ];
      const second = cells[1]!;
      const attrs = second[1] ?? '';
      return {
        formula: /table:formula=/.test(attrs),
        type: /office:value-type="([^"]*)"/.exec(attrs)?.[1] ?? 'none',
        text: (/<text:p>([\s\S]*?)<\/text:p>/.exec(second[2] ?? '')?.[1] ?? '')
          .replace(/&apos;/g, "'")
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, '&'),
      };
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`field values as CSV (${storage}; FRW-064)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage, {});
    });
    afterAll(async () => {
      await h?.close();
    });

    const csvOf = async (doc: string) => {
      const r = await h.call('GET', `/v1/documents/${doc}/field-values?format=csv`, {
        token: h.serviceJwt(),
      });
      expect(r.status, r.text).toBe(200);
      return r;
    };

    it.skipIf(skip)(
      'answers text/csv with a neutralised cell for each leading =, +, - or @, and the stored value for the rest (criteria 1 and 2)',
      async () => {
        const doc = await h.createDocument({ content: document() });
        const r = await csvOf(doc);
        expect(r.headers.get('content-type')).toMatch(/^text\/csv; charset=utf-8/);
        const rows = parseCsv(r.text);
        expect(rows[0]).toEqual(['key', 'value']);
        const byKey: Record<string, string> = Object.fromEntries(
          rows.slice(1).map(([k, v]) => [k ?? '', v ?? '']),
        );
        expect(byKey).toEqual({
          'a.formula': "'=1+1",
          'b.plus': "'+2+3",
          'c.negative': "'-12.50",
          'd.at': "'@SUM(1)",
          'e.plain': 'Ada',
          'f.comma': "'=a,b",
          'g.inside': 'x=1+1',
          'h.empty': '',
          'i.checked': 'true',
        });
        // A reader recovers the stored value of a negative number by removing the one apostrophe.
        expect(byKey['c.negative']!.slice(1)).toBe('-12.50');
        // A value that is not neutralised starts with none of the four characters.
        for (const v of Object.values(byKey)) expect(/^[=+\-@]/.test(v), `cell ${v}`).toBe(false);
      },
      60_000,
    );

    it.skipIf(skip)(
      'leaves the JSON of the same route as stored, and refuses a format it does not know (criterion 4)',
      async () => {
        const doc = await h.createDocument({ content: document() });
        const service = h.serviceJwt();
        const json = await h.call('GET', `/v1/documents/${doc}/field-values`, { token: service });
        expect(json.status).toBe(200);
        expect(json.json.values).toMatchObject({
          'a.formula': '=1+1',
          'c.negative': '-12.50',
          'f.comma': '=a,b',
        });
        expect(JSON.stringify(json.json)).not.toContain("'=1+1");
        const explicit = await h.call('GET', `/v1/documents/${doc}/field-values?format=json`, {
          token: service,
        });
        expect(explicit.json).toEqual(json.json);
        // The two representations do not share an ETag, so a cache cannot mix them up.
        const csv = await csvOf(doc);
        expect(csv.headers.get('etag')).not.toBe(json.headers.get('etag'));
        const unknown = await h.call('GET', `/v1/documents/${doc}/field-values?format=xlsx`, {
          token: service,
        });
        expect(unknown.status).toBe(400);
      },
      60_000,
    );

    const soffice = sofficePath();
    it.skipIf(skip || soffice === null)(
      'is read by LibreOffice Calc as text, where the same file without the apostrophes is read as formulas (criterion 1, spreadsheet application)',
      async () => {
        const doc = await h.createDocument({ content: document() });
        const written = (await csvOf(doc)).text;
        const cells = convert(soffice!, written);
        // Row 0 is the header. The four leading characters give strings, never a formula.
        const keys = parseCsv(written)
          .slice(1)
          .map((r) => r[0]);
        for (const [i, key] of keys.entries()) {
          const cell = cells[i + 1]!;
          expect(cell.formula, `${key} is not a formula`).toBe(false);
        }
        const at = (k: string) => cells[keys.indexOf(k) + 1]!;
        expect(at('a.formula')).toMatchObject({ type: 'string', text: "'=1+1" });
        expect(at('c.negative')).toMatchObject({ type: 'string', text: "'-12.50" });
        expect(at('e.plain')).toMatchObject({ type: 'string', text: 'Ada' });

        // The control: the stored values written with no neutralising are a formula for LibreOffice,
        // so the check above is one that can fail.
        const raw = `key,value\r\n${FIELDS.filter(
          ([, , v]) => typeof v === 'string' && v !== '' && !v.includes(','),
        )
          .map(([k, , v]) => `${k},${String(v)}`)
          .join('\r\n')}\r\n`;
        const rawCells = convert(soffice!, raw);
        expect(rawCells.some((c) => c.formula)).toBe(true);
      },
      180_000,
    );
  });
}
