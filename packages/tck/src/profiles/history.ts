/**
 * The `history` profile (PRO-119; 05 §6.2, §11; 08 §10). This module holds the scenarios that the
 * reference service can run now: the read marker of a user, which only moves forward (HIS-027
 * criterion 2). The comparison, attribution, history and dry-run restore routes are not served yet
 * (see the Notes of PRO-119), so their criteria stay open and have no scenario here.
 */
import { check, equal } from '../assert.ts';
import { IDS, insertText, posIn } from '../documents.ts';
import { expectStatus } from '../rest.ts';
import { scenario, type ProfileDef, type ScenarioDef } from '../scenario.ts';
import { acked, join } from './support.ts';

const hs = (def: Omit<ScenarioDef, 'id'> & { id: string }) => scenario('history', def);

export const HISTORY: ProfileDef = {
  id: 'history',
  title: 'History, versions, comparison, attribution, restore and read markers',
  spec: '08; 05 §6.2',
  stories: ['PRO-119'],
  requires: { kind: 'features', features: ['history'] },
  scenarios: [
    hs({
      id: 'read-marker.forward-only',
      title: 'a read marker moved backwards stays where it was',
      spec: '08 §10; 05 §6.2; HIS-027 criterion 2',
      covers: { operations: ['PUT /documents/{id}/read-marker'] },
      async run(ctx) {
        const d = await ctx.document();
        const m = await join(ctx, 'reader', d, 'editor');
        const at = await acked(m.wire, m.ch, {
          base: m.content.seq,
          steps: [insertText(posIn(m.content.doc, IDS.intro, 0), 'Read ')],
        });
        const seq = at.seq;
        check(seq > 0, 'the commit is stored at a seq above 0', '> 0', seq);

        const put = (value: number) =>
          ctx.service.as(m.token, 'PUT', `/documents/${d}/read-marker`, {
            body: { seq: value },
          });

        const up = await put(seq);
        expectStatus(up, 200, `moving the read marker to ${seq}`);
        equal((up.json as { seq: number }).seq, seq, 'the marker in force after a forward move');

        const back = await put(0);
        expectStatus(back, 200, 'moving the read marker backwards to 0');
        equal(
          (back.json as { seq: number }).seq,
          seq,
          'a backward move leaves the marker where it was (08 §10)',
        );

        const again = await put(seq);
        expectStatus(again, 200, 'repeating the same marker');
        equal(
          (again.json as { seq: number }).seq,
          seq,
          'an equal move leaves the marker as it was',
        );
        await m.wire.close();
      },
    }),
  ],
};
