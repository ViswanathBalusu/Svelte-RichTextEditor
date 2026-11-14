/**
 * The `semantics` profile (PRO-110 criteria 1, 2 and 5): the golden fixtures replayed against a
 * server. The conversation of 05 §5.9 is played in order from its fixture, and the step-semantics
 * fixtures of the engine (generated from the pinned prosemirror-transform release, SYN-002) are
 * submitted as commits: a case the engine applies must be acknowledged with the document whose
 * canonical hash the fixture records; a case it cannot apply must be rejected with invalid_op.
 */
import {
  canonicalNodeText,
  uuid7,
  type CdmEnvelope,
  type JsonNode as ModelNode,
} from '@docedit/model';
import { validate } from '@docedit/model/validate';
import type { ServerMessage } from '@docedit/protocol';
import { KitFailure, check, equal, isObject, jsonEqual } from '../assert.ts';
import { IDS, LOCKED_SCOPE, insertText, posIn } from '../documents.ts';
import { engineDefinition, engineFixture, kitFixture, type ApplyCase } from '../fixtures.ts';
import { sha256Hex } from '../jcs.ts';
import { scenario, type ProfileDef, type ScenarioDef } from '../scenario.ts';
import { acked, join, readContent, submit } from './support.ts';

const s = (def: Omit<ScenarioDef, 'id'> & { id: string }) => scenario('semantics', def);

/**
 * A rejection that the identity rule of 03 §5 makes: a suggestion mark (an `ins` or `del` mark)
 * that does not name the submitting user is refused with permission_denied. The engine fixtures
 * apply such steps without a user, so this refusal is accepted only when the server says exactly
 * that, and never for any other code.
 */
function identityRefusal(d: { code: string; message: string }, steps: readonly unknown[]): boolean {
  return (
    d.code === 'permission_denied' &&
    d.message.includes('a suggestion mark must name the submitting user') &&
    /"type":"(ins|del)"/.test(JSON.stringify(steps))
  );
}

interface ConversationFrame {
  from: 'C' | 'S' | 'host';
  frame?: Record<string, unknown>;
  match?: string[];
  action?: string;
}

/** Replaces `$name` placeholders in a template with bound values. */
function fill(v: unknown, vars: Map<string, unknown>): unknown {
  if (typeof v === 'string' && v.startsWith('$')) {
    if (v === '$features') return '$features';
    if (!vars.has(v)) throw new Error(`the conversation needs ${v}`);
    return vars.get(v);
  }
  if (Array.isArray(v))
    return v.flatMap((x) =>
      x === '$features' ? (vars.get('$features') as unknown[]) : [fill(x, vars)],
    );
  if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, vars)]));
  return v;
}

function at(v: unknown, path: string): unknown {
  let cur: unknown = v;
  for (const p of path.split('.')) {
    if (Array.isArray(cur)) cur = cur.map((x) => (isObject(x) ? x[p] : undefined));
    else cur = isObject(cur) ? cur[p] : undefined;
  }
  return cur;
}

/** Compares a template value with a received one, binding placeholders the server decides. */
function matches(template: unknown, got: unknown, vars: Map<string, unknown>, what: string): void {
  if (typeof template === 'string' && template.startsWith('$')) {
    if (vars.has(template)) jsonEqual(got, vars.get(template), what);
    else vars.set(template, got);
    return;
  }
  if (Array.isArray(template)) {
    check(Array.isArray(got) && got.length === template.length, what, template, got);
    template.forEach((t, i) => matches(t, (got as unknown[])[i], vars, `${what}[${i}]`));
    return;
  }
  jsonEqual(got, template, what);
}

export const SEMANTICS: ProfileDef = {
  id: 'semantics',
  title: 'Golden fixtures replayed: the 05 §5.9 conversation and the step semantics',
  spec: '05 §5.9, §9, §11; 04 §4; SYN-002',
  stories: ['PRO-110'],
  requires: { kind: 'mode', mode: 'authority' },
  scenarios: [
    s({
      id: 'conversation',
      title: 'the conversation of 05 §5.9 is replayed in order from its fixture',
      spec: '05 §5.9; G53',
      needs: { features: ['regions'] },
      covers: {
        messages: [
          'hello',
          'welcome',
          'ch.open',
          'ch.opened',
          'sync.commit',
          'sync.caughtUp',
          'sync.submit',
          'sync.ack',
          'perm.changed',
          'sync.reject',
        ],
      },
      async run(ctx) {
        const fixture = kitFixture<{ frames: ConversationFrame[] }>('messages/conversation.json');
        const sub = ctx.sub('grantee');
        const doc = await ctx.document(undefined, [
          { region: IDS.locked, principal: `user:${sub}`, role: 'editor' },
        ]);
        const owner = await join(ctx, 'owner', doc, 'owner');
        // The grant is a PATCH after creation, so a control commit precedes the conversation; let it
        // land, then take the seq before the owner's first commit as the joiner's resume point.
        await ctx.sleep(300);
        const end = posIn(owner.content.doc, IDS.end);
        let base = (await readContent(ctx, owner.token, doc)).seq;
        const seqs: number[] = [];
        for (const [i, t] of ['a', 'b', 'c'].entries()) {
          base = (await acked(owner.wire, 1, { base, steps: [insertText(end + i, t)] })).seq;
          seqs.push(base);
        }
        const s0 = seqs[0]! - 1;
        const token = await ctx.service.token(sub, { [doc]: 'editor' });
        // The joiner reads the content it resumes from, as 05 §5.2 says, and echoes its view token
        // when the server gives one (D28; D70).
        const pinned = await readContent(ctx, token, doc, s0);
        const vars = new Map<string, unknown>([
          ['$token', token],
          ['$doc', doc],
          ['$incarnation', pinned.incarnation],
          ['$s0', s0],
          ['$commitA', uuid7()],
          ['$commitB', uuid7()],
          ['$posLocked', posIn(pinned.doc, IDS.lockedPara)],
          ['$lockedScope', LOCKED_SCOPE],
          ['$features', ctx.clientFeatures()],
        ]);
        const w = await ctx.connect({ label: 'conversation' });
        let cursor = 0;
        for (const [i, f] of fixture.frames.entries()) {
          if (f.from === 'C') {
            const frame = fill(f.frame, vars) as {
              t: string;
              d?: { resume?: Record<string, unknown> };
            };
            if (frame.t === 'ch.open' && frame.d?.resume && pinned.view !== undefined)
              frame.d.resume['view'] = pinned.view;
            w.send(frame as Record<string, unknown>);
          } else if (f.from === 'host') await ctx.service.setGrants(doc, []);
          else {
            const t = f.frame!['t'] as string;
            const want = f.frame!;
            const found: ServerMessage[] = [];
            if (t === 'sync.commit') {
              const seqs = (at(want, 'd.commits.seq') as unknown[]).length;
              while (
                found.flatMap((m) => (m.t === 'sync.commit' ? m.d.commits : [])).length < seqs
              ) {
                const m = await w.next((x) => x.t === 'sync.commit', `frame ${i}: sync.commit`, {
                  from: cursor,
                });
                cursor = w.messages.indexOf(m) + 1;
                found.push(m);
              }
            } else {
              const m = await w.next(
                (x) => x.t === t && (!('re' in want) || ('re' in x && x.re === want['re'])),
                `frame ${i}: ${t}`,
                { from: cursor },
              );
              cursor = w.messages.indexOf(m) + 1;
              found.push(m);
            }
            const got =
              t === 'sync.commit'
                ? {
                    d: {
                      commits: found.flatMap((m) => (m.t === 'sync.commit' ? m.d.commits : [])),
                    },
                  }
                : found[0];
            for (const path of f.match ?? [])
              matches(at(want, path), at(got, path), vars, `frame ${i} (${t}) ${path} (05 §5.9)`);
          }
        }
        check(
          vars.get('$s1') === s0 + 1,
          'the stream starts after resume.seq',
          s0 + 1,
          vars.get('$s1'),
        );
      },
    }),
    s({
      id: 'steps',
      title:
        'the step-semantics fixtures of the pinned engine release give the same documents through the server',
      spec: '04 §4; 05 §9; SYN-002',
      timeoutMs: 180_000,
      covers: { messages: ['sync.submit', 'sync.ack', 'sync.reject'], errors: ['invalid_op'] },
      async run(ctx) {
        const def = engineDefinition();
        const fx = engineFixture<ApplyCase>('apply');
        equal(fx.engine, def.engine, 'the fixtures belong to the engine definition');
        // A server stores only valid CDM (03 §6), so a fixture document that breaks an invariant
        // cannot be replayed through POST /documents: that is a defect of the fixtures, not of the target.
        for (const [name, d] of Object.entries(fx.docs)) {
          const v = validate({ cdm: 1, requires: [], doc: d } as never);
          if (!v.valid)
            ctx.skip(
              `the engine fixture document "${name}" is not valid CDM (${v.violations
                .slice(0, 2)
                .map((x) => `${x.invariant} ${x.path}`)
                .join('; ')}), so it cannot be created on a server`,
            );
        }
        let applied = 0;
        let refused = 0;
        let identity = 0;
        for (const c of fx.cases) {
          const env = { cdm: 1, requires: [], doc: fx.docs[c.doc] } as unknown as CdmEnvelope;
          const created = await ctx.service.call('POST', '/documents', { body: { content: env } });
          if (created.status !== 201 && created.status !== 200)
            throw new KitFailure(
              `${c.id}: the fixture document is refused`,
              'HTTP 201',
              `HTTP ${created.status} ${created.text.slice(0, 200)}`,
            );
          const doc = (created.json as { id: string }).id;
          const m = await join(ctx, 'engine', doc, 'owner');
          const r = await submit(m.wire, 1, { base: m.content.seq, steps: c.steps as never });
          if (c.expected.ok) {
            const valid = validate({ cdm: 1, requires: [], doc: c.expected.doc } as never).valid;
            if (r.t === 'sync.reject' && !valid) {
              refused++;
              await m.wire.close();
              continue; // the engine applies it, but the result breaks a CDM invariant the authority enforces
            }
            if (r.t === 'sync.reject' && identityRefusal(r.d, c.steps)) {
              // The fixture is identity-blind; the server applies 03 §5 and refuses it. Counted apart.
              identity++;
              refused++;
              await m.wire.close();
              continue;
            }
            if (r.t !== 'sync.ack')
              throw new KitFailure(`${c.id}: steps the engine applies (SYN-002)`, 'sync.ack', r);
            const content = await readContent(ctx, m.token, doc, r.d.seq);
            equal(
              sha256Hex(canonicalNodeText(content.doc as unknown as ModelNode)),
              c.expected.docSha256,
              `${c.id}: the canonical hash of the result (04 §4; 03 §2)`,
            );
            applied++;
          } else {
            if (r.t !== 'sync.reject')
              throw new KitFailure(
                `${c.id}: steps the engine cannot apply`,
                'sync.reject invalid_op',
                r,
              );
            equal(r.d.code, 'invalid_op', `${c.id}: the code of a step that fails (04 §5)`);
            refused++;
          }
          await m.wire.close();
        }
        ctx.note(
          `${fx.cases.length} apply cases of ${def.engine} (${def.library.name} ${def.library.version}): ${applied} applied with the fixture hash, ${refused} refused (${identity} by the identity rule of 03 §5, which the identity-blind fixtures do not model)`,
        );
      },
    }),
  ],
};
