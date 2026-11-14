/** Liveness of the reference host, for the stack's health check (UX-091 criterion 1). */
import { json } from '@sveltejs/kit';
import { host } from '../../lib/server/host.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
  // Composing the host reads its settings, directory and catalogue: a broken one fails here.
  await host();
  return json({ live: true }, { headers: { 'Cache-Control': 'no-store' } });
};
