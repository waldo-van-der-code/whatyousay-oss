/**
 * WAY-48: one message, one language.
 *
 * The pipeline settles on a single language per note — Whisper's detection, or the
 * translation target when translation is on — and labels the reply in it. Nothing used
 * to check that the transcript body actually stayed in that language, so a note could
 * go out mostly in German with one paragraph in English (the drift Whisper and the
 * cleanup model both produce on longer notes).
 *
 * This module is the detector. It answers one question per paragraph: is this clearly
 * written in a language other than the one the reply is going out in? It is deliberately
 * conservative — an unrecognised paragraph is never flagged, because the repair that
 * follows a flag rewrites the speaker's words.
 */

/** Function words per language. Entries shared with another profile are dropped below. */
const RAW_PROFILES: Record<string, string[]> = {
  en: ['the', 'and', 'to', 'of', 'in', 'that', 'is', 'was', 'are', 'were', 'have', 'has', 'had',
    'will', 'would', 'with', 'this', 'you', 'your', 'we', 'they', 'it', 'for', 'but', 'not',
    'what', 'when', 'because', 'should', 'could', 'about', 'from', 'there', 'which', 'just',
    'like', 'really', 'going', 'want', 'need', 'know', 'think', 'our', 'their', 'my', 'me',
    'so', 'as', 'at', 'on', 'be', 'been', 'do', 'does', 'did', 'can', 'very', 'also', 'then',
    'than', 'more', 'some', 'any', 'all', 'one', 'out', 'up', 'if', 'or', 'an', 'a', 'no'],
  de: ['der', 'die', 'das', 'und', 'ist', 'sind', 'war', 'waren', 'nicht', 'auch', 'ein', 'eine',
    'einen', 'einem', 'einer', 'mit', 'für', 'auf', 'dass', 'wir', 'ihr', 'sie', 'ich', 'du',
    'noch', 'schon', 'aber', 'oder', 'wenn', 'weil', 'haben', 'hat', 'hatte', 'werden', 'wird',
    'wurde', 'kann', 'können', 'muss', 'müssen', 'sehr', 'mal', 'halt', 'ja', 'zu', 'von', 'im',
    'am', 'beim', 'nach', 'bei', 'dem', 'den', 'des', 'es', 'man', 'sich', 'nur', 'wie', 'was',
    'so', 'dann', 'mehr', 'als', 'um', 'über', 'aus', 'doch', 'eigentlich', 'ne'],
  nl: ['de', 'het', 'een', 'en', 'is', 'zijn', 'was', 'waren', 'niet', 'ook', 'met', 'voor', 'op',
    'dat', 'wij', 'we', 'jij', 'je', 'ik', 'nog', 'al', 'maar', 'of', 'als', 'omdat', 'hebben',
    'heeft', 'had', 'worden', 'wordt', 'werd', 'kan', 'kunnen', 'moet', 'moeten', 'heel', 'even',
    'hoor', 'dus', 'naar', 'bij', 'om', 'te', 'van', 'in', 'toch', 'hè', 'er', 'die', 'dit',
    'wat', 'zo', 'dan', 'meer', 'uit', 'over', 'ze', 'hun', 'mijn', 'jouw'],
  fr: ['le', 'la', 'les', 'un', 'une', 'des', 'et', 'est', 'sont', 'était', 'pas', 'aussi', 'avec',
    'pour', 'sur', 'que', 'nous', 'vous', 'je', 'tu', 'il', 'elle', 'ils', 'mais', 'ou', 'parce',
    'avoir', 'ont', 'peut', 'très', 'bien', 'dans', 'du', 'au', 'aux', 'ce', 'cette', 'se', 'ne',
    'plus', 'comme', 'quoi', 'alors', 'me', 'de', 'en', 'a', 'si', 'mon', 'leur'],
  es: ['el', 'la', 'los', 'las', 'un', 'una', 'y', 'es', 'son', 'era', 'no', 'también', 'con',
    'para', 'sobre', 'que', 'nosotros', 'ustedes', 'yo', 'tú', 'él', 'ella', 'pero', 'o',
    'porque', 'tener', 'tiene', 'puede', 'muy', 'bien', 'en', 'de', 'del', 'al', 'este', 'esta',
    'se', 'más', 'como', 'qué', 'entonces', 'me', 'si', 'mi', 'su', 'ya', 'está'],
  it: ['il', 'lo', 'la', 'gli', 'le', 'un', 'una', 'e', 'è', 'sono', 'era', 'non', 'anche', 'con',
    'per', 'su', 'che', 'noi', 'voi', 'io', 'tu', 'lui', 'lei', 'ma', 'o', 'perché', 'avere',
    'ha', 'può', 'molto', 'bene', 'in', 'di', 'del', 'al', 'questo', 'questa', 'si', 'più',
    'come', 'cosa', 'allora', 'me', 'mi', 'se', 'sua'],
  pt: ['o', 'a', 'os', 'as', 'um', 'uma', 'e', 'é', 'são', 'era', 'não', 'também', 'com', 'para',
    'sobre', 'que', 'nós', 'vocês', 'eu', 'tu', 'ele', 'ela', 'mas', 'ou', 'porque', 'ter', 'tem',
    'pode', 'muito', 'bem', 'em', 'de', 'do', 'da', 'ao', 'este', 'esta', 'se', 'mais', 'como',
    'então', 'me', 'se', 'meu', 'já', 'está'],
};

/**
 * A word shared by two profiles ("in", "die", "was", "de") says nothing about which
 * language a paragraph is in, so only words unique to one profile are scored. Doing it
 * here rather than by hand keeps the lists above readable and self-correcting: adding a
 * language cannot silently poison an existing profile.
 */
const DISCRIMINATIVE: Record<string, ReadonlySet<string>> = (() => {
  const owners = new Map<string, string[]>();
  for (const [lang, words] of Object.entries(RAW_PROFILES)) {
    for (const word of new Set(words)) owners.set(word, [...(owners.get(word) ?? []), lang]);
  }
  const out: Record<string, Set<string>> = {};
  for (const lang of Object.keys(RAW_PROFILES)) out[lang] = new Set();
  for (const [word, langs] of owners) if (langs.length === 1) out[langs[0]].add(word);
  return out;
})();

/** Languages this module can judge. Anything else is never flagged — see detectLanguage. */
export const PROFILED_LANGUAGES: readonly string[] = Object.keys(RAW_PROFILES);

/**
 * Thresholds. They are intentionally cautious: the cost of a missed drift is a paragraph
 * the reader has to work through in the wrong language, while the cost of a false flag is
 * a paragraph of the speaker's own words replaced by a machine translation.
 */
/** A short block can be a quoted phrase or a name; only real paragraphs are judged. */
export const MIN_PARAGRAPH_WORDS = 12;
/** The winning language must account for at least this share of the paragraph's words. */
const MIN_SHARE = 0.12;
/** ...and beat the runner-up by this factor, so de/nl near-ties stay undecided. */
const MIN_MARGIN = 1.6;
/** A paragraph with this much signal in the reply's own language is left alone. */
const MAX_TARGET_SHARE = 0.06;

export function splitParagraphs(text: string): string[] {
  return text.split(/\n\s*\n/);
}

function words(text: string): string[] {
  return text.toLocaleLowerCase().match(/[\p{L}]+(?:['’][\p{L}]+)*/gu) ?? [];
}

export function languageShares(text: string): Record<string, number> {
  const tokens = words(text);
  const shares: Record<string, number> = {};
  for (const lang of PROFILED_LANGUAGES) shares[lang] = 0;
  if (!tokens.length) return shares;
  for (const token of tokens) {
    for (const lang of PROFILED_LANGUAGES) if (DISCRIMINATIVE[lang].has(token)) shares[lang]++;
  }
  for (const lang of PROFILED_LANGUAGES) shares[lang] /= tokens.length;
  return shares;
}

/**
 * Best-guess language of a block of text, or null when the evidence is not clear enough.
 * Null is the normal answer for a short block, an unprofiled language, or a de/nl tie.
 */
export function detectLanguage(text: string): string | null {
  const shares = languageShares(text);
  const ranked = Object.entries(shares).sort((a, b) => b[1] - a[1]);
  const [best, bestShare] = ranked[0];
  const runnerUp = ranked[1]?.[1] ?? 0;
  if (bestShare < MIN_SHARE) return null;
  if (runnerUp > 0 && bestShare < runnerUp * MIN_MARGIN) return null;
  return best;
}

/**
 * True when this paragraph is clearly not in `target`. Embedded foreign words and phrases
 * inside an otherwise on-target paragraph never trip this — the paragraph keeps enough of
 * the target's own function words to stay under MAX_TARGET_SHARE.
 */
export function isForeignParagraph(paragraph: string, target: string): boolean {
  if (!PROFILED_LANGUAGES.includes(target)) return false;
  if (words(paragraph).length < MIN_PARAGRAPH_WORDS) return false;
  const detected = detectLanguage(paragraph);
  if (!detected || detected === target) return false;
  return languageShares(paragraph)[target] < MAX_TARGET_SHARE;
}

/** Indexes (into splitParagraphs) of the paragraphs that are not in `target`. */
export function foreignParagraphIndexes(text: string, target: string): number[] {
  return splitParagraphs(text).flatMap((paragraph, index) =>
    isForeignParagraph(paragraph, target) ? [index] : []);
}
