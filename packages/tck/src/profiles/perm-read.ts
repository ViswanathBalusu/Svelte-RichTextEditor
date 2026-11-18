/**
 * The `perm-read` profile (PRO-131; ADR 0019, proposed; spike S12): read restrictions by projection.
 * Unique canary strings are placed in a confidential region (its text and its title); the leak
 * oracle scans every frame and every REST response delivered to readers without access, as S12's
 * oracle scans every outgoing message. Grant changes during the run must bring readers to the
 * projection of their new class, and a reader's commit that touches the placeholder is refused.
 *
 * DEP has no feature name for read restrictions yet (G101, PRO-130); the kit maps the profile to
 * `read-restrictions` unless configured otherwise (ADR 0042).
 */
import { uuid7 } from '@docedit/model';
import { KitFailure, check } from '../assert.ts';
import type { ScenarioContext } from '../context.ts';
import { IDS, contractDocument, deleteRange, posBefore, type JsonNode } from '../documents.ts';
import { scenario, type ProfileDef, type ScenarioDef } from '../scenario.ts';
import { FIELD_IDS, fieldsDocument } from './fields.ts';
import { ASSET_EVENT_WAIT_MS, PNG, upload } from './jobs.ts';
import { join, openChannel, readContent, submit, type Member } from './support.ts';

const r = (def: Omit<ScenarioDef, 'id'> & { id: string }) => scenario('perm-read', def);

/** A leak oracle: every text a reader receives, scanned for canaries. */
export class LeakOracle {
  readonly canaries: string[];
  readonly leaks: Array<{ reader: string; where: string; canary: string; excerpt: string }> = [];
  scanned = 0;

  constructor(canaries: readonly string[]) {
    this.canaries = [...canaries];
  }

  /**
   * While true, the REST responses seen on the wire are not scanned: the readers' observers see
   * every response about the document, the owner's calls included, and those carry the secret on
   * purpose. Frames to readers are always scanned. The scenario runs one REST call at a time.
   */
  ownerCalls = false;

  /** Watches one more canary, for a secret that exists only from now on (an asset, say). */
  watch(canary: string): void {
    if (!this.canaries.includes(canary)) this.canaries.push(canary);
  }

  scan(reader: string, where: string, text: string): void {
    this.scanned++;
    for (const c of this.canaries) {
      const at = text.indexOf(c);
      if (at >= 0)
        this.leaks.push({
          reader,
          where,
          canary: c,
          excerpt: text.slice(Math.max(0, at - 40), at + c.length + 40),
        });
    }
  }

  /** Fails with the first leak, if any. */
  assertClean(): void {
    if (this.leaks.length)
      throw new KitFailure(
        `hidden content reached a reader without access (${this.leaks.length} times; ADR 0019)`,
        'no canary in anything sent to a reader without access',
        this.leaks.slice(0, 3),
      );
  }
}

function confidentialDocument(canaries: { text: string; title: string }) {
  const env = contractDocument();
  const body = (env.doc as unknown as JsonNode).content!.find((n) => n.type === 'body')!;
  const region = body.content!.find((n) => n.attrs?.['id'] === IDS.locked)!;
  region.attrs = { ...region.attrs, policy: 'confidential', title: `Secret ${canaries.title}` };
  region.content = [
    {
      type: 'paragraph',
      attrs: { id: IDS.lockedPara },
      content: [{ type: 'text', text: `Confidential ${canaries.text}` }],
    },
  ];
  return env;
}

/** A reader whose every frame and REST response goes through the oracle. */
async function watchedReader(
  ctx: ScenarioContext,
  oracle: LeakOracle,
  name: string,
  doc: string,
  role: 'viewer' | 'editor',
): Promise<Member> {
  const { sub, token } = await ctx.token(name, { [doc]: role });
  const stop = ctx.target.http.observe((res) => {
    if (res.url.includes(doc) && !oracle.ownerCalls)
      oracle.scan(name, `${res.method} ${new URL(res.url).pathname}`, res.text);
  });
  ctx.defer(stop);
  const wire = await ctx.connect({
    label: name,
    observe: (dir, text) => dir === 'in' && oracle.scan(name, 'websocket', text),
  });
  const welcome = await ctx.hello(wire, token);
  const content = await readContent(ctx, token, doc);
  const resume: { seq: number; incarnation: string; view?: string } = {
    seq: content.seq,
    incarnation: content.incarnation,
  };
  if (content.view !== undefined) resume.view = content.view;
  const o = await openChannel(ctx, wire, 1, doc, { resume });
  if (o.t !== 'ch.opened') throw new KitFailure('the reader opens the document', 'ch.opened', o);
  return { sub, token, wire, welcome, content, opened: o.d, ch: 1, doc };
}

function canaries() {
  const tag = uuid7().replace(/-/g, '').slice(-12).toUpperCase();
  return { text: `CANARYTEXT${tag}`, title: `CANARYTITLE${tag}`, typed: `CANARYTYPED${tag}` };
}

/** How long the owner's CDM export may take to end, ms. */
const EXPORT_WAIT_MS = 60_000;

/**
 * Requests a CDM export as `token` and follows its job for up to `waitMs` (0: not at all). Each
 * response the job exchanges is handed to `scan`. The delivered file's text is returned when the
 * job completes; otherwise `text` is null and `state` says how the job ended (`refused`, `queued`
 * when not awaited, `timeout`, `failed` or `cancelled`).
 */
async function exportAs(
  ctx: ScenarioContext,
  token: string,
  doc: string,
  scan: (where: string, text: string) => void,
  waitMs: number,
): Promise<{ state: string; text: string | null }> {
  const res = await ctx.service.as(token, 'POST', `/documents/${doc}/exports`, {
    body: { target: 'cdm' },
  });
  scan('POST /documents/{id}/exports', res.text);
  if (res.status !== 202)
    return { state: `refused: HTTP ${res.status} ${res.text.slice(0, 160)}`, text: null };
  if (waitMs <= 0) return { state: 'queued', text: null };
  const id = (res.json as { id: string }).id;
  const until = Date.now() + waitMs;
  for (;;) {
    const got = await ctx.service.as(token, 'GET', `/exports/${id}`);
    scan('GET /exports/{jid}', got.text);
    const job = got.json as { state: string; result: { url: string } | null };
    if (job.state === 'completed' && job.result) {
      const file = await fetch(job.result.url);
      const text = await file.text();
      scan('export file', text);
      return { state: job.state, text };
    }
    if (job.state === 'failed' || job.state === 'cancelled')
      return { state: job.state, text: null };
    if (Date.now() > until) return { state: 'timeout', text: null };
    await ctx.sleep(200);
  }
}

/**
 * Uploads a one-pixel image as the owner, waits until its signed URL resolves, and puts an image of
 * it into the confidential paragraph. The asset identifier and the path of its signed URL become
 * canaries. Returns the identifier, or null when the upload cannot be made. The owner resolves the asset (so the secret is real); a
 * resolution that never succeeds fails the scenario.
 */
async function placeAsset(
  ctx: ScenarioContext,
  oracle: LeakOracle,
  owner: Member,
  doc: string,
  lastAck: Awaited<ReturnType<typeof submit>>,
): Promise<string | null> {
  let asset: string;
  try {
    asset = await upload(ctx, owner.token, doc, PNG, 'image/png');
  } catch (e) {
    // A target that announces assets but cannot take an upload from the kit (no object store
    // behind the upload URL, say): the asset branch is unproven, as the export branch is when its
    // queue is not served. The `assets` profile fails such a target on its own account.
    ctx.note(
      `asset branch unproven: the upload did not complete (${e instanceof Error ? e.message : String(e)})`,
    );
    return null;
  }
  oracle.watch(asset);
  const until = Date.now() + ASSET_EVENT_WAIT_MS;
  let url: string | null = null;
  for (;;) {
    // A fresh token each round: the check can outlast a short token (05 §3.1).
    const token = await ctx.service.token(owner.sub, { [doc]: 'owner' });
    const res = await ctx.service.as(token, 'POST', `/documents/${doc}/assets/resolve`, {
      body: { assets: [asset] },
    });
    const found = ((res.json as { assets?: Array<{ url: string }> }).assets ?? [])[0];
    if (res.status === 200 && found) {
      url = found.url;
      break;
    }
    if (Date.now() > until) break;
    await ctx.sleep(250);
  }
  if (url === null)
    throw new KitFailure(
      'the owner resolves the uploaded asset (the secret is real)',
      'a signed URL within the wait',
      `none after ${ASSET_EVENT_WAIT_MS} ms`,
    );
  // The path of the URL names the stored object: a second thing a reader must never receive.
  const path = new URL(url).pathname;
  if (path.length > 8) oracle.watch(path);
  const base = lastAck.t === 'sync.ack' ? lastAck.d.seq : owner.content.seq;
  const placed = await submit(owner.wire, 1, {
    base,
    steps: [
      {
        stepType: 'replace',
        from: posBefore(owner.content.doc, IDS.lockedPara) + 1,
        to: posBefore(owner.content.doc, IDS.lockedPara) + 1,
        slice: { content: [{ type: 'image', attrs: { asset, width: 1, height: 1 } }] },
      },
    ],
  });
  check(
    placed.t === 'sync.ack',
    'the owner may place an image in the confidential region',
    'sync.ack',
    placed,
  );
  ctx.note('asset branch proven: the owner resolves the asset and it is placed in the region');
  return asset;
}

/** A field that only some people may read, holding a canary as its value. */
function hiddenValueDocument(value: string) {
  const env = fieldsDocument();
  const root = env.doc as unknown as JsonNode;
  const body = root.content!.find((n) => n.type === 'body')!;
  const para = body.content!.find((n) => n.attrs?.['id'] === FIELD_IDS.para)!;
  const field = para.content!.find((n) => n.attrs?.['id'] === FIELD_IDS.name)!;
  field.attrs = { ...field.attrs, sensitive: true, value };
  return env;
}

export const PERM_READ: ProfileDef = {
  id: 'perm-read',
  title: 'Read restrictions by projection',
  spec: 'ADR 0019; 05 §5.2, §5.3, §6.2',
  stories: ['PRO-131'],
  requires: { kind: 'features', features: ['$readRestrictions'] },
  scenarios: [
    r({
      id: 'leak',
      title:
        'nothing of a confidential region reaches a reader without access: frames, content, regions, exports',
      spec: 'ADR 0019 (what leaks); S12 leak oracle',
      timeoutMs: 240_000,
      // Only what every run exercises. The export branch runs only where the target announces
      // `exports`, which a service without an export worker need not do (the reference service in
      // memory does not), so its routes are declared by the `exports` profile and `authz.export`,
      // not here (PRO-117).
      covers: {
        messages: ['sync.commit', 'ch.opened', 'presence.update'],
        operations: ['GET /documents/{id}/content', 'GET /documents/{id}/regions'],
      },
      async run(ctx) {
        const c = canaries();
        const oracle = new LeakOracle([c.text, c.title, c.typed]);
        const doc = await ctx.document(confidentialDocument(c));
        const owner = await join(ctx, 'owner', doc, 'owner');
        const plain = await watchedReader(ctx, oracle, 'editor-without-grant', doc, 'editor');
        const viewer = await watchedReader(ctx, oracle, 'viewer-without-grant', doc, 'viewer');
        check(
          JSON.stringify(owner.content.doc).includes(c.text),
          'the owner sees the confidential region (the canary is real)',
          c.text,
          'missing',
        );
        // The owner types more secret text and points a selection into the region.
        const pos = posBefore(owner.content.doc, IDS.lockedPara) + 2;
        const typed = await submit(owner.wire, 1, {
          base: owner.content.seq,
          steps: [
            {
              stepType: 'replace',
              from: pos,
              to: pos,
              slice: { content: [{ type: 'text', text: c.typed }] },
            },
          ],
        });
        check(
          typed.t === 'sync.ack',
          'the owner may type in the confidential region',
          'sync.ack',
          typed,
        );
        if (ctx.has('presence'))
          owner.wire.send({
            t: 'presence.update',
            ch: 1,
            d: {
              seq: owner.content.seq,
              state: {
                selection: { anchor: pos, head: pos + 4 },
                scope: `region:${IDS.locked}`,
                status: 'active',
              },
            },
          });
        await ctx.sleep(1000);
        // Exports (when announced): the owner's export must deliver the region, which shows the
        // canary is real in exports too. When it does not (a service whose export queue is not
        // served), the export branch is unproven and the report says so; readers are not waited for.
        let delivered = false;
        if (ctx.has('exports')) {
          const own = await exportAs(ctx, owner.token, doc, () => undefined, EXPORT_WAIT_MS);
          delivered = own.text !== null;
          if (own.text !== null) {
            check(
              own.text.includes(c.text),
              'the owner export carries the confidential region (the canary is real in exports)',
              c.text,
              'missing',
            );
            ctx.note(
              'export branch proven: the owner export delivers the region; readers exports are scanned',
            );
          } else ctx.note(`export branch unproven: the owner's export ended ${own.state}`);
        }
        // Assets (when announced): an image of an uploaded asset in the confidential region. The
        // owner resolves it to a signed URL (so the secret is real); readers without access must
        // get neither the identifier nor the URL, in content, in a resolution or anywhere else.
        let asset: string | null = null;
        if (ctx.has('assets')) {
          oracle.ownerCalls = true;
          try {
            asset = await placeAsset(ctx, oracle, owner, doc, typed);
          } finally {
            oracle.ownerCalls = false;
          }
        }
        for (const [name, m] of [
          ['editor-without-grant', plain],
          ['viewer-without-grant', viewer],
        ] as const) {
          await readContent(ctx, m.token, doc);
          await ctx.service.as(m.token, 'GET', `/documents/${doc}/regions`);
          if (asset !== null) {
            const res = await ctx.service.as(m.token, 'POST', `/documents/${doc}/assets/resolve`, {
              body: { assets: [asset] },
            });
            oracle.scan(name, 'POST /documents/{id}/assets/resolve', res.text);
            check(
              res.status === 200 &&
                ((res.json as { assets?: unknown[] }).assets ?? []).length === 0,
              `${name}: an asset of a confidential region is not resolved`,
              '200 with no asset',
              `HTTP ${res.status} ${res.text.slice(0, 200)}`,
            );
            ctx.note(`${name}: asset resolution scanned, nothing resolved`);
          }
          if (ctx.has('exports')) {
            const sent = await exportAs(
              ctx,
              m.token,
              doc,
              (where, text) => oracle.scan(name, where, text),
              delivered ? EXPORT_WAIT_MS : 0,
            );
            // Says what reached the reader, so that a delivered file is visibly scanned.
            ctx.note(
              `${name}: export ${sent.text === null ? sent.state : 'delivered and scanned'}`,
            );
          }
        }
        oracle.assertClean();
        ctx.note(`${oracle.scanned} frames and responses scanned`);
      },
    }),
    r({
      id: 'converge',
      title: 'a grant change brings a connected reader to the projection of its new class',
      spec: 'ADR 0019 item 6, change 2; G103',
      timeoutMs: 90_000,
      covers: { messages: ['ch.closed'], operations: ['PATCH /documents/{id}/grants'] },
      async run(ctx) {
        const c = canaries();
        const doc = await ctx.document(confidentialDocument(c));
        const oracle = new LeakOracle([c.text]);
        const reader = await watchedReader(ctx, oracle, 'reader', doc, 'viewer');
        oracle.assertClean();
        const from = reader.wire.mark();
        await ctx.service.setGrants(doc, [
          { region: IDS.locked, principal: `user:${reader.sub}`, role: 'viewer' },
        ]);
        await reader.wire.nextOf('ch.closed', { from, ch: 1 });
        const after = await readContent(ctx, reader.token, doc);
        check(
          JSON.stringify(after.doc).includes(c.text),
          'with a read grant the reader sees the region',
          c.text,
          'missing',
        );
        await ctx.service.setGrants(doc, []);
        const again = await readContent(ctx, reader.token, doc);
        check(
          !JSON.stringify(again.doc).includes(c.text),
          'without it the projection hides it again',
          'no canary',
          'canary present',
        );
      },
    }),
    r({
      id: 'hidden-value',
      title:
        'the value of a sensitive field never reaches a reader without access, and a reader cannot change it',
      spec: 'ADR 0019 (hidden field values, change 5); 12 §3.2',
      needs: { features: ['fields'] },
      timeoutMs: 90_000,
      covers: {
        messages: ['sync.reject'],
        operations: ['GET /documents/{id}/fields', 'GET /documents/{id}/field-values'],
      },
      async run(ctx) {
        const tag = uuid7().replace(/-/g, '').slice(-12).toUpperCase();
        const secret = `CANARYVALUE${tag}`;
        const oracle = new LeakOracle([secret]);
        const doc = await ctx.document(hiddenValueDocument(secret));
        const owner = await join(ctx, 'owner', doc, 'owner');
        check(
          JSON.stringify(owner.content.doc).includes(secret),
          'the owner reads the value (the canary is real)',
          secret,
          'missing',
        );
        const editor = await watchedReader(ctx, oracle, 'editor-without-grant', doc, 'editor');
        const viewer = await watchedReader(ctx, oracle, 'viewer-without-grant', doc, 'viewer');
        for (const [name, m] of [
          ['editor-without-grant', editor],
          ['viewer-without-grant', viewer],
        ] as const) {
          await readContent(ctx, m.token, doc);
          for (const path of ['fields', 'field-values'])
            oracle.scan(
              name,
              `GET /documents/{id}/${path}`,
              (await ctx.service.as(m.token, 'GET', `/documents/${doc}/${path}`)).text,
            );
        }
        // The reader's commit that sets the value of a field it cannot read is refused (ADR 0019
        // change 5), whatever it writes, and the value stays what it was.
        const reply = await submit(editor.wire, 1, {
          base: editor.content.seq,
          steps: [
            {
              stepType: 'attr',
              pos: posBefore(editor.content.doc, FIELD_IDS.name),
              attr: 'value',
              value: 'overwritten by a reader',
            },
          ],
        });
        check(
          reply.t === 'sync.reject',
          'changing the value of a hidden field is refused (ADR 0019 change 5)',
          'sync.reject',
          reply,
        );
        if (reply.t === 'sync.reject') ctx.note(`the refused commit: ${reply.d.code}`);
        // The oracle first: the readers' observers see every response about the document, and the
        // owner's read below legitimately carries the value.
        oracle.assertClean();
        ctx.note(`${oracle.scanned} frames and responses scanned`);
        const after = await readContent(ctx, owner.token, doc);
        check(
          JSON.stringify(after.doc).includes(secret) &&
            !JSON.stringify(after.doc).includes('overwritten by a reader'),
          'the hidden value is unchanged after the refused commit',
          secret,
          'changed',
        );
      },
    }),
    r({
      id: 'placeholder',
      title: "a reader's commit that touches the placeholder is refused",
      spec: 'ADR 0019 change 5',
      covers: { messages: ['sync.reject'] },
      async run(ctx) {
        const c = canaries();
        const doc = await ctx.document(confidentialDocument(c));
        const oracle = new LeakOracle([c.text]);
        const editor = await watchedReader(ctx, oracle, 'editor', doc, 'editor');
        const at = posBefore(editor.content.doc, IDS.locked);
        const reply = await submit(editor.wire, 1, {
          base: editor.content.seq,
          steps: [deleteRange(at, at + 1)],
        });
        check(
          reply.t === 'sync.reject',
          'deleting the placeholder is refused (ADR 0019 change 5)',
          'sync.reject',
          reply,
        );
        oracle.assertClean();
      },
    }),
  ],
};
