/**
 * SEC-006 criterion 5, DOCX side (lane U-SEC-001-016): a link written into a DOCX has its address
 * checked by the same allow-list as `link.href` (CDM-002, `LINK_HREF_PATTERN`; I9). A refused
 * address is written as plain text: no `w:hyperlink` element and no external relationship for it.
 * An allowed address keeps its hyperlink and its relationship. The writer is the real one
 * (`writeDocx`), run on envelopes built here, so a commit-time check cannot hide a writer gap.
 */
import { describe, expect, it } from 'vitest';
import { newDocument, type JsonEnvelope, type JsonNode } from '@docedit/model';
import { AssetStore, entryData, readZip } from '../src/index.ts';
import { writeDocx, type WriteResult } from '../src/writer.ts';

const pid = (n: number): string => `p${String(n).padStart(15, '0')}`;

/** One paragraph per address; each paragraph's text is the address's label, carrying the link. */
function linked(addresses: string[]): JsonEnvelope {
  const env = newDocument({ lang: 'en-GB' });
  const body = env.doc.content!.find((n) => n.type === 'body')!;
  body.content = addresses.map(
    (href, i) =>
      ({
        type: 'paragraph',
        attrs: { id: pid(i + 1) },
        content: [{ type: 'text', text: `label ${i}`, marks: [{ type: 'link', attrs: { href } }] }],
      }) as JsonNode,
  );
  return env;
}

async function write(env: JsonEnvelope): Promise<WriteResult> {
  return writeDocx(env, new AssetStore(), {});
}

function part(res: WriteResult, name: string): string {
  const zip = readZip(res.bytes);
  const e = zip.entries.find((x) => x.name === name);
  return e ? new TextDecoder().decode(entryData(zip, e)) : '';
}

/** Forbidden schemes and obfuscated forms (the corpus of SEC-006 criterion 1). */
const FORBIDDEN = [
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  'java\tscript:alert(1)',
  ' javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
  'blob:https://example.com/0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10',
];

const ACCEPTED = ['https://example.com/a?b=c', 'http://example.com', 'mailto:ada@example.com'];

describe('SEC-006 criterion 5, DOCX: link schemes are checked when written', () => {
  it('writes no hyperlink and no external relationship for a refused address', async () => {
    for (const href of FORBIDDEN) {
      const res = await write(linked([href]));
      const doc = part(res, 'word/document.xml');
      const rels = part(res, 'word/_rels/document.xml.rels');
      expect(doc, href).toContain('label 0');
      expect(doc, href).not.toContain('<w:hyperlink');
      expect(rels, href).not.toContain(href.replace(/&/g, '&amp;'));
      expect(rels, href).not.toMatch(/TargetMode="External"/);
    }
  });

  it('keeps the hyperlink and its external relationship for an allowed address', async () => {
    for (const href of ACCEPTED) {
      const res = await write(linked([href]));
      const doc = part(res, 'word/document.xml');
      const rels = part(res, 'word/_rels/document.xml.rels');
      expect(doc, href).toContain('<w:hyperlink');
      expect(rels, href).toContain(`Target="${href.replace(/&/g, '&amp;')}"`);
    }
  });

  it('writes a refused address as text beside an allowed one, without losing the allowed link', async () => {
    const res = await write(linked(['javascript:alert(1)', 'https://example.com/ok']));
    const doc = part(res, 'word/document.xml');
    expect(doc).toContain('label 0');
    expect(doc).toContain('label 1');
    expect(doc.match(/<w:hyperlink /g)?.length ?? 0).toBe(1);
  });
});

describe('SEC-006 criterion 5, DOCX: the refusal is reported', () => {
  it('returns a warning when an address is written as text', async () => {
    const res = await write(linked(['javascript:alert(1)']));
    const messages = JSON.stringify(res);
    expect(messages).toContain('I9');
  });
});
