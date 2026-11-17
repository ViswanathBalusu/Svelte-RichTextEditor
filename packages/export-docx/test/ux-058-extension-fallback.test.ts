/**
 * UX-058 criterion 3 for the DOCX writer: a custom block whose extension is not available is written
 * as its fallback text, and the payload and the extension name never reach any part of the package.
 */
import { describe, expect, it } from 'vitest';
import { newDocument, type JsonNode } from '@docedit/model';
import { AssetStore, entryData, readZip } from '../src/index.ts';
import { writeDocx } from '../src/writer.ts';

const SENTINEL = 'UX058_PAYLOAD_SENTINEL_91c4';

describe('UX-058 criterion 3: the DOCX writer writes the fallback and never the payload', () => {
  it('has the fallback text in word/document.xml and the payload in no part', async () => {
    const env = newDocument({ lang: 'en-GB' });
    const body = env.doc.content!.find((n) => n.type === 'body')!;
    body.content = [
      {
        type: 'extension_block',
        attrs: {
          id: 'xBlock0000000001',
          extension: 'com.example.gone',
          payload: { text: SENTINEL, nested: { value: SENTINEL } },
          fallbackAsset: null,
          fallbackText: 'A chart of three values',
          ext: {},
        },
      } as JsonNode,
    ];
    env.requires = [...env.requires, 'extensions'];
    const out = await writeDocx(env, new AssetStore());
    const zip = readZip(out.bytes);
    const parts = new Map(
      zip.entries.map((e) => [e.name, new TextDecoder().decode(entryData(zip, e))]),
    );
    expect(parts.get('word/document.xml')).toContain('A chart of three values');
    for (const [name, xml] of parts) {
      expect(xml, name).not.toContain(SENTINEL);
      expect(xml, name).not.toContain('com.example.gone');
    }
  });
});
