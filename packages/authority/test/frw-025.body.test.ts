// FRW-025: the body of `PUT /documents/{id}/workflow` (criteria 1 and 4): the server-owned members
// are ignored, the writable members are checked, and every refusal names a path and a rule.
import { describe, expect, it } from 'vitest';
import { checkWorkflowBody, DEFAULT_TIME_ZONE, relayCapabilities } from '../src/index.ts';

const DOC = '0192f0aa-0000-7000-8000-000000000001';
const P1 = { id: 'p1', roles: ['role_tenant'], kind: 'signer', order: 1, name: 'Jane Doe' };

const problemsOf = (body: unknown) => {
  const r = checkWorkflowBody(body, DOC);
  return r.ok ? [] : r.problems;
};

describe('the body of a PUT of the workflow resource (FRW-025)', () => {
  it('ignores the members the server owns, and the state of a participant', () => {
    const r = checkWorkflowBody(
      {
        id: 'x',
        doc: DOC,
        state: 'completed',
        rev: 9,
        sentSeq: 640,
        sentHash: 'sha256:9c1f',
        participants: [{ ...P1, state: 'completed', completedSeq: 655 }],
      },
      DOC,
    );
    expect(r).toEqual({
      ok: true,
      input: { timeZone: DEFAULT_TIME_ZONE, participants: [P1], members: {} },
    });
  });

  it('stores the time zone and every writable member as given', () => {
    const members = {
      routing: [{ when: { '>': [{ field: 'lease.total' }, '50000'] }, then: [] }],
      deadline: '2026-10-18T00:00:00Z',
      reminders: { firstAfterDays: 3, everyDays: 2 },
      consent: { textId: 'esign-consent', version: 3 },
      finalisation: { seal: 'pades-b-lta', certificate: true },
    };
    const auth = { require: ['access_code'] };
    const r = checkWorkflowBody(
      { timeZone: 'Europe/Berlin', participants: [{ ...P1, auth }], ...members },
      DOC,
    );
    expect(r).toEqual({
      ok: true,
      input: { timeZone: 'Europe/Berlin', participants: [{ ...P1, auth }], members },
    });
  });

  it('refuses a body that is not an object, unknown members and another document', () => {
    expect(problemsOf([])).toEqual([{ path: '', rule: 'not_an_object' }]);
    expect(problemsOf({ participants: [], colour: 'red' })).toEqual([
      { path: '/colour', rule: 'unknown_member' },
    ]);
    expect(problemsOf({ participants: [], doc: 'another' })).toEqual([
      { path: '/doc', rule: 'not_the_document_of_the_path' },
    ]);
    expect(problemsOf({})).toEqual([{ path: '/participants', rule: 'missing_member' }]);
  });

  it('names the path and the rule of each refusal', () => {
    const problems = problemsOf({
      timeZone: 'Mars/Olympus',
      participants: [
        { ...P1, kind: 'witness' },
        { ...P1, id: 'p2', auth: { require: [''] } },
        { ...P1, id: 'p3', phone: '+49 1' },
      ],
      routing: [{ when: true }],
      deadline: '18 October',
      reminders: { everyDays: 0, weekly: 1 },
      consent: { version: 1.5 },
      finalisation: { certificate: 'yes' },
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        { path: '/timeZone', rule: 'invalid_time_zone' },
        { path: '/participants/0/kind', rule: 'invalid_kind' },
        { path: '/participants/1/auth', rule: 'invalid_auth' },
        { path: '/participants/2/phone', rule: 'unknown_member' },
        { path: '/routing/0', rule: 'not_a_route' },
        { path: '/deadline', rule: 'invalid_instant' },
        { path: '/reminders/everyDays', rule: 'invalid_value' },
        { path: '/reminders/weekly', rule: 'unknown_member' },
        { path: '/consent/version', rule: 'invalid_value' },
        { path: '/finalisation/certificate', rule: 'invalid_value' },
      ]),
    );
  });

  it('accepts exactly the four kinds (criterion 4)', () => {
    for (const kind of ['filler', 'signer', 'approver', 'cc'])
      expect(checkWorkflowBody({ participants: [{ ...P1, kind }] }, DOC).ok, kind).toBe(true);
    for (const kind of ['Signer', 'witness', '', 'cc ', 'reviewer'])
      expect(problemsOf({ participants: [{ ...P1, kind }] }), kind).toEqual([
        { path: '/participants/0/kind', rule: 'invalid_kind' },
      ]);
  });

  it('is never announced by a relay (criterion 6)', () => {
    const caps = relayCapabilities(['presence', 'workflow', 'fields']);
    expect(caps.mode).toBe('relay');
    expect(caps.features).toEqual(['presence']);
  });
});
