/**
 * The sealed PDF and the evidence bundle the host fetched for the owner (UX-099 criterion 5). Only
 * the owner of the document is served, and only the two files the host wrote.
 */
import { error } from '@sveltejs/kit';
import { host } from '../../../../../../../../lib/server/host.ts';
import { requirePerson } from '../../../../../../../../lib/server/request.ts';
import { resultFile } from '../../../../../../../../lib/server/send-for-completion.ts';
import { workflowDeps } from '../../../../../../../../lib/server/workflow-runtime.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, cookies }) => {
  const h = await host();
  const person = requirePerson(h, cookies, params.user);
  if (params.kind !== 'sealed-pdf' && params.kind !== 'evidence') error(404, 'No such file.');
  const d = await workflowDeps();
  const file = await resultFile(d.host, d.store, params.id, person.sub, params.kind);
  if (file === null) error(404, 'There is no such file for you.');
  return new Response(new Blob([file.bytes as BlobPart]), {
    headers: {
      'Content-Type': file.type,
      'Content-Disposition': `attachment; filename="${file.filename}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
};
