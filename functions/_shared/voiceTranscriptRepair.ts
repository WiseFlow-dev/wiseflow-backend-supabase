const MONEY_CONTEXT_WORDS = new Set([
  "spent",
  "spend",
  "paid",
  "pay",
  "bought",
  "purchased",
  "received",
  "receive",
  "earned",
  "got",
  "salary",
  "income",
  "paycheck",
  "dollar",
  "dollars",
  "bucks",
  "usd",
  "euro",
  "euros",
  "pound",
  "pounds",
  "rupee",
  "rupees",
  "lira",
]);

function isEnglishLanguage(languageCode: string): boolean {
  return languageCode.toLowerCase().startsWith("en");
}

export function repairVoiceTranscript(text: string, languageCode: string): string {
  if (!isEnglishLanguage(languageCode)) return text;

  return repairDroppedLeadingOneForThousand(text);
}

function repairDroppedLeadingOneForThousand(text: string): string {
  const tokenRe = /[A-Za-z0-9]+/g;
  const tokens: Array<{
    value: string;
    lower: string;
    start: number;
    end: number;
  }> = [];
  let match: RegExpExecArray | null;

  while ((match = tokenRe.exec(text)) !== null) {
    tokens.push({
      value: match[0],
      lower: match[0].toLowerCase(),
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  if (tokens.length === 0) return text;

  const replacements: Array<{ start: number; end: number; value: string }> = [];
  tokens.forEach((token, index) => {
    if (!/^0{3}$/.test(token.value)) return;

    // If a digit token is immediately before (e.g. "1,000"), this is already
    // a correctly formatted number — don't prepend another "1".
    if (index > 0 && /^\d+$/.test(tokens[index - 1].value)) return;

    const leftContext = tokens
      .slice(Math.max(0, index - 3), index)
      .some((candidate) => MONEY_CONTEXT_WORDS.has(candidate.lower));
    const rightContext = tokens
      .slice(index + 1, Math.min(tokens.length, index + 4))
      .some((candidate) => MONEY_CONTEXT_WORDS.has(candidate.lower));

    if (leftContext || rightContext) {
      replacements.push({
        start: token.start,
        end: token.end,
        value: "1000",
      });
    }
  });

  if (replacements.length === 0) return text;

  let repaired = text;
  for (const replacement of replacements.reverse()) {
    repaired = repaired.slice(0, replacement.start) +
      replacement.value +
      repaired.slice(replacement.end);
  }
  return repaired;
}
