/**
 * The shapes a client needs only when it calls the control plane (the REST resources of 05 §6 and
 * the additions of 12 §10): `wire.ts` loads this module with the first call that names one of them
 * (`loadWireMoreShapes`), so that the first load of a client does not carry them (FND-008).
 */
import { WEBHOOK_DELIVERY_SHAPE } from './events.ts';
import { FRW_SHAPES } from './frw-shapes.ts';
import { REST_SHAPES } from './resources.ts';
import type { NamedShape } from './shapes.ts';

/** In the order `DEP1_WIRE` has them: the resources' shapes, then the additions'. */
export const WIRE_MORE_SHAPES: readonly NamedShape[] = [
  WEBHOOK_DELIVERY_SHAPE,
  ...REST_SHAPES,
  ...FRW_SHAPES,
];
