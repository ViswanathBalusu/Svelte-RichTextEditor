/**
 * WASM-003: the decision and the words when the layout kernel cannot start. The browser runs are in
 * e2e/wasm-003-blocked.spec.ts; this file holds what needs no browser.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  chooseMeasurementProvider,
  DEFAULT_MEASUREMENT_PROVIDER,
  fallbackFor,
  noticeReason,
  PAGE_VIEW_NOTICE,
} from '../src/kernel-fallback.ts';

describe('the fallback spike S5 recorded', () => {
  it('is canvas measurement in Chromium, Edge and WebKit and the web view in Firefox', () => {
    const agents = {
      chromium:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36',
      edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0',
      webkit:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Safari/605.1.15',
      firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:159.0) Gecko/20100101 Firefox/159.0',
    };
    expect(fallbackFor(agents.chromium)).toBe('canvas-measurement');
    expect(fallbackFor(agents.edge)).toBe('canvas-measurement');
    expect(fallbackFor(agents.webkit)).toBe('canvas-measurement');
    expect(fallbackFor(agents.firefox)).toBe('web-view');
  });
});

describe('the message', () => {
  it('names the policy when that is the cause and the directive to add', () => {
    expect(noticeReason({ code: 'blocked_by_policy' })).toContain("'wasm-unsafe-eval'");
    expect(noticeReason({ code: 'blocked_by_policy' })).toContain('script-src');
  });

  it('says only that the file did not load for any other cause', () => {
    for (const code of ['fetch_failed', 'chunk_failed', 'bad_module', null])
      expect(noticeReason({ code })).toBe(PAGE_VIEW_NOTICE.other);
  });

  it('is plain: no code, no markup, and it offers the two views', () => {
    for (const text of Object.values(PAGE_VIEW_NOTICE)) expect(text).not.toMatch(/[<>{}]/);
    expect(PAGE_VIEW_NOTICE.choose).toContain('web view');
    expect(PAGE_VIEW_NOTICE.choose).toContain('read view');
  });
});

describe('the measurement provider the S5 recommendation chooses (FE-079 criterion 6)', () => {
  const chromium =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36';
  const webkit =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Safari/605.1.15';
  const firefox =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:159.0) Gecko/20100101 Firefox/159.0';

  it('is the font files, with the kernel, in every engine (recommendation 1)', () => {
    expect(DEFAULT_MEASUREMENT_PROVIDER).toBe('font-files');
    for (const agent of [chromium, webkit, firefox])
      expect(chooseMeasurementProvider('available', agent)).toBe('font-files');
  });

  it('falls back to canvas in Chromium, Edge and WebKit and to no page view in Firefox when the kernel cannot start (recommendation 4)', () => {
    expect(chooseMeasurementProvider('unavailable', chromium)).toBe('canvas');
    expect(chooseMeasurementProvider('unavailable', webkit)).toBe('canvas');
    expect(chooseMeasurementProvider('unavailable', firefox)).toBe('none');
  });

  it('agrees with the page view fallback for every user agent', () => {
    fc.assert(
      fc.property(fc.string(), (agent) => {
        const fallback = fallbackFor(agent);
        expect(chooseMeasurementProvider('unavailable', agent)).toBe(
          fallback === 'web-view' ? 'none' : 'canvas',
        );
        expect(chooseMeasurementProvider('available', agent)).toBe('font-files');
      }),
    );
  });
});
