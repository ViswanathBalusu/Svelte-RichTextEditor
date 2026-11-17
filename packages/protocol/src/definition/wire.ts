/**
 * The part of the DEP 1.0 definition that a client reads at run time: the version, the engines, the
 * CDM range, the shapes, the messages and the features. The codec, the validator and the client
 * state machines take this type, so a browser bundle does not carry the records that only the
 * generators and the documents read (the gaps, the decisions and the REST operations).
 *
 * `DEP1_WIRE` holds the same values as `DEP1` for these members; `wire.test.ts` checks that.
 */
import { CDM1 } from '@docedit/model/definition';
import { COMMON_SHAPES, ENGINES, PROTOCOL_VERSION } from './common.ts';
import { EVENT_SHAPES } from './events.ts';
import type { DepDefinition } from './extension.ts';
import { FEATURES } from './features.ts';
import { FRW_EXTENSION } from './frw.ts';
import { MESSAGES } from './messages.ts';
import { REST_SHAPES } from './resources.ts';

/** The members of a definition that the codec and the client state machines read. */
export type WireDefinition = Pick<
  DepDefinition,
  'version' | 'engines' | 'cdm' | 'shapes' | 'messages' | 'features'
>;

/** Protocol 1.0 with the additions of 12 §10, as a client reads it. */
export const DEP1_WIRE: WireDefinition = {
  version: PROTOCOL_VERSION,
  engines: ENGINES,
  cdm: { min: CDM1.cdm, max: CDM1.cdm },
  shapes: [...COMMON_SHAPES, ...EVENT_SHAPES, ...REST_SHAPES, ...FRW_EXTENSION.shapes],
  messages: [...MESSAGES, ...FRW_EXTENSION.messages],
  features: [...FEATURES, ...FRW_EXTENSION.features],
};
