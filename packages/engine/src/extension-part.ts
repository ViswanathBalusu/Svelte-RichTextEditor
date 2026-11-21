/**
 * The `extension` part (`./parts.ts`; FND-008): the range-based document API that the core gives a
 * host extension (UX-053; `DocumentCore.extensionApi`). The element does not give it to the shell
 * yet, so the first load does not carry it. A host or a test that asks the core for one loads the
 * part first (`loadParts(['extension'])`).
 *
 * The module reads no clock and no store. It is universal: no Node.js or browser API.
 */
export { ExtensionApi } from './extension-api.ts';
