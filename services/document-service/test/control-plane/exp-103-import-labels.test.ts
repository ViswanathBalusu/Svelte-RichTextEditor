// EXP-103 criterion 2: the authors of tracked changes arrive as labels (`word:<author>`) and never
// as the identity of a user of the tenant. The importer of packages/export-docx (imported by its
// source path, as exp-098-real-importer.test.ts does) writes the labels; the authority decides what
// a label is (`isImportLabel`; packages/authority/src/permissions/suggestions.ts). This test joins
// the two: every `user` of an imported suggestion mark is a label to the authority, and neither the
// bare author name, a host identifier that equals it, nor a per-tenant surrogate is one.
//
// The rules that follow from a label (only an import commit may name one; no connection owns a mark
// that names one) are tested in packages/authority/test/suggestions.test.ts.
//
// The import route is not used here: it stores the envelope only, and a file whose preserved
// content is kept as assets (fragments) fails invariant I4 at the route until the importer's assets
// are stored with the snapshot (see the Notes of EXP-103).
import { isImportLabel } from '@docedit/authority';
import { describe, expect, it } from 'vitest';
import { importDocx } from '../../../../packages/export-docx/src/index.ts';
import { corpusFiles, readFile } from '../../../../packages/export-docx/test/corpus.ts';
import { MemoryUserDirectory } from '../../src/control-plane/users.ts';

type Node = {
  type?: string;
  marks?: { type: string; attrs?: { user?: string } }[];
  content?: Node[];
};

function suggestionUsers(node: Node, out = new Set<string>()): Set<string> {
  for (const m of node.marks ?? [])
    if ((m.type === 'ins' || m.type === 'del') && typeof m.attrs?.user === 'string')
      out.add(m.attrs.user);
  for (const c of node.content ?? []) suggestionUsers(c, out);
  return out;
}

const FILES: Array<[string, string[]]> = [
  ['docx4j/cr043-tracked.docx', ['Author A', 'CR-043 base']],
  ['docx4j/review-for-word-word2010.docx', ['Author A', 'Author B', 'Claude']],
  ['poi/delins.docx', ['pavel']],
];

describe('EXP-103 criterion 2: imported suggestions name labels, not users', () => {
  it.each(FILES)(
    '%s: every suggestion mark names a label of its authors',
    async (name, authors) => {
      const file = corpusFiles().find((f) => f.name === name)!;
      const { envelope } = await importDocx(readFile(file));
      const users = [...suggestionUsers(envelope.doc as unknown as Node)];
      expect(users.length).toBeGreaterThan(0);
      for (const u of users) {
        expect(isImportLabel(u), `label ${u}`).toBe(true);
        expect(authors.map((a) => `word:${a}`)).toContain(u);
      }
      // The labels the importer writes for each file (a revision the importer cannot express is kept as preserved content, not as a mark), so the check is not vacuous.
      expect(users.length).toBe(
        name === 'docx4j/review-for-word-word2010.docx'
          ? 3
          : name === 'poi/delins.docx' || name === 'docx4j/cr043-tracked.docx'
            ? 1
            : 2,
      );
    },
  );

  it('a label is never a real user: the bare name, a host identifier and a surrogate are not labels', async () => {
    const directory = new MemoryUserDirectory();
    const tenant = 'tenant-exp-103';
    const authors = ['Author A', 'Author B', 'Claude', 'pavel', 'CR-043 base'];
    for (const sub of authors) {
      const u = await directory.resolve(tenant, sub);
      // The host's identifier of a user who has the author's name, and the stored surrogate.
      expect(isImportLabel(sub)).toBe(false);
      expect(isImportLabel(u.surrogate)).toBe(false);
      // The label of the same author is not either of them.
      expect(`word:${sub}`).not.toBe(sub);
      expect(`word:${sub}`).not.toBe(u.surrogate);
      expect(isImportLabel(`word:${sub}`)).toBe(true);
    }
  });
});
