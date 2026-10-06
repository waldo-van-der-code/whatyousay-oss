/** Measure how much cleanup changed the recognizer's words, ignoring punctuation/case. */
export function transcriptEditRate(raw: string, cleaned: string): number {
  const tokens = (text: string) => text.toLowerCase()
    .replace(/[‘’ʼ]/gu, "'")
    .replace(/[‐‑‒–—−]/gu, '-')
    .replace(/[^\p{L}\p{N}'\s-]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  const source = tokens(raw);
  const result = tokens(cleaned);
  if (!source.length) return 0;
  let row = Array.from({ length: source.length + 1 }, (_, i) => i);
  for (let i = 1; i <= result.length; i++) {
    const next = [i];
    for (let j = 1; j <= source.length; j++) {
      next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (result[i - 1] === source[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[source.length] / source.length;
}

/** WAY-47: catch Dutch cleanup drafts that change a configured name or Spree. */
export function dutchFidelityIssues(raw: string, cleaned: string, knownNames?: string): string[] {
  const tokens = (text: string) => text.toLocaleLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
  const contains = (haystack: string[], needle: string[]) =>
    needle.length > 0 && (` ${haystack.join(' ')} `).includes(` ${needle.join(' ')} `);
  const rawTokens = tokens(raw);
  const cleanTokens = tokens(cleaned);
  const names = (knownNames ?? '').split(',').map(name => name.trim().replace(/\.+$/u, ''));
  const configuredNameLost = names.some(name => {
    const nameTokens = tokens(name);
    return contains(rawTokens, nameTokens) && !contains(cleanTokens, nameTokens);
  });
  // Unconfigured place names in the audio need protection too. Do not
  // treat every cased Whisper token as a name: it would reject valid ASR repairs.
  const spreeLost = /\bSpree\b/iu.test(raw) && !contains(cleanTokens, ['spree']);
  const knownNameLost = configuredNameLost || spreeLost;
  return knownNameLost ? ['known_name_lost'] : [];
}

/** Keep Whisper's words while borrowing safe punctuation and paragraphs from an LLM draft. */
export function mergeTranscriptFormatting(raw: string, draft: string): string {
  if (!raw.trim() || !draft.trim()) return raw;

  const pattern = /[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu;
  const tokenize = (text: string) => [...text.matchAll(pattern)].map(match => ({
    word: match[0], start: match.index, end: match.index + match[0].length,
  }));
  const source = tokenize(raw);
  const proposed = tokenize(draft);
  if (!source.length || !proposed.length) return raw;

  const normalized = (word: string) => word.toLocaleLowerCase();
  const table = Array.from({ length: source.length + 1 }, () => new Uint16Array(proposed.length + 1));
  for (let i = source.length - 1; i >= 0; i--) {
    for (let j = proposed.length - 1; j >= 0; j--) {
      table[i][j] = normalized(source[i].word) === normalized(proposed[j].word)
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const matches = new Map<number, number>();
  for (let i = 0, j = 0; i < source.length && j < proposed.length;) {
    if (normalized(source[i].word) === normalized(proposed[j].word)) {
      matches.set(i++, j++);
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  if (!matches.size) return raw;

  let result = raw.slice(0, source[0].start);
  for (let i = 0; i < source.length; i++) {
    const sourceToken = source[i];
    const proposedIndex = matches.get(i);
    let word = sourceToken.word;
    const startsSentence = i === 0 || /(?:[.!?]\s*|\n\n)$/u.test(result);
    if (/^\p{Ll}/u.test(word) && (startsSentence || proposedIndex !== undefined
      && /^\p{Lu}/u.test(proposed[proposedIndex].word) && matches.get(i - 1) === proposedIndex - 1)) {
      word = word[0].toLocaleUpperCase() + word.slice(1);
    }
    result += word;

    let gap = raw.slice(sourceToken.end, source[i + 1]?.start ?? raw.length);
    if (proposedIndex !== undefined) {
      const proposedToken = proposed[proposedIndex];
      const proposedGap = draft.slice(proposedToken.end, proposed[proposedIndex + 1]?.start ?? draft.length);
      const nextAligned = i === source.length - 1 || matches.get(i + 1) === proposedIndex + 1;
      const paragraph = /\n\s*\n/u.test(proposedGap);
      if ((nextAligned || paragraph) && !/[.!?;:,]/u.test(gap)) {
        const punctuation = proposedGap.match(/[.!?;:,]/u)?.[0];
        if (punctuation) gap = punctuation + gap;
      }
      if (paragraph && i < source.length - 1) {
        gap = gap.replace(/\s*$/u, '') + '\n\n';
      }
    }
    result += gap;
  }
  return result;
}

/** Conservative language-specific fallback for cleanup drafts with many word edits. */
export function guardTranscriptCleanup(raw: string, cleaned: string, language: string): string {
  const editRate = transcriptEditRate(raw, cleaned);
  if (language === 'de' && editRate > 0.08 || language === 'en' && editRate > 0.05) {
    return mergeTranscriptFormatting(raw, cleaned);
  }
  return cleaned;
}
