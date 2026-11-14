/**
 * Which feature each optional port serves (05 §2, §8.3; 12 §10), and the one question the user
 * interface asks: is this feature available? (PRO-092). A port without a feature name (G06) is
 * available when it is present.
 */
import type { Backend } from './core.ts';

export const OPTIONAL_PORTS = [
  'presence',
  'history',
  'comments',
  'assets',
  'exports',
  'imports',
  'fonts',
  'leases',
  'fields',
  'workflow',
  'proofing',
  'assistant',
] as const;

export type OptionalPortName = (typeof OPTIONAL_PORTS)[number];

export const PORT_FEATURES: Readonly<Record<OptionalPortName, string | null>> = {
  presence: 'presence',
  history: 'history',
  comments: 'comments',
  assets: 'assets',
  exports: 'exports',
  imports: null,
  fonts: null,
  leases: 'leases',
  fields: 'fields',
  workflow: 'workflow',
  proofing: null,
  assistant: null,
};

/** True when the backend has the port and, where the port has a feature, announced it. */
export function hasPort(backend: Backend, port: OptionalPortName): boolean {
  if (backend[port] === undefined) return false;
  const feature = PORT_FEATURES[port];
  return feature === null || backend.features.has(feature);
}

/** Inconsistencies between ports and features: a port whose feature is not announced, or the reverse. */
export function portFeatureMismatches(backend: Backend): string[] {
  const out: string[] = [];
  for (const port of OPTIONAL_PORTS) {
    const feature = PORT_FEATURES[port];
    if (feature === null) continue;
    const present = backend[port] !== undefined;
    const announced = backend.features.has(feature);
    if (present && !announced)
      out.push(`port ${port} is present but feature ${feature} is not announced`);
    if (!present && announced)
      out.push(`feature ${feature} is announced but port ${port} is absent`);
  }
  return out;
}
