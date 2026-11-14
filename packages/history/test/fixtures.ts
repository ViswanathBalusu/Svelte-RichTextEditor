/**
 * Test fixtures for the history functions: a document with definitions, regions (one of them
 * confidential, holding canary text and a sensitive field with a canary value), a table, a
 * footnote and a form field, plus helpers that turn transforms into stored commits.
 */
import {
  ENGINE,
  type HiddenSet,
  type LogCommit,
  type SnapshotCommit,
  type StoredCommit,
  stepsToJson,
} from '@docedit/authority';
import { cdmSchema } from '@docedit/model/prosemirror';
import type { Node } from 'prosemirror-model';
import { type Step, Transform } from 'prosemirror-transform';
import type { CommitMeta } from '../src/types.ts';

export const schema = cdmSchema();

/** Text that must never reach a reader of the confidential region. */
export const CANARY = 'CANARYsecretTEXT';
/** A value that must never reach a reader who may not read the sensitive field. */
export const CANARY_VALUE = 'CANARYsecretVALUE';

export const p = (id: string, text: string, style: string | null = null) => ({
  type: 'paragraph',
  attrs: { id, ...(style ? { style } : {}) },
  content: text ? [{ type: 'text', text }] : [],
});

const cell = (id: string, pid: string, text: string) => ({
  type: 'table_cell',
  attrs: { id },
  content: [p(pid, text)],
});

export const BASE_JSON = {
  type: 'doc',
  content: [
    {
      type: 'defs',
      content: [
        { type: 'settings', attrs: { lang: 'en-GB' } },
        {
          type: 'style_def',
          attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
        },
        {
          type: 'style_def',
          attrs: {
            id: 'Heading1',
            kind: 'paragraph',
            name: 'Heading 1',
            builtIn: true,
            basedOn: 'Normal',
            outlineLevel: 1,
          },
        },
        {
          type: 'style_def',
          attrs: { id: 'LegalQuote', kind: 'paragraph', name: 'Legal quote', basedOn: 'Normal' },
        },
        { type: 'page_setup', attrs: { id: 'ps1' } },
        { type: 'role_def', attrs: { id: 'role_tenant', name: 'Tenant', color: '#1F77B4' } },
      ],
    },
    {
      type: 'body',
      attrs: { pageSetup: 'ps1' },
      content: [
        p('pTitle0000000001', 'Lease agreement', 'Heading1'),
        p('pIntro0000000001', 'This agreement is made between the parties.'),
        {
          type: 'region',
          attrs: { id: 'rTerms000000000A', title: 'Terms', policy: 'inherit' },
          content: [
            p('pTerms000000001A', 'Rent is due monthly.'),
            p('pTerms000000002A', 'Deposit is one month.'),
            p('pTerms000000003A', 'Pets need consent.'),
          ],
        },
        {
          type: 'table',
          attrs: { id: 'tFees00000000001', grid: [4500, 4500] },
          content: [
            {
              type: 'table_row',
              attrs: { id: 'trFees0000000001' },
              content: [
                cell('tcFees000000011A', 'pCell00000000011', 'Item'),
                cell('tcFees000000012A', 'pCell00000000012', 'Fee'),
              ],
            },
            {
              type: 'table_row',
              attrs: { id: 'trFees0000000002' },
              content: [
                cell('tcFees000000021A', 'pCell00000000021', 'Cleaning'),
                cell('tcFees000000022A', 'pCell00000000022', '50'),
              ],
            },
          ],
        },
        {
          type: 'region',
          attrs: { id: 'rSecret00000000B', title: 'Secret terms', policy: 'confidential' },
          content: [
            {
              type: 'paragraph',
              attrs: { id: 'pSecret00000001B' },
              content: [
                { type: 'text', text: `Hidden clause ${CANARY}. Tenant: ` },
                {
                  type: 'form_field',
                  attrs: {
                    id: 'fSecretName00001',
                    key: 'secret.name',
                    kind: 'text',
                    label: 'Name',
                    value: CANARY_VALUE,
                  },
                },
              ],
            },
          ],
        },
        {
          type: 'paragraph',
          attrs: { id: 'pNote00000000001' },
          content: [
            { type: 'text', text: 'See the note' },
            {
              type: 'footnote',
              attrs: { id: 'fnNote0000000001' },
              content: [p('pFoot00000000001', 'A footnote.')],
            },
            { type: 'text', text: ' and sign: ' },
            {
              type: 'form_field',
              attrs: {
                id: 'fTenantName00001',
                key: 'tenant.name',
                kind: 'text',
                label: 'Tenant name',
                assignee: 'role_tenant',
                sensitive: true,
                value: CANARY_VALUE,
              },
            },
          ],
        },
        p('pEnd00000000001Z', 'The end.'),
      ],
    },
  ],
};

export const REQUIRES = ['fields'];

export function baseDoc(): Node {
  const doc = schema.nodeFromJSON(BASE_JSON);
  doc.check();
  return doc;
}

/** What a reader without access to the confidential region and the sensitive value may not see. */
export const HIDDEN: HiddenSet = {
  regions: new Set(['rSecret00000000B']),
  values: new Set(['fTenantName00001']),
  titles: false,
};

/** Position just inside the first node whose id is `id`, plus `offset`. */
export function posInside(doc: Node, id: string, offset = 0): number {
  let found = -1;
  doc.descendants((n, pos) => {
    if (found >= 0) return false;
    if (n.attrs['id'] === id) {
      found = pos + 1 + offset;
      return false;
    }
    return true;
  });
  if (found < 0) throw new Error(`no node ${id}`);
  return found;
}

/** Position of the node itself. */
export function posOf(doc: Node, id: string): number {
  let found = -1;
  doc.descendants((n, pos) => {
    if (found >= 0) return false;
    if (n.attrs['id'] === id) {
      found = pos;
      return false;
    }
    return true;
  });
  if (found < 0) throw new Error(`no node ${id}`);
  return found;
}

/** Types `text` at `offset` in the block `id`. */
export function typeAt(doc: Node, id: string, offset: number, text: string): Transform {
  return new Transform(doc).insert(posInside(doc, id, offset), schema.text(text));
}

/** Deletes `length` positions from `offset` in the block `id`. */
export function deleteIn(doc: Node, id: string, offset: number, length: number): Transform {
  const at = posInside(doc, id, offset);
  return new Transform(doc).delete(at, at + length);
}

let counter = 0;
export const uuid = () => `0192f0c4-7b1e-7000-8000-${(++counter).toString(16).padStart(12, '0')}`;

export interface CommitOptions {
  user?: string;
  agent?: string;
  origin?: string;
  time?: number;
  scopes?: string[];
  session?: string;
}

/** A stored step commit made of `steps`. */
export function stepCommit(
  seq: number,
  steps: readonly Step[],
  o: CommitOptions = {},
): StoredCommit {
  const user = o.user ?? 'alice';
  const c: StoredCommit = {
    seq,
    id: uuid(),
    kind: 'steps',
    steps: stepsToJson(steps),
    user,
    session: o.session ?? `s-${user}`,
    time: o.time ?? 1_000_000 + seq * 1000,
    origin: o.origin ?? 'input',
    scopes: o.scopes ?? ['body'],
    revision: 1,
    cdm: 1,
    engine: ENGINE,
    retired: [],
    claimed: [],
  };
  if (o.agent !== undefined) c.agent = o.agent;
  return c;
}

export function snapshotCommit(
  seq: number,
  checkpoint: string,
  o: CommitOptions = {},
): SnapshotCommit {
  const user = o.user ?? 'alice';
  return {
    seq,
    id: uuid(),
    kind: 'snapshot',
    steps: [],
    snapshot: { checkpoint, reason: 'restore' },
    user,
    session: o.session ?? `s-${user}`,
    time: o.time ?? 1_000_000 + seq * 1000,
    origin: 'restore',
    scopes: o.scopes ?? ['body'],
    revision: 1,
    cdm: 1,
    engine: ENGINE,
    retired: [],
    claimed: [],
  };
}

/** A log built step by step: each `add` takes a transform made on the current document. */
export class LogBuilder {
  docs: Node[];
  log: LogCommit[] = [];
  constructor(start: Node = baseDoc()) {
    this.docs = [start];
  }
  get doc(): Node {
    return this.docs[this.docs.length - 1]!;
  }
  get head(): number {
    return this.docs.length - 1;
  }
  add(make: (doc: Node) => Transform, o: CommitOptions = {}): StoredCommit {
    const tr = make(this.doc);
    const c = stepCommit(this.head + 1, tr.steps, o);
    this.log.push(c);
    this.docs.push(tr.doc);
    return c;
  }
  commits(after: number, to: number): LogCommit[] {
    return this.log.filter((c) => c.seq > after && c.seq <= to);
  }
}

export function meta(c: LogCommit): CommitMeta {
  const m: CommitMeta = {
    seq: c.seq,
    kind: c.kind,
    user: c.user,
    session: c.session,
    time: c.time,
    origin: c.origin,
    scopes: c.scopes,
  };
  if (c.agent !== undefined) m.agent = c.agent;
  return m;
}

/** Whether any string in a JSON value contains a canary. */
export function leaks(value: unknown): boolean {
  const text = JSON.stringify(value, (_, v) => (v instanceof Set ? [...v] : v)) ?? '';
  return text.includes(CANARY) || text.includes(CANARY_VALUE) || text.includes('CANARY');
}
