/**
 * PRM-024 criteria 1 and 2: a rejection names the part of the document whose change was refused,
 * and names who changed the permissions when the client knows it.
 */
import { describe, expect, it } from 'vitest';
import type { RegionSummary } from '../src/core-api.ts';
import { Strings } from '../src/i18n/strings.ts';
import { changedByLine, refusedPart, refusedParts } from '../src/shell/rejection-words.ts';

const tr = new Strings().current;

const REGIONS = [
  { id: 'rLegal0000000001', title: 'Legal clause' },
  { id: 'rHidden000000001', title: null },
] as unknown as readonly RegionSummary[];

describe('the part a rejection names (PRM-024 criterion 1)', () => {
  it('names a region by its title', () => {
    expect(refusedPart('region:rLegal0000000001', REGIONS, tr)).toBe('Region: Legal clause');
  });

  it('names the body, the definitions, the header or footer and the whole document', () => {
    expect(refusedPart('body', REGIONS, tr)).toBe('Part: the body');
    expect(refusedPart('defs', REGIONS, tr)).toBe('Part: the definitions');
    expect(refusedPart('defs:settings', REGIONS, tr)).toBe('Part: the definitions');
    expect(refusedPart('defs:field:f1', REGIONS, tr)).toBe('Part: the definitions');
    expect(refusedPart('story:header', REGIONS, tr)).toBe('Part: the header or footer');
    expect(refusedPart('doc', REGIONS, tr)).toBe('Part: the whole document');
  });

  it('names nothing for a region the reader cannot see (ADR 0019)', () => {
    expect(refusedPart('region:rHidden000000001', REGIONS, tr)).toBeNull();
  });

  it('names nothing for a region it does not know, or for no scope', () => {
    expect(refusedPart('region:rUnknown0000001', REGIONS, tr)).toBeNull();
    expect(refusedPart(null, REGIONS, tr)).toBeNull();
    expect(refusedPart(undefined, REGIONS, tr)).toBeNull();
    expect(refusedPart('', REGIONS, tr)).toBeNull();
  });

  it('names every part a rejection names, once each, and leaves out what the reader cannot see', () => {
    const scopes = ['body', 'region:rLegal0000000001', 'region:rHidden000000001', 'defs', 'defs:x'];
    expect(refusedParts({ scopes }, REGIONS, tr)).toEqual([
      'Part: the body',
      'Region: Legal clause',
      'Part: the definitions',
    ]);
    expect(refusedParts({ scope: 'region:rLegal0000000001' }, REGIONS, tr)).toEqual([
      'Region: Legal clause',
    ]);
    expect(refusedParts({}, REGIONS, tr)).toEqual([]);
  });
});

describe('who changed the permissions (PRM-024 criterion 2)', () => {
  it('names the person through the host directory when the client knows them', () => {
    const names: string[] = [];
    const line = changedByLine({ changedBy: 'user:alice' }, tr, (p) => {
      names.push(p);
      return 'Alice Example';
    });
    expect(names).toEqual(['user:alice']);
    expect(line).toBe('Permission changed by Alice Example');
  });

  it('says when, as well as who, when the client knows both', () => {
    const at = '2026-11-13T09:30:00.000Z';
    const when = tr.date(new Date(at), { dateStyle: 'medium', timeStyle: 'short' });
    const line = changedByLine({ changedBy: 'user:alice', changedAt: at }, tr, () => 'Alice');
    expect(line).toBe(`Permission changed by Alice on ${when}`);
    // A time that does not parse is not shown.
    expect(changedByLine({ changedBy: 'user:alice', changedAt: 'soon' }, tr, () => 'Alice')).toBe(
      'Permission changed by Alice',
    );
  });

  it('says only that the permissions changed when the time is known but not the person', () => {
    const line = changedByLine(
      { changedBy: null, changedAt: '2026-11-13T09:30:00.000Z' },
      tr,
      () => {
        throw new Error('the directory must not be asked');
      },
    );
    expect(line).toBeNull();
  });

  it('says nothing more than the reason line when the changer is unknown', () => {
    const nameOf = () => {
      throw new Error('the directory must not be asked');
    };
    expect(changedByLine({ changedBy: null }, tr, nameOf)).toBeNull();
    expect(changedByLine({}, tr, nameOf)).toBeNull();
  });

  it('the reason for a permission rejection says only that the permissions changed', () => {
    expect(tr.t('recovered.why.permission')).toBe('Not saved: your permissions changed');
  });
});
