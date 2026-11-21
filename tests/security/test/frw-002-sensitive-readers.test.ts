/**
 * FRW-002 criterion 5 — a field value marked `sensitive` is readable exactly by the readers ADR 0019
 * allows, and redacted for everyone else, when the document is opened, synced, compared, exported
 * or read through the API.
 *
 * The readers of a sensitive value (ADR 0019; owner decision 156; ADR 0033 item 7; `canReadValue` of
 * the authority): users with `manage`, participants who hold the field's assignee role, and
 * principals with a grant on the region that holds the field. The document has two sensitive fields
 * and one plain field:
 *
 * - S1, in the body, assigned to the role `tenant`;
 * - S2, in a region, assigned to the role `landlord`;
 * - a field that is not sensitive, which everyone reads (so that no check passes on an empty answer).
 *
 * A participant holds a role in one of two ways, and each is a case of its own here:
 *
 * - form mode, without a workflow (FRW-083): the roles are in the token (the fill roles claim);
 * - a workflow that has been sent: the token names a participant (`wfp`) and the roles are those
 *   the workflow gives that participant, bound by the recorded `sub` (FRW-038).
 *
 * Each case is the whole table of who reads which value, on every surface:
 *
 *   form mode                                              workflow
 *   ann   owner (`manage`)                    S1 and S2    ann   owner                         S1 and S2
 *   tess  filler, token role `tenant`         S1           pat   participant p1 (`tenant`)     S1
 *   lars  filler, token role `landlord`       S2           lou   participant p2 (`landlord`)   S2
 *   gina  viewer, grant on the region of S2   S2           gina  viewer, grant on the region   S2
 *   hana  viewer, group grant on that region  S2           mal   names p1, another `sub`       neither
 *   greg  viewer, grant on another region     neither      ned   names no participant, and
 *   ed    editor (no `manage`)                neither            claims the role in the token  neither
 *   vic   viewer                              neither      ed, vic  as in form mode            neither
 *
 * The service is the real document service with its own default composition (read restrictions on;
 * no `views` option is passed), reached over HTTP and a WebSocket. Exports are built by the real
 * export worker handler in the same process; the PDF is compiled in the Podman sandbox when the
 * worker image is on the machine and its text is read back with `pdftotext` (that case skips, with
 * the reason, without them). Memory storage and, when the test environment is up, PostgreSQL.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { imageFontManifest } from '../../../services/export-worker/src/fonts.ts';
import { createExportHandler } from '../../../services/export-worker/src/job.ts';
import { IMAGE } from '../../../services/export-worker/src/sandbox.ts';
import { sandboxReady } from '../../../services/export-worker/src/sandbox-ready.ts';
import { readTar } from '../../../services/export-worker/src/tar.ts';
import { TEST_FONTS } from '../../../services/export-worker/test/fonts.ts';
import { pdfText, pdftotextAvailable } from '../../../services/export-worker/test/pdf-text.ts';
import {
  documentWithRegions,
  posOf,
  postgresUnavailable,
  startHarness,
  type CallResult,
  type Harness,
  type Storage,
} from './support/harness.ts';
import { WireClient } from './support/wire.ts';

const S1 = 'fSensTenant00001';
const S2 = 'fSensLandlord001';
const PLAIN = 'fPlainField00001';
const KEY = { [S1]: 'tenant.iban', [S2]: 'landlord.account', [PLAIN]: 'plain.ref' } as const;
const SENSITIVE = [S1, S2] as const;
type Sensitive = (typeof SENSITIVE)[number];

/** The values: letters and digits only, so that every export format carries them unchanged. */
const BEFORE: Record<Sensitive, string> = { [S1]: 'SONEAQ7K2M4X', [S2]: 'STWOAT9M4P6Z' };
const AFTER: Record<Sensitive, string> = { [S1]: 'SONEBR8L3N5Y', [S2]: 'STWOBU2N5Q7W' };
const PLAIN_VALUE = 'PLAINV3X8C1D';

const OPEN_REGION = 'rOpen00000000001';
const LEGAL_REGION = 'rLegal0000000001';

interface Reader {
  role: string;
  claims?: Record<string, unknown>;
  reads: readonly Sensitive[];
}

interface Case {
  name: string;
  /** Whether the roles come from a workflow that is sent, and not from the token. */
  workflow: boolean;
  readers: Record<string, Reader>;
  /** The readers by class: those who may read the same values share one projection. */
  classes: string[][];
  /** Who fills each field: the participant who holds its role. */
  authors: Record<Sensitive, string>;
}

const CASES: Case[] = [
  {
    name: 'form mode, roles from the token',
    workflow: false,
    readers: {
      ann: { role: 'owner', reads: [S1, S2] },
      tess: { role: 'filler', claims: { wfr: ['tenant'] }, reads: [S1] },
      lars: { role: 'filler', claims: { wfr: ['landlord'] }, reads: [S2] },
      gina: { role: 'viewer', reads: [S2] },
      hana: { role: 'viewer', claims: { grp: ['payers'] }, reads: [S2] },
      greg: { role: 'viewer', reads: [] },
      ed: { role: 'editor', reads: [] },
      vic: { role: 'viewer', reads: [] },
    },
    classes: [['ann'], ['tess'], ['lars', 'gina', 'hana'], ['greg', 'ed', 'vic']],
    authors: { [S1]: 'tess', [S2]: 'lars' },
  },
  {
    name: 'a sent workflow, roles from the participant binding',
    workflow: true,
    readers: {
      ann: { role: 'owner', reads: [S1, S2] },
      pat: { role: 'filler', claims: { wfp: 'p1' }, reads: [S1] },
      lou: { role: 'filler', claims: { wfp: 'p2' }, reads: [S2] },
      gina: { role: 'viewer', reads: [S2] },
      // The token names participant p1, whose recorded `sub` is pat's: it binds to no one.
      mal: { role: 'filler', claims: { wfp: 'p1' }, reads: [] },
      // The token names no participant of the workflow; the role it claims for itself is not held.
      ned: { role: 'filler', claims: { wfp: 'p9', wfr: ['tenant', 'landlord'] }, reads: [] },
      ed: { role: 'editor', reads: [] },
      vic: { role: 'viewer', reads: [] },
    },
    classes: [['ann'], ['pat'], ['lou', 'gina'], ['mal', 'ned', 'ed', 'vic']],
    authors: { [S1]: 'pat', [S2]: 'lou' },
  },
];

const REDACTED = { redacted: true };
const FEATURES = ['presence', 'regions', 'fields'];

type Json = Record<string, unknown>;

function fixture(): Record<string, unknown> {
  const content = structuredClone(documentWithRegions()) as {
    requires: string[];
    doc: { content: Array<{ type: string; content: Array<Record<string, unknown>> }> };
  };
  content.requires = ['fields'];
  const defs = content.doc.content[0]!.content;
  defs.push(
    { type: 'role_def', attrs: { id: 'tenant', name: 'Tenant', color: '#1F77B4' } },
    { type: 'role_def', attrs: { id: 'landlord', name: 'Landlord', color: '#D62728' } },
  );
  const field = (id: keyof typeof KEY, extra: Record<string, unknown>) => ({
    type: 'form_field',
    attrs: { id, key: KEY[id], kind: 'text', label: KEY[id], ...extra },
  });
  const body = content.doc.content[1]!.content;
  // The body: the sensitive value of the tenant, and the plain value, in a paragraph of their own.
  body.splice(1, 0, {
    type: 'paragraph',
    attrs: { id: 'pIban00000000001', style: 'Normal' },
    content: [
      field(S1, { assignee: 'tenant', sensitive: true, value: BEFORE[S1] }),
      { type: 'text', text: ' and ' },
      field(PLAIN, { assignee: 'tenant', value: PLAIN_VALUE }),
    ],
  });
  // The region: the sensitive value of the landlord.
  const region = body.find((b) => (b['attrs'] as { id?: string }).id === OPEN_REGION) as {
    content: Array<Record<string, unknown>>;
  };
  region.content[0]!['content'] = [
    field(S2, { assignee: 'landlord', sensitive: true, value: BEFORE[S2] }),
  ];
  return content;
}

/** The attributes of the form field `id` in a document's JSON. */
function fieldAttrs(doc: unknown, id: string): Json {
  const visit = (n: unknown): Json | null => {
    const x = n as { type?: string; attrs?: Json; content?: unknown[] } | null;
    if (!x || typeof x !== 'object') return null;
    if (x.type === 'form_field' && x.attrs?.['id'] === id) return x.attrs;
    for (const c of x.content ?? []) {
      const hit = visit(c);
      if (hit) return hit;
    }
    return null;
  };
  const found = visit(doc);
  if (!found) throw new Error(`no field ${id}`);
  return found;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > until) throw new Error(`${what} did not hold within ${timeoutMs} ms`);
    await sleep(20);
  }
}

interface WireCommit {
  seq: number;
  steps: unknown[];
}
const commitsOf = (c: WireClient): WireCommit[] =>
  c.all('sync.commit').flatMap((m) => (m.d?.['commits'] ?? []) as WireCommit[]);

// Probed once, when the file is collected: the compile case is skipped, with the reason, without
// Podman, the worker image or pdftotext.
const sandbox = await sandboxReady();
const noPdf = !sandbox.ok
  ? `no sandbox: ${sandbox.reason}`
  : pdftotextAvailable()
    ? null
    : 'pdftotext is not installed';

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null;
  for (const scenario of CASES) {
    const READERS = scenario.readers;
    const NAMES = Object.keys(READERS);
    const reads = (name: string, field: Sensitive): boolean => READERS[name]!.reads.includes(field);

    describe(`FRW-002 a sensitive value reaches exactly its readers (${storage}; ${scenario.name})`, () => {
      let h: Harness;
      let doc: string;
      /** The head before the two fills, and the `seq` of each fill. */
      let head0 = 0;
      const filled: Record<Sensitive, number> = { [S1]: 0, [S2]: 0 };
      /** The view token of each reader, from the content read. */
      const views: Record<string, string> = {};
      const incarnation = { current: '' };
      /** What the participant of the tenant role read of S1 while the workflow was a draft. */
      let draftRead: unknown;
      const t = () => (skip ? it.skip : it);

      const token = (name: string): string =>
        h.userToken(
          h.a,
          name,
          { [doc]: READERS[name]!.role },
          { claims: READERS[name]!.claims ?? {} },
        );
      const get = (name: string, path: string): Promise<CallResult> =>
        h.call('GET', `/v1/documents/${doc}${path}`, { token: token(name) });

      /**
       * Checks a text a reader received: a value they may read is there (when `present` asks for
       * it), and no value of a field they may not read is there, old or new.
       */
      const expectText = (
        name: string,
        text: string,
        where: string,
        present: Partial<Record<Sensitive, string>> = {},
      ): void => {
        for (const f of SENSITIVE) {
          if (reads(name, f)) {
            const want = present[f];
            if (want !== undefined)
              expect(text, `${where}: ${name} reads ${KEY[f]}`).toContain(want);
          } else
            for (const v of [BEFORE[f], AFTER[f]])
              expect(text, `${where}: ${name} must not get ${KEY[f]}`).not.toContain(v);
        }
      };

      beforeAll(async () => {
        if (skip) return;
        h = await startHarness(storage, {
          jobHandlers: {
            export: createExportHandler({
              stores: {
                get logs() {
                  return h.parts.logs;
                },
                get checkpoints() {
                  return h.service.checkpoints;
                },
                get documents() {
                  return h.parts.documents;
                },
              },
              outputs: { putExport: (a, b, c, d, e) => h.service.assets.putExport(a, b, c, d, e) },
              // A compile needs the fonts of the image; the other targets only name them.
              fonts: async () => (sandbox.ok ? imageFontManifest(IMAGE) : TEST_FONTS),
            }),
          },
          env: {
            DOCEDIT_EXPORT_TARGETS: 'pdf,cdm,tex,html,md',
            DOCEDIT_ASSET_ORIGIN: 'https://assets.tests.example',
            DOCEDIT_ASSET_URL_KEY: `k1:${randomBytes(32).toString('base64')}`,
          },
        });
        doc = await h.createDocument(h.a, fixture());
        const service = { token: h.a.apiKey };
        // The grants: gina by name and hana by her group on the region of S2; greg on another region.
        const etag = (await h.call('GET', `/v1/documents/${doc}/grants`, service)).headers.get(
          'etag',
        )!;
        const granted = await h.call('PATCH', `/v1/documents/${doc}/grants`, {
          ...service,
          headers: { 'If-Match': etag },
          body: {
            grants: [
              { region: OPEN_REGION, principal: 'user:gina', role: 'viewer' },
              { region: OPEN_REGION, principal: 'group:payers', role: 'viewer' },
              { region: LEGAL_REGION, principal: 'user:greg', role: 'viewer' },
            ],
          },
        });
        expect(granted.status, granted.text).toBe(200);
        // Everyone may read the history, so that the comparison and the catch-up answer each reader
        // in their own class and not with a refusal of the history gate (07 section 8; ADR 0034).
        const setting = await h.call('GET', `/v1/documents/${doc}/history-visibility`, service);
        expect(setting.status, setting.text).toBe(200);
        const all = await h.call('PUT', `/v1/documents/${doc}/history-visibility`, {
          ...service,
          headers: { 'If-Match': setting.headers.get('etag')! },
          body: { setting: 'all' },
        });
        expect(all.status, all.text).toBe(200);

        if (scenario.workflow) {
          // Two participants who act at the same time, each bound to a person by `sub`.
          const made = await h.call('PUT', `/v1/documents/${doc}/workflow`, {
            token: token('ann'),
            headers: { 'If-Match': '"0"' },
            body: {
              id: uuid7(),
              doc,
              state: 'draft',
              rev: 0,
              timeZone: 'UTC',
              participants: [
                { id: 'p1', roles: ['tenant'], kind: 'filler', order: 1, sub: 'pat' },
                { id: 'p2', roles: ['landlord'], kind: 'filler', order: 1, sub: 'lou' },
              ],
            },
          });
          expect(made.status, made.text).toBe(201);
          // A draft binds no one: the participant does not read the value of their role yet.
          const early = await get('pat', '/content');
          expect(early.status, early.text).toBe(200);
          draftRead = fieldAttrs(early.json.doc, S1)['value'];
          const sent = await h.call('POST', `/v1/documents/${doc}/workflow/send`, {
            token: token('ann'),
          });
          expect(sent.status, sent.text).toBe(200);
        }
      }, 300_000);
      afterAll(async () => {
        await h?.close();
      }, 60_000);

      (skip || !scenario.workflow ? it.skip : it)(
        'a workflow still in draft gives its participants no role to read with',
        () => {
          expect(draftRead).toEqual(REDACTED);
        },
      );

      t()('opened: the content and the channel of each reader are of their class', async () => {
        for (const name of NAMES) {
          const r = await get(name, '/content');
          expect(r.status, `${name}: ${r.text}`).toBe(200);
          for (const f of SENSITIVE)
            expect(fieldAttrs(r.json.doc, f)['value'], `${name} ${KEY[f]}`).toEqual(
              reads(name, f) ? BEFORE[f] : REDACTED,
            );
          expect(fieldAttrs(r.json.doc, PLAIN)['value']).toBe(PLAIN_VALUE);
          expectText(name, r.text, 'content', BEFORE);
          views[name] = r.json.view as string;

          const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
          try {
            const welcome = await c.hello(token(name), { features: FEATURES });
            expect(welcome.t, JSON.stringify(welcome.d)).toBe('welcome');
            const opened = await c.open(1, doc, { features: FEATURES });
            expect(opened.t, JSON.stringify(opened.d)).toBe('ch.opened');
            // The channel names the class of the content the reader loaded (D70).
            expect(opened.d!['view'], `${name}: view of the channel`).toBe(views[name]);
            expectText(name, c.frames.join('\n'), 'frames of the open');
          } finally {
            c.terminate();
          }
        }
        // Readers of the same values share a class; readers of different values do not.
        for (const members of scenario.classes)
          for (const m of members)
            expect(views[m], `${m} is in its class`).toBe(views[members[0]!]);
        expect(new Set(scenario.classes.map((m) => views[m[0]!])).size).toBe(
          scenario.classes.length,
        );
      });

      t()(
        'synced: a new value reaches the open channels and the catch-up of its readers only',
        async () => {
          const clients: Record<string, WireClient> = {};
          try {
            for (const name of NAMES) {
              const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
              clients[name] = c;
              expect((await c.hello(token(name), { features: FEATURES })).t).toBe('welcome');
              const opened = await c.open(1, doc, { features: FEATURES });
              expect(opened.t, JSON.stringify(opened.d)).toBe('ch.opened');
              head0 = opened.d!['head'] as number;
              incarnation.current = opened.d!['incarnation'] as string;
            }
            const full = (await get('ann', '/content')).json.doc as unknown;
            // Each participant fills the field of their own role. A sensitive value does not move
            // positions, so the position in the full document is the position in every projection.
            const fill = async (name: string, f: Sensitive, base: number): Promise<number> => {
              const ack = await clients[name]!.submit(1, {
                id: uuid7(),
                base,
                steps: [{ stepType: 'attr', pos: posOf(full, f), attr: 'value', value: AFTER[f] }],
              });
              expect(ack.t, `${name} fills ${KEY[f]}: ${JSON.stringify(ack.d)}`).toBe('sync.ack');
              return ack.d!['seq'] as number;
            };
            // A person who may not read a value may not set it either, whatever their role says.
            for (const [name, f] of [
              [scenario.authors[S2], S1],
              ['ed', S1],
            ] as const) {
              const refused = await clients[name]!.submit(1, {
                id: uuid7(),
                base: head0,
                steps: [{ stepType: 'attr', pos: posOf(full, f), attr: 'value', value: 'NOTMINE' }],
              });
              expect(refused.t, `${name} sets ${KEY[f]}`).toBe('sync.reject');
              expectText(name, JSON.stringify(refused.d), 'the refusal');
            }
            filled[S1] = await fill(scenario.authors[S1], S1, head0);
            filled[S2] = await fill(scenario.authors[S2], S2, filled[S1]);

            for (const name of NAMES) {
              const c = clients[name]!;
              for (const f of SENSITIVE) {
                // The author gets an acknowledgement, not a commit.
                if (scenario.authors[f] === name) continue;
                await waitFor(
                  () => commitsOf(c).some((x) => x.seq === filled[f]),
                  `${name} to receive commit ${filled[f]}`,
                );
                const commit = commitsOf(c).find((x) => x.seq === filled[f])!;
                if (reads(name, f))
                  expect(JSON.stringify(commit.steps), `${name} gets ${KEY[f]}`).toContain(
                    AFTER[f],
                  );
                // The value was redacted before and is redacted after: the projection did not change.
                else expect(commit.steps, `${name}: no step for ${KEY[f]}`).toEqual([]);
              }
              expectText(name, c.frames.join('\n'), 'frames of the live channel');
            }
          } finally {
            for (const c of Object.values(clients)) c.terminate();
          }

          // Catch-up over REST: the page of commits of each reader is of their class.
          for (const name of NAMES) {
            const r = await get(name, `/commits?after=${head0}`);
            expect(r.status, `${name}: ${r.text}`).toBe(200);
            const items = r.json.items as WireCommit[];
            expect(items.map((c) => c.seq)).toEqual(
              expect.arrayContaining([filled[S1], filled[S2]]),
            );
            expectText(name, r.text, 'commits page', AFTER);
            for (const f of SENSITIVE)
              if (!reads(name, f))
                expect(items.find((c) => c.seq === filled[f])!.steps, `${name} ${KEY[f]}`).toEqual(
                  [],
                );
          }

          // Catch-up over the socket: a reader who resumes from before the fills.
          for (const name of NAMES) {
            const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
            try {
              expect((await c.hello(token(name), { features: FEATURES })).t).toBe('welcome');
              const resumed = await c.open(1, doc, {
                features: FEATURES,
                resume: { seq: head0, incarnation: incarnation.current, view: views[name] },
              });
              expect(resumed.t, JSON.stringify(resumed.d)).toBe('ch.opened');
              const mode = resumed.d!['catchUp'];
              if (mode === 'stream') {
                await waitFor(
                  () => commitsOf(c).some((x) => x.seq === filled[S2]),
                  `${name} to be streamed up to ${filled[S2]}`,
                );
                expectText(name, c.frames.join('\n'), 'frames of the catch-up', AFTER);
              } else {
                // A reload carries no commits: the reader reads the content again (checked below).
                expect(mode, `${name}: catch-up mode`).toBe('reload');
                await sleep(200);
                expectText(name, c.frames.join('\n'), 'frames of the reload');
              }
            } finally {
              c.terminate();
            }
          }
        },
        120_000,
      );

      t()('compared: the change of a value is shown to its readers only', async () => {
        expect(filled[S2], 'the fills were made').toBeGreaterThan(head0);
        for (const name of NAMES) {
          const r = await get(name, `/diff?fromSeq=${head0}&toSeq=${filled[S2]}`);
          expect(r.status, `${name}: ${r.text}`).toBe(200);
          const changes = r.json.changes as Array<{ kind: string; fieldId?: string }>;
          for (const f of SENSITIVE)
            expect(
              changes.some((c) => c.kind === 'field' && c.fieldId === f),
              `${name}: the comparison ${reads(name, f) ? 'names' : 'does not name'} ${KEY[f]}`,
            ).toBe(reads(name, f));
          expectText(name, r.text, 'diff');
          // The history of the field: served to a reader of the value, refused to anyone else as if
          // the field did not exist (HIS-046).
          for (const f of SENSITIVE) {
            const hist = await get(name, `/history?field=${f}`);
            expect(hist.status, `${name} history of ${KEY[f]}: ${hist.text}`).toBe(
              reads(name, f) ? 200 : 404,
            );
            expectText(name, hist.text, 'field history');
          }
        }
      });

      t()(
        'read through the API: content, old content and field values are of the class',
        async () => {
          for (const name of NAMES) {
            // The head, and the state before the fills (a pinned read of history).
            for (const [query, values] of [
              ['', AFTER],
              [`?seq=${head0}`, BEFORE],
            ] as const) {
              const r = await get(name, `/content${query}`);
              expect(r.status, `${name} content${query}: ${r.text}`).toBe(200);
              for (const f of SENSITIVE)
                expect(fieldAttrs(r.json.doc, f)['value'], `${name} ${KEY[f]}${query}`).toEqual(
                  reads(name, f) ? values[f] : REDACTED,
                );
              expectText(name, r.text, `content${query}`, values);
            }

            const values = await get(name, '/field-values');
            expect(values.status, values.text).toBe(200);
            expect(values.json.values).toEqual({
              [KEY[S1]]: reads(name, S1) ? AFTER[S1] : REDACTED,
              [KEY[PLAIN]]: PLAIN_VALUE,
              [KEY[S2]]: reads(name, S2) ? AFTER[S2] : REDACTED,
            });
            expectText(name, values.text, 'field values', AFTER);

            const csv = await get(name, '/field-values?format=csv');
            expect(csv.status, csv.text).toBe(200);
            expect(csv.text).toContain(`${KEY[PLAIN]},${PLAIN_VALUE}`);
            expectText(name, csv.text, 'field values as CSV', AFTER);

            // The list of fields names every field and carries no value: a value is hidden, not
            // the field.
            const fields = await get(name, '/fields');
            expect(fields.status, fields.text).toBe(200);
            expect((fields.json.items as Array<{ id: string }>).map((f) => f.id).sort()).toEqual(
              [S1, S2, PLAIN].sort(),
            );
            expectText(name, fields.text, 'fields');
            expect(fields.text).not.toContain(PLAIN_VALUE);
          }
        },
      );

      /** Requests an export as `name`, waits for it and returns the job and the bytes of its output. */
      const exportAs = async (
        name: string,
        target: string,
      ): Promise<{ id: string; bytes: Uint8Array; text: string; diagnostics: string[] }> => {
        const created = await h.call('POST', `/v1/documents/${doc}/exports`, {
          token: token(name),
          headers: { 'Idempotency-Key': randomUUID() },
          body: { target },
        });
        expect(created.status, `${name} ${target}: ${created.text}`).toBe(202);
        const id = created.json.id as string;
        const giveUp = Date.now() + 240_000;
        let last = await h.call('GET', `/v1/exports/${id}`, { token: token(name) });
        while (!['completed', 'failed', 'cancelled'].includes(String(last.json?.state))) {
          if (Date.now() > giveUp) break;
          await sleep(50);
          last = await h.call('GET', `/v1/exports/${id}`, { token: token(name) });
        }
        expect(last.json.state, `${name} ${target}: ${last.text}`).toBe('completed');
        // The output is named by a signed URL of the asset origin, which is not running here: the
        // object the URL names is read from the store.
        const url = (last.json.result as { url: string }).url;
        const named =
          /^https:\/\/assets\.tests\.example\/e\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/([^/?]+)\?/.exec(
            url,
          );
        expect(named, `a result URL on the asset origin: ${url}`).not.toBeNull();
        const bytes = await h.parts.objects.get(
          `tenants/${named![1]}/exports/${named![2]}/${named![3]}`,
        );
        expect(bytes, `the output of ${name}'s ${target} export exists`).not.toBeNull();
        return {
          id,
          bytes: bytes!,
          text: `${last.text}\n${new TextDecoder().decode(bytes!)}`,
          diagnostics: ((last.json.diagnostics ?? []) as Array<{ code: string }>).map(
            (d) => d.code,
          ),
        };
      };

      t()(
        'exported: the CDM, LaTeX, HTML and Markdown outputs of each reader hold the values of their class',
        async () => {
          let ownerJob = '';
          for (const target of ['cdm', 'tex', 'html', 'md']) {
            for (const name of NAMES) {
              const out = await exportAs(name, target);
              if (name === 'ann') ownerJob = out.id;
              // A target that writes no form field says so in a diagnostic, and then holds no value
              // of a field for anyone. The canonical JSON and the LaTeX bundle write every field.
              const writesFields = !out.diagnostics.includes('form_field_omitted');
              if (target === 'cdm' || target === 'tex')
                expect(writesFields, `${target} writes form fields`).toBe(true);
              if (writesFields) {
                expect(out.text, `${target}: ${name} gets the plain value`).toContain(PLAIN_VALUE);
                expectText(name, out.text, `${target} export`, AFTER);
              } else {
                expect(out.text, `${target} writes no field value`).not.toContain(PLAIN_VALUE);
                for (const v of Object.values(AFTER))
                  expect(out.text, `${target}: ${name} gets no field value`).not.toContain(v);
              }
              if (target === 'cdm') {
                const envelope = JSON.parse(new TextDecoder().decode(out.bytes)) as {
                  doc: unknown;
                };
                for (const f of SENSITIVE)
                  expect(fieldAttrs(envelope.doc, f)['value'], `${name} ${KEY[f]}`).toEqual(
                    reads(name, f) ? AFTER[f] : REDACTED,
                  );
              }
              if (target === 'tex') {
                // The bundle says what the projection left out (EXP-123).
                const files = readTar(out.bytes, {
                  allow: new Set(['manifest.json']),
                  maxFileBytes: 4 * 1024 * 1024,
                });
                const manifest = JSON.parse(
                  new TextDecoder().decode(files.get('manifest.json')),
                ) as { redactions: Array<{ kind: string; id: string }> };
                expect(
                  manifest.redactions.map((r) => `${r.kind}:${r.id}`).sort(),
                  `${name}: the redactions of the bundle`,
                ).toEqual(
                  SENSITIVE.filter((f) => !reads(name, f))
                    .map((f) => `fieldValue:${f}`)
                    .sort(),
                );
              }
            }
          }
          // The owner's export holds both values, and it is the owner's alone: another reader who
          // asks for the job by its identifier is answered as for a job that does not exist.
          for (const name of NAMES.filter((n) => n !== 'ann')) {
            const r = await h.call('GET', `/v1/exports/${ownerJob}`, { token: token(name) });
            expect(r.status, `${name} reads the owner's job: ${r.text}`).toBe(404);
            expectText(name, r.text, "the owner's job");
          }
        },
        300_000,
      );

      // The compile is the same for both cases (the bundle is checked above for each): it runs once.
      (skip || noPdf || scenario.workflow ? it.skip : it)(
        `exported: the compiled PDF of each reader prints the values of their class${noPdf ? ` (skipped: ${noPdf})` : ''}`,
        async () => {
          for (const name of NAMES) {
            const out = await exportAs(name, 'pdf');
            expect(new TextDecoder().decode(out.bytes.subarray(0, 5))).toBe('%PDF-');
            const text = pdfText(out.bytes);
            expect(text, `${name}: the text of the PDF`).not.toBeNull();
            expect(text!, `${name}: the plain value is printed`).toContain(PLAIN_VALUE);
            expectText(name, text!, 'PDF text', AFTER);
            // A value that is left out is printed as the notice of the house class, once for each.
            expect(text!.split('[hidden]').length - 1, `${name}: notices in the PDF`).toBe(
              SENSITIVE.filter((f) => !reads(name, f)).length,
            );
          }
        },
        900_000,
      );

      t()('the service log holds no sensitive value', () => {
        const blob = h.logs.join('\n');
        expect(blob.length, 'the service logged something').toBeGreaterThan(0);
        for (const v of [...Object.values(BEFORE), ...Object.values(AFTER)])
          expect(blob, `the log must not carry ${v}`).not.toContain(v);
      });
    });
  }
}
