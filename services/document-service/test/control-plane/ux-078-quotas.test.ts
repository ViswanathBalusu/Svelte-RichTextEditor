// Tenant quota values (UX-078 criterion 1; 06 §12): each dimension is stored, validated as a finite
// non-negative number, and readable; an unknown dimension, an unknown tenant or a negative value is
// refused. The store is in memory (durable storage is not built).
import { describe, expect, it } from 'vitest';
import { MemoryQuotaStore, QUOTA_DIMENSIONS, QuotaError } from '../../src/control-plane/quotas.ts';

const TENANT = '0190d5a4-0000-7000-8000-000000000001';

function store() {
  return new MemoryQuotaStore((t) => t === TENANT);
}

describe('UX-078 criterion 1: quota values are stored, validated and readable', () => {
  it('lists the seven dimensions of 06 section 12 and reads null for every unset one', () => {
    const s = store();
    expect([...QUOTA_DIMENSIONS]).toEqual([
      'connections',
      'openDocuments',
      'commitRate',
      'roomCpuBudget',
      'storage',
      'exportConcurrency',
      'exportMinutes',
    ]);
    expect(s.get(TENANT)).toEqual(Object.fromEntries(QUOTA_DIMENSIONS.map((d) => [d, null])));
  });

  it('stores every dimension with a value of zero or more and reads it back', () => {
    const s = store();
    for (const [i, d] of QUOTA_DIMENSIONS.entries()) {
      expect(s.set(TENANT, d, i * 10)).toBe(i * 10);
    }
    s.set(TENANT, 'roomCpuBudget', 0.5);
    const read = s.get(TENANT);
    expect(read.connections).toBe(0);
    expect(read.exportMinutes).toBe(60);
    expect(read.roomCpuBudget).toBe(0.5);
  });

  it('refuses a negative, non-finite or non-numeric value and keeps the previous one', () => {
    const s = store();
    s.set(TENANT, 'storage', 100);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, '5', null, undefined]) {
      expect(() => s.set(TENANT, 'storage', bad)).toThrow(QuotaError);
    }
    expect(s.get(TENANT).storage).toBe(100);
  });

  it('refuses an unknown dimension and a tenant that is not registered', () => {
    const s = store();
    expect(() => s.set(TENANT, 'bandwidth', 1)).toThrow(QuotaError);
    expect(() => s.set(TENANT, 'constructor', 1)).toThrow(QuotaError);
    expect(() => s.set('0190d5a4-0000-7000-8000-000000000002', 'storage', 1)).toThrow(QuotaError);
    expect(s.get('0190d5a4-0000-7000-8000-000000000002').storage).toBeNull();
  });
});
