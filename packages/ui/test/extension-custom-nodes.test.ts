/**
 * Custom blocks and inline content, and the fallback for a missing extension (UX-056, UX-057,
 * UX-058): the editor's checks before a node is sent, and the view a reader gets. The insertion
 * itself, the authority's I12 check, the save path and the rendered fallback are not tested here.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  BLOCK_PAYLOAD_LIMIT_BYTES,
  checkBlockInsert,
  checkInlineInsert,
  payloadBytes,
  resolveExtensionNode,
  type ExtensionNode,
} from '../src/extensions/custom-nodes.ts';

const EXT = fc.stringMatching(/^[a-z][a-z0-9-]{0,15}(\.[a-z][a-z0-9-]{0,15}){1,2}$/);
const TEXT = fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim() !== '');

describe('block payload limit of 16 KiB (UX-056, criterion 2, the editor part)', () => {
  it('measures the UTF-8 JSON text and accepts exactly up to the limit', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20_000 }), (n) => {
        // A JSON string of n ASCII characters is n + 2 bytes (the quotes).
        const payload = 'a'.repeat(n);
        const bytes = payloadBytes(payload);
        expect(bytes).toBe(n + 2);
        const check = checkBlockInsert({
          extension: 'example.widget',
          payload,
          fallbackAsset: null,
          fallbackText: 'A widget',
        });
        if (n + 2 <= BLOCK_PAYLOAD_LIMIT_BYTES) {
          expect(check).toEqual({ ok: true, payloadBytes: n + 2 });
        } else {
          expect(check).toEqual({ ok: false, reason: 'payload-too-large', payloadBytes: n + 2 });
        }
      }),
      { numRuns: 300 },
    );
  });

  it('counts multi-byte characters by their UTF-8 length', () => {
    // Each 'é' is two bytes in UTF-8; 8,200 of them are 16,400 bytes plus two quotes, over the limit
    // although the string has fewer than 16,384 characters.
    const payload = 'é'.repeat(8_200);
    expect(payloadBytes(payload)).toBe(16_402);
    expect(
      checkBlockInsert({ extension: 'x.y', payload, fallbackAsset: null, fallbackText: 'a' }),
    ).toMatchObject({
      ok: false,
      reason: 'payload-too-large',
    });
  });
});

describe('a block needs a fallback picture or text (UX-056, criterion 1, the editor part)', () => {
  it('refuses a block with neither fallback, and accepts either fallback alone', () => {
    fc.assert(
      fc.property(EXT, TEXT, fc.option(TEXT, { nil: null }), (extension, text, asset) => {
        const neither = checkBlockInsert({
          extension,
          payload: {},
          fallbackAsset: null,
          fallbackText: null,
        });
        expect(neither).toMatchObject({ ok: false, reason: 'no-fallback' });
        const textOnly = checkBlockInsert({
          extension,
          payload: {},
          fallbackAsset: null,
          fallbackText: text,
        });
        expect(textOnly.ok).toBe(true);
        const assetOnly = checkBlockInsert({
          extension,
          payload: {},
          fallbackAsset: asset ?? text,
          fallbackText: null,
        });
        expect(assetOnly.ok).toBe(true);
      }),
    );
  });

  it('treats a whitespace-only text as no fallback', () => {
    expect(
      checkBlockInsert({
        extension: 'x.y',
        payload: {},
        fallbackAsset: null,
        fallbackText: '  \n\t',
      }),
    ).toMatchObject({ ok: false, reason: 'no-fallback' });
  });

  it('refuses a draft with no extension identifier and a payload with no JSON form', () => {
    expect(
      checkBlockInsert({ extension: '  ', payload: {}, fallbackAsset: null, fallbackText: 'a' }),
    ).toMatchObject({
      ok: false,
      reason: 'no-extension',
    });
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(
      checkBlockInsert({
        extension: 'x.y',
        payload: cyclic,
        fallbackAsset: null,
        fallbackText: 'a',
      }),
    ).toMatchObject({ ok: false, reason: 'payload-not-json' });
    expect(
      checkBlockInsert({ extension: 'x.y', payload: 10n, fallbackAsset: null, fallbackText: 'a' }),
    ).toMatchObject({ ok: false, reason: 'payload-not-json' });
  });
});

describe('inline content needs a fallback text (UX-057, criterion 1, the editor part)', () => {
  it('refuses inline content without fallback text and accepts it with one', () => {
    fc.assert(
      fc.property(EXT, TEXT, (extension, text) => {
        expect(checkInlineInsert({ extension, payload: {}, fallbackText: null })).toMatchObject({
          ok: false,
          reason: 'no-fallback-text',
        });
        expect(checkInlineInsert({ extension, payload: {}, fallbackText: text }).ok).toBe(true);
      }),
    );
  });

  it('applies no size limit to inline payloads, which 13 section 7.3 leaves unnumbered', () => {
    const payload = 'a'.repeat(BLOCK_PAYLOAD_LIMIT_BYTES * 4);
    expect(checkInlineInsert({ extension: 'x.y', payload, fallbackText: 'a' })).toEqual({
      ok: true,
      payloadBytes: BLOCK_PAYLOAD_LIMIT_BYTES * 4 + 2,
    });
  });
});

describe('the fallback for an extension that is not available (UX-058, criteria 1 and 2, in memory)', () => {
  const NODE_TYPES = ['extension_block', 'extension_inline'] as const;

  it('shows the extension for an available identifier and the fallback otherwise', () => {
    fc.assert(
      fc.property(
        EXT,
        fc.uniqueArray(EXT, { maxLength: 4 }),
        fc.constantFrom(...NODE_TYPES),
        TEXT,
        (extension, others, type, text) => {
          const node: ExtensionNode = {
            type,
            extension,
            payload: { n: 1 },
            fallbackAsset: null,
            fallbackText: text,
          };
          const available = new Set(others.filter((o) => o !== extension));
          expect(resolveExtensionNode(node, available)).toEqual({
            kind: 'fallback',
            reason: 'not-available',
            extension,
            asset: null,
            text,
          });
          available.add(extension);
          expect(resolveExtensionNode(node, available)).toEqual({ kind: 'extension', extension });
        },
      ),
    );
  });

  it('never exposes the payload in a fallback view and leaves the node unchanged', () => {
    fc.assert(
      fc.property(EXT, TEXT, fc.nat(), (extension, text, n) => {
        const marker = `payload-marker-${n}`;
        const node: ExtensionNode = {
          type: 'extension_block',
          extension,
          payload: { secret: marker },
          fallbackAsset: null,
          fallbackText: text,
        };
        const before = JSON.stringify(node);
        const view = resolveExtensionNode(node, new Set());
        expect(JSON.stringify(view)).not.toContain(marker);
        expect(Object.keys(view)).not.toContain('payload');
        expect(JSON.stringify(node)).toBe(before);
      }),
    );
  });

  it('keeps the fallback asset of a block and has no asset for inline content', () => {
    const block: ExtensionNode = {
      type: 'extension_block',
      extension: 'x.y',
      payload: {},
      fallbackAsset: 'asset-1',
      fallbackText: null,
    };
    expect(resolveExtensionNode(block, new Set())).toMatchObject({
      kind: 'fallback',
      asset: 'asset-1',
      text: null,
    });
    const inline: ExtensionNode = {
      type: 'extension_inline',
      extension: 'x.y',
      payload: {},
      fallbackAsset: null,
      fallbackText: 'a widget',
    };
    expect(resolveExtensionNode(inline, new Set())).toMatchObject({
      kind: 'fallback',
      asset: null,
      text: 'a widget',
    });
  });
});
