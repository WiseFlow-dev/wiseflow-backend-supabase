import {
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildReceiptOcrSuccessPayload,
  extractGeminiText,
} from "./receiptStructuring.ts";

Deno.test("vision success plus gemini success returns text and structured receipt", () => {
  const payload = buildReceiptOcrSuccessPayload(
    "VISION RAW TEXT",
    JSON.stringify({
      merchantName: "BIM",
      totalAmount: 18.25,
      items: [{ name: "Water", price: 18.25, quantity: 1 }],
      rawText: "this should be ignored",
    }),
  );

  assertEquals(payload.success, true);
  assertEquals(payload.text, "VISION RAW TEXT");
  assertEquals(payload.structured?.merchantName, "BIM");
  assertEquals(payload.structured?.totalAmount, 18.25);
  assertEquals(payload.structured?.rawText, "VISION RAW TEXT");
  assertEquals(payload.structured_error, null);
});

Deno.test("vision success plus gemini failure keeps text and returns null structured", () => {
  const payload = buildReceiptOcrSuccessPayload(
    "VISION RAW TEXT",
    null,
    "Gemini receipt structuring timed out",
  );

  assertEquals(payload.success, true);
  assertEquals(payload.text, "VISION RAW TEXT");
  assertEquals(payload.structured, null);
  assertEquals(payload.structured_error, "Gemini receipt structuring timed out");
});

Deno.test("structured rawText always comes from cloud vision text", () => {
  const payload = buildReceiptOcrSuccessPayload(
    "REAL OCR TEXT",
    JSON.stringify({
      merchantName: "Shell",
      totalAmount: 75.0,
      rawText: "invented by model",
      items: [],
    }),
  );

  assertEquals(payload.structured?.rawText, "REAL OCR TEXT");
  assertNotEquals(payload.structured?.rawText, "invented by model");
});

Deno.test("invalid gemini json still returns text and marks structured null", () => {
  const payload = buildReceiptOcrSuccessPayload(
    "VISION RAW TEXT",
    "{ not valid json",
  );

  assertEquals(payload.success, true);
  assertEquals(payload.text, "VISION RAW TEXT");
  assertEquals(payload.structured, null);
  assertEquals(payload.structured_error, "Gemini returned invalid receipt JSON");
});

Deno.test("extractGeminiText reads first candidate part text", () => {
  const text = extractGeminiText({
    candidates: [
      {
        content: {
          parts: [{ text: "{\"merchantName\":\"A101\"}" }],
        },
      },
    ],
  });

  assertEquals(text, "{\"merchantName\":\"A101\"}");
});
