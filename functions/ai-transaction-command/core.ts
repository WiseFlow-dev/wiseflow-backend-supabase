export type CommandIntent =
  | "expense"
  | "income"
  | "transfer"
  | "question"
  | "future"
  | "unknown";

export type AiCommandPayload = {
  intent: CommandIntent;
  completed: boolean;
  typeConfidence: number;
  amountMajor: string | null;
  currencyCode: string | null;
  title: string | null;
  merchant: string | null;
  dateYmd: string | null;
  walletId: string | null;
  requestedWalletName: string | null;
  categoryName: string | null;
  categoryConfidence: number;
};

export type AllowedWallet = {
  id: string;
  name: string;
  type: string;
  currencyCode: string;
};

export type AllowedCategory = {
  id: string | null;
  name: string;
};

export type ResolvedTransaction = {
  transactionType: "expense" | "income";
  typeConfidence: number;
  amountMinor: number;
  sourceCurrency: string;
  title: string;
  merchant: string | null;
  dateYmd: string;
  dateWasSpecified: boolean;
  wallet: AllowedWallet;
  category: AllowedCategory;
  categoryConfidence: number;
};

export type Resolution =
  | { outcome: "parsed"; transaction: ResolvedTransaction }
  | {
    outcome:
      | "not_transaction"
      | "missing_information"
      | "unknown_wallet"
      | "linked_wallet_blocked";
    code: string;
  };

const DATE_YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_CURRENCY_RE = /^[A-Z]{3}$/;
const SUPPORTED_CURRENCY_CODES = new Set(
  Intl.supportedValuesOf("currency").map((code) => code.toUpperCase()),
);

export function normalizeCurrencyCodeOrNull(value: unknown): string | null {
  const code = String(value ?? "").trim().toUpperCase();
  if (!ISO_CURRENCY_RE.test(code)) return null;
  return SUPPORTED_CURRENCY_CODES.has(code) ? code : null;
}

export function isValidDateYmd(value: string): boolean {
  if (!DATE_YMD_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value;
}

export function normalizeText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Future / planning cues. If the user describes something that has NOT happened
// yet ("I will...", "tomorrow", "going to pay"), it must never be saved as a
// completed transaction, no matter what the model guessed. These are kept
// deliberately distinct from PAST references like "yesterday" / "last week" /
// "last month", which stay valid. normalizeText turns "I'll" into "i ll" and
// "next week" stays "next week", so the run-on contractions are matched too.
const FUTURE_INTENT_RE =
  /\b(?:will|gonna|going to|plan to|planning|want to|(?:i|we|you|he|she|they|it) ll|tomorrow|next week|next month|next year)\b/;

export function hasFutureIntent(rawText: unknown): boolean {
  const text = normalizeText(rawText);
  if (!text) return false;
  return FUTURE_INTENT_RE.test(text);
}

export function clampConfidence(value: unknown): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 0;
  const scaled = numberValue > 1 ? numberValue / 100 : numberValue;
  return Math.max(0, Math.min(1, scaled));
}

export function parseJsonObject(raw: string): Record<string, unknown> | null {
  const cleaned = raw
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(cleaned.slice(start, end + 1));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }
}

export function parseAiCommand(raw: string): AiCommandPayload | null {
  const value = parseJsonObject(raw);
  if (!value) return null;
  const intent = String(value.intent ?? "").trim()
    .toLowerCase() as CommandIntent;
  if (
    !["expense", "income", "transfer", "question", "future", "unknown"]
      .includes(intent)
  ) {
    return null;
  }

  const nullableString = (input: unknown): string | null => {
    const text = String(input ?? "").trim();
    return text && text.toLowerCase() !== "null" ? text : null;
  };

  return {
    intent,
    completed: value.completed === true,
    typeConfidence: clampConfidence(value.typeConfidence),
    amountMajor: nullableString(value.amountMajor),
    currencyCode: nullableString(value.currencyCode)?.toUpperCase() ?? null,
    title: nullableString(value.title),
    merchant: nullableString(value.merchant),
    dateYmd: nullableString(value.dateYmd),
    walletId: nullableString(value.walletId),
    requestedWalletName: nullableString(value.requestedWalletName),
    categoryName: nullableString(value.categoryName),
    categoryConfidence: clampConfidence(value.categoryConfidence),
  };
}

export function fractionDigitsForCurrency(currencyCode: string): number {
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: currencyCode,
    }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

export function majorStringToMinor(
  majorAmount: string,
  currencyCode: string,
): number | null {
  const digits = fractionDigitsForCurrency(currencyCode);
  const compact = majorAmount.trim().replace(/[\s']/g, "");
  if (!/^\d+(?:[.,]\d+)*$/.test(compact)) return null;

  const commaIndex = compact.lastIndexOf(",");
  const dotIndex = compact.lastIndexOf(".");
  let normalized = compact;
  if (commaIndex >= 0 && dotIndex >= 0) {
    const decimalSeparator = commaIndex > dotIndex ? "," : ".";
    const groupingSeparator = decimalSeparator === "," ? "." : ",";
    normalized = compact.split(groupingSeparator).join("")
      .replace(decimalSeparator, ".");
  } else {
    const separator = commaIndex >= 0 ? "," : dotIndex >= 0 ? "." : null;
    if (separator) {
      const separatorCount = compact.split(separator).length - 1;
      const tailLength = compact.length - compact.lastIndexOf(separator) - 1;
      const isDecimal = separatorCount === 1 &&
        digits > 0 &&
        tailLength > 0 &&
        tailLength <= digits;
      normalized = isDecimal
        ? compact.replace(separator, ".")
        : compact.split(separator).join("");
    }
  }
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;

  const [whole, fraction = ""] = normalized.split(".");
  const paddedFraction = (fraction + "0".repeat(digits)).slice(0, digits);
  const nextDigit = fraction.charAt(digits);
  let minor = BigInt(whole) * (10n ** BigInt(digits));
  if (digits > 0 && paddedFraction) minor += BigInt(paddedFraction);
  if (nextDigit && Number(nextDigit) >= 5) minor += 1n;
  if (minor <= 0n || minor > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(minor);
}

export function todayInTimeZone(timeZone: string, now = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const values = Object.fromEntries(
      parts.map((part) => [part.type, part.value]),
    );
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

function exactNameMatch<T extends { name: string }>(
  requestedName: string,
  rows: T[],
): T | null {
  const normalized = normalizeText(requestedName);
  return rows.find((row) => normalizeText(row.name) === normalized) ?? null;
}

function containsNormalizedPhrase(text: string, phrase: string): boolean {
  const normalized = normalizeText(phrase);
  if (!normalized) return false;
  return new RegExp(`\\b${normalized.replace(/\s+/g, "\\s+")}\\b`).test(text);
}

function mentionedCategory(
  text: string,
  categories: AllowedCategory[],
): AllowedCategory | null {
  return categories.find((category) => {
    const normalized = normalizeText(category.name);
    return normalized.length > 2 && containsNormalizedPhrase(text, normalized);
  }) ?? null;
}

function detectCurrencyCode(rawText: string): string | null {
  const upper = rawText.toUpperCase();
  const code = upper.match(/\b[A-Z]{3}\b/)?.[0] ?? null;
  if (code) {
    const normalized = normalizeCurrencyCodeOrNull(code);
    if (normalized) return normalized;
  }
  if (/[$]/.test(rawText)) return "USD";
  if (/\b(dollars?|bucks?)\b/i.test(rawText)) return "USD";
  if (/\brupees?\b/i.test(rawText)) return "INR";
  if (/\beuros?\b/i.test(rawText)) return "EUR";
  if (/\bpounds?\b/i.test(rawText)) return "GBP";
  if (/\blira\b/i.test(rawText)) return "TRY";
  return null;
}

function chooseDefaultWallet(
  wallets: AllowedWallet[],
  requestedWallet: AllowedWallet | null,
  sourceCurrency: string,
): AllowedWallet {
  if (requestedWallet) return requestedWallet;
  return wallets.find((wallet) =>
    wallet.currencyCode.toUpperCase() === sourceCurrency
  ) ?? wallets[0];
}

function detectAmountMajor(rawText: string): string | null {
  const hybridOrSpoken = detectSpokenOrHybridAmountMajor(rawText);
  if (hybridOrSpoken) return hybridOrSpoken;
  const match = rawText.match(
    /(?:[$]\s*)?(\d+(?:[.,]\d+)*(?:[.,]\d+)?)(?:\s*(?:usd|eur|gbp|inr|try|cad|aud|dollars?|euros?|pounds?|rupees?|lira))?/i,
  );
  return match?.[1] ?? null;
}

// Speech-to-text often returns number words ("fifty", "one hundred") instead of
// digits, and the model does not always normalize them. These tables let the
// server rescue the amount deterministically. English only, by design — the
// smallest safe scope. Other languages still rely on the model + digits.
const SPOKEN_SMALL_NUMBERS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fourty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
const SPOKEN_MAGNITUDES: Record<string, number> = {
  hundred: 100,
  thousand: 1000,
  million: 1_000_000,
};
const SPOKEN_TENS_WORDS = new Set([
  "twenty",
  "thirty",
  "forty",
  "fourty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
]);
const MONEY_CONTEXT_WORDS = new Set([
  "spent",
  "spend",
  "paid",
  "pay",
  "bought",
  "purchased",
  "ordered",
  "charged",
  "cost",
  "received",
  "receive",
  "earned",
  "got",
  "salary",
  "paycheck",
  "income",
  "refund",
  "cashback",
  "reimbursed",
  "reimbursement",
  "dollar",
  "dollars",
  "bucks",
  "buck",
  "usd",
  "euro",
  "euros",
  "eur",
  "pound",
  "pounds",
  "gbp",
  "rupee",
  "rupees",
  "inr",
  "lira",
  "try",
  "cad",
  "aud",
]);

type ParsedEnglishAmountRun = {
  value: number;
  endExclusive: number;
  sawDigit: boolean;
  sawWord: boolean;
};

function parseEnglishAmountRun(
  tokens: string[],
  startIndex: number,
): ParsedEnglishAmountRun | null {
  let total = 0;
  let current = 0;
  let started = false;
  let sawWord = false;
  let sawDigit = false;
  let consumedAny = false;
  let index = startIndex;
  for (; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "and" && started) continue;
    const digitValue = /^\d+$/.test(token) ? Number(token) : null;
    if (digitValue !== null && Number.isFinite(digitValue)) {
      const next = tokens[index + 1] ?? "";
      if (
        digitValue >= 1 &&
        digitValue <= 9 &&
        current === 0 &&
        (SPOKEN_TENS_WORDS.has(next) || next in SPOKEN_MAGNITUDES)
      ) {
        current += SPOKEN_TENS_WORDS.has(next) ? digitValue * 100 : digitValue;
      } else {
        current += digitValue;
      }
      started = true;
      sawDigit = true;
      consumedAny = true;
      continue;
    }
    if (token in SPOKEN_SMALL_NUMBERS) {
      const value = SPOKEN_SMALL_NUMBERS[token];
      const next = tokens[index + 1] ?? "";
      if (
        value >= 1 &&
        value <= 9 &&
        current === 0 &&
        SPOKEN_TENS_WORDS.has(next)
      ) {
        current += value * 100;
      } else {
        current += value;
      }
      started = true;
      sawWord = true;
      consumedAny = true;
      continue;
    }
    if (token === "hundred") {
      current = (current === 0 ? 1 : current) * 100;
      started = true;
      sawWord = true;
      consumedAny = true;
      continue;
    }
    if (token === "thousand" || token === "million") {
      total += (current === 0 ? 1 : current) * SPOKEN_MAGNITUDES[token];
      current = 0;
      started = true;
      sawWord = true;
      consumedAny = true;
      continue;
    }
    if (started) break;
    return null;
  }
  if (!consumedAny) return null;
  const value = total + current;
  if (value <= 0) return null;
  return { value, endExclusive: index, sawDigit, sawWord };
}

// Convert the first run of English number words in `text` to a plain decimal
// string: "fifty" -> "50", "one hundred" -> "100", "five hundred salary" ->
// "500", "twenty five" -> "25", "two thousand five hundred" -> "2500".
// Returns null when there are no number words. Digits are intentionally ignored
// here so this never competes with the existing numeric parser.
export function detectSpokenAmountMajor(text: string): string | null {
  return detectSpokenOrHybridAmountMajor(text);
  const tokens = normalizeText(text).split(" ").filter(Boolean);
  let total = 0;
  let current = 0;
  let started = false;
  let consumedAny = false;
  for (const token of tokens) {
    if (token in SPOKEN_SMALL_NUMBERS) {
      current += SPOKEN_SMALL_NUMBERS[token];
      started = true;
      consumedAny = true;
    } else if (token === "hundred") {
      current = (current === 0 ? 1 : current) * 100;
      started = true;
      consumedAny = true;
    } else if (token === "thousand" || token === "million") {
      total += (current === 0 ? 1 : current) * SPOKEN_MAGNITUDES[token];
      current = 0;
      started = true;
      consumedAny = true;
    } else if (token === "and" && started) {
      // "one hundred and twenty" — keep the run going.
      continue;
    } else if (started) {
      // First non-number word ends the run.
      break;
    }
  }
  if (!consumedAny) return null;
  const value = total + current;
  return value > 0 ? String(value) : null;
}

function detectSpokenOrHybridAmountMajor(text: string): string | null {
  const tokens = normalizeText(text).split(" ").filter(Boolean);
  for (let index = 0; index < tokens.length; index++) {
    const parsed = parseEnglishAmountRun(tokens, index);
    if (parsed?.sawWord) return String(parsed.value);
  }
  return null;
}

export function normalizeEnglishHybridMoneyAmounts(text: string): string {
  const tokenRe = /[A-Za-z0-9]+/g;
  const tokenMatches: Array<{
    value: string;
    normalized: string;
    lower: string;
    start: number;
    end: number;
  }> = [];
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(text)) !== null) {
    tokenMatches.push({
      value: match[0],
      normalized: normalizeText(match[0]),
      lower: match[0].toLowerCase(),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  if (tokenMatches.length === 0) return text;

  const replacements: Array<{ start: number; end: number; value: string }> = [];
  let tokenIndex = 0;
  while (tokenIndex < tokenMatches.length) {
    const parsed = parseEnglishAmountRun(
      tokenMatches.map((token) => token.normalized),
      tokenIndex,
    );
    if (!parsed || !(parsed.sawDigit && parsed.sawWord)) {
      tokenIndex += 1;
      continue;
    }

    const leftContext = tokenMatches
      .slice(Math.max(0, tokenIndex - 3), tokenIndex)
      .some((token) => MONEY_CONTEXT_WORDS.has(token.lower));
    const rightContext = tokenMatches
      .slice(
        parsed.endExclusive,
        Math.min(tokenMatches.length, parsed.endExclusive + 3),
      )
      .some((token) => MONEY_CONTEXT_WORDS.has(token.lower));
    if (!leftContext && !rightContext) {
      tokenIndex += 1;
      continue;
    }

    replacements.push({
      start: tokenMatches[tokenIndex].start,
      end: tokenMatches[parsed.endExclusive - 1].end,
      value: String(parsed.value),
    });
    tokenIndex = parsed.endExclusive;
  }

  if (replacements.length === 0) return text;
  let normalized = text;
  for (const replacement of replacements.reverse()) {
    normalized = normalized.slice(0, replacement.start) +
      replacement.value +
      normalized.slice(replacement.end);
  }
  return normalized;
}

// Resolve the amount to minor units, preferring the model's normalized amount,
// then a number-word version of that amount, then a number-word amount rescued
// from the raw text. Returns null only when no amount can be recovered at all.
function resolveAmountMinor(
  modelAmountMajor: string | null,
  rawText: string,
  currencyCode: string,
): number | null {
  if (modelAmountMajor) {
    const direct = majorStringToMinor(modelAmountMajor, currencyCode);
    if (direct !== null) return direct;
    const hybridFromModel = detectSpokenOrHybridAmountMajor(modelAmountMajor);
    if (hybridFromModel) {
      const minor = majorStringToMinor(hybridFromModel, currencyCode);
      if (minor !== null) return minor;
    }
    const spokenFromModel = detectSpokenAmountMajor(modelAmountMajor);
    if (spokenFromModel) {
      const minor = majorStringToMinor(spokenFromModel, currencyCode);
      if (minor !== null) return minor;
    }
  }
  const hybridFromRaw = detectSpokenOrHybridAmountMajor(rawText);
  if (hybridFromRaw) {
    const minor = majorStringToMinor(hybridFromRaw, currencyCode);
    if (minor !== null) return minor;
  }
  const spokenFromRaw = detectSpokenAmountMajor(rawText);
  if (spokenFromRaw) {
    const minor = majorStringToMinor(spokenFromRaw, currencyCode);
    if (minor !== null) return minor;
  }
  return null;
}

export function resolveRuleBasedTransaction(input: {
  rawText: string;
  wallets: AllowedWallet[];
  blockedLinkedWalletNames: string[];
  expenseCategories: AllowedCategory[];
  incomeCategories: AllowedCategory[];
  expenseFallbackCategory: AllowedCategory;
  incomeFallbackCategory: AllowedCategory;
  todayYmd: string;
  defaultCurrencyCode?: string | null;
}): Resolution | null {
  const text = normalizeText(input.rawText);
  if (!text || input.rawText.includes("?")) return null;
  if (
    /\b(will|tomorrow|next week|next month|planning|plan to|want to|should i|can i|could i|afford)\b/
      .test(text)
  ) {
    return null;
  }
  if (
    /\b(transfer|transferred|moved|withdrew|withdrawn|top up|topup)\b/.test(
      text,
    ) ||
    /\bsent\b.+\bto\b/.test(text)
  ) {
    return { outcome: "not_transaction", code: "transfer" };
  }

  const incomeCue =
    /\b(got paid|was paid|paid me|sent me|salary|paycheck|income|earned|received|got|refund|refunded|cashback|reimbursed|reimbursement|bonus|commission)\b/
      .test(text);
  const expenseCue = /\b(spent|paid for|bought|purchased|ordered|charged)\b/
    .test(text);
  if (incomeCue === expenseCue) return null;

  const amountMajor = detectAmountMajor(input.rawText);
  if (!amountMajor) return null;

  const transactionType = incomeCue ? "income" : "expense";
  const wallets = input.wallets;
  if (wallets.length === 0) {
    return { outcome: "missing_information", code: "no_wallets" };
  }

  const requestedWallet =
    wallets.find((wallet) => containsNormalizedPhrase(text, wallet.name)) ??
      null;
  const blockedWallet = !requestedWallet
    ? input.blockedLinkedWalletNames.find((name) =>
      containsNormalizedPhrase(text, name)
    )
    : null;
  if (blockedWallet) {
    return { outcome: "linked_wallet_blocked", code: "linked_wallet_blocked" };
  }
  const explicitCurrency = detectCurrencyCode(input.rawText);
  const sourceCurrency = explicitCurrency ??
    requestedWallet?.currencyCode ??
    wallets[0].currencyCode ??
    normalizeCurrencyCodeOrNull(input.defaultCurrencyCode) ??
    "USD";
  const wallet = chooseDefaultWallet(wallets, requestedWallet, sourceCurrency);
  const amountMinor = majorStringToMinor(amountMajor, sourceCurrency);
  if (amountMinor === null) {
    return { outcome: "missing_information", code: "missing_amount" };
  }

  const categories = transactionType === "income"
    ? input.incomeCategories
    : input.expenseCategories;
  const category = mentionedCategory(text, categories);
  if (!category) return null;
  const categoryConfidence = 0.96;

  return {
    outcome: "parsed",
    transaction: {
      transactionType,
      typeConfidence: 0.98,
      amountMinor,
      sourceCurrency,
      title: category.name,
      merchant: null,
      dateYmd: input.todayYmd,
      dateWasSpecified: false,
      wallet,
      category,
      categoryConfidence,
    },
  };
}

export function enforceTransactionDirection(input: {
  ai: AiCommandPayload;
  rawText: string;
  expenseCategories: AllowedCategory[];
  incomeCategories: AllowedCategory[];
}): AiCommandPayload {
  const { ai, expenseCategories, incomeCategories } = input;
  const text = normalizeText(input.rawText);
  const transferCue =
    /\b(transfer|transferred|moved|withdrew|withdrawn|top up|topup)\b/
      .test(text) ||
    /\bsent\b.+\bto\b/.test(text);
  if (transferCue) {
    return { ...ai, intent: "transfer", typeConfidence: 1 };
  }

  const incomeCue =
    /\b(got paid|was paid|paid me|sent me|salary|paycheck|earned|received|refund|refunded|cashback|reimbursed|reimbursement)\b/
      .test(text);
  const expenseCue = /\b(spent|paid for|bought|purchased|ordered|charged)\b/
    .test(text);
  if (incomeCue && !expenseCue) {
    return { ...ai, intent: "income", typeConfidence: 1 };
  }
  if (expenseCue && !incomeCue) {
    return { ...ai, intent: "expense", typeConfidence: 1 };
  }

  if (ai.categoryName) {
    const expenseMatch = exactNameMatch(ai.categoryName, expenseCategories);
    const incomeMatch = exactNameMatch(ai.categoryName, incomeCategories);
    if (expenseMatch && !incomeMatch) {
      return {
        ...ai,
        intent: "expense",
        typeConfidence: Math.max(ai.typeConfidence, ai.categoryConfidence),
      };
    }
    if (incomeMatch && !expenseMatch) {
      return {
        ...ai,
        intent: "income",
        typeConfidence: Math.max(ai.typeConfidence, ai.categoryConfidence),
      };
    }
  }

  if (
    ai.completed &&
    ai.amountMajor &&
    ai.intent === "unknown"
  ) {
    return { ...ai, intent: "expense" };
  }
  return ai;
}

export function resolveAiTransaction(input: {
  ai: AiCommandPayload;
  rawText?: string;
  wallets: AllowedWallet[];
  blockedLinkedWalletNames: string[];
  expenseCategories: AllowedCategory[];
  incomeCategories: AllowedCategory[];
  expenseFallbackCategory: AllowedCategory;
  incomeFallbackCategory: AllowedCategory;
  todayYmd: string;
  defaultCurrencyCode?: string | null;
}): Resolution {
  const {
    ai,
    wallets,
    blockedLinkedWalletNames,
    expenseCategories,
    incomeCategories,
    expenseFallbackCategory,
    incomeFallbackCategory,
    todayYmd,
  } = input;

  // Deterministic future guard, independent of what the model returned. A
  // statement like "I will receive my salary tomorrow" must be ignored even if
  // the model marked it intent=income, completed=true, dateYmd=null.
  if (hasFutureIntent(input.rawText)) {
    return { outcome: "not_transaction", code: "future_transaction" };
  }

  if (
    (ai.intent !== "expense" && ai.intent !== "income") ||
    !ai.completed
  ) {
    return { outcome: "not_transaction", code: ai.intent || "not_transaction" };
  }
  const transactionType = ai.intent;
  const categories = transactionType === "income"
    ? incomeCategories
    : expenseCategories;
  const fallbackCategory = transactionType === "income"
    ? incomeFallbackCategory
    : expenseFallbackCategory;

  if (wallets.length === 0) {
    return { outcome: "missing_information", code: "no_wallets" };
  }

  let wallet = ai.walletId
    ? wallets.find((candidate) => candidate.id === ai.walletId) ?? null
    : null;

  if (!wallet && ai.requestedWalletName) {
    wallet = exactNameMatch(ai.requestedWalletName, wallets);
    if (!wallet) {
      const blocked = exactNameMatch(
        ai.requestedWalletName,
        blockedLinkedWalletNames.map((name) => ({ name })),
      );
      return blocked
        ? { outcome: "linked_wallet_blocked", code: "linked_wallet_blocked" }
        : { outcome: "unknown_wallet", code: "unknown_wallet" };
    }
  }

  const explicitCurrency = detectCurrencyCode(input.rawText ?? "");
  const sourceCurrency = (
    explicitCurrency ??
      wallet?.currencyCode ??
      wallets[0].currencyCode ??
      normalizeCurrencyCodeOrNull(input.defaultCurrencyCode) ??
      "USD"
  ).toUpperCase();
  wallet = chooseDefaultWallet(wallets, wallet, sourceCurrency);
  const amountMinor = resolveAmountMinor(
    ai.amountMajor,
    input.rawText ?? "",
    sourceCurrency,
  );
  if (amountMinor === null) {
    return { outcome: "missing_information", code: "missing_amount" };
  }

  const resolvedDateYmd = ai.dateYmd && isValidDateYmd(ai.dateYmd)
    ? ai.dateYmd
    : null;
  const dateYmd = resolvedDateYmd ?? todayYmd;
  const dateWasSpecified = Boolean(resolvedDateYmd && dateYmd !== todayYmd);
  if (dateYmd > todayYmd) {
    return { outcome: "not_transaction", code: "future_transaction" };
  }

  const matchedCategory = ai.categoryName
    ? exactNameMatch(ai.categoryName, categories)
    : null;
  const category = matchedCategory && ai.categoryConfidence >= 0.9
    ? matchedCategory
    : fallbackCategory;
  const defaultTitle = transactionType === "income" ? "Income" : "Expense";
  const title = (ai.title || ai.merchant || category.name || defaultTitle)
    .trim();

  return {
    outcome: "parsed",
    transaction: {
      transactionType,
      typeConfidence: ai.typeConfidence,
      amountMinor,
      sourceCurrency,
      title,
      merchant: ai.merchant,
      dateYmd,
      dateWasSpecified,
      wallet,
      category,
      categoryConfidence: matchedCategory === category
        ? ai.categoryConfidence
        : 0,
    },
  };
}
