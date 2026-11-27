/**
 * A test-only CDM version 2 for the service (BE-094; owner decisions 75 and 76: a first version 2
 * exists only to exercise migrations, and nothing of it ships). The same definition as
 * `packages/model/test/cdm2-test-only.ts`: version 1 plus the paragraph attribute `keepTogether`,
 * which version 1 documents carry as `ext["acme.test:keepTogether"]`.
 */
import { CDM1, attr, bool, nullable, type CdmDefinition } from '@docedit/model/definition';
import { moveExtKey, type Migration } from '@docedit/model';
import { buildProjectionSchema, buildSchema } from '@docedit/model/prosemirror';
import { registerCdmSchema } from '../../src/cdm-schemas.ts';

export const EXT_KEY = 'acme.test:keepTogether';

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

export const MIGRATE_V1_TO_V2: Migration = {
  from: 1,
  to: 2,
  name: `move ext["${EXT_KEY}"] to paragraph.keepTogether`,
  apply: (envelope) => ({ ...envelope, cdm: 2, doc: moveInNode(envelope['doc']) }),
};

/** Makes version 2 readable in this process; returns the function that takes it away. */
export function serveCdm2(): () => void {
  return registerCdmSchema(
    2,
    buildSchema(CDM2_TEST_ONLY),
    buildProjectionSchema(CDM2_TEST_ONLY),
    CDM2_TEST_ONLY,
  );
}

/** Sets `ext[EXT_KEY]` on the paragraph with this identifier. */
export function withKeepTogether(doc: unknown, id: string, value: unknown): unknown {
  const walk = (n: unknown): unknown => {
    if (!isObject(n)) return n;
    const out: Json = { ...n };
    const attrs = isObject(n['attrs']) ? n['attrs'] : undefined;
    if (attrs && attrs['id'] === id)
      out['attrs'] = {
        ...attrs,
        ext: { ...(isObject(attrs['ext']) ? attrs['ext'] : {}), [EXT_KEY]: value },
      };
    if (Array.isArray(n['content'])) out['content'] = n['content'].map(walk);
    return out;
  };
  return walk(doc);
}
