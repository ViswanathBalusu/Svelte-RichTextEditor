/**
 * What this package puts on a commit stamp (03 §11.3; CDM-050 criterion 2).
 *
 * The model stamps no commits: the room does (SYN-014). The package only says which `cdm` major
 * version it reads and which build of itself is running, so a service can write both on a commit
 * and an operator can read them back from history. The format of the package identifier is
 * proposed in ADR 0424.
 */
import { CDM1 } from './cdm1.ts';
import type { CdmDefinition } from './grammar.ts';

/** The name and version of this package. A test keeps the version equal to `package.json`. */
export const MODEL_PACKAGE = { name: '@docedit/model', version: '0.0.0' } as const;

export interface ModelStampIdentity {
  /** The CDM major version the definition describes. */
  cdm: number;
  /** The package identifier, `<name>@<version>`, as npm writes it. */
  package: string;
}

/** The `cdm` version and the package identifier a commit stamp carries for the model. */
export function modelStampIdentity(def: CdmDefinition = CDM1): ModelStampIdentity {
  return { cdm: def.cdm, package: `${MODEL_PACKAGE.name}@${MODEL_PACKAGE.version}` };
}
