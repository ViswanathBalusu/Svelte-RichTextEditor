// Cross-cutting conventions of 01 §8 (FND-003). Runs in Node.js and in every browser engine.
import { describe, expect, it } from 'vitest';
import { isNodeId, isUuid7, nodeId, uuid7, uuid7Time } from './ids.ts';
import { formatTimestamp, isTimestamp, parseTimestamp } from './time.ts';
import { pointsToTwips, twipsToBp, twipsToCss, twipsToPoints } from './units.ts';
import {
  findNonIntegers,
  isColour,
  isDecimalString,
  isLanguageTag,
  normaliseColour,
} from './validators.ts';
import { CodedError, errorCode, problem } from './errors.ts';
import { sha256Hex } from '../canonical/hash.ts';

describe('identifiers', () => {
  it('makes UUID version 7 identifiers in canonical text form', () => {
    const id = uuid7(Date.UTC(2026, 10, 6, 12, 0, 0, 123));
    expect(isUuid7(id)).toBe(true);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuid7Time(id)).toBe(Date.UTC(2026, 10, 6, 12, 0, 0, 123));
  });

  it('keeps identifiers of one process in creation order within a millisecond', () => {
    const t = Date.UTC(2026, 10, 6);
    const ids = Array.from({ length: 5000 }, () => uuid7(t));
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  it('makes 16-character URL-safe node identifiers', () => {
    const ids = Array.from({ length: 2000 }, () => nodeId());
    for (const id of ids) expect(isNodeId(id)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(isNodeId('p3Jq8sLw0aZx1VbN')).toBe(true);
    expect(isNodeId('p3Jq8sLw0aZx1Vb')).toBe(false);
    expect(isNodeId('p3Jq8sLw0aZx1Vb+')).toBe(false);
  });
});

describe('time', () => {
  it('formats RFC 3339 UTC timestamps with milliseconds', () => {
    expect(formatTimestamp(Date.UTC(2026, 10, 6, 9, 5, 7, 3))).toBe('2026-11-06T09:05:07.003Z');
    expect(isTimestamp('2026-11-06T09:05:07.003Z')).toBe(true);
    expect(isTimestamp('2026-11-06T09:05:07Z')).toBe(false);
    expect(isTimestamp('2026-11-06T09:05:07.003+00:00')).toBe(false);
    expect(isTimestamp('2026-02-30T00:00:00.000Z')).toBe(false);
    expect(parseTimestamp('1970-01-01T00:00:00.001Z')).toBe(1);
  });
});

describe('lengths', () => {
  it('converts twentieths of a point exactly', () => {
    expect(twipsToBp(230)).toBe('11.5bp');
    expect(twipsToBp(221)).toBe('11.05bp');
    expect(twipsToBp(240)).toBe('12bp');
    expect(twipsToBp(-15)).toBe('-0.75bp');
    expect(twipsToBp(1)).toBe('0.05bp');
    expect(twipsToCss(220)).toBe('11pt');
    expect(twipsToPoints(1440)).toBe(72);
    expect(pointsToTwips(11.5)).toBe(230);
    expect(() => twipsToBp(1.5)).toThrow(RangeError);
  });
});

describe('values', () => {
  it('accepts decimal strings and nothing else', () => {
    for (const ok of ['0', '-1', '12.50', '1000000', '0.001'])
      expect(isDecimalString(ok)).toBe(true);
    for (const bad of ['01', '+1', '1e3', '1.', '.5', '', '1,5', ' 1'])
      expect(isDecimalString(bad)).toBe(false);
  });

  it('accepts #RRGGBB in upper case', () => {
    expect(isColour('#1F77B4')).toBe(true);
    expect(isColour('#1f77b4')).toBe(false);
    expect(isColour('#FFF')).toBe(false);
    expect(normaliseColour('#1f77b4')).toBe('#1F77B4');
  });

  it('accepts well-formed BCP 47 tags', () => {
    for (const ok of [
      'en',
      'en-GB',
      'zh-Hant-TW',
      'sr-Latn-RS',
      'de-CH-1996',
      'es-419',
      'x-private',
      'en-a-bbb-x-a-ccc',
    ])
      expect(isLanguageTag(ok)).toBe(true);
    for (const bad of ['', 'e', 'en_GB', 'english-language-tag-way-too-long', 'en--GB', '123'])
      expect(isLanguageTag(bad)).toBe(false);
  });

  it('finds floating-point numbers', () => {
    expect(findNonIntegers({ a: 1, b: [2, 3.5], c: { d: 1e300, e: '1.5' } })).toEqual([
      { path: '/b/1', value: 3.5 },
      { path: '/c/d', value: 1e300 },
    ]);
  });
});

describe('errors', () => {
  it('builds RFC 9457 problem details with a stable code', () => {
    const p = problem({
      code: 'permission_denied',
      status: 403,
      title: 'Permission denied',
      detail: 'region rX',
    });
    expect(p).toMatchObject({
      code: 'permission_denied',
      status: 403,
      type: 'urn:docedit:problem:permission_denied',
    });
    expect(() => errorCode('Bad Code')).toThrow(RangeError);
    expect(new CodedError('stale_base', 'x').code).toBe('stale_base');
  });
});

describe('hashing', () => {
  it('uses the platform SHA-256', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});
