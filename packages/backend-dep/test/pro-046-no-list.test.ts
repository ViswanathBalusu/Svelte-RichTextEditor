// PRO-046, criterion 5: the backend-dep source never calls `GET /documents`. A host creates and
// lists documents with its service credential; the editor finds documents through the host's own
// catalogue, so the editor's port must not reach the collection route. Two checks: the source is
// searched for any literal that names the bare collection path, and the requests of a real session
// (against the reference service, in memory) are recorded and none is a GET of the collection.
// Node.js only: the search reads the source files (lane U-PRO-035-051).
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MemoryNetwork } from './support/memory-network.ts';
import { MockDepServer } from './support/mock-server.ts';
import { LEGAL_GRANT, USERS, contractDocument } from './support/fixtures.ts';
import { createDepBackend } from '../src/index.ts';

const SRC = new URL('../src/', import.meta.url);

/** Every non-test TypeScript source file under src/. */
function sourceFiles(): Array<{ name: string; text: string }> {
  return readdirSync(SRC)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((name) => ({ name, text: readFileSync(new URL(name, SRC), 'utf8') }));
}

/**
 * A path literal that names the bare collection: `/documents` followed by a quote, a backtick, a
 * query or the end of the literal, and not by `/` (the document-scoped routes) or a word character.
 */
const COLLECTION_PATH = /\/documents(?=['"`?])/g;

describe('PRO-046 criterion 5: the editor never lists documents', () => {
  it('searches the source for the bare collection path and finds none', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(0);
    // The search is not vacuous: the document-scoped routes are in the files searched.
    expect(files.some((f) => f.text.includes('/documents/${'))).toBe(true);
    const hits = files.flatMap((f) =>
      [...f.text.matchAll(COLLECTION_PATH)].map((m) => `${f.name}@${m.index}`),
    );
    expect(hits).toEqual([]);
  });

  it('records the requests of a session and finds no GET of the collection', async () => {
    const server = new MockDepServer();
    const net = new MemoryNetwork(server);
    const docId = server.service.createDocument(contractDocument(), { grants: [LEGAL_GRANT] });
    const b = createDepBackend({
      endpoint: server.endpoint,
      getToken: async () => server.mintToken(USERS.editor, { [docId]: 'editor' }),
      platform: { random: () => 0, ...net.platform() },
    });
    try {
      await b.connect();
      await b.sync.loadContent(docId);
      await b.sync.loadContent(docId, 0).catch(() => undefined);
      const requests = net.requests;
      // The session must have made REST calls, or the check proves nothing.
      expect(requests.length).toBeGreaterThan(0);
      const listing = requests.filter(
        (r) => r.method.toUpperCase() === 'GET' && /\/v1\/documents(\?|$)/.test(r.url),
      );
      expect(listing).toEqual([]);
    } finally {
      await b.close();
    }
  });
});
