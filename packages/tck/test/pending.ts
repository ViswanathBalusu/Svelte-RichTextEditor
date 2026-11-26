/**
 * Artifact entries the kit has no scenario for yet, each with the reason and the story that will
 * add one (PRO-117 criterion 2). The check fails for an entry missing from this list, and for an
 * entry that is listed but now has a scenario, so the list can only shrink honestly.
 */
const FAULTS = 'needs the fault-injection profile and its server hooks (PRO-126; BE-079)';
const WORKFLOW =
  'workflow resources of phase 2 (FRW-068); the workflow actions are not defined (G95)';
const HISTORY = 'history resources of phase 2 (PRO-119)';
const LEASES = 'leases of phase 2 (PRO-122)';

export const PENDING: Readonly<Record<string, string>> = {
  'operation GET /tenant-fonts/{sha256}':
    'the kit adds no font file: a tenant font needs the asset worker font check, and the route is tested in services/document-service/test/control-plane/be-048-tenant-fonts.test.ts (BE-048)',
  'message sync.check': `sync.check is optional and follows a checkpoint (04 §13): ${FAULTS}`,
  'message wf.changed': WORKFLOW,
  'field error.retryAfterMs': `only rate-limited errors carry it: ${FAULTS}`,
  'field ch.opened.workflow': WORKFLOW,
  'field ch.closed.retryInMs': `a room that moves or is fenced: ${FAULTS}`,
  'field ch.closed.cause':
    'a change of access under read restrictions (G103; PRO-130); the perm-read profile runs when a server announces them',
  'field sync.reject.rule': 'rules of phase 2 (FRW-020)',
  'field sync.reject.retryAfterMs': `a spent CPU budget (04 §12): ${FAULTS}`,
  'field event.rev': 'what rev counts is not stated (G48)',
  'field event.data': 'the members of data per event are not stated (G48)',
  'field wf.changed.rev': WORKFLOW,
  'field wf.changed.participant': WORKFLOW,
  'operation PUT /documents/{id}/regions/{rid}/lease': LEASES,
  'operation GET /documents/{id}/connect':
    'the connect hint needs a server that runs more than one node and a node address; BE-061 tests it in the document service, a kit scenario follows with the node-routing profile (BE-061; PRO-126)',
  'operation GET /documents/{id}/audit-segment': `the log segment for a third party (08 §12) is served and tested in the document service (HIS-037); a kit scenario follows with the history profile: ${HISTORY}`,
  'operation GET /documents/{id}/suggestions/{sid}/introduction': `the introducing commit of a suggestion (08 §14) is served and tested in the document service (HIS-042); a kit scenario follows with the history profile: ${HISTORY}`,
  'operation GET /imports/{jid}':
    'imports take a service credential and arrive with EXP (G79; D16)',
  'operation GET /fonts': 'the font manifest has no shape and no feature yet (G75; G06)',
  'operation GET /documents/{id}/workflow': WORKFLOW,
  'operation PUT /documents/{id}/workflow': WORKFLOW,
  'operation POST /documents/{id}/workflow/send': WORKFLOW,
  'operation POST /documents/{id}/workflow/correct': WORKFLOW,
  'operation POST /documents/{id}/workflow/resume': WORKFLOW,
  'operation POST /documents/{id}/workflow/remind': WORKFLOW,
  'operation POST /documents/{id}/workflow/void': WORKFLOW,
  'operation POST /documents/{id}/workflow/participants/{pid}/consent': WORKFLOW,
  'operation GET /documents/{id}/workflow/participants/{pid}/consent': WORKFLOW,
  'operation POST /documents/{id}/workflow/participants/{pid}/access-code': WORKFLOW,
  'operation POST /documents/{id}/workflow/participants/{pid}/verify': WORKFLOW,
  'operation POST /documents/{id}/workflow/participants/{pid}/complete': WORKFLOW,
  'operation POST /documents/{id}/workflow/participants/{pid}/decline': WORKFLOW,
  'operation POST /documents/{id}/fields/{fid}/sign': `the signing ceremony (12 §8.1): ${WORKFLOW}`,
  'operation GET /documents/{id}/workflow/evidence': WORKFLOW,
  'operation GET /documents/{id}/workflow/final': `sealing (12 §8.2): ${WORKFLOW}`,
  'close 4429': `rate limits: ${FAULTS}`,
  'close 4500': `an internal error: ${FAULTS}`,
  'error slow_consumer': `a client that stops reading: ${FAULTS}`,
  'error internal': FAULTS,
  'event comment.reacted':
    'the notice follows the reaction routes; the kit scenario of the reactions profile covers the routes and refusals only (UX-033; ADR 0424)',
  'event import.completed': 'imports arrive with EXP (G79; D16)',
  'event import.failed': 'imports arrive with EXP (G79; D16)',
};
