// PRO-070 criterion 5 (lane V-PRO-069-085): the integration guide's section on the webhook receiver
// says to verify the signature and to drop a repeated delivery by its `webhook-id`. The guide is
// the reference host's (apps/reference-host/docs/integration-guide.md, UX-090). This test reads the
// text and checks the statements, so that an edit which removes them fails here.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const guide = readFileSync(
  new URL('../../../../apps/reference-host/docs/integration-guide.md', import.meta.url),
  'utf8',
);

/** The receiver section: from its heading to the next top-level section. */
function receiverSection(): string {
  const start = guide.indexOf('## 3. The webhook receiver');
  expect(start, 'the guide has a webhook receiver section').toBeGreaterThanOrEqual(0);
  const next = guide.indexOf('\n## ', start + 1);
  return guide.slice(start, next === -1 ? undefined : next);
}

describe('PRO-070 criterion 5: the integration guide describes the receiver (V-PRO-069-085)', () => {
  it('says to verify each delivery signature with the Standard Webhooks headers', () => {
    const section = receiverSection();
    expect(section).toMatch(/check the signature of each delivery/i);
    for (const header of ['webhook-id', 'webhook-timestamp', 'webhook-signature']) {
      expect(section).toContain(header);
    }
  });

  it('says to drop a delivery whose webhook-id was already handled', () => {
    const section = receiverSection();
    expect(section).toMatch(/drop a delivery whose `webhook-id` it has already handled/);
  });
});
