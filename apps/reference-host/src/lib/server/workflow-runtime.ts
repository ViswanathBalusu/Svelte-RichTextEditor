/**
 * The send-for-completion parts of the running host (UX-099), composed once per process: the host,
 * the store of who was sent what, the mailer and the public address for links. The webhook
 * endpoint and the pages share them.
 *
 * Mail goes to the relay named by `DOCEDIT_HOST_SMTP`, the development mail sink of the demo stack.
 * Without it nothing is mailed and a line says so.
 */
import { host } from './host.ts';
import { ParticipantSessions } from './participant-session.ts';
import { sendMail } from './smtp.ts';
import { WorkflowStore, type EventDeps, type Mailer } from './send-for-completion.ts';

export function mailerFromEnv(env: NodeJS.ProcessEnv = process.env): Mailer | null {
  const relay = env['DOCEDIT_HOST_SMTP'];
  if (!relay) return null;
  const colon = relay.lastIndexOf(':');
  const port = Number(relay.slice(colon + 1));
  if (colon < 1 || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('DOCEDIT_HOST_SMTP is host:port');
  const from = env['DOCEDIT_HOST_MAIL_FROM'] || 'notifications@demo.example.test';
  return (m) =>
    sendMail(
      { host: relay.slice(0, colon), port },
      { from, to: m.to, subject: m.subject, text: m.text, messageId: m.messageId },
    );
}

let composed: Promise<EventDeps> | null = null;

/** The workflow parts of this process. */
export function workflowDeps(): Promise<EventDeps> {
  composed ??= (async () => {
    const h = await host();
    const mail = mailerFromEnv();
    const publicUrl = process.env['DOCEDIT_HOST_PUBLIC_URL'] ?? '';
    const deps: EventDeps = {
      host: h,
      store: await WorkflowStore.open(h.config.dataDir),
      mail:
        mail ??
        ((m) => {
          console.warn(`mail not sent (DOCEDIT_HOST_SMTP is not set): ${m.subject.slice(0, 40)}`);
          return Promise.resolve();
        }),
      publicUrl,
    };
    return deps;
  })();
  return composed;
}

/** The sessions of participants who passed the passcode (UX-106); one for the process. */
export const participantSessions = new ParticipantSessions();
