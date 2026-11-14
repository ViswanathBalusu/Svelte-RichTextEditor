/**
 * Receives the document service's webhooks (UX-098; 05 §7; 13 §11.1 item 3). The subscription's
 * URL points here. No session is needed: the Standard Webhooks signature is the only credential.
 *
 * - The signature covers the exact bytes sent, so the body is read raw and never re-serialised.
 * - A valid delivery is answered 202 at once; the work (notifications) runs after the response,
 *   so the dispatcher does not retry a delivery that is merely slow to process.
 * - A repeated `webhook-id` is answered 202 again and causes no new work.
 * - A delivery that fails verification is answered 401 (signature) or 400 (headers, timestamp,
 *   body), and the dispatcher's retry policy decides what follows.
 */
import { webhookEndpoint } from '../../../lib/server/webhook-endpoint.ts';
import type { RequestHandler } from './$types';

const NO_STORE = { 'cache-control': 'no-store' };

export const POST: RequestHandler = async ({ request }) => {
  const endpoint = webhookEndpoint();
  // `ignoreBOM`: a leading byte-order mark is part of the signed bytes and must be kept.
  const body = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await request.arrayBuffer());
  const outcome = endpoint.receiver.receive(request.headers, body);
  if (outcome.status !== 202)
    return Response.json({ error: outcome.reason }, { status: outcome.status, headers: NO_STORE });
  if (!outcome.duplicate) endpoint.schedule();
  return new Response(null, { status: 202, headers: NO_STORE });
};
