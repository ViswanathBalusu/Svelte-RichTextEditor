// HIS-038 criterion 5: the integration guide and the token documentation ask hosts not to use
// e-mail addresses as `sub`. The token documentation is 05 section 3.1, the `TokenRequest` of the
// published OpenAPI document, and the erase operation's own request.
import { describe, expect, it } from 'vitest';
import { readJson, readText } from './support.ts';

const asks = (text: string): boolean => /not\b[^.]{0,40}e-mail address/i.test(text);

describe('hosts are asked not to use e-mail addresses as sub (HIS-038 criterion 5)', () => {
  it('says so in the integration guide', () => {
    const guide = readText('apps/reference-host/docs/integration-guide.md');
    expect(guide).toMatch(/### The user identifier: `sub`/);
    expect(guide).toMatch(/Not an e-mail address\.\*\* Do not use e-mail addresses as `sub`/);
  });

  it('says so in the token documentation of the protocol (05 section 3.1)', () => {
    const spec = readText('docs/spec/05-protocol.md');
    const row = spec.split('\n').find((l) => l.startsWith('| `sub` |'));
    expect(row).toBeDefined();
    expect(row).toMatch(/SHOULD NOT use e-mail addresses/);
  });

  it('says so in the published schemas that carry a sub', () => {
    const openapi = readJson('spec/dep/dep-1.openapi.json') as {
      components: {
        schemas: Record<string, { properties?: Record<string, { description?: string }> }>;
      };
    };
    for (const name of ['TokenRequest', 'ErasePersonRequest']) {
      const sub = openapi.components.schemas[name]?.properties?.['sub'];
      expect(sub?.description, name).toBeDefined();
      expect(asks(sub!.description!) || /SHOULD NOT use/.test(sub!.description!), name).toBe(true);
    }
  });
});
