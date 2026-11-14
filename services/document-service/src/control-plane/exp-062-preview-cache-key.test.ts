// EXP-062 criterion 4: a preview result is stored apart from final results. The first-result
// cache is keyed by exportRequestKey (EXP-006), so a preview and a final export of the same
// document, content and options must have different keys. Pure Node: no PostgreSQL, no container.
import { uuid7 } from '@docedit/model';
import { describe, expect, it } from 'vitest';
import { exportRequestKey } from './exports.ts';

const base = {
  tenant: 'tenant-exp-062',
  doc: uuid7(),
  incarnation: 'incarnation-exp-062',
  seq: 7,
  view: 'editor',
  target: 'pdf',
  full: false,
  classVersion: '1.0.0',
};

describe('preview results are cached apart from final results (EXP-062 criterion 4)', () => {
  it('gives a preview and a final export of the same content different cache keys', () => {
    const preview = exportRequestKey({ ...base, options: { profile: 'preview' } });
    const final = exportRequestKey({ ...base, options: { profile: 'final' } });
    const unset = exportRequestKey({ ...base, options: {} });
    expect(preview).not.toBe(final);
    expect(preview).not.toBe(unset);
    expect(final).not.toBe(unset);
  });

  it('keeps the preview key stable for an identical preview request', () => {
    const a = exportRequestKey({ ...base, options: { profile: 'preview' } });
    const b = exportRequestKey({ ...base, options: { profile: 'preview' } });
    expect(a).toBe(b);
  });
});
