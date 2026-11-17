// FE-067 criterion 3, the rule in Node.js: a picture is drawn only from an http or https URL of a
// raster type. The view's own test (view/fe-067-image-view.universal.test.ts) runs in browsers.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { imageSource, RASTER_IMAGE_TYPES } from '../src/image-source.ts';

describe('imageSource (FE-067 criterion 3)', () => {
  it('gives the URL of an https or http answer of a raster type', () => {
    expect(imageSource({ url: 'https://a.example/x.png?s=1', contentType: 'image/png' })).toBe(
      'https://a.example/x.png?s=1',
    );
    expect(imageSource({ url: 'http://a.example/x', contentType: 'image/jpeg' })).toBe(
      'http://a.example/x',
    );
    expect(imageSource({ url: 'https://a.example/x', contentType: ' Image/WebP ; q=1' })).toBe(
      'https://a.example/x',
    );
  });

  it.each([
    'data:image/png;base64,AAAA',
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'blob:https://a.example/1',
    'file:///etc/passwd',
    'vbscript:x',
    'ftp://a.example/x.png',
    '//a.example/x.png',
    '/x.png',
    'https://user:pw@a.example/x.png',
    '',
    'not a url',
  ])('refuses the URL %j', (url) => {
    expect(imageSource({ url, contentType: 'image/png' })).toBeUndefined();
  });

  it.each([
    'image/svg+xml',
    'IMAGE/SVG+XML',
    'application/pdf',
    'text/html',
    'image/x-icon',
    '',
    'image/png/x',
  ])('refuses the type %j', (contentType) => {
    expect(imageSource({ url: 'https://a.example/x', contentType })).toBeUndefined();
  });

  it('refuses a value that is not an answer', () => {
    for (const v of [undefined, null, 1, 'https://a.example/x.png', {}, { url: 1, contentType: 2 }])
      expect(imageSource(v)).toBeUndefined();
  });

  it('property: whatever the strings are, a result is an http(s) URL of a listed type', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.oneof(fc.string(), fc.constantFrom(...RASTER_IMAGE_TYPES)),
        (url, contentType) => {
          const src = imageSource({ url, contentType });
          if (src === undefined) return;
          expect(/^https?:\/\//.test(src)).toBe(true);
          expect(
            RASTER_IMAGE_TYPES.has((contentType.split(';')[0] ?? '').trim().toLowerCase()),
          ).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('property: no data:, javascript:, blob: or file: URL passes, in any case', () => {
    const scheme = fc.constantFrom('data', 'javascript', 'blob', 'file', 'vbscript');
    fc.assert(
      fc.property(scheme, fc.string(), fc.boolean(), (s, rest, upper) => {
        const url = `${upper ? s.toUpperCase() : s}:${rest}`;
        expect(imageSource({ url, contentType: 'image/png' })).toBeUndefined();
      }),
      { numRuns: 300 },
    );
  });
});
