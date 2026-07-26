export type StructuredReceiptItemPayload = {
  name: string;
  price: number | null;
  quantity: number;
  unitPrice: number | null;
  unit: string | null;
  sku: string | null;
};

export type StructuredReceiptPayload = {
  merchantName: string | null;
  merchantAddress: string | null;
  merchantPhone: string | null;
  merchantCountryOrRegion: string | null;
  receiptNumber: string | null;
  transactionTime: string | null;
  receiptType: string | null;
  date: string | null;
  currencyCode: string | null;
  totalAmount: number | null;
  taxAmount: number | null;
  tipAmount: number | null;
  subtotalAmount: number | null;
  discountAmount: number | null;
  serviceChargeAmount: number | null;
  amountDue: number | null;
  items: StructuredReceiptItemPayload[];
  rawText: string;
};

type ReceiptOcrSuccessPayload = {
  success: true;
  text: string;
  structured: StructuredReceiptPayload | null;
  structured_error: string | null;
};

export function buildReceiptStructuringPrompt(rawText: string): string {
  return [
    "Extract structured receipt data from OCR text.",
    "Return ONLY valid JSON. No markdown. No extra text.",
    "IMPORTANT: items must only include purchasable products/services.",
    "Do NOT include staff/clerk lines, table number, VAT/tax lines, phone/address, receipt id, payment method, or any header/footer metadata as items.",
    "Do NOT include lines that have no item price.",
    "If a line is uncertain, skip it (better fewer items than wrong items).",
    "Return these fields exactly:",
    "{",
    '  "merchantName": string|null,',
    '  "merchantAddress": string|null,',
    '  "merchantPhone": string|null,',
    '  "merchantCountryOrRegion": string|null,',
    '  "receiptNumber": string|null,',
    '  "transactionTime": string|null,',
    '  "receiptType": string|null,',
    '  "date": string|null,',
    '  "currencyCode": string|null,',
    '  "totalAmount": number|null,',
    '  "taxAmount": number|null,',
    '  "tipAmount": number|null,',
    '  "subtotalAmount": number|null,',
    '  "discountAmount": number|null,',
    '  "serviceChargeAmount": number|null,',
    '  "amountDue": number|null,',
    '  "items": [ { "name": string, "price": number|null, "quantity": integer, "unitPrice": number|null, "unit": string|null, "sku": string|null } ]',
    "}",
    "Date rules:",
    "- Prefer YYYY-MM-DD.",
    "- If the receipt uses DD-MM-YYYY or DD/MM/YYYY, convert to YYYY-MM-DD.",
    "Total rules:",
    "- totalAmount should be the final TOTAL charged (not subtotal), if visible.",
    "- subtotalAmount should be the SUBTOTAL before tax/tip/fees when visible.",
    "- taxAmount must come from an explicit tax/VAT/GST/KDV/IVA line.",
    "- Never copy subtotalAmount or an items subtotal into taxAmount.",
    "- If tax is not explicitly visible, set taxAmount to null.",
    "Currency rules:",
    "- currencyCode must be a 3-letter ISO 4217 code when visible.",
    "- If uncertain, set currencyCode to null.",
    "Item rules:",
    "- price must be the per-unit price.",
    "- quantity should be >= 1. If quantity is unknown, use 1.",
    "- If both quantity and line total are visible, derive unitPrice and set both price and unitPrice to the per-unit amount.",
    "- unit is optional. Use null if unavailable.",
    "- sku is optional. Use null if unavailable.",
    "",
    "OCR text:",
    rawText,
  ].join("\n");
}

export function extractGeminiText(geminiData: unknown): string {
  if (!isObject(geminiData)) return "";
  const candidates = Array.isArray(geminiData.candidates) ? geminiData.candidates : [];
  const firstCandidate = candidates[0];
  if (!isObject(firstCandidate)) return "";
  const content = isObject(firstCandidate.content) ? firstCandidate.content : null;
  const parts = content && Array.isArray(content.parts) ? content.parts : [];
  const firstPart = parts[0];
  return isObject(firstPart) && typeof firstPart.text === "string"
    ? firstPart.text.trim()
    : "";
}

export function buildReceiptOcrSuccessPayload(
  text: string,
  structuredText: string | null,
  structuredError: string | null = null,
): ReceiptOcrSuccessPayload {
  const structured = structuredText
    ? parseStructuredReceiptPayload(structuredText, text)
    : null;

  return {
    success: true,
    text,
    structured,
    structured_error: structured
      ? structuredError
      : structuredError ?? (structuredText ? "Gemini returned invalid receipt JSON" : null),
  };
}

function parseStructuredReceiptPayload(
  raw: string,
  ocrText: string,
): StructuredReceiptPayload | null {
  const parsed = parseJsonObjectFromText(raw);
  if (!isObject(parsed)) return null;

  return {
    merchantName: readString(parsed.merchantName),
    merchantAddress: readString(parsed.merchantAddress),
    merchantPhone: readString(parsed.merchantPhone),
    merchantCountryOrRegion: readString(parsed.merchantCountryOrRegion),
    receiptNumber: readString(parsed.receiptNumber),
    transactionTime: readString(parsed.transactionTime),
    receiptType: readString(parsed.receiptType),
    date: readString(parsed.date),
    currencyCode: readString(parsed.currencyCode),
    totalAmount: readNumber(parsed.totalAmount),
    taxAmount: readNumber(parsed.taxAmount),
    tipAmount: readNumber(parsed.tipAmount),
    subtotalAmount: readNumber(parsed.subtotalAmount),
    discountAmount: readNumber(parsed.discountAmount),
    serviceChargeAmount: readNumber(parsed.serviceChargeAmount),
    amountDue: readNumber(parsed.amountDue),
    items: readItems(parsed.items),
    rawText: ocrText,
  };
}

function readItems(value: unknown): StructuredReceiptItemPayload[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!isObject(item)) return null;
      const name = readString(item.name);
      if (!name) return null;
      return {
        name,
        price: readNumber(item.price),
        quantity: Math.max(1, Math.trunc(readNumber(item.quantity) ?? 1)),
        unitPrice: readNumber(item.unitPrice),
        unit: readString(item.unit),
        sku: readString(item.sku),
      } satisfies StructuredReceiptItemPayload;
    })
    .filter((item): item is StructuredReceiptItemPayload => item !== null);
}

function parseJsonObjectFromText(raw: string): Record<string, unknown> | null {
  const cleaned = stripJsonFence(raw);
  try {
    const parsed = JSON.parse(cleaned);
    return isObject(parsed) ? parsed : null;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(cleaned.slice(start, end + 1));
      return isObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function stripJsonFence(raw: string): string {
  return raw.replace(/^```[a-z]*\n?/i, "").replace(/```$/i, "").trim();
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
