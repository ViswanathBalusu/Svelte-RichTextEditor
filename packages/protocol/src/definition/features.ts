/**
 * Feature names (05 §1 rule 4, §2; 12 §10; 03 §11). Protocol and CDM features share one namespace.
 * The vocabulary is open: a minor version adds names, and experimental ones start with `x-`.
 */

export interface FeatureDef {
  name: string;
  doc: string;
  spec: string;
  /** 05 §2: "a relay never announces `regions`, `suggest-enforced` or `fields`". */
  relayForbidden: boolean;
  /** The optional backend port that serves it, when there is one (05 §8.3). */
  port?: string;
  owner: string;
}

export const FEATURES: readonly FeatureDef[] = [
  {
    name: 'presence',
    doc: 'Selections shared between sessions (05 §5.4).',
    spec: '05 §2, §5.4',
    relayForbidden: false,
    port: 'presence',
    owner: 'PRO',
  },
  {
    name: 'regions',
    doc: 'Region grants enforced by the authority (07).',
    spec: '05 §2, §9',
    relayForbidden: true,
    owner: 'PRO',
  },
  {
    name: 'suggest-enforced',
    doc: 'The suggestion-only rule P4 enforced by the authority (07 §5.2).',
    spec: '05 §2, §9',
    relayForbidden: true,
    owner: 'PRO',
  },
  {
    name: 'history',
    doc: 'History, versions, comparison, attribution, restore and read markers (08).',
    spec: '05 §2, §6.2',
    relayForbidden: false,
    port: 'history',
    owner: 'PRO',
  },
  {
    name: 'comments',
    doc: 'Comment threads on ranges and blocks (07 §6).',
    spec: '05 §2, §6.2',
    relayForbidden: false,
    port: 'comments',
    owner: 'PRO',
  },
  {
    name: 'assets',
    doc: 'Asset upload through quarantine and signed URLs (05 §6.2).',
    spec: '05 §2, §6.2',
    relayForbidden: false,
    port: 'assets',
    owner: 'PRO',
  },
  {
    name: 'exports',
    doc: 'Export jobs (09).',
    spec: '05 §2, §6.2',
    relayForbidden: false,
    port: 'exports',
    owner: 'PRO',
  },
  {
    name: 'leases',
    doc: 'Exclusive-edit leases on regions (07 §10).',
    spec: '05 §2, §6.2',
    relayForbidden: false,
    port: 'leases',
    owner: 'PRO',
  },
  {
    name: 'fields',
    doc: 'Fillable fields and the fill capability (12 §4); also a CDM feature (03 §11).',
    spec: '05 §2; 12 §10',
    relayForbidden: true,
    port: 'fields',
    owner: 'FRW',
  },
  {
    name: 'rules',
    doc: 'Field rules evaluated by the authority (12 §5).',
    spec: '12 §10',
    relayForbidden: false,
    owner: 'FRW',
  },
  {
    name: 'workflow',
    doc: 'The workflow resource (12 §6).',
    spec: '12 §10',
    relayForbidden: false,
    port: 'workflow',
    owner: 'FRW',
  },
  {
    name: 'sign',
    doc: 'The signing ceremony (12 §8.1).',
    spec: '12 §10',
    relayForbidden: false,
    owner: 'FRW',
  },
  {
    name: 'seal',
    doc: 'Sealed final PDFs (12 §8.2).',
    spec: '12 §10',
    relayForbidden: false,
    owner: 'FRW',
  },
  {
    name: 'extensions',
    doc: 'Host-registered extension nodes; a CDM feature (03 §11, 13 §7.3).',
    spec: '03 §11',
    relayForbidden: false,
    owner: 'CDM',
  },
  {
    name: 'preserve',
    doc: 'Content preserved from an imported Word file; a CDM feature (03 §4.6).',
    spec: '03 §4.6',
    relayForbidden: false,
    owner: 'CDM',
  },
];

/** Optional ports with no feature name (gap G06). */
export const PORTS_WITHOUT_FEATURE: readonly string[] = [
  'imports',
  'fonts',
  'proofing',
  'assistant',
];

export const FEATURE_NAMES: readonly string[] = FEATURES.map((f) => f.name);
