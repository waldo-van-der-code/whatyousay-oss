import { dutchFidelityIssues, guardTranscriptCleanup, mergeTranscriptFormatting, transcriptEditRate } from '../src/transcript-format';

// Regression WAY-45: a cleanup draft may paraphrase or drop speech; formatting must not.
const raw = 'hallo tom hier ist jonas ja danke für deine nachricht am 10. und 13.';
const draft = 'Hallo Tom, hier ist Jonas.\n\nDanke für deine Nachricht am Zehnten und Dreizehnten.';
const formatted = mergeTranscriptFormatting(raw, draft);
const lexical = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(' ') ?? '';
if (lexical(formatted) !== lexical(raw)) throw new Error('Formatting changed raw words or numbers');
if (!lexical(formatted).includes('jonas ja danke')) throw new Error('A spoken word was dropped');
if (!formatted.includes('Jonas.\n\nJa')) throw new Error('Expected sentence and paragraph formatting was not carried across');
if (mergeTranscriptFormatting(raw, '') !== raw) throw new Error('Empty draft must keep raw transcript');
if (transcriptEditRate('Hello, world!', 'hello world.') !== 0) throw new Error('Punctuation must not count as a word edit');
if (transcriptEditRate('Like, like, I agree.', 'Like, I agree.') <= 0.05) throw new Error('Dropped spoken word must trip the English guard');
if (transcriptEditRate('I’m sure that’s true.', "I'm sure that's true.") !== 0) throw new Error('Curly apostrophes must not count as edits');
if (transcriptEditRate('A 15‑minute note.', 'A 15-minute note.') !== 0) throw new Error('Hyphen lookalikes must not count as edits');
const namedFallback = guardTranscriptCleanup('Hallo Mirah, ja, das ist ein schöner Tag.', 'Hallo Mira, das ist ein Tag.', 'de');
if (!namedFallback.includes('Mirah, ja, das ist ein schöner Tag')) throw new Error('German fallback must prefer raw speech over uncertain name changes');
const namedLowEdit = guardTranscriptCleanup('Hallo Mirah, bis morgen. Wir treffen uns dann am Bahnhof und gehen gemeinsam zum kleinen Café in der Innenstadt, falls du Zeit hast.', 'Hallo Mira, bis morgen. Wir treffen uns dann am Bahnhof und gehen gemeinsam zum kleinen Café in der Innenstadt, falls du Zeit hast.', 'de');
if (!namedLowEdit.includes('Mira')) throw new Error('Low-edit German name correction was rejected');
const inventedName = guardTranscriptCleanup('Many people came to the party and they left early.', 'Manny people came to the party, but they left early.', 'en');
if (!inventedName.startsWith('Many people')) throw new Error('Guard must not invent a configured-looking name');
const dutchWords = guardTranscriptCleanup('twintig grapjes dus', '20 grapjes', 'nl');
if (dutchWords !== '20 grapjes') throw new Error('Dutch candidate must remain unguarded by German/English thresholds');
// Regression WAY-47: a cleanup that changes a supplied or recognizer-cased
// place name must be retried, even if its overall word count still looks healthy.
const source = 'We fietsten samen langs de Spree. Het was een mooie middag. En een die ik zeker zal onthouden. Daarna gingen we naar huis.';
const lost = 'We fietsten samen langs de spreeuwen. Het was een mooie middag. En ik hoop dat het goed komt. Daarna gingen we naar huis.';
const faithful = 'We fietsten samen langs de Spree. Het was een mooie middag, en eentje die ik zeker zal onthouden, daarna gingen we naar huis.';
const lostIssues = dutchFidelityIssues(source, lost, 'Spree.');
if (!lostIssues.includes('known_name_lost')) throw new Error('Known Spree name change went undetected');
if (dutchFidelityIssues(source, faithful, 'Spree.').length) throw new Error('Faithful Dutch correction was wrongly rejected');
if (!dutchFidelityIssues('We voeren over de Spree.', 'We voeren over de spreeuwen.').includes('known_name_lost')) throw new Error('Unconfigured source-cased Spree name change went undetected');
if (dutchFidelityIssues('We gingen naar het Feest.', 'We gingen naar het festival.').length) throw new Error('Unconfigured cased words must not all be protected as names');
if (!dutchFidelityIssues('We voeren Spree op en af.', 'We voeren spreeuwen op en af.').includes('known_name_lost')) throw new Error('Unconfigured Spree without an article went unprotected');
if (dutchFidelityIssues('Ik kreeg bericht. We zijn thuis.', 'Ik kreeg bericht. Wij zijn thuis.').length) throw new Error('Sentence-start capitalization was wrongly treated as a name');
console.log('WAY-45 transcript formatting checks passed');
