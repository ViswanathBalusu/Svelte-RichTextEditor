// What the package supports: the CDM features it reads (what `hello` and `ch.open` announce) and
// the cdm range it reads (CDM-047 criterion 5, CDM-050 criterion 5).
import { describe, expect, it } from 'vitest';
import { supportedVersions } from '../validate/read.ts';
import { CDM1 } from './cdm1.ts';
import { featureRegistry, mayOpen, supportedFeatures } from './features.ts';

describe('what the package supports (CDM-047, CDM-050)', () => {
  it('lists the CDM features it reads, in registry order, once each', () => {
    const names = supportedFeatures();
    expect(names).toEqual(CDM1.features.map((f) => f.name));
    expect(names).toEqual(featureRegistry().map((e) => e.name));
    expect(names).toEqual(expect.arrayContaining(['fields', 'extensions', 'preserve']));
    expect(new Set(names).size).toBe(names.length);
  });

  it('opens a document whose requires it supports, and names the features it lacks', () => {
    const supported = supportedFeatures();
    expect(mayOpen(supported, supported)).toEqual({ ok: true });
    expect(mayOpen(['fields', 'x-future-feature'], supported)).toEqual({
      ok: false,
      missing: ['x-future-feature'],
    });
  });

  it('returns the cdm range it reads as min and max', () => {
    expect(supportedVersions()).toEqual({ min: CDM1.cdm, max: CDM1.cdm });
    expect(supportedVersions(CDM1)).toEqual({ min: 1, max: 1 });
  });
});
