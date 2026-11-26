// Notifications reach the development mail sink (UX-098 criterion 5), run against a real Mailpit
// container: the `mail` service of apps/reference-host/compose.json (`stack.ps1 up` starts it; so
// does a plain `podman run` of the same image and command). The host's own sink, built from the
// environment the stack gives the host (`sinkFromEnv`), sends a mention and a task to the SMTP
// port, and the test reads the messages back from Mailpit's API.
//
//   $env:DOCEDIT_DEMO_REUSE = '1'   (and DOCEDIT_DEMO_MAIL_SMTP_PORT / DOCEDIT_DEMO_MAIL_UI_PORT)
//   pnpm exec vitest run --project node apps/reference-host/test/ux-098-mailpit.stack.test.ts
//
// It skips, with the reason, when DOCEDIT_DEMO_REUSE is not set. It deletes the messages it sent.
import { afterAll, describe, expect, it } from 'vitest';
import { setting, stackSettings } from '../scripts/lib/stack.ts';
import { sinkFromEnv } from '../src/lib/server/webhook-endpoint.ts';
import { notificationOf } from '../src/lib/server/webhook-notifications.ts';

const ENABLED = process.env['DOCEDIT_DEMO_REUSE'] === '1';
const RUN = Date.now().toString(36);
const DOC = '0192f0a1-0000-7000-8000-000000000001';

interface Summary {
  ID: string;
  Subject: string;
  To: Array<{ Address: string }>;
}

describe.skipIf(!ENABLED)(
  'notifications go to the development mail sink (UX-098 criterion 5)',
  () => {
    const s = stackSettings();
    const api = `http://127.0.0.1:${setting(s, 'DOCEDIT_DEMO_MAIL_UI_PORT')}/api/v1`;
    const sent: string[] = [];

    afterAll(async () => {
      for (const id of sent)
        await fetch(`${api}/messages`, { method: 'DELETE', body: JSON.stringify({ IDs: [id] }) });
    });

    async function find(query: string): Promise<Summary[]> {
      for (let i = 0; i < 20; i++) {
        const res = await fetch(`${api}/search?query=${encodeURIComponent(query)}`);
        const body = (await res.json()) as { messages: Summary[] };
        if (body.messages.length > 0) return body.messages;
        await new Promise((r) => setTimeout(r, 250));
      }
      return [];
    }

    it('delivers a mention and a task to the people the directory names, with a link and no token', async () => {
      const env = {
        DOCEDIT_HOST_SMTP: `127.0.0.1:${setting(s, 'DOCEDIT_DEMO_MAIL_SMTP_PORT')}`,
        DOCEDIT_HOST_PUBLIC_URL: `http://127.0.0.1:${setting(s, 'DOCEDIT_DEMO_HOST_PORT')}`,
      };
      const sink = sinkFromEnv(env);
      const event = (type: string, data: Record<string, unknown>) => ({
        webhookId: `msg_${RUN}_${type}`,
        type,
        subject: DOC,
        test: false,
        body: { id: `ev-${RUN}`, data },
      });
      const mention = notificationOf(
        event('dep.comment.mentioned.v1', {
          comment: `c-${RUN}`,
          thread: `t-${RUN}`,
          principal: 'user:u-ada',
          seq: 3,
        }),
      );
      const task = notificationOf(
        event('dep.task.assigned.v1', { thread: `t-${RUN}`, assignee: 'user:u-bob', seq: 4 }),
      );
      if (mention === null || task === null) throw new Error('no notification');
      await sink.send(mention);
      await sink.send(task);

      const toAda = await find(`to:ada@demo.example.test c-${RUN}`);
      expect(toAda).toHaveLength(1);
      sent.push(...toAda.map((m) => m.ID));
      expect(toAda[0]?.Subject).toBe('You were mentioned in a comment');
      const full = (await (await fetch(`${api}/message/${toAda[0]?.ID}`)).json()) as {
        Text: string;
      };
      expect(full.Text).toContain(`/as/u-ada/docs/${DOC}?thread=t-${RUN}&comment=c-${RUN}`);
      expect(full.Text).not.toMatch(/token|secret|bearer/i);

      const toBob = await find(`to:bob@demo.example.test t-${RUN}`);
      expect(toBob).toHaveLength(1);
      sent.push(...toBob.map((m) => m.ID));
      expect(toBob[0]?.Subject).toBe('A task was assigned to you');
    });
  },
);
