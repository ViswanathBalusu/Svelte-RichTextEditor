// SYN-043 criterion 6: the tests of authority and permissions do not rely on `sync.check`, which is
// not a security control (04 §13). This is a static check: it reads the test sources and fails when a
// test file other than the check's own unit test (`room-check.test.ts`) names the divergence check.
// It is a proxy for "no test relies on it"; it cannot see a reliance that goes through a helper
// file which does not name the check. Those helpers are scanned too, so a re-export is caught.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SERVICE_TESTS = join(HERE, '..', '..', '..', 'services', 'document-service', 'test');
const OWN = 'syn-043-check-not-security.test.ts';
/** The unit test of the check itself; it is allowed to name it. */
const CHECK_UNIT_TEST = 'room-check.test.ts';
/**
 * The SYN-043 lane test of the host's send of `sync.check` (criterion 1 Evidence). Its subject is the
 * check, not an authority or permission test relying on it, so it is exempt by exact name.
 */
const CHECK_SEND_TEST = 'syn-043.v-syn-037-053.check.pg.test.ts';

const FORBIDDEN = [
  /room\/check(\.ts)?['"]/,
  /\bsyncCheck\b/,
  /\bdocumentCanonicalHash\b/,
  /sync\.check/,
];

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!/\.(ts|js|mjs)$/.test(entry.name)) continue;
    out.push(join(entry.parentPath, entry.name));
  }
  return out;
}

describe('sync.check is not relied on by authority or permission tests (SYN-043 criterion 6)', () => {
  it('scans a non-empty set of authority test sources', () => {
    const files = testFiles(join(HERE));
    expect(files.length).toBeGreaterThan(50);
  });

  it('no authority or permissions test names the divergence check', () => {
    const offenders: string[] = [];
    const sources = [...testFiles(HERE), ...testFiles(SERVICE_TESTS)];
    for (const file of sources) {
      const name = file.split(/[\\/]/).pop() ?? '';
      if (name === OWN || name === CHECK_UNIT_TEST || name === CHECK_SEND_TEST) continue;
      // Only the authority and permissions tests: the service's data-plane and permission tests,
      // and every authority test. Other service tests are not in scope of criterion 6.
      const inScope =
        file.startsWith(HERE) ||
        /permission|authority|data-plane/i.test(relative(SERVICE_TESTS, file));
      if (!inScope) continue;
      const text = readFileSync(file, 'utf8');
      if (FORBIDDEN.some((re) => re.test(text)))
        offenders.push(relative(join(HERE, '..', '..', '..'), file));
    }
    expect(offenders).toEqual([]);
  });
});
