/**
 * UX-040 criterion 5, the guide half: the integration guide describes the three output
 * restrictions as honoured by the editor and the service, and says they are a deterrent and not a
 * security boundary. It must not keep the old "not wired yet" wording.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const GUIDE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'integration-guide.md'),
  'utf8',
);
const bullet = GUIDE.split('\n').find((l) => l.startsWith('- **Output restrictions (UX-040)')) ?? '';

describe('integration guide, output restrictions (UX-040 criterion 5)', () => {
  it('states the deterrent wording and names each restriction', () => {
    expect(bullet).toContain('deter casual copying');
    expect(bullet).toContain('not a security boundary');
    for (const name of ['no-export', 'no-copy', 'no-print']) expect(bullet).toContain(`\`${name}\``);
  });

  it('describes what the editor and the service do, without the stale "not wired" text', () => {
    expect(bullet).not.toContain('not wired');
    expect(bullet).not.toContain('not yet tested');
    expect(bullet).toContain('`perm.changed`');
    expect(bullet).toContain('document service refuses a direct export request');
  });
});
