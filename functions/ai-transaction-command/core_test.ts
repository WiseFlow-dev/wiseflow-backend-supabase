import {
  detectSpokenAmountMajor,
  enforceTransactionDirection,
  hasFutureIntent,
  isValidDateYmd,
  majorStringToMinor,
  normalizeEnglishHybridMoneyAmounts,
  parseAiCommand,
  resolveAiTransaction,
  resolveRuleBasedTransaction,
  todayInTimeZone,
} from "./core.ts";

const wallets = [
  { id: "wallet-1", name: "Spending", type: "SPENDING", currencyCode: "USD" },
];
const expenseCategories = [
  { id: "cat-food", name: "Dining" },
  { id: "cat-other", name: "Uncategorized" },
];
const incomeCategories = [
  { id: "cat-salary", name: "Salary" },
  { id: "cat-refund", name: "Refund" },
  { id: "cat-income-other", name: "Uncategorized" },
];
const expenseFallbackCategory = expenseCategories[1];
const incomeFallbackCategory = incomeCategories[2];

Deno.test("majorStringToMinor respects currency fraction digits", () => {
  if (majorStringToMinor("12.34", "USD") !== 1234) {
    throw new Error("USD conversion failed");
  }
  if (majorStringToMinor("1200", "JPY") !== 1200) {
    throw new Error("JPY conversion failed");
  }
  if (majorStringToMinor("1.234", "KWD") !== 1234) {
    throw new Error("KWD conversion failed");
  }
  if (majorStringToMinor("1.234,56", "EUR") !== 123456) {
    throw new Error("European decimal conversion failed");
  }
});

Deno.test("low-confidence category becomes Uncategorized", () => {
  const ai = parseAiCommand(JSON.stringify({
    intent: "expense",
    completed: true,
    typeConfidence: 0.99,
    amountMajor: "15",
    currencyCode: "USD",
    title: "Dinner",
    merchant: "Takeout",
    dateYmd: null,
    walletId: "wallet-1",
    requestedWalletName: null,
    categoryName: "Dining",
    categoryConfidence: 0.89,
  }));
  if (!ai) throw new Error("AI payload did not parse");
  const result = resolveAiTransaction({
    ai,
    wallets,
    blockedLinkedWalletNames: [],
    expenseCategories,
    incomeCategories,
    expenseFallbackCategory,
    incomeFallbackCategory,
    todayYmd: "2026-06-06",
  });
  if (
    result.outcome !== "parsed" ||
    result.transaction.category.name !== "Uncategorized" ||
    result.transaction.dateYmd !== "2026-06-06" ||
    result.transaction.dateWasSpecified
  ) {
    throw new Error("Fallback category or default date resolution failed");
  }
});

Deno.test("explicit expense dates are marked as specified", () => {
  const result = resolveAiTransaction({
    ai: {
      intent: "expense",
      completed: true,
      typeConfidence: 0.99,
      amountMajor: "15",
      currencyCode: "USD",
      title: "Dinner",
      merchant: null,
      dateYmd: "2026-06-05",
      walletId: "wallet-1",
      requestedWalletName: null,
      categoryName: "Dining",
      categoryConfidence: 0.95,
    },
    wallets,
    blockedLinkedWalletNames: [],
    expenseCategories,
    incomeCategories,
    expenseFallbackCategory,
    incomeFallbackCategory,
    todayYmd: "2026-06-06",
  });
  if (
    result.outcome !== "parsed" ||
    result.transaction.dateYmd !== "2026-06-05" ||
    !result.transaction.dateWasSpecified
  ) {
    throw new Error("Explicit date provenance was lost");
  }
});

Deno.test("today dates save as now instead of midnight", () => {
  const result = resolveAiTransaction({
    ai: {
      intent: "expense",
      completed: true,
      typeConfidence: 0.99,
      amountMajor: "15",
      currencyCode: "USD",
      title: "Dinner",
      merchant: null,
      dateYmd: "2026-06-06",
      walletId: "wallet-1",
      requestedWalletName: null,
      categoryName: "Dining",
      categoryConfidence: 0.95,
    },
    wallets,
    blockedLinkedWalletNames: [],
    expenseCategories,
    incomeCategories,
    expenseFallbackCategory,
    incomeFallbackCategory,
    todayYmd: "2026-06-06",
  });
  if (
    result.outcome !== "parsed" ||
    result.transaction.dateYmd !== "2026-06-06" ||
    result.transaction.dateWasSpecified
  ) {
    throw new Error("Today should use the current timestamp, not midnight");
  }
});

Deno.test("income resolves against income categories", () => {
  const result = resolveAiTransaction({
    ai: {
      intent: "income",
      completed: true,
      typeConfidence: 0.93,
      amountMajor: "500",
      currencyCode: "USD",
      title: "Salary",
      merchant: "Acme",
      dateYmd: null,
      walletId: null,
      requestedWalletName: null,
      categoryName: "Salary",
      categoryConfidence: 0.98,
    },
    wallets,
    blockedLinkedWalletNames: [],
    expenseCategories,
    incomeCategories,
    expenseFallbackCategory,
    incomeFallbackCategory,
    todayYmd: "2026-06-06",
  });
  if (
    result.outcome !== "parsed" ||
    result.transaction.transactionType !== "income" ||
    result.transaction.category.name !== "Salary"
  ) {
    throw new Error("Income did not resolve against income categories");
  }
});

Deno.test("rule-based parser handles simple salary without model call", () => {
  const result = resolveRuleBasedTransaction({
    rawText: "got 250 salary",
    wallets,
    blockedLinkedWalletNames: [],
    expenseCategories,
    incomeCategories,
    expenseFallbackCategory,
    incomeFallbackCategory,
    todayYmd: "2026-06-06",
  });
  if (
    !result ||
    result.outcome !== "parsed" ||
    result.transaction.transactionType !== "income" ||
    result.transaction.amountMinor !== 25000 ||
    result.transaction.category.name !== "Salary"
  ) {
    throw new Error("Simple salary was not parsed locally");
  }
});

Deno.test("raw salary defaults to the wallet currency, not display currency", () => {
  const result = resolveRuleBasedTransaction({
    rawText: "got 250 salary",
    wallets: [
      {
        id: "wallet-usd",
        name: "Spending",
        type: "SPENDING",
        currencyCode: "USD",
      },
    ],
    blockedLinkedWalletNames: [],
    expenseCategories,
    incomeCategories,
    expenseFallbackCategory,
    incomeFallbackCategory,
    todayYmd: "2026-06-06",
    defaultCurrencyCode: "TRY",
  });
  if (
    !result ||
    result.outcome !== "parsed" ||
    result.transaction.sourceCurrency !== "USD" ||
    result.transaction.wallet.id !== "wallet-usd"
  ) {
    throw new Error("Raw salary did not use the wallet currency");
  }
});

Deno.test("rule-based parser does not save uncategorized merchant expenses", () => {
  const result = resolveRuleBasedTransaction({
    rawText: "spent 5.43 at random shop",
    wallets,
    blockedLinkedWalletNames: [],
    expenseCategories,
    incomeCategories,
    expenseFallbackCategory,
    incomeFallbackCategory,
    todayYmd: "2026-06-06",
    defaultCurrencyCode: "USD",
  });
  if (result !== null) {
    throw new Error("Uncategorized merchant expense should fall through to AI");
  }
});

Deno.test("model currency guesses are ignored when the text has no currency", () => {
  const result = resolveAiTransaction({
    ai: {
      intent: "income",
      completed: true,
      typeConfidence: 0.99,
      amountMajor: "250",
      currencyCode: "USD",
      title: "Salary",
      merchant: null,
      dateYmd: null,
      walletId: null,
      requestedWalletName: null,
      categoryName: "Salary",
      categoryConfidence: 0.95,
    },
    rawText: "got 250 salary",
    wallets: [
      {
        id: "wallet-eur",
        name: "Spending",
        type: "SPENDING",
        currencyCode: "EUR",
      },
    ],
    blockedLinkedWalletNames: [],
    expenseCategories,
    incomeCategories,
    expenseFallbackCategory,
    incomeFallbackCategory,
    todayYmd: "2026-06-06",
    defaultCurrencyCode: "EUR",
  });
  if (
    result.outcome !== "parsed" ||
    result.transaction.sourceCurrency !== "EUR" ||
    result.transaction.amountMinor !== 25000
  ) {
    throw new Error(
      "Model currency guess was not replaced by wallet currency",
    );
  }
});

Deno.test("raw model amounts use wallet currency even when display currency differs", () => {
  const result = resolveAiTransaction({
    ai: {
      intent: "expense",
      completed: true,
      typeConfidence: 0.99,
      amountMajor: "1,500",
      currencyCode: "TRY",
      title: "Dinner",
      merchant: "Dinner",
      dateYmd: null,
      walletId: null,
      requestedWalletName: null,
      categoryName: "Dining",
      categoryConfidence: 0.95,
    },
    rawText: "spent 1,500 on dinner",
    wallets: [
      {
        id: "wallet-usd",
        name: "Spending",
        type: "SPENDING",
        currencyCode: "USD",
      },
    ],
    blockedLinkedWalletNames: [],
    expenseCategories,
    incomeCategories,
    expenseFallbackCategory,
    incomeFallbackCategory,
    todayYmd: "2026-06-06",
    defaultCurrencyCode: "TRY",
  });
  if (
    result.outcome !== "parsed" ||
    result.transaction.sourceCurrency !== "USD" ||
    result.transaction.amountMinor !== 150000
  ) {
    throw new Error("Raw model amount did not stay in wallet currency");
  }
});

Deno.test("rule-based parser leaves future and transfer text unsaved", () => {
  const future = resolveRuleBasedTransaction({
    rawText: "got 250 salary tomorrow",
    wallets,
    blockedLinkedWalletNames: [],
    expenseCategories,
    incomeCategories,
    expenseFallbackCategory,
    incomeFallbackCategory,
    todayYmd: "2026-06-06",
  });
  if (future !== null) {
    throw new Error("Future salary should not be rule-parsed");
  }

  const transfer = resolveRuleBasedTransaction({
    rawText: "sent 250 to savings",
    wallets,
    blockedLinkedWalletNames: [],
    expenseCategories,
    incomeCategories,
    expenseFallbackCategory,
    incomeFallbackCategory,
    todayYmd: "2026-06-06",
  });
  if (!transfer || transfer.outcome !== "not_transaction") {
    throw new Error("Transfer should fall through as not_transaction");
  }
});

Deno.test("low-confidence income category uses income fallback", () => {
  const result = resolveAiTransaction({
    ai: {
      intent: "income",
      completed: true,
      typeConfidence: 0.9,
      amountMajor: "30",
      currencyCode: "USD",
      title: "Amazon refund",
      merchant: "Amazon",
      dateYmd: null,
      walletId: null,
      requestedWalletName: null,
      categoryName: "Refund",
      categoryConfidence: 0.89,
    },
    wallets,
    blockedLinkedWalletNames: [],
    expenseCategories,
    incomeCategories,
    expenseFallbackCategory,
    incomeFallbackCategory,
    todayYmd: "2026-06-06",
  });
  if (
    result.outcome !== "parsed" ||
    result.transaction.category.id !== incomeFallbackCategory.id
  ) {
    throw new Error("Income did not use its own fallback category");
  }
});

Deno.test("an expense cannot select an income category", () => {
  const result = resolveAiTransaction({
    ai: {
      intent: "expense",
      completed: true,
      typeConfidence: 0.95,
      amountMajor: "20",
      currencyCode: "USD",
      title: "Dinner",
      merchant: null,
      dateYmd: null,
      walletId: null,
      requestedWalletName: null,
      categoryName: "Salary",
      categoryConfidence: 0.99,
    },
    wallets,
    blockedLinkedWalletNames: [],
    expenseCategories,
    incomeCategories,
    expenseFallbackCategory,
    incomeFallbackCategory,
    todayYmd: "2026-06-06",
  });
  if (
    result.outcome !== "parsed" ||
    result.transaction.category.id !== expenseFallbackCategory.id
  ) {
    throw new Error("Expense accepted an income category");
  }
});

Deno.test("explicit wording wins over a conflicting model guess", () => {
  const base = {
    intent: "expense" as const,
    completed: true,
    typeConfidence: 0.6,
    amountMajor: "50",
    currencyCode: "USD",
    title: "Payment",
    merchant: null,
    dateYmd: null,
    walletId: null,
    requestedWalletName: null,
    categoryName: "Dining",
    categoryConfidence: 0.95,
  };
  const paidMe = enforceTransactionDirection({
    ai: base,
    rawText: "Acme paid me $50",
    expenseCategories,
    incomeCategories,
  });
  if (paidMe.intent !== "income") {
    throw new Error("'paid me' did not force income");
  }

  const sentMe = enforceTransactionDirection({
    ai: { ...base, intent: "expense" },
    rawText: "Acme sent me $500",
    expenseCategories,
    incomeCategories,
  });
  if (sentMe.intent !== "income") {
    throw new Error("'sent me' did not force income");
  }

  const sentTo = enforceTransactionDirection({
    ai: { ...base, intent: "expense" },
    rawText: "I sent $50 to savings",
    expenseCategories,
    incomeCategories,
  });
  if (sentTo.intent !== "transfer") {
    throw new Error("'sent to' did not force transfer");
  }

  const paidFor = enforceTransactionDirection({
    ai: { ...base, intent: "income" },
    rawText: "I paid $50 for dinner",
    expenseCategories,
    incomeCategories,
  });
  if (paidFor.intent !== "expense") {
    throw new Error("'paid for' did not force expense");
  }
});

Deno.test("a unique category can resolve transaction direction", () => {
  const result = enforceTransactionDirection({
    ai: {
      intent: "unknown",
      completed: true,
      typeConfidence: 0.2,
      amountMajor: "500",
      currencyCode: "USD",
      title: "Acme",
      merchant: "Acme",
      dateYmd: null,
      walletId: null,
      requestedWalletName: null,
      categoryName: "Salary",
      categoryConfidence: 0.96,
    },
    rawText: "$500 from Acme",
    expenseCategories,
    incomeCategories,
  });
  if (result.intent !== "income") {
    throw new Error("Income category did not resolve direction");
  }
});

Deno.test("transfers fall through as not_transaction", () => {
  for (const intent of ["transfer"] as const) {
    const result = resolveAiTransaction({
      ai: {
        intent,
        completed: true,
        typeConfidence: 0.99,
        amountMajor: "50",
        currencyCode: "USD",
        title: null,
        merchant: null,
        dateYmd: null,
        walletId: null,
        requestedWalletName: null,
        categoryName: null,
        categoryConfidence: 0,
      },
      wallets,
      blockedLinkedWalletNames: [],
      expenseCategories,
      incomeCategories,
      expenseFallbackCategory,
      incomeFallbackCategory,
      todayYmd: "2026-06-06",
    });
    if (result.outcome !== "not_transaction") {
      throw new Error(`${intent} did not fall through`);
    }
  }
});

Deno.test("named linked wallet is blocked", () => {
  const result = resolveAiTransaction({
    ai: {
      intent: "expense",
      completed: true,
      typeConfidence: 0.99,
      amountMajor: "20",
      currencyCode: null,
      title: "Medicine",
      merchant: "Pharmacy",
      dateYmd: null,
      walletId: null,
      requestedWalletName: "My Chase",
      categoryName: "Dining",
      categoryConfidence: 0.95,
    },
    wallets,
    blockedLinkedWalletNames: ["My Chase"],
    expenseCategories,
    incomeCategories,
    expenseFallbackCategory,
    incomeFallbackCategory,
    todayYmd: "2026-06-06",
  });
  if (result.outcome !== "linked_wallet_blocked") {
    throw new Error("Linked wallet was not blocked");
  }
});

Deno.test("todayInTimeZone uses the supplied timezone", () => {
  const now = new Date("2026-06-06T22:30:00Z");
  if (todayInTimeZone("Europe/Istanbul", now) !== "2026-06-07") {
    throw new Error("Timezone date resolution failed");
  }
});

Deno.test("future income is rejected even when the model marks it completed with no date", () => {
  // Mirrors the slipping-through case: model returns income/completed/null date,
  // but the text clearly describes a future event.
  const result = resolveAiTransaction({
    ai: {
      intent: "income",
      completed: true,
      typeConfidence: 0.99,
      amountMajor: "500",
      currencyCode: null,
      title: "Salary",
      merchant: null,
      dateYmd: null,
      walletId: "wallet-1",
      requestedWalletName: null,
      categoryName: "Salary",
      categoryConfidence: 0.98,
    },
    rawText: "I will receive my salary of 500 tomorrow",
    wallets,
    blockedLinkedWalletNames: [],
    expenseCategories,
    incomeCategories,
    expenseFallbackCategory,
    incomeFallbackCategory,
    todayYmd: "2026-06-06",
  });
  if (result.outcome !== "not_transaction" || result.code !== "future_transaction") {
    throw new Error("Future income was not rejected by the deterministic guard");
  }
});

Deno.test("past references stay valid (last week is not future)", () => {
  const result = resolveAiTransaction({
    ai: {
      intent: "expense",
      completed: true,
      typeConfidence: 0.99,
      amountMajor: "20",
      currencyCode: null,
      title: "Fast food",
      merchant: null,
      dateYmd: null,
      walletId: "wallet-1",
      requestedWalletName: null,
      categoryName: "Dining",
      categoryConfidence: 0.95,
    },
    rawText: "I spent 20 on fast food last week",
    wallets,
    blockedLinkedWalletNames: [],
    expenseCategories,
    incomeCategories,
    expenseFallbackCategory,
    incomeFallbackCategory,
    todayYmd: "2026-06-06",
  });
  if (result.outcome !== "parsed" || result.transaction.amountMinor !== 2000) {
    throw new Error("Past expense was wrongly rejected as future");
  }
});

Deno.test("hasFutureIntent flags future cues but not past references", () => {
  for (const future of [
    "I will pay rent",
    "going to pay tomorrow",
    "next week salary",
    "I'll receive 500",
    "planning to buy a laptop",
    "I want to buy shoes",
  ]) {
    if (!hasFutureIntent(future)) {
      throw new Error(`Expected future cue: ${future}`);
    }
  }
  for (const past of [
    "I spent 20 on fast food last week",
    "got paid yesterday",
    "bought coffee this morning",
    "paid rent",
  ]) {
    if (hasFutureIntent(past)) {
      throw new Error(`Past text wrongly flagged as future: ${past}`);
    }
  }
});

Deno.test("detectSpokenAmountMajor converts English number words", () => {
  const cases: Array<[string, string | null]> = [
    ["fifty", "50"],
    ["fifty dollars", "50"],
    ["one hundred", "100"],
    ["one fifty", "150"],
    ["1 fifty", "150"],
    ["2 hundred", "200"],
    ["five hundred salary", "500"],
    ["twenty five", "25"],
    ["one hundred twenty five", "125"],
    ["1 thousand", "1000"],
    ["two thousand", "2000"],
    ["2 thousand 5 hundred", "2500"],
    ["two thousand five hundred", "2500"],
    ["spent 20 on dinner", null],
    ["coffee and lunch", null],
  ];
  for (const [input, expected] of cases) {
    const actual = detectSpokenAmountMajor(input);
    if (actual !== expected) {
      throw new Error(`spoken "${input}" -> ${actual}, expected ${expected}`);
    }
  }
});

Deno.test("normalizeEnglishHybridMoneyAmounts rewrites only clear money-context hybrids", () => {
  const cases: Array<[string, string]> = [
    ["spent 1 fifty on groceries", "spent 150 on groceries"],
    ["received 2 hundred salary", "received 200 salary"],
    ["paid 1 hundred fifty for rent", "paid 150 for rent"],
    ["1 fifty dollars on food", "150 dollars on food"],
    ["I saw gate 1 fifty open", "I saw gate 1 fifty open"],
  ];
  for (const [input, expected] of cases) {
    const actual = normalizeEnglishHybridMoneyAmounts(input);
    if (actual !== expected) {
      throw new Error(`normalize "${input}" -> ${actual}, expected ${expected}`);
    }
  }
});

Deno.test("spoken amount in the model field is rescued into minor units", () => {
  const result = resolveAiTransaction({
    ai: {
      intent: "expense",
      completed: true,
      typeConfidence: 0.99,
      amountMajor: "fifty",
      currencyCode: null,
      title: "Dinner",
      merchant: null,
      dateYmd: null,
      walletId: "wallet-1",
      requestedWalletName: null,
      categoryName: "Dining",
      categoryConfidence: 0.95,
    },
    rawText: "spent fifty on dinner",
    wallets,
    blockedLinkedWalletNames: [],
    expenseCategories,
    incomeCategories,
    expenseFallbackCategory,
    incomeFallbackCategory,
    todayYmd: "2026-06-06",
  });
  if (result.outcome !== "parsed" || result.transaction.amountMinor !== 5000) {
    throw new Error("Spoken model amount was not rescued");
  }
});

Deno.test("hybrid amount in the model field is rescued into minor units", () => {
  const result = resolveAiTransaction({
    ai: {
      intent: "expense",
      completed: true,
      typeConfidence: 0.99,
      amountMajor: "1 fifty",
      currencyCode: null,
      title: "Groceries",
      merchant: null,
      dateYmd: null,
      walletId: "wallet-1",
      requestedWalletName: null,
      categoryName: "Dining",
      categoryConfidence: 0.95,
    },
    rawText: "spent 1 fifty on groceries",
    wallets,
    blockedLinkedWalletNames: [],
    expenseCategories,
    incomeCategories,
    expenseFallbackCategory,
    incomeFallbackCategory,
    todayYmd: "2026-06-06",
  });
  if (result.outcome !== "parsed" || result.transaction.amountMinor !== 15000) {
    throw new Error("Hybrid model amount was not rescued");
  }
});

Deno.test("spoken amount is rescued from raw text when the model amount is missing", () => {
  const result = resolveAiTransaction({
    ai: {
      intent: "income",
      completed: true,
      typeConfidence: 0.99,
      amountMajor: null,
      currencyCode: null,
      title: "Salary",
      merchant: null,
      dateYmd: null,
      walletId: "wallet-1",
      requestedWalletName: null,
      categoryName: "Salary",
      categoryConfidence: 0.98,
    },
    rawText: "received five hundred salary",
    wallets,
    blockedLinkedWalletNames: [],
    expenseCategories,
    incomeCategories,
    expenseFallbackCategory,
    incomeFallbackCategory,
    todayYmd: "2026-06-06",
  });
  if (result.outcome !== "parsed" || result.transaction.amountMinor !== 50000) {
    throw new Error("Spoken amount was not rescued from raw text");
  }
});

Deno.test("hybrid amount is rescued from raw text when the model amount is missing", () => {
  const result = resolveAiTransaction({
    ai: {
      intent: "income",
      completed: true,
      typeConfidence: 0.99,
      amountMajor: null,
      currencyCode: null,
      title: "Salary",
      merchant: null,
      dateYmd: null,
      walletId: "wallet-1",
      requestedWalletName: null,
      categoryName: "Salary",
      categoryConfidence: 0.98,
    },
    rawText: "received 2 hundred salary",
    wallets,
    blockedLinkedWalletNames: [],
    expenseCategories,
    incomeCategories,
    expenseFallbackCategory,
    incomeFallbackCategory,
    todayYmd: "2026-06-06",
  });
  if (result.outcome !== "parsed" || result.transaction.amountMinor !== 20000) {
    throw new Error("Hybrid amount was not rescued from raw text");
  }
});

Deno.test("future hybrid income is still rejected", () => {
  const result = resolveRuleBasedTransaction({
    rawText: "I will receive 2 hundred salary tomorrow",
    wallets,
    blockedLinkedWalletNames: [],
    expenseCategories,
    incomeCategories,
    expenseFallbackCategory,
    incomeFallbackCategory,
    todayYmd: "2026-06-06",
  });
  if (result !== null) {
    throw new Error("Future hybrid income should not parse as a completed transaction");
  }
});

Deno.test("future expenses fall through and impossible dates are rejected", () => {
  if (isValidDateYmd("2026-02-30")) {
    throw new Error("Impossible date was accepted");
  }
  if (!isValidDateYmd("2026-02-28")) throw new Error("Valid date was rejected");

  const result = resolveAiTransaction({
    ai: {
      intent: "expense",
      completed: true,
      typeConfidence: 0.99,
      amountMajor: "20",
      currencyCode: "USD",
      title: "Dinner",
      merchant: null,
      dateYmd: "2026-06-07",
      walletId: "wallet-1",
      requestedWalletName: null,
      categoryName: "Dining",
      categoryConfidence: 0.95,
    },
    wallets,
    blockedLinkedWalletNames: [],
    expenseCategories,
    incomeCategories,
    expenseFallbackCategory,
    incomeFallbackCategory,
    todayYmd: "2026-06-06",
  });
  if (result.outcome !== "not_transaction") {
    throw new Error("Future expense did not fall through");
  }
});
