/**
 * UX-057 criterion 4 for the DOCX writer: inline custom content is written as its fallback text,
 * and the payload and the extension name never reach any part of the package.
 */
import { describe, expect, it } from 'vitest';
import { newDocument, type JsonNode } from '@docedit/model';
import { AssetStore, entryData, readZip } from '../src/index.ts';
import { writeDocx } from '../src/writer.ts';

const SENTINEL = 'UX057_PAYLOAD_SENTINEL_5be2';

describe('UX-057 criterion 4: the DOCX writer writes the inline fallback and never the payload', () => {
  it('has the fallback text in word/document.xml and the payload in no part', async () => {
    const env = newDocument({ lang: 'en-GB' });
    const body = env.doc.content!.find((n) => n.type === 'body')!;
    body.content = [
      {
        type: 'paragraph',
        attrs: { id: 'pInline000000001' },
        content: [
          { type: 'text', text: 'Ask ' },
          {
            type: 'extension_inline',
            attrs: {
              extension: 'com.example.mention',
              payload: { user: SENTINEL },
              fallbackText: '@Ada Lovelace',
              ext: {},
            },
          },
        ],
      } as JsonNode,
    ];
    env.requires = [...env.requires, 'extensions'];
    const out = await writeDocx(env, new AssetStore());
    const zip = readZip(out.bytes);
    const parts = new Map(
      zip.entries.map((e) => [e.name, new TextDecoder().decode(entryData(zip, e))]),
    );
    expect(parts.get('word/document.xml')).toContain('@Ada Lovelace');
    for (const [name, xml] of parts) {
      expect(xml, name).not.toContain(SENTINEL);
      expect(xml, name).not.toContain('com.example.mention');
    }
  });
});
