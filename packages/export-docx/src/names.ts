/**
 * Names in element trees and in comparisons (03 §4.6; spike S11, model change 3; CDM-051): a name
 * in a registered namespace is written with its registered short prefix (`w:val`), a name in any
 * other namespace in Clark notation (`{uri}local`), and a name without a namespace as its bare
 * local name. The spelling depends on the namespace URI only, never on the prefix a part happens to
 * bind, so every name has exactly one spelling: two spellings would hash differently and defeat the
 * sharing of `preserved_def` trees (I11 refuses a Clark name of a registered namespace).
 */
import { PRESERVED_PREFIXES } from '@docedit/model/definition';

const PREFIX_OF = new Map<string, string>();
const URI_OF = new Map<string, string>();
for (const [prefix, uri] of Object.entries(PRESERVED_PREFIXES)) {
  if (!PREFIX_OF.has(uri)) PREFIX_OF.set(uri, prefix);
  URI_OF.set(prefix, uri);
}

/** The registered prefix of a namespace, if it has one. */
export const registeredPrefix = (uri: string): string | undefined => PREFIX_OF.get(uri);

/** The one spelling of a name: `prefix:local`, `{uri}local` or `local`. */
export function pname(ns: string, local: string): string {
  if (!ns) return local;
  const p = PREFIX_OF.get(ns);
  return p === undefined ? `{${ns}}${local}` : `${p}:${local}`;
}

export class NameError extends Error {
  override name = 'NameError';
}

/** The namespace URI and local name of a name spelt by {@link pname}. */
export function splitPname(name: string): [string, string] {
  if (name.startsWith('{')) {
    const close = name.indexOf('}');
    if (close < 0) throw new NameError(`malformed name ${name.slice(0, 64)}`);
    return [name.slice(1, close), name.slice(close + 1)];
  }
  const colon = name.indexOf(':');
  if (colon < 0) return ['', name];
  const uri = URI_OF.get(name.slice(0, colon));
  if (uri === undefined) throw new NameError(`unregistered prefix in ${name.slice(0, 64)}`);
  return [uri, name.slice(colon + 1)];
}
