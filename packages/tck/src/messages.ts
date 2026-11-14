/**
 * Golden message fixtures (PRO-110 criterion 1): for every message type of the definition, valid
 * frames (only the required members, and every member) and invalid ones (a required member
 * missing, a member of the wrong type, a mistyped envelope), built from the definition data, and
 * the conversation of 05 §5.9, completed with the members the example leaves out (G53). The
 * generator writes them to fixtures/messages/; a test checks that the files equal a fresh build.
 */
import { DEP1, depCodec, type definition } from '@docedit/protocol';
import { contractDocument } from './documents.ts';

type Shape = definition.Shape;
type StringShape = Extract<Shape, { kind: 'string' }>;

const FORMAT: Record<string, string> = {
  uuid7: '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10',
  timestamp: '2026-09-18T10:42:00.000Z',
  nodeId: 'rG7mK2pQ9xYt4HcD',
  scope: 'region:rG7mK2pQ9xYt4HcD',
  uri: 'https://docs.example.com/v1',
  'uri-reference': '/documents/0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10',
  sha256: '9c1f'.repeat(16),
  version: '1.0',
  name: 'presence',
  language: 'en-GB',
};

const named = new Map(DEP1.shapes.map((s) => [s.name, s.shape]));

function str(s: StringShape): string {
  if (s.enum) return s.enum[0]!;
  if (s.known) return s.known[0]!;
  if (s.format) return FORMAT[s.format] ?? 'x';
  if (s.pattern) {
    const re = new RegExp(s.pattern, 'u');
    const found = ['everyone', 'x', 'a1', 'body'].find((c) => re.test(c));
    if (found) return found;
  }
  return 'x'.repeat(Math.max(1, s.minLength ?? 1));
}

/** An example value of a shape: `min` has the required members only, `max` every member. */
export function example(shape: Shape, mode: 'min' | 'max', depth = 0): unknown {
  if (depth > 24) throw new Error('example nesting too deep');
  switch (shape.kind) {
    case 'string':
      return str(shape);
    case 'integer':
      return Math.min(Math.max(shape.min ?? 0, 0), shape.max ?? Number.MAX_SAFE_INTEGER);
    case 'boolean':
      return true;
    case 'const':
      return shape.value;
    case 'array': {
      const n = mode === 'min' ? (shape.minItems ?? 0) : Math.max(1, shape.minItems ?? 0);
      return Array.from({ length: n }, () => example(shape.items, mode, depth + 1));
    }
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, p] of Object.entries(shape.props))
        if (p.required === true || mode === 'max') out[k] = example(p.shape, mode, depth + 1);
      for (const [k, p] of Object.entries(shape.props))
        if (
          typeof p.required === 'object' &&
          !(k in out) &&
          out[p.required.if.prop] === p.required.if.equals
        )
          out[k] = example(p.shape, mode, depth + 1);
      return out;
    }
    case 'map':
      return mode === 'min'
        ? {}
        : {
            [shape.keys ? (example(shape.keys, mode, depth + 1) as string) : 'key']: example(
              shape.values,
              mode,
              depth + 1,
            ),
          };
    case 'ref': {
      const target = named.get(shape.name);
      if (!target) throw new Error(`unknown shape ${shape.name}`);
      return example(target, mode, depth + 1);
    }
    case 'anyOf':
      return example(shape.of[0]!, mode, depth + 1);
    case 'nullable':
      return mode === 'min' ? null : example(shape.of, mode, depth + 1);
    case 'any':
      return 'any';
    case 'external': {
      const env = contractDocument();
      return JSON.parse(JSON.stringify(shape.target === 'cdm-doc' ? env.doc : env)) as unknown;
    }
  }
}

export interface MessageFixture {
  t: string;
  dir: string;
  spec: string;
  valid: Array<{ name: string; frame: Record<string, unknown> }>;
  invalid: Array<{ name: string; frame: Record<string, unknown>; fatal: boolean }>;
}

function envelope(m: definition.MessageDef, mode: 'min' | 'max'): Record<string, unknown> {
  const out: Record<string, unknown> = { t: m.t };
  if (m.id === 'required' || mode === 'max') out['id'] = 'm1';
  if (m.re === 'required' || (mode === 'max' && m.re !== 'none')) out['re'] = 'm0';
  if (m.ch === 'required' || (mode === 'max' && m.ch !== 'none')) out['ch'] = 1;
  if (m.payload) out['d'] = example(m.payload, mode);
  return out;
}

/** A required member of the payload, for the invalid fixtures. */
function requiredMember(m: definition.MessageDef): string | null {
  let s = m.payload;
  if (s?.kind === 'ref') s = named.get(s.name) ?? null;
  if (!s || s.kind !== 'object') return null;
  return Object.entries(s.props).find(([, p]) => p.required === true)?.[0] ?? null;
}

/** The message fixtures of every message type of the definition. */
export function messageFixtures(): MessageFixture[] {
  return DEP1.messages.map((m) => {
    const valid = [
      { name: 'required members only', frame: envelope(m, 'min') },
      { name: 'every member', frame: envelope(m, 'max') },
    ];
    const invalid: MessageFixture['invalid'] = [];
    const req = requiredMember(m);
    if (req) {
      const missing = envelope(m, 'min');
      missing['d'] = Object.fromEntries(
        Object.entries(missing['d'] as Record<string, unknown>).filter(([k]) => k !== req),
      );
      invalid.push({ name: `payload member ${req} missing`, frame: missing, fatal: false });
      const wrong = envelope(m, 'min');
      (wrong['d'] as Record<string, unknown>)[req] = { 'x-tck-wrong-type': true };
      invalid.push({ name: `payload member ${req} of the wrong type`, frame: wrong, fatal: false });
    }
    if (m.payload) {
      const noPayload = envelope(m, 'min');
      noPayload['d'] = 'not an object';
      invalid.push({ name: 'payload is not an object', frame: noPayload, fatal: true });
    }
    const badCh = envelope(m, 'max');
    badCh['ch'] = 'one';
    invalid.push({ name: 'envelope ch is not an integer', frame: badCh, fatal: true });
    if (m.id === 'required') {
      const noId = envelope(m, 'min');
      delete noId['id'];
      invalid.push({ name: 'envelope id missing', frame: noId, fatal: false });
    }
    return { t: m.t, dir: m.dir, spec: m.spec, valid, invalid };
  });
}

/**
 * The conversation of 05 §5.9 as a fixture, completed (G53). Placeholders in `$…` are filled in by
 * the replay: `$token`, `$doc`, `$incarnation`, `$s1`, `$s2`, `$s3`, `$commitA`, `$commitB`, the
 * positions `$posLocked` and `$posLockedNext`. Server frames are templates: the replay matches `t`,
 * `re`, `ch` and the members listed in `match`.
 */
export function conversationFixture() {
  return {
    description:
      'The example conversation of 05 §5.9, completed with the members the example leaves out (G53) and replayed in order against a server by the semantics.conversation scenario. A user with a region grant resumes, streams three commits, commits, loses the grant and is rejected.',
    spec: '05 §5.9',
    frames: [
      {
        from: 'C',
        frame: {
          t: 'hello',
          id: '1',
          d: {
            versions: ['1.0'],
            token: '$token',
            client: { name: '@docedit/tck', version: '0.0.0' },
            engines: ['pm-steps/1'],
            cdm: { min: 1, max: 1 },
            features: ['$features'],
          },
        },
      },
      { from: 'S', frame: { t: 'welcome', re: '1', d: { version: '1.0' } }, match: ['d.version'] },
      {
        from: 'C',
        frame: {
          t: 'ch.open',
          id: '2',
          ch: 1,
          d: {
            kind: 'doc',
            doc: '$doc',
            engine: 'pm-steps/1',
            cdm: 1,
            features: ['$features'],
            resume: { seq: '$s0', incarnation: '$incarnation' },
          },
        },
      },
      {
        from: 'S',
        frame: { t: 'ch.opened', re: '2', ch: 1, d: { head: '$s3', catchUp: 'stream' } },
        match: ['d.head', 'd.catchUp'],
      },
      {
        from: 'S',
        frame: {
          t: 'sync.commit',
          ch: 1,
          d: { commits: [{ seq: '$s1' }, { seq: '$s2' }, { seq: '$s3' }] },
        },
        match: ['d.commits.seq'],
      },
      { from: 'S', frame: { t: 'sync.caughtUp', ch: 1, d: { seq: '$s3' } }, match: ['d.seq'] },
      {
        from: 'C',
        frame: {
          t: 'sync.submit',
          id: '3',
          ch: 1,
          d: {
            id: '$commitA',
            base: '$s3',
            steps: [
              {
                stepType: 'replace',
                from: '$posLocked',
                to: '$posLocked',
                slice: { content: [{ type: 'text', text: 'G' }] },
              },
            ],
            origin: 'input',
          },
        },
      },
      {
        from: 'S',
        frame: { t: 'sync.ack', re: '3', ch: 1, d: { id: '$commitA', seq: '$s4', rebased: false } },
        match: ['d.id', 'd.seq', 'd.rebased'],
      },
      { from: 'host', action: 'remove the grant (PATCH /documents/{id}/grants)' },
      {
        from: 'S',
        frame: { t: 'sync.commit', ch: 1, d: { commits: [{ seq: '$s5', kind: 'control' }] } },
        match: ['d.commits.seq', 'd.commits.kind'],
      },
      {
        from: 'S',
        frame: { t: 'perm.changed', ch: 1, d: { asOfSeq: '$s5' } },
        match: ['d.asOfSeq'],
      },
      {
        from: 'C',
        frame: {
          t: 'sync.submit',
          id: '4',
          ch: 1,
          d: {
            id: '$commitB',
            base: '$s4',
            steps: [
              {
                stepType: 'replace',
                from: '$posLocked',
                to: '$posLocked',
                slice: { content: [{ type: 'text', text: 'H' }] },
              },
            ],
          },
        },
      },
      {
        from: 'S',
        frame: {
          t: 'sync.reject',
          re: '4',
          ch: 1,
          d: {
            id: '$commitB',
            code: 'permission_denied',
            action: 'drop',
            head: '$s5',
            scopes: ['$lockedScope'],
          },
        },
        match: ['d.id', 'd.code', 'd.action', 'd.head', 'd.scopes'],
      },
    ],
  };
}

/** Whether a frame passes the codec's validation (for the fixtures' self-check). */
export function codecViolations(frame: Record<string, unknown>): string[] {
  return depCodec()
    .check(frame)
    .map((v) => `${v.path} ${v.message}`);
}
