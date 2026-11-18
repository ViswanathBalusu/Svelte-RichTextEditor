/**
 * The `perm-doc` and `perm-region` profiles (PRO-113; 05 §5.5; 07 §4, §5, §9). Document roles and
 * region grants are checked against the authority's capability fixtures, commits inside and outside
 * the writable set are submitted, a grants change is made while a client is connected, and a
 * property test in the style of S3 submits random commits and judges every accepted one with the
 * reference outcome check (PRM-009).
 */
import { DOC_ROLES, type DocRole } from '@docedit/authority';
import fc from 'fast-check';
import { KitFailure, check, equal, excludes, includes, jsonEqual } from '../assert.ts';
import type { ScenarioContext } from '../context.ts';
import {
  IDS,
  LOCKED_SCOPE,
  OPEN_SCOPE,
  contractDocument,
  deleteRange,
  insertText,
  nodeById,
  paragraph,
  posBefore,
  posIn,
  textOf,
  withBody,
  type JsonNode,
} from '../documents.ts';
import { capabilityFixtures, type CapabilityCase } from '../fixtures.ts';
import { judge, permissionState, type OracleGrant } from '../oracle.ts';
import { scenario, type ProfileDef, type ScenarioDef } from '../scenario.ts';
import { PERM_DOC_MATRIX, PERM_REGION_MATRIX } from './perm-matrix.ts';
import {
  acked,
  join,
  opened,
  problemOf,
  readContent,
  rejected,
  submit,
  type Member,
} from './support.ts';

const doc = (def: Omit<ScenarioDef, 'id'> & { id: string }) => scenario('perm-doc', def);
const reg = (def: Omit<ScenarioDef, 'id'> & { id: string }) => scenario('perm-region', def);

const sorted = (caps: readonly string[]) => [...caps].filter((c) => c !== 'fill').sort();

/** The fixture case for a role with no grant, in an active document and a draft region. */
function baseline(role: string, policy: 'inherit' | 'restricted'): CapabilityCase {
  const c = capabilityFixtures().cases.find(
    (x) =>
      x.role === role &&
      x.policy === policy &&
      x.grants.length === 0 &&
      x.documentState === 'active' &&
      !x.workflowActive &&
      x.regionState === 'draft' &&
      x.leaseHolder === null,
  );
  if (!c) throw new KitFailure(`no capability fixture for ${role}, ${policy}`, 'a fixture', null);
  return c;
}

const SECOND = 'rSecond000000001';
const SECOND_PARA = 'pSecond000000001';

/** The contract document with a second restricted region. */
function twoRegions() {
  const env = contractDocument();
  const body = (env.doc as unknown as JsonNode).content!.find((n) => n.type === 'body')!;
  body.content!.splice(body.content!.length - 1, 0, {
    type: 'region',
    attrs: { id: SECOND, title: 'Second', policy: 'restricted' },
    content: [paragraph(SECOND_PARA, 'Second restricted')],
  });
  return env;
}

async function roleCommit(
  ctx: ScenarioContext,
  m: Member,
  id: string,
): Promise<'accepted' | string> {
  const content = await readContent(ctx, m.token, m.doc);
  const r = await submit(m.wire, m.ch, {
    base: content.seq,
    steps: [insertText(posIn(content.doc, id), 'r')],
  });
  if (r.t === 'sync.ack') return 'accepted';
  if (r.t === 'sync.reject') return r.d.code;
  throw new KitFailure(
    'a commit is answered with sync.ack or sync.reject',
    'sync.ack or sync.reject',
    r,
  );
}

export const PERM_DOC: ProfileDef = {
  id: 'perm-doc',
  title: 'Document roles',
  spec: '07 §2, §4, §5; 05 §3.1, §5.5',
  stories: ['PRO-113', 'PRM-057'],
  requires: { kind: 'mode', mode: 'authority' },
  scenarios: [
    ...PERM_DOC_MATRIX,
    doc({
      id: 'access',
      title: 'the access of each document role matches the capability fixtures',
      spec: '07 §2, §4; 05 §5.5; PRM-005',
      covers: { messages: ['ch.opened'] },
      async run(ctx) {
        const d = await ctx.document();
        for (const role of DOC_ROLES) {
          const m = await join(ctx, role, d, role);
          const a = m.opened.access;
          equal(a.docRole, role, `docRole of a ${role}`);
          const inherit = baseline(role, 'inherit');
          const restricted = baseline(role, 'restricted');
          jsonEqual(
            sorted(a.scopes['body'] ?? []),
            sorted(inherit.expected.body),
            `body capabilities of a ${role} (07 §4)`,
          );
          jsonEqual(
            sorted(a.scopes[OPEN_SCOPE] ?? []),
            sorted(inherit.expected.region),
            `an inherit region for a ${role}`,
          );
          jsonEqual(
            sorted(a.scopes[LOCKED_SCOPE] ?? []),
            sorted(restricted.expected.region),
            `a restricted region for a ${role}`,
          );
          if (a.scopes['defs'])
            jsonEqual(
              sorted(a.scopes['defs']),
              sorted(inherit.expected.defs),
              `defs capabilities of a ${role}`,
            );
          else ctx.note('access.scopes lists no defs scope (G43; D11 lists it)');
          await m.wire.close();
        }
      },
    }),
    doc({
      id: 'commits',
      title: 'each role may change exactly the scopes its capabilities allow',
      spec: '07 §5; 05 §5.3',
      covers: {
        messages: ['sync.submit', 'sync.ack', 'sync.reject'],
        errors: ['permission_denied'],
      },
      async run(ctx) {
        for (const role of DOC_ROLES) {
          const d = await ctx.document();
          const m = await join(ctx, role, d, role);
          const cases: Array<[string, string[]]> = [
            [IDS.intro, baseline(role, 'inherit').expected.body],
            [IDS.openPara, baseline(role, 'inherit').expected.region],
            [IDS.lockedPara, baseline(role, 'restricted').expected.region],
          ];
          for (const [id, caps] of cases) {
            const outcome = await roleCommit(ctx, m, id);
            if (caps.includes('edit'))
              equal(outcome, 'accepted', `a ${role} typing in ${id} (edit allowed)`);
            else if (caps.includes('suggest') && !ctx.has('suggest-enforced'))
              ctx.note(
                `a ${role} typing in ${id} got ${outcome}; without suggest-enforced P4 is not checked`,
              );
            else equal(outcome, 'permission_denied', `a ${role} typing in ${id} (no edit: 07 §5)`);
          }
          await m.wire.close();
        }
      },
    }),
    doc({
      id: 'role-change',
      title: 'a refreshed token with another role recomputes access and sends perm.changed',
      spec: '05 §3.1, §5.5',
      covers: { messages: ['auth.refresh', 'auth.ok', 'perm.changed'] },
      async run(ctx) {
        const d = await ctx.document();
        const m = await join(ctx, 'promoted', d, 'viewer');
        const from = m.wire.mark();
        const next = await ctx.service.token(m.sub, { [d]: 'editor' });
        const { reply } = await m.wire.request({ t: 'auth.refresh', d: { token: next } });
        equal(reply.t, 'auth.ok', 'auth.refresh with a token of the same user');
        const perm = await m.wire.nextOf('perm.changed', { from });
        equal(perm.d.docRole, 'editor', 'the new role (05 §3.1)');
        check(
          perm.d.rev > m.opened.access.rev,
          'rev increases',
          `> ${m.opened.access.rev}`,
          perm.d.rev,
        );
        equal(await roleCommit(ctx, m, IDS.intro), 'accepted', 'the new role is in force');
      },
    }),
  ],
};

export const PERM_REGION: ProfileDef = {
  id: 'perm-region',
  title: 'Region grants',
  spec: '07 §1, §3, §4, §9; 05 §5.5',
  stories: ['PRO-113', 'PRM-057'],
  requires: { kind: 'features', features: ['regions'] },
  scenarios: [
    ...PERM_REGION_MATRIX,
    reg({
      id: 'capabilities',
      title:
        'the access for policies, grants, document states and region states matches the capability fixtures',
      spec: '07 §4; PRM-005',
      timeoutMs: 180_000,
      covers: {
        operations: [
          'PATCH /documents/{id}/grants',
          'PUT /documents/{id}/regions/{rid}/state',
          'PATCH /documents/{id}',
        ],
      },
      async run(ctx) {
        const fx = capabilityFixtures();
        const usable = fx.cases.filter(
          (c) =>
            c.policy !== 'confidential' &&
            !c.workflowActive &&
            c.leaseHolder === null &&
            // Grants with a document role (owner, filler) are invalid grants (07 §2): a server refuses
            // them, and the fixtures use them to show that they convey nothing.
            c.grants.every(
              (g) =>
                g.expiresAt === null &&
                // `everyone` on a restricted region is refused (PRM-061); the scenario below checks it.
                !(g.principal === 'everyone' && c.policy === 'restricted') &&
                !g.principal.startsWith('role:') &&
                ['viewer', 'commenter', 'suggester', 'editor'].includes(g.role),
            ),
        );
        // A stratified sample: every role and policy, a spread of grants and states.
        const step = Math.max(1, Math.floor(usable.length / 48));
        const sample = usable.filter((_, i) => i % step === 0);
        // The sample keeps a non-active document state, which the scenario declares (PATCH /documents/{id}).
        const inactive = usable.find((c) => c.documentState !== 'active');
        if (inactive && !sample.some((c) => c.documentState !== 'active')) sample.push(inactive);
        const group = `tck-${ctx.config.run}-group`;
        let checked = 0;
        for (const c of sample) {
          const env = withBody([
            paragraph(IDS.intro, 'Body'),
            {
              type: 'region',
              attrs: { id: fx.region, title: 'R', policy: c.policy },
              content: [paragraph('pRegion000000001', 'Region')],
            },
            paragraph(IDS.end, ''),
          ]);
          const sub = ctx.sub(c.role);
          // The fixture user and its groups become the kit's; other principals stay other people.
          const map = (p: string) =>
            p === `user:${fx.user.sub}`
              ? `user:${sub}`
              : p.startsWith('group:') && fx.user.groups.includes(p.slice(6))
                ? `group:${group}`
                : p.startsWith('group:') || p.startsWith('user:')
                  ? `${p}-${ctx.config.run}`
                  : p;
          const d = await ctx.document(
            env,
            c.grants.map((g) => ({ region: fx.region, principal: map(g.principal), role: g.role })),
          );
          if (c.regionState !== 'draft') {
            const r = await ctx.service.call('PUT', `/documents/${d}/regions/${fx.region}/state`, {
              body: { state: c.regionState },
              headers: { 'if-match': '*' },
            });
            check(r.status === 200, 'PUT region state with a service credential', 200, r.status);
          }
          if (c.documentState !== 'active') await ctx.service.setState(d, c.documentState);
          const token = await ctx.service.token(sub, { [d]: c.role }, { grp: [group] });
          const w = await ctx.connect({ label: c.id });
          await ctx.hello(w, token);
          const o = await opened(ctx, w, 1, d, {});
          const got = o.access.scopes[`region:${fx.region}`] ?? [];
          jsonEqual(
            sorted(got),
            sorted(c.expected.region),
            `${c.id} (${c.name}): region capabilities`,
          );
          jsonEqual(
            sorted(o.access.scopes['body'] ?? []),
            sorted(c.expected.body),
            `${c.id} (${c.name}): body capabilities`,
          );
          await w.close();
          checked++;
        }
        ctx.note(
          `${checked} of ${fx.cases.length} fixture cases checked (confidential, workflow, lease and expiring cases need other features)`,
        );
      },
    }),
    reg({
      id: 'inside-outside',
      title:
        'a grantee may edit inside the granted region; outside it the commit is permission_denied with the scopes',
      spec: '07 §1, §5; 05 §5.3',
      covers: { errors: ['permission_denied'], fields: ['sync.reject.scopes'] },
      async run(ctx) {
        const sub = ctx.sub('grantee');
        const d = await ctx.document(twoRegions(), [
          { region: IDS.locked, principal: `user:${sub}`, role: 'editor' },
        ]);
        const token = await ctx.service.token(sub, { [d]: 'editor' });
        const w = await ctx.connect({ label: 'grantee' });
        await ctx.hello(w, token);
        const content = await readContent(ctx, token, d);
        const o = await opened(ctx, w, 1, d, {
          resume: {
            seq: content.seq,
            incarnation: content.incarnation,
            ...(content.view ? { view: content.view } : {}),
          },
        });
        includes(o.access.scopes[LOCKED_SCOPE], 'edit', 'the grant gives edit in the region');
        excludes(
          o.access.scopes[`region:${SECOND}`],
          'edit',
          'no edit in the other restricted region',
        );
        const inside = await acked(w, 1, {
          base: content.seq,
          steps: [insertText(posIn(content.doc, IDS.lockedPara), 'in')],
        });
        check(
          inside.seq > content.seq,
          'the commit inside is stored',
          `> ${content.seq}`,
          inside.seq,
        );
        // Positions of the content read before; the server rebases them over the commit inside.
        const r = await rejected(w, 1, {
          base: content.seq,
          steps: [insertText(posIn(content.doc, SECOND_PARA), 'out')],
        });
        equal(r.code, 'permission_denied', 'outside the granted region');
        includes(r.scopes, `region:${SECOND}`, 'the rejection names the region (05 §5.3)');
        excludes(r.scopes, LOCKED_SCOPE, 'and not the granted one');
      },
    }),
    reg({
      id: 'everyone-restricted',
      title:
        'a grant to everyone on a restricted region is validation_failed and stores nothing; a named user is accepted',
      spec: '07 §1, §17; PRM-061; owner decision 12 of 2026-11-15',
      covers: {
        operations: ['PATCH /documents/{id}/grants'],
        errors: ['validation_failed'],
      },
      async run(ctx) {
        const d = await ctx.document(twoRegions());
        const read = await ctx.service.call('GET', `/documents/${d}/grants`);
        const etag = read.headers.get('etag') ?? '*';
        const refused = await ctx.service.call('PATCH', `/documents/${d}/grants`, {
          body: { grants: [{ region: IDS.locked, principal: 'everyone', role: 'editor' }] },
          headers: { 'if-match': etag },
        });
        equal(
          problemOf(refused, 'everyone on a restricted region').code,
          'validation_failed',
          'code',
        );
        equal(refused.status, 400, 'the HTTP status of validation_failed (D61)');
        const after = await ctx.service.call('GET', `/documents/${d}/grants`);
        equal(
          after.headers.get('etag') ?? '*',
          etag,
          'nothing was stored: the revision is unchanged',
        );
        jsonEqual((after.json as { grants?: unknown }).grants, [], 'nothing was stored: no grant');
        // The same region takes a named user (07 §1).
        const sub = ctx.sub('named');
        await ctx.service.setGrants(d, [
          { region: IDS.locked, principal: `user:${sub}`, role: 'editor' },
        ]);
      },
    }),
    reg({
      id: 'grants-change',
      title:
        'a grants change sends a control commit, then perm.changed with a higher rev; the old rights no longer apply',
      spec: '05 §5.5, §5.9, §6.2; 07 §9; D12',
      covers: {
        messages: ['perm.changed', 'sync.commit'],
        operations: ['GET /documents/{id}/grants', 'PATCH /documents/{id}/grants'],
      },
      async run(ctx) {
        const d = await ctx.document();
        const m = await join(ctx, 'changing', d, 'editor');
        excludes(m.opened.access.scopes[LOCKED_SCOPE], 'edit', 'no grant yet');
        const from = m.wire.mark();
        const g = await ctx.service.setGrants(d, [
          { region: IDS.locked, principal: `user:${m.sub}`, role: 'editor' },
        ]);
        check(
          typeof g.rev === 'number',
          'PATCH answers with the grants revision (D63)',
          'a number',
          g,
        );
        const perm = await m.wire.nextOf('perm.changed', { from });
        check(
          perm.d.rev > m.opened.access.rev,
          'rev increases (05 §5.5)',
          `> ${m.opened.access.rev}`,
          perm.d.rev,
        );
        includes(perm.d.scopes[LOCKED_SCOPE], 'edit', 'the new grant');
        const control = m.wire.messages
          .slice(from)
          .flatMap((x) => (x.t === 'sync.commit' ? x.d.commits : []))
          .find((c) => c.kind === 'control');
        check(
          control,
          'a control commit records the grants change (07 §9)',
          'a control commit',
          m.wire.summary(from),
        );
        equal(perm.d.asOfSeq, control.seq, 'asOfSeq is the control commit (D12)');
        const controlAt = m.wire.messages.findIndex(
          (x) => x.t === 'sync.commit' && x.d.commits.includes(control),
        );
        check(
          controlAt < m.wire.messages.indexOf(perm),
          'the control commit precedes perm.changed (05 §5.9; PRO-033)',
          'control first',
          m.wire.summary(from),
        );
        const inside = await acked(m.wire, 1, {
          base: control.seq,
          steps: [insertText(posIn(m.content.doc, IDS.lockedPara), 'g')],
        });
        const from2 = m.wire.mark();
        await ctx.service.setGrants(d, []);
        await m.wire.nextOf('perm.changed', { from: from2 });
        const r = await rejected(m.wire, 1, {
          base: inside.seq,
          steps: [insertText(posIn(m.content.doc, IDS.lockedPara), 'h')],
        });
        equal(r.code, 'permission_denied', 'a commit under the old rights is rejected');
      },
    }),
    reg({
      id: 'property',
      title:
        'random commits by users of every role: no accepted commit changes a scope outside the writable set',
      spec: '07 §5; 11 §2 (S3); PRM-009',
      timeoutMs: 240_000,
      covers: { messages: ['sync.submit'] },
      async run(ctx) {
        const targets = [IDS.intro, IDS.openPara, IDS.mid, IDS.lockedPara, IDS.end];
        const target = fc.constantFrom(...targets);
        const op = fc.oneof(
          fc.record({
            kind: fc.constant('insert' as const),
            at: target,
            offset: fc.nat(14),
            text: fc.string({ minLength: 1, maxLength: 3 }),
          }),
          fc.record({
            kind: fc.constant('delete' as const),
            at: target,
            offset: fc.nat(14),
            len: fc.integer({ min: 1, max: 6 }),
          }),
          fc.record({
            kind: fc.constant('bold' as const),
            at: target,
            offset: fc.nat(10),
            len: fc.integer({ min: 1, max: 5 }),
          }),
          fc.record({
            kind: fc.constant('policy' as const),
            value: fc.constantFrom('inherit', 'restricted'),
          }),
          fc.record({ kind: fc.constant('across' as const), from: target, to: target }),
        );
        const grant = fc.record({
          region: fc.constantFrom(IDS.locked, IDS.open),
          role: fc.constantFrom('viewer', 'commenter', 'suggester', 'editor' as const),
        });
        let accepted = 0;
        let submitted = 0;
        await fc
          .assert(
            fc.asyncProperty(
              fc.constantFrom(...DOC_ROLES),
              fc.array(grant, { maxLength: 2 }),
              fc.array(op, { minLength: 1, maxLength: 5 }),
              async (role: DocRole, grants, ops) => {
                const sub = ctx.sub(`p-${role}`);
                const uniq = grants.filter(
                  (g, i) => grants.findIndex((h) => h.region === g.region) === i,
                );
                const oracleGrants: OracleGrant[] = uniq.map((g) => ({
                  region: g.region,
                  principal: `user:${sub}`,
                  role: g.role,
                }));
                const d = await ctx.document(contractDocument(), oracleGrants);
                const token = await ctx.service.token(sub, { [d]: role });
                const w = await ctx.connect({ label: `property-${role}` });
                try {
                  await ctx.hello(w, token);
                  const o = await opened(ctx, w, 1, d, {});
                  let head = o.head;
                  const perms = permissionState(oracleGrants);
                  for (const x of ops) {
                    const before = await ctx.service.call('GET', `/documents/${d}/content`);
                    const cur = (before.json as { doc: unknown; seq: number }).doc;
                    head = (before.json as { seq: number }).seq;
                    const steps = buildSteps(cur, x);
                    if (!steps) continue;
                    submitted++;
                    const r = await submit(w, 1, { base: head, steps });
                    if (r.t !== 'sync.ack') continue;
                    accepted++;
                    const after = await ctx.service.call('GET', `/documents/${d}/content`, {
                      query: { seq: r.d.seq },
                    });
                    const verdict = judge(
                      cur,
                      (after.json as { doc: unknown }).doc,
                      { sub, role },
                      perms,
                    );
                    if (!verdict.ok)
                      throw new KitFailure(
                        `an accepted commit is outside the writable set of a ${role} (07 §5)`,
                        'the reference outcome check accepts it',
                        {
                          role,
                          grants: uniq,
                          steps,
                          changed: verdict.changed,
                          oracle: verdict.reason,
                        },
                      );
                  }
                } finally {
                  await w.close();
                }
              },
            ),
            {
              seed: ctx.config.property.seed,
              numRuns: ctx.config.property.runs,
              endOnFailure: true,
            },
          )
          .catch((e: unknown) => {
            throw propertyFailure(e, ctx.config.property.seed);
          });
        ctx.note(
          `seed ${ctx.config.property.seed}, ${ctx.config.property.runs} runs: ${submitted} commits submitted, ${accepted} accepted and judged`,
        );
        check(submitted > 0, 'the property submitted commits', '> 0', submitted);
      },
    }),
  ],
};

/**
 * The failure of a property run as the report shows it. fast-check wraps the error of the failing
 * run (its `cause`) in a message that starts with the replay parameters and the counterexample and
 * ends with that error; the inner failure is kept whole and the replay parameters are added, so the
 * counterexample can be replayed with `property.seed` (and fast-check's `path`).
 */
export function propertyFailure(e: unknown, seed: number): KitFailure {
  const msg = e instanceof Error ? e.message : String(e);
  const replay = /\{ seed: [^}]*\}/.exec(msg)?.[0] ?? `{ seed: ${seed} }`;
  const cause = e instanceof Error ? e.cause : undefined;
  const kit = e instanceof KitFailure ? e : cause instanceof KitFailure ? cause : null;
  if (kit) {
    kit.message = `${kit.message} (property ${replay})`;
    return kit;
  }
  const counterexample = /Counterexample: (.*)/.exec(msg)?.[1] ?? '';
  const inner =
    cause instanceof Error
      ? `${cause.name}: ${cause.message}`
      : (/Got error: ([\s\S]*)$/.exec(msg)?.[1] ?? msg);
  return new KitFailure(
    `the property failed (property ${replay}): ${inner.slice(0, 600)}`,
    'every accepted commit within the writable set, and no error in the kit',
    counterexample || msg.slice(-1500),
  );
}

export type Op =
  | { kind: 'insert'; at: string; offset: number; text: string }
  | { kind: 'delete'; at: string; offset: number; len: number }
  | { kind: 'bold'; at: string; offset: number; len: number }
  | { kind: 'policy'; value: string }
  | { kind: 'across'; from: string; to: string };

/**
 * Steps for one random operation on the current document, or null when it cannot apply. An earlier
 * accepted commit of the same run may have removed the node an operation names (an `across` delete
 * removes the paragraphs and regions between its ends), so such an operation is skipped.
 */
export function buildSteps(cur: unknown, x: Op) {
  const named = x.kind === 'policy' ? [IDS.locked] : x.kind === 'across' ? [x.from, x.to] : [x.at];
  if (named.some((id) => nodeById(cur, id) === null)) return null;
  const len = (id: string) => textOf(cur, id).length;
  switch (x.kind) {
    case 'insert':
      return [insertText(posIn(cur, x.at, Math.min(x.offset, len(x.at))), x.text)];
    case 'delete': {
      const n = len(x.at);
      if (n === 0) return null;
      const from = Math.min(x.offset, n - 1);
      return [deleteRange(posIn(cur, x.at, from), posIn(cur, x.at, Math.min(n, from + x.len)))];
    }
    case 'bold': {
      const n = len(x.at);
      if (n === 0) return null;
      const from = Math.min(x.offset, n - 1);
      return [
        {
          stepType: 'addMark',
          mark: { type: 'bold' },
          from: posIn(cur, x.at, from),
          to: posIn(cur, x.at, Math.min(n, from + x.len)),
        },
      ];
    }
    case 'policy':
      return [
        { stepType: 'attr', pos: posBefore(cur, IDS.locked), attr: 'policy', value: x.value },
      ];
    case 'across': {
      const a = posIn(cur, x.from, 0);
      const b = posIn(cur, x.to, len(x.to));
      if (a >= b) return null;
      return [deleteRange(a, b)];
    }
  }
}
