/**
 * Languages (09 §3.1, Languages; EXP-027). `babel` is loaded by the class through its ini-based
 * interface only (`\babelprovide[import=<tag>]`), with shorthands off, so no language module
 * rewrites the text. A language is chosen through `enumLookup` from the fixed table below; a tag
 * without an entry prints in the document language, with a warning naming the tag.
 */
import { diag, type Ctx } from './context.ts';
import { lit, type Tex } from './emit.ts';

const t = lit;

/** BCP 47 tag to the babel name and the ini tag the class imports. */
export const LANGUAGES: Readonly<Record<string, { name: Tex; ini: Tex; tag: Tex }>> = {
  en: { name: t('english'), ini: t('en'), tag: t('en') },
  'en-GB': { name: t('british'), ini: t('en-GB'), tag: t('en-GB') },
  'en-US': { name: t('american'), ini: t('en-US'), tag: t('en-US') },
  'en-AU': { name: t('australian'), ini: t('en-AU'), tag: t('en-AU') },
  'en-CA': { name: t('canadian'), ini: t('en-CA'), tag: t('en-CA') },
  'en-NZ': { name: t('newzealand'), ini: t('en-NZ'), tag: t('en-NZ') },
  de: { name: t('ngerman'), ini: t('de'), tag: t('de') },
  'de-DE': { name: t('ngerman'), ini: t('de'), tag: t('de-DE') },
  'de-AT': { name: t('naustrian'), ini: t('de-AT'), tag: t('de-AT') },
  'de-CH': { name: t('nswissgerman'), ini: t('de-CH'), tag: t('de-CH') },
  fr: { name: t('french'), ini: t('fr'), tag: t('fr') },
  'fr-FR': { name: t('french'), ini: t('fr'), tag: t('fr-FR') },
  'fr-CA': { name: t('canadien'), ini: t('fr-CA'), tag: t('fr-CA') },
  es: { name: t('spanish'), ini: t('es'), tag: t('es') },
  'es-ES': { name: t('spanish'), ini: t('es'), tag: t('es-ES') },
  it: { name: t('italian'), ini: t('it'), tag: t('it') },
  'it-IT': { name: t('italian'), ini: t('it'), tag: t('it-IT') },
  nl: { name: t('dutch'), ini: t('nl'), tag: t('nl') },
  'nl-NL': { name: t('dutch'), ini: t('nl'), tag: t('nl-NL') },
  pt: { name: t('portuguese'), ini: t('pt'), tag: t('pt') },
  'pt-PT': { name: t('portuguese'), ini: t('pt'), tag: t('pt-PT') },
  'pt-BR': { name: t('brazilian'), ini: t('pt-BR'), tag: t('pt-BR') },
  sv: { name: t('swedish'), ini: t('sv'), tag: t('sv') },
  da: { name: t('danish'), ini: t('da'), tag: t('da') },
  nb: { name: t('norsk'), ini: t('nb'), tag: t('nb') },
  fi: { name: t('finnish'), ini: t('fi'), tag: t('fi') },
  pl: { name: t('polish'), ini: t('pl'), tag: t('pl') },
  cs: { name: t('czech'), ini: t('cs'), tag: t('cs') },
  hu: { name: t('hungarian'), ini: t('hu'), tag: t('hu') },
  ro: { name: t('romanian'), ini: t('ro'), tag: t('ro') },
  el: { name: t('greek'), ini: t('el'), tag: t('el') },
  ga: { name: t('irish'), ini: t('ga'), tag: t('ga') },
  cy: { name: t('welsh'), ini: t('cy'), tag: t('cy') },
};

/** The class's number for a language, registered on first use; null for an unknown tag. */
export function languageRef(ctx: Ctx, tag: string, blockId: string | null): number | null {
  if (!Object.hasOwn(LANGUAGES, tag)) {
    const key = `lang:${tag}`;
    if (!ctx.warned.has(key)) {
      ctx.warned.add(key);
      diag(
        ctx,
        'warning',
        'language_unknown',
        blockId,
        `the language "${tag.slice(0, 64)}" has no entry; the document language is used`,
      );
    }
    return null;
  }
  const known = ctx.languages.get(tag);
  if (known !== undefined) return known;
  const k = ctx.languages.size + 1;
  ctx.languages.set(tag, k);
  return k;
}
