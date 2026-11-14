/**
 * SEC-006 criterion 1 — `link.href` values with a forbidden scheme, or an obfuscated form of one,
 * are refused; `http`, `https`, `mailto` and in-document targets are accepted (10 §3.4; I9). The
 * adversarial client submits the link as an `addMark` step over the wire, as an editor, so the
 * refusal is the service's own, not the component's.
 *
 * The allow-list is the grammar of `link.href` (`LINK_HREF_PATTERN`, CDM-002). The fixed cases name
 * the schemes of the criterion and their obfuscated forms; the property test generates more of them.
 * The rendering criteria (`noopener`, `noreferrer`) and the LaTeX and DOCX writers are not covered
 * here: they need a browser and the export workers (ADR 0121 item 9).
 */
import fc from 'fast-check';
import { AddMarkStep } from 'prosemirror-transform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import {
  documentWithRegions,
  postgresUnavailable,
  startHarness,
  type Harness,
  type Storage,
} from './support/harness.ts';
import { inside, loadDoc, schema, stepsJson } from './support/cdm.ts';
import { WireClient } from './support/wire.ts';

/** Schemes and forms that must be refused (I9). Each is a whole `href` value. */
const HOSTILE = [
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  'JAVASCRIPT:alert(1)',
  'java\tscript:alert(1)',
  'java\nscript:alert(1)',
  ' javascript:alert(1)',
  'javascript%3Aalert(1)',
  '%6Aavascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'DATA:text/html;base64,PHNjcmlwdD4=',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
  'blob:https://example.com/0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10',
  'https://example.com/ javascript:alert(1)',
  'https://example.com/"onmouseover="alert(1)',
];

/** Targets that must be accepted (the allow-list of I9). */
const ACCEPTED = [
  'https://example.com/a?b=c',
  'http://example.com',
  'mailto:ada@example.com',
  '#section-1',
];

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null;
  describe(`SEC-006 link schemes are restricted over the wire (${storage})`, () => {
    let h: Harness;
    let doc: string;
    beforeAll(async () => {
      if (!skip) {
        h = await startHarness(storage);
        doc = await h.createDocument(h.a, documentWithRegions());
      }
    });
    afterAll(async () => {
      await h?.close();
    });
    const t = () => (skip ? it.skip : it);

    const headSeq = async () =>
      (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey })).json
        .seq as number;

    /** The `addMark` of a link over the first five characters of the introduction. */
    async function linkCommit(c: WireClient, href: string) {
      const d = loadDoc(
        (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey })).json.doc,
      );
      const start = inside(d, 'pIntro0000000001');
      return c.submit(1, {
        id: uuid7(),
        base: await headSeq(),
        steps: stepsJson([
          new AddMarkStep(start, start + 5, schema.marks['link']!.create({ href })),
        ]),
      });
    }

    t()('refuses every forbidden scheme and obfuscated form with invalid_op', async () => {
      const token = await h.mintToken(h.a, 'ann', { [doc]: 'editor' });
      const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
      await c.hello(token);
      await c.open(1, doc);
      try {
        const before = await headSeq();
        for (const href of HOSTILE) {
          const r = await linkCommit(c, href);
          expect(r.t, `${JSON.stringify(href)} is refused: ${JSON.stringify(r.d)}`).toBe(
            'sync.reject',
          );
          expect(r.d?.['code'], JSON.stringify(href)).toBe('invalid_op');
          expect(String(r.d?.['message'] ?? ''), JSON.stringify(href)).toMatch(/\bI9\b/);
        }
        expect(await headSeq()).toBe(before);
      } finally {
        c.terminate();
      }
    });

    t()('accepts http, https, mailto and in-document targets', async () => {
      const token = await h.mintToken(h.a, 'ben', { [doc]: 'editor' });
      const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
      await c.hello(token);
      await c.open(1, doc);
      try {
        for (const href of ACCEPTED) {
          const r = await linkCommit(c, href);
          expect(r.t, `${href} is accepted: ${JSON.stringify(r.d)}`).toBe('sync.ack');
        }
      } finally {
        c.terminate();
      }
    });

    t()(
      'property: a javascript scheme with random case, leading whitespace and a control character is refused',
      async () => {
        const token = await h.mintToken(h.a, 'cai', { [doc]: 'editor' });
        const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
        await c.hello(token);
        await c.open(1, doc);
        try {
          const schemeChars = fc.array(fc.boolean(), { minLength: 10, maxLength: 10 });
          const control = fc.constantFrom('\t', '\n', '\r', '\u0000', ' ');
          await fc.assert(
            fc.asyncProperty(
              schemeChars,
              control,
              fc.integer({ min: 0, max: 3 }),
              async (cases, ctl, at0) => {
                const word = 'javascript'
                  .split('')
                  .map((ch, i) => (cases[i] ? ch.toUpperCase() : ch))
                  .join('');
                const pos = Math.min(at0, word.length);
                const href = word.slice(0, pos) + ctl + word.slice(pos) + ':alert(1)';
                const r = await linkCommit(c, href);
                expect(r.t, `${JSON.stringify(href)}`).toBe('sync.reject');
                expect(r.d?.['code']).toBe('invalid_op');
              },
            ),
            { numRuns: 25 },
          );
        } finally {
          c.terminate();
        }
      },
      120_000,
    );
  });
}
