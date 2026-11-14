/**
 * SEC-001 — the threat register ties every threat of 10 §3 to its control and its proof, and this
 * check runs in CI so a mitigation cannot exist without a test and no threat is forgotten when the
 * design changes (10 §2, §3, §5). The register is threat-register.json; a "proven" row must name
 * tests that exist, and a row with no proof must be marked "control-not-built" with its phase.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface Threat {
  id: string;
  section: string;
  threat: string;
  control: string;
  builtBy: string[];
  provenBy: string;
  phase: string;
  status: 'proven' | 'control-not-built';
  tests: string[];
  boundaries: string[];
}
interface Register {
  boundaries: Array<{ id: string; from: string; to: string; via: string }>;
  actors: Array<{ id: string; trustedFor: string; hostile: string }>;
  threats: Threat[];
  review: { phase: string; secondMaintainerReview: string; note: string };
}

const HERE = fileURLToPath(new URL('..', import.meta.url)); // tests/security/
const register = JSON.parse(readFileSync(HERE + 'threat-register.json', 'utf8')) as Register;
const testDir = HERE + 'test/';

describe('SEC-001 threat register', () => {
  it('gives every threat an identifier, a control, the building epic/story and the proving story', () => {
    expect(register.threats.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    for (const t of register.threats) {
      expect(t.id, 'id').toBeTruthy();
      expect(seen.has(t.id), `${t.id} is unique`).toBe(false);
      seen.add(t.id);
      expect(t.control, `${t.id} control`).toBeTruthy();
      expect(t.builtBy.length, `${t.id} builtBy`).toBeGreaterThan(0);
      expect(t.provenBy, `${t.id} provenBy`).toMatch(/^SEC-\d+$|^FE-\d+$/);
    }
  });

  it('every row of 10 §3.1 to §3.8 is present', () => {
    const sections = new Set(register.threats.map((t) => t.section));
    for (const s of ['3.1', '3.2', '3.3', '3.4', '3.5', '3.6', '3.7', '3.8'])
      expect(sections, `section ${s} has threats`).toContain(s);
  });

  it('a proven row names tests that exist; an unproven row is marked control-not-built with a phase', () => {
    for (const t of register.threats) {
      if (t.status === 'proven') {
        expect(t.tests.length, `${t.id} proven has tests`).toBeGreaterThan(0);
        for (const file of t.tests)
          expect(existsSync(testDir + file), `${t.id} test ${file} exists`).toBe(true);
      } else {
        expect(t.status, `${t.id} status`).toBe('control-not-built');
        expect(t.phase, `${t.id} phase`).toMatch(/^(1a|1b|2|3|4|cond)$/);
        expect(t.tests.length, `${t.id} not-built has no tests`).toBe(0);
      }
    }
  });

  it('each trust boundary of 10 §2 lists the threats that cross it, and every reference resolves', () => {
    const ids = new Set(register.boundaries.map((b) => b.id));
    expect(ids.size).toBe(6); // 10 §2: six trust boundaries
    for (const t of register.threats)
      for (const b of t.boundaries) expect(ids, `${t.id} boundary ${b}`).toContain(b);
    // Every boundary is crossed by at least one threat.
    for (const b of register.boundaries)
      expect(
        register.threats.some((t) => t.boundaries.includes(b.id)),
        `boundary ${b.id} is used`,
      ).toBe(true);
  });

  it('each actor records what it is trusted for and what is assumed hostile, with the two key assumptions', () => {
    for (const a of register.actors) {
      expect(a.trustedFor, `${a.id} trustedFor`).toBeTruthy();
      expect(a.hostile, `${a.id} hostile`).toBeTruthy();
    }
    const user = register.actors.find((a) => a.id === 'end-user');
    const worker = register.actors.find((a) => a.id === 'workers');
    expect(user?.hostile).toMatch(/hand-crafted/);
    expect(worker?.hostile).toMatch(/fully compromised/);
  });

  it('every phase-1a packet-F story has a proven row that points at it', () => {
    // The stories this packet proves in phase 1a must each appear as a proven threat.
    const proven = new Set(
      register.threats.filter((t) => t.status === 'proven').map((t) => t.provenBy),
    );
    for (const story of [
      'SEC-012',
      'SEC-013',
      'SEC-017',
      'SEC-019',
      'SEC-021',
      'SEC-025',
      'SEC-026',
      'SEC-027',
      'SEC-031',
      'SEC-045',
      'SEC-047',
      'SEC-050',
      'SEC-059',
    ])
      expect(proven, `${story} is proven in the register`).toContain(story);
  });

  it('records the phase-1a review input and notes the second-maintainer sign-off (SEC-003)', () => {
    expect(register.review.phase).toBe('1a');
    expect(register.review.note).toMatch(/SEC-003/);
  });
});
