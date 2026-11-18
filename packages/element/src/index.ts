/**
 * `@docedit/element`: the `<doc-editor>` element (02 §2; 05 §8). Importing this module registers
 * `doc-editor` unless the name is taken (FE-001). Where there is no DOM (Node.js, server-side
 * rendering) it defines nothing and reads no browser global: the check is `'customElements' in
 * globalThis`, and the editor's code is a separate chunk that loads with the first document.
 */
import { defineDocEditor } from './register.ts';

export { DocEditorElement, OBSERVED_ATTRIBUTES, type GetToken } from './doc-editor.ts';
export { DEFAULT_TAG, defineDocEditor, type DefineResult } from './register.ts';
export { EMBEDDING_VERSION, RELEASE } from './version.ts';
export type { DocEditorConfig } from './config.ts';
export type { HostExtension, HostExtensionApi, HostExtensionManifest } from './extensions.ts';
export {
  FillActionError,
  type CompleteFillingOutcome,
  type FillActionReason,
  type FillFailure,
} from './fill-actions.ts';
export {
  EVENT_NAMES,
  type Connection,
  type DocEditorEventMap,
  type DocEditorEventName,
  type ErrorDetail,
  type StatusDetail,
  type SyncState,
} from './events.ts';

if ('customElements' in globalThis) defineDocEditor();
