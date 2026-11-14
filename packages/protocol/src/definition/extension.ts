/**
 * What an epic registers to add to DEP (PRO-001 criterion 4): named shapes, messages, resources,
 * notifications, webhooks and features. The envelope and the generators do not change.
 */
import type { Decision } from './decisions.ts';
import type { CloseCodeDef, ErrorDef } from './errors.ts';
import type { NotificationDef, WebhookDef } from './events.ts';
import type { FeatureDef } from './features.ts';
import type { Gap } from './gaps.ts';
import type { MessageDef } from './messages.ts';
import type { OperationDef } from './resources.ts';
import type { NamedShape } from './shapes.ts';

export interface DepExtension {
  owner: string;
  shapes: readonly NamedShape[];
  messages: readonly MessageDef[];
  operations: readonly OperationDef[];
  notifications: readonly NotificationDef[];
  webhooks: readonly WebhookDef[];
  features: readonly FeatureDef[];
}

/** The whole protocol definition of one major version. */
export interface DepDefinition {
  version: string;
  major: number;
  subprotocol: string;
  /** Draft until the protocol is frozen after a second server passes `core` (05 §11). */
  status: 'draft' | 'final';
  engines: readonly string[];
  /** The CDM versions this release of the protocol carries (05 §2 `cdm`; PRO-003). */
  cdm: { min: number; max: number };
  shapes: readonly NamedShape[];
  messages: readonly MessageDef[];
  operations: readonly OperationDef[];
  notifications: readonly NotificationDef[];
  webhooks: readonly WebhookDef[];
  features: readonly FeatureDef[];
  errors: readonly ErrorDef[];
  closeCodes: readonly CloseCodeDef[];
  gaps: readonly Gap[];
  decisions: readonly Decision[];
}
