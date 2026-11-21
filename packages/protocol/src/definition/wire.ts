/**
 * The part of the DEP 1.0 definition that a client reads at run time: the version, the engines, the
 * CDM range, the shapes, the messages and the features. The codec, the validator and the client
 * state machines take this type, so a browser bundle does not carry the records that only the
 * generators and the documents read (the gaps, the decisions and the REST operations).
 *
 * `DEP1_WIRE` holds the same values as `DEP1` for these members; `wire.test.ts` checks that.
 * `DEP1_WIRE_BASE` is the smaller definition a client starts from (FND-008): what the channel and
 * the discovery document need. The shapes of the control plane's resources and of the additions of
 * 12 §10 are not in it; `loadWireMoreShapes` loads them, and `ShapeValidator` does so with the
 * first check of a shape it does not have. `DEP1_WIRE_BASE.shapes` and `loadWireMoreShapes()` hold
 * together what `DEP1_WIRE.shapes` holds, in the same order (`wire.test.ts`).
 */
import { CDM1 } from '@docedit/model/definition';
import { COMMON_SHAPES, ENGINES, PROTOCOL_VERSION } from './common.ts';
import { EVENT_SHAPES } from './events.ts';
import { NOTIFICATION_TYPE_SHAPE } from './notifications.ts';
import type { DepDefinition } from './extension.ts';
import { FEATURES } from './features.ts';
import { FRW_FEATURES, FRW_MESSAGES } from './frw.ts';
import { FRW_SHAPES } from './frw-shapes.ts';
import { MESSAGES } from './messages.ts';
import { REST_SHAPES } from './resources.ts';
import type { NamedShape } from './shapes.ts';

/** The members of a definition that the codec and the client state machines read. */
export type WireDefinition = Pick<
  DepDefinition,
  'version' | 'engines' | 'cdm' | 'shapes' | 'messages' | 'features'
>;

/**
 * Protocol 1.0 with the additions of 12 §10, as a client starts from it: without the shapes of the
 * control plane's resources and of the additions (`loadWireMoreShapes`).
 */
export const DEP1_WIRE_BASE: WireDefinition = {
  version: PROTOCOL_VERSION,
  engines: ENGINES,
  cdm: { min: CDM1.cdm, max: CDM1.cdm },
  shapes: [...COMMON_SHAPES, NOTIFICATION_TYPE_SHAPE],
  messages: [...MESSAGES, ...FRW_MESSAGES],
  features: [...FEATURES, ...FRW_FEATURES],
};

/** The shapes `DEP1_WIRE_BASE` leaves out, loaded on first use. */
export function loadWireMoreShapes(): Promise<readonly NamedShape[]> {
  return import('./wire-more.ts').then((m) => m.WIRE_MORE_SHAPES);
}

/** The whole definition, made by a function so that a bundle that never reads it does not keep the shapes (FND-008). */
function wholeWire(): WireDefinition {
  return {
    ...DEP1_WIRE_BASE,
    shapes: [...COMMON_SHAPES, ...EVENT_SHAPES, ...REST_SHAPES, ...FRW_SHAPES],
  };
}

/** Protocol 1.0 with the additions of 12 §10, as a client reads it, whole. */
export const DEP1_WIRE: WireDefinition = /* @__PURE__ */ wholeWire();

/**
 * The notification types of DEP 1.0 with the additions of 12 §10, as a client reads them. The
 * names live in a module of their own, so that the element's dispatcher does not import the whole
 * definition (FND-008).
 */
export { DEP1_WIRE_NOTIFICATION_TYPES } from './notification-types.ts';
