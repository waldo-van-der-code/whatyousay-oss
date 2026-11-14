import {
  MIN_PARAGRAPH_WORDS, detectLanguage, foreignParagraphIndexes, isForeignParagraph, splitParagraphs,
} from '../src/language-guard';
import { unifyLanguage } from '../src/pipeline';

const check = (ok: boolean, message: string) => { if (!ok) throw new Error(message); };

// ── Detection ─────────────────────────────────────────────────────────────────

// WAY-48: the reported shape — a German note whose middle paragraph came back in English.
// Reworded from the report; the real note was a private message.
const driftedDe = [
  'Hey, vielen Dank für die Besichtigung gestern. Ich hoffe, dir geht es auch viel besser mittlerweile.',
  'Also, wir waren sehr froh, das Gewerbe und auch die hintere Unit zu sehen, und das matcht auch unsere Erwartungen. Wir haben auf jeden Fall Interesse am Kauf.',
  'We would like to have a relationship with the market. That is the direction we want to go and we have experience. We will look at a few other companies. Price is an important thing.',
  'Hier werden wir nochmal Rückmeldungen geben. Interessant wäre, ob du von deiner Seite aus noch mögliche Bewegungen im Preis siehst.',
].join('\n\n');

check(splitParagraphs(driftedDe).length === 4, 'Paragraph split lost a block');
check(detectLanguage(splitParagraphs(driftedDe)[1]) === 'de', 'German paragraph was not recognised as German');
check(detectLanguage(splitParagraphs(driftedDe)[2]) === 'en', 'English paragraph was not recognised as English');
check(
  JSON.stringify(foreignParagraphIndexes(driftedDe, 'de')) === '[2]',
  'The drifted paragraph was not the one and only paragraph flagged',
);
check(foreignParagraphIndexes(driftedDe, 'en').length === 3, 'With an English reply the German paragraphs must be flagged');

// A clean single-language note must never be touched.
const cleanDe = [
  'Hallo zusammen, ich wollte nur kurz Bescheid geben, dass ich heute Abend später komme.',
  'Wir sehen uns dann morgen früh im Büro und können da in Ruhe über alles sprechen, was noch offen ist.',
].join('\n\n');
check(foreignParagraphIndexes(cleanDe, 'de').length === 0, 'A fully German note was flagged');
check(foreignParagraphIndexes('I will send the deck over tonight so that everybody can read it before we meet.', 'en').length === 0,
  'A fully English note was flagged');

// Embedded English inside German speech is the speaker's own word choice — never a drift.
const embedded = 'Ja, wir haben uns den Business Case nochmal angeschaut und das Pricing passt eigentlich, aber wir müssen das Timing nochmal checken und dann machen wir ein Follow-up.';
check(!isForeignParagraph(embedded, 'de'), 'Embedded English words were mistaken for a language switch');

// Short blocks are quotes, sign-offs or names, not paragraphs worth rewriting.
check(!isForeignParagraph('Thanks a lot and see you.', 'de'), 'A short English line was flagged');
check(detectLanguage('und das ist so') === 'de', 'Short text may still be detected, only not flagged');

// Dutch and German share too many function words to call a tie — undecided beats wrong.
check(!isForeignParagraph('We gingen gisteren samen naar de markt en daarna hebben we nog iets gedronken bij dat kleine café.', 'nl'),
  'A Dutch paragraph was flagged under a Dutch reply');
check(isForeignParagraph('We gingen gisteren samen naar de markt en daarna hebben we nog iets gedronken bij dat kleine café.', 'en'),
  'A Dutch paragraph went unflagged under an English reply');

// An unprofiled language can never be judged, in either direction: no flag, no damage.
const finnish = 'Minä menin eilen kauppaan ja ostin leipää, maitoa sekä juustoa, koska jääkaappi oli aivan tyhjä.';
check(foreignParagraphIndexes(finnish, 'fi').length === 0, 'An unprofiled reply language produced a flag');
check(!isForeignParagraph(finnish, 'de'), 'Unrecognised text was flagged as foreign');

check(MIN_PARAGRAPH_WORDS >= 8, 'The paragraph floor is too low to protect quoted speech');

// ── Repair ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const germanFor = (_: string) => 'Wir möchten eine Beziehung zum Markt aufbauen. In diese Richtung wollen wir gehen und wir haben Erfahrung. Wir schauen uns noch ein paar andere Firmen an. Der Preis ist ein wichtiger Punkt.';
  const translator = (text: string, lang: string) =>
    Promise.resolve({ text: lang === 'de' ? germanFor(text) : text, inputTokens: 7, outputTokens: 11 });

  const repaired = await unifyLanguage(driftedDe, 'de', translator);
  check(repaired.repairedParagraphs === 1, `Expected one repaired paragraph, got ${repaired.repairedParagraphs}`);
  check(!repaired.text.includes('We would like to have'), 'The English paragraph survived the repair');
  check(repaired.text.includes('Wir möchten eine Beziehung'), 'The translated paragraph is missing');
  check(splitParagraphs(repaired.text).length === 4, 'The repair changed the paragraph structure');
  check(splitParagraphs(repaired.text)[0] === splitParagraphs(driftedDe)[0], 'An on-target paragraph was rewritten');
  check(repaired.inputTokens === 7 && repaired.outputTokens === 11, 'Repair tokens were not reported');

  // Nothing to repair ⇒ no LLM call at all.
  let calls = 0;
  const counting = (text: string) => { calls++; return Promise.resolve({ text, inputTokens: 1, outputTokens: 1 }); };
  const untouched = await unifyLanguage(cleanDe, 'de', counting);
  check(calls === 0, 'A clean note still called the translator');
  check(untouched.text === cleanDe, 'A clean note was modified');

  // A translation that comes back short, empty, or still foreign is refused: the speaker's
  // own words are always better than a half-dropped rewrite.
  for (const bad of ['', 'Ja.', 'We would like to have a relationship with the market anyway.']) {
    const refused = await unifyLanguage(driftedDe, 'de', () => Promise.resolve({ text: bad, inputTokens: 1, outputTokens: 1 }));
    check(refused.text === driftedDe, `A bad translation ("${bad.slice(0, 20)}") replaced the original`);
    check(refused.repairedParagraphs === 0, 'A refused repair was counted as repaired');
  }

  // If most of the note is "foreign", the reply language itself is wrong — rewriting the
  // whole message would be the bigger error, so the note goes out as spoken.
  const mostlyEnglish = [
    'I wanted to let you know that the meeting has moved to Thursday afternoon, same room as before.',
    'Please bring the printed agenda with you because we will not have time to go through it on screen.',
    'Ich schicke dir die Unterlagen aber trotzdem noch heute Abend per Mail zu, damit du sie vorher hast.',
  ].join('\n\n');
  let majorityCalls = 0;
  const majority = await unifyLanguage(mostlyEnglish, 'de', (text) => { majorityCalls++; return Promise.resolve({ text, inputTokens: 0, outputTokens: 0 }); });
  check(majorityCalls === 0, 'A note that is mostly off-target was rewritten instead of left alone');
  check(majority.text === mostlyEnglish, 'A mostly off-target note was modified');

  console.log('WAY-48 language guard checks passed');
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
