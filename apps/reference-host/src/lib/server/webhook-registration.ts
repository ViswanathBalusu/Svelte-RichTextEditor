/**
 * The host's webhook subscription at the document service (UX-105 criterion 1; 05 §6.2 and §7;
 * PRO-070). The seed step calls `ensureSubscription` once the service is ready.
 *
 * The service issues the signing secret when it creates the subscription and shows it once, so the
 * registrar must keep it: the seed step writes it to the host's role directory and the host reads
 * it at start. The service keeps subscriptions in memory only (webhook-composition.ts), so a
 * restarted service has none and the next seed run creates it again.
 *
 * Repeating the call is safe. A subscription that already names this URL and these events is kept
 * when the registrar still holds its secret; otherwise it is deleted and created again, because a
 * secret that was lost cannot be read back.
 */
import type { ServiceClient } from './service.ts';

export interface Registration {
  id: string;
  /** `created`: a new subscription and its secret. `kept`: the one already registered. */
  action: 'created' | 'kept';
  /** The secret to keep: the new one, or the one given when the subscription was kept. */
  secret: string;
}

const sameEvents = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

export async function ensureSubscription(
  client: Pick<ServiceClient, 'listWebhooks' | 'createWebhook' | 'deleteWebhook'>,
  want: { url: string; events: readonly string[]; knownSecret: string | undefined },
): Promise<Registration> {
  // The service stores the URL as `new URL(...).toString()`.
  const url = new URL(want.url).toString();
  const present = (await client.listWebhooks()).filter((s) => s.url === url);
  const kept = present.find((s) => sameEvents(s.events, want.events));
  if (kept && want.knownSecret && present.length === 1)
    return { id: kept.id, action: 'kept', secret: want.knownSecret };
  for (const s of present) await client.deleteWebhook(s.id);
  const created = await client.createWebhook({ url, events: [...want.events] });
  return { id: created.id, action: 'created', secret: created.secret };
}
