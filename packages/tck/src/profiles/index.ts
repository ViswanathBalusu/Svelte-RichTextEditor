/**
 * Every profile of the kit, in the order a run reports them (05 §11; 12 §10; ADR 0019). A profile
 * maps to what a server announces; a profile of a later phase is listed with the reason it has no
 * scenarios yet, so that a report shows it as skipped rather than leaving it out.
 */
import type { ProfileDef } from '../scenario.ts';
import { AUTHORITY_SERVICE } from './authority-service.ts';
import { AUTHZ } from './authz.ts';
import { COMMENTS } from './comments.ts';
import { CORE_CHANNELS } from './core-channels.ts';
import { CORE_RELAY_PROFILE } from './core-relay.ts';
import { CORE_REST } from './core-rest.ts';
import { CORE_SESSION } from './core-session.ts';
import { CORE_SYNC } from './core-sync.ts';
import { FAULT_INJECTION } from './fault-injection.ts';
import { FIELDS } from './fields.ts';
import { PERM_FILL } from './perm-fill.ts';
import { FUZZ } from './fuzz.ts';
import { HISTORY } from './history.ts';
import { LEASES } from './leases.ts';
import { ASSETS, EXPORTS } from './jobs.ts';
import { PERM_READ } from './perm-read.ts';
import { PERM_SUGGEST } from './perm-suggest.ts';
import { PERM_DOC, PERM_REGION } from './perm.ts';
import { PRESENCE } from './presence.ts';
import { REGISTRY_PROFILE } from './registry.ts';
import { SEMANTICS } from './semantics.ts';

export const CORE: ProfileDef = {
  id: 'core',
  title: 'Discovery, authentication, framing, channels, sync and the REST conventions',
  spec: '05 §1 to §6',
  stories: ['PRO-111'],
  requires: { kind: 'mode', mode: 'authority' },
  scenarios: [...CORE_SESSION, ...CORE_CHANNELS, ...CORE_SYNC, ...CORE_REST],
};

const later = (
  id: string,
  title: string,
  spec: string,
  requires: ProfileDef['requires'],
  stories: string[],
  pending: string,
): ProfileDef => ({
  id,
  title,
  spec,
  stories,
  requires,
  scenarios: [],
  pending,
});

export const PROFILES: readonly ProfileDef[] = [
  CORE,
  SEMANTICS,
  PRESENCE,
  PERM_DOC,
  PERM_REGION,
  PERM_READ,
  EXPORTS,
  ASSETS,
  AUTHZ,
  REGISTRY_PROFILE,
  FUZZ,
  FIELDS,
  PERM_FILL,
  CORE_RELAY_PROFILE,
  PERM_SUGGEST,
  HISTORY,
  COMMENTS,
  later(
    'webhooks',
    'Signed webhooks',
    '05 §7',
    { kind: 'features', features: ['webhooks'] },
    ['PRO-121'],
    'PRO-121: phase 2',
  ),
  LEASES,
  AUTHORITY_SERVICE,
  FAULT_INJECTION,
];
