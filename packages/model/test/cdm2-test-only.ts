/**
 * A test-only CDM version 2 (CDM-049; owner decisions 75 and 76 in docs/owner-decisions-2026-11-15.md:
 * a first version 2 exists only to exercise migrations, and nothing of it ships). Version 2 differs
 * from version 1 in one thing: the paragraph gains the core attribute `keepTogether`, which version 1
 * documents carry as `ext["acme.test:keepTogether"]`. The migration moves the value and leaves
 * nothing behind in `ext` (03 §11.2: an attribute leaves `ext` at the next major version).
 *
 * This file is not part of the package's exports and defines no schema that a reader accepts.
 */
import { CDM1 } from '../src/definition/cdm1.ts';
import { attr, bool, nullable, type CdmDefinition } from '../src/definition/grammar.ts';
import { moveExtKey, type Migration } from '../src/migrate/migrations.ts';

/** The `ext` key of version 1 that becomes the core attribute `keepTogether` in version 2. */
export const EXT_KEY = 'acme.test:keepTogether';

/** Version 1 with one more paragraph attribute, stamped 2. */
export const CDM2_TEST_ONLY: CdmDefinition = {
  ...CDM1,
  cdm: 2,
  nodes: CDM1.nodes.map((n) =>
    n.name === 'paragraph'
      ? {
          ...n,
          attrs: {
            ...n.attrs,
            keepTogether: attr(
              nullable(bool()),
              null,
              'Test only: keep the lines of the paragraph on one page.',
            ),
          },
        }
      : n,
  ),
};

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function moveInNode(node: unknown): unknown {
  if (!isObject(node)) return node;
  const out: Json = { ...node };
  if (node['type'] === 'paragraph' && isObject(node['attrs']))
    out['attrs'] = moveExtKey(node['attrs'], EXT_KEY, 'keepTogether');
  if (Array.isArray(node['content'])) out['content'] = node['content'].map(moveInNode);
  return out;
}

/** The migration from version 1 to the test-only version 2: pure, no clock, no randomness, no I/O. */
export const MIGRATE_V1_TO_V2: Migration = {
  from: 1,
  to: 2,
  name: `move ext["${EXT_KEY}"] to paragraph.keepTogether`,
  apply: (envelope) => ({ ...envelope, cdm: 2, doc: moveInNode(envelope['doc']) }),
};
