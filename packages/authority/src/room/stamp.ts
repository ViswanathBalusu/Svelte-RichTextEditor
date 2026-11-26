/**
 * The identity a room writes on every commit it stamps: the `cdm` version, the engine and the
 * model package (03 §11.3; CDM-050 criterion 2). One place, so an operator reads the same three
 * values the room wrote. The package identifier format is proposed in ADR 0424.
 */
import { modelStampIdentity } from '@docedit/model/definition';
import { ENGINE } from './types.ts';

export interface CommitStampIdentity {
  cdm: number;
  engine: string;
  /** The model package that validated the document, as `<name>@<version>`. */
  package: string;
}

export function commitStampIdentity(): CommitStampIdentity {
  const { cdm, package: pkg } = modelStampIdentity();
  return { cdm, engine: ENGINE, package: pkg };
}
