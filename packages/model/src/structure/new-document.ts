/**
 * A new, empty document (03 §4.1, §12; CDM-016): settings, every built-in style under its
 * reserved identifier, one page setup and a body with one empty paragraph. Every definition that
 * is not built in gets a random identifier (03 §4.1). The built-in styles carry their structure
 * (kind, name, `basedOn`, heading levels) and no formatting: how they look is the house
 * template's, which this model does not decide.
 */
import type { JsonEnvelope, JsonNode } from '../canonical/canonical-form.ts';
import { nodeId } from '../conventions/ids.ts';
import { BUILT_IN_STYLES } from '../definition/cdm1.ts';

export interface NewDocumentOptions {
  /** Document language (BCP 47), for `settings.lang`. */
  lang?: string;
  /** Identifier source; defaults to 16 random URL-safe Base64 characters (03 §9). */
  newId?: () => string;
}

/** The human-readable name of a built-in style: `Heading1` is "Heading 1". */
export function builtInStyleName(id: string): string {
  return id
    .replace(/([a-z])([A-Z0-9])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Z])([0-9])/g, '$1 $2');
}

function builtInStyle(id: string, kind: string): JsonNode {
  const attrs: Record<string, string | number | boolean> = {
    id,
    kind,
    name: builtInStyleName(id),
    builtIn: true,
  };
  const heading = /^Heading([1-9])$/.exec(id);
  if (kind === 'paragraph' && id !== 'Normal') attrs['basedOn'] = 'Normal';
  if (heading) {
    attrs['outlineLevel'] = Number(heading[1]);
    attrs['next'] = 'Normal';
  }
  if (id === 'Footer') attrs['basedOn'] = 'Header';
  if (id === 'TableGrid') attrs['basedOn'] = 'TableNormal';
  return { type: 'style_def', attrs };
}

/** A new document envelope that `validate()` accepts. */
export function newDocument(opts: NewDocumentOptions = {}): JsonEnvelope {
  const newId = opts.newId ?? nodeId;
  const pageSetup = newId();
  const settings: JsonNode = opts.lang
    ? { type: 'settings', attrs: { lang: opts.lang } }
    : { type: 'settings' };
  const styles = Object.entries(BUILT_IN_STYLES).map(([id, kind]) => builtInStyle(id, kind));
  return {
    cdm: 1,
    requires: [],
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [settings, ...styles, { type: 'page_setup', attrs: { id: pageSetup } }],
        },
        {
          type: 'body',
          attrs: { pageSetup },
          content: [{ type: 'paragraph', attrs: { id: newId() } }],
        },
      ],
    },
  };
}
