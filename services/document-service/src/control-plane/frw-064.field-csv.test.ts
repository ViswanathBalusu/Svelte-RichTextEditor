// FRW-064: spreadsheet output of field values neutralises a leading formula character (owner
// decision 44). The unit part checks the CSV output; the HTTP part checks that `GET /field-values`
// returns the stored value unchanged.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { csvCell, fieldValuesCsv, neutraliseCell } from './field-csv.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
} from '../../test/control-plane/support.ts';

describe('FRW-064 spreadsheet output (CSV)', () => {
  it('prefixes an apostrophe to a value that starts with =, + , - or @ (criterion 1, output side)', () => {
    expect(neutraliseCell('=HYPERLINK("https://example.test")')).toBe(
      `'=HYPERLINK("https://example.test")`,
    );
    expect(neutraliseCell('+1+1')).toBe(`'+1+1`);
    expect(neutraliseCell('@SUM(A1)')).toBe(`'@SUM(A1)`);
    expect(csvCell('=1+1')).toBe(`'=1+1`);
  });

  it('writes a value with none of those first characters unchanged (criterion 2)', () => {
    expect(neutraliseCell('Ada Lovelace')).toBe('Ada Lovelace');
    // A formula character that is not first is not touched.
    expect(neutraliseCell('a=b')).toBe('a=b');
    expect(neutraliseCell('')).toBe('');
    expect(fieldValuesCsv([{ key: 'tenant.name', value: 'Ada' }])).toBe(
      'key,value\r\ntenant.name,Ada\r\n',
    );
  });

  it('neutralises a negative number, which is then readable by removing one leading apostrophe (criterion 3)', () => {
    const cell = csvCell('-12.50');
    expect(cell).toBe(`'-12.50`);
    // A reader recovers the stored value by removing the one apostrophe it finds in front.
    expect(cell.startsWith("'") && cell.slice(1)).toBe('-12.50');
  });

  it('quotes a cell with a comma or a quote and doubles the quotes', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=a,b')).toBe(`"'=a,b"`);
  });
});

const skipHttp = await skipReason('memory');
describe.skipIf(skipHttp)('FRW-064 field values over HTTP stay unchanged (criterion 4)', () => {
  let h: Harness;
  beforeAll(async () => {
    if (!skipHttp) h = await startHarness('memory', {});
  });
  afterAll(async () => {
    await h?.close();
  });

  it('returns a value that starts with a formula character as stored', async () => {
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
      attrs: { id: 'pFields000000002', style: 'Normal' },
      content: [
        {
          type: 'form_field',
          attrs: {
            id: 'ff00000000000021',
            key: 'tenant.note',
            kind: 'text',
            label: 'Note',
            assignee: 'tenant',
            value: '=1+1',
          },
        },
      ],
    });
    const doc = await h.createDocument({ content: d as unknown as Record<string, unknown> });
    const editor = h.userToken({ [doc]: 'editor' });
    const r = await h.call('GET', `/v1/documents/${doc}/field-values`, { token: editor });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.json)).toContain('"=1+1"');
    expect(JSON.stringify(r.json)).not.toContain("'=1+1");
  });
});
