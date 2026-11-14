// The reference forms that 03 leaves open (CDM-002, criterion 5; ADR 0018, "Node identifiers",
// "field.target", "link.href", "Uniqueness" and "listId"): the form of each field target kind,
// the form of an in-document link, the uniqueness of bookmark names and equation labels, and the
// format of listId. The copy rule of listId is ADR 0032 section 2 (CDM-005), not tested here.
import { describe, expect, it } from 'vitest';
import { bodyOf, codes, exampleDoc, type Json } from '../../test/support.ts';
import { NODE_ID_PATTERN } from '../conventions/ids.ts';
import {
  BOOKMARK_NAME_PATTERN,
  EQUATION_LABEL_PATTERN,
  FIELD_TARGET_PATTERN,
  LINK_HREF_PATTERN,
} from './cdm1.ts';

const target = new RegExp(FIELD_TARGET_PATTERN);
const href = new RegExp(LINK_HREF_PATTERN);
const nodeId = new RegExp(NODE_ID_PATTERN);

describe('field.target addressing forms (CDM-002, ADR 0018)', () => {
  it('takes one form per target kind: bookmark, node, eq, style and field', () => {
    const good = [
      'bookmark:here',
      'bookmark:_clause_4',
      'node:p3Jq8sLw0aZx1VbN',
      'node:pNumbered0000001',
      'eq:sum',
      'eq:energy:total-2',
      'style:Heading1',
      'style:ps1',
      'field:client.name',
      'field:total',
    ];
    for (const t of good) expect(target.test(t), t).toBe(true);
  });

  it('refuses bare identifiers, the wrong prefix for a kind, and names outside the grammar', () => {
    const bad = [
      'here',
      'Heading1',
      'bookmark:4clause',
      'bookmark:' + 'a'.repeat(41),
      'node:short',
      'node:p3Jq8sLw0aZx1VbN9',
      'node:p3Jq8sLw0aZx1Vb+',
      'eq:4sum',
      'style:',
      'field:client..name',
      'field:client name',
      'bookmark:x eq:y',
    ];
    for (const t of bad) expect(target.test(t), t).toBe(false);
  });

  it('gives bookmark names and equation labels their own grammars (uniqueness is checked by I4)', () => {
    expect(new RegExp(BOOKMARK_NAME_PATTERN).test('clause_4')).toBe(true);
    expect(new RegExp(BOOKMARK_NAME_PATTERN).test('clause-4')).toBe(false);
    expect(new RegExp(EQUATION_LABEL_PATTERN).test('eq:energy')).toBe(true);
    expect(new RegExp(EQUATION_LABEL_PATTERN).test('eq energy')).toBe(false);
  });
});

describe('link.href forms (CDM-002, ADR 0018; invariant I9)', () => {
  it('takes http, https, mailto and an in-document target', () => {
    for (const h of [
      'https://example.org/a?b=c',
      'http://example.org/',
      'mailto:someone@example.org',
      '#clause_4',
      '#eq:energy',
    ])
      expect(href.test(h), h).toBe(true);
  });

  it('refuses other schemes, relative references and empty fragments', () => {
    for (const h of [
      'javascript:alert(1)',
      'data:text/html,hi',
      'file:///etc/passwd',
      'ftp://example.org/',
      'other.html',
      '#',
      '#has space',
      'https://example.org/<bad>',
    ])
      expect(href.test(h), h).toBe(false);
  });
});

describe('listId format (CDM-002, ADR 0018)', () => {
  it('is a 16-character URL-safe Base64 identifier, like a node identifier', () => {
    expect(nodeId.test('lList00000000001')).toBe(true);
    expect(nodeId.test('abc-DEF_ghi01234')).toBe(true);
    expect(nodeId.test('lList0000000001')).toBe(false);
    expect(nodeId.test('lList000000000001')).toBe(false);
    expect(nodeId.test('lList0000000000+1')).toBe(false);
    expect(nodeId.test('lList0000000000/1')).toBe(false);
  });
});

describe('uniqueness of bookmark names and equation labels (CDM-002, ADR 0018)', () => {
  const eq = (id: string, label: string): Json => ({
    type: 'equation_block',
    attrs: { id, latex: 'E = mc^2', numbered: true, label },
  });

  it('reports two equation labels with one value as ambiguous', () => {
    const d = exampleDoc();
    bodyOf(d).push(eq('eqBlock000000001', 'eq:energy'), eq('eqBlock000000002', 'eq:energy'));
    expect(codes(d)).toContain('duplicate_target_name');
  });

  it('accepts two distinct equation labels', () => {
    const d = exampleDoc();
    bodyOf(d).push(eq('eqBlock000000001', 'eq:energy'), eq('eqBlock000000002', 'eq:mass'));
    expect(codes(d)).toEqual([]);
  });
});
