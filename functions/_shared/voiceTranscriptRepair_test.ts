import { repairVoiceTranscript } from "./voiceTranscriptRepair.ts";

Deno.test("repairVoiceTranscript fixes dropped leading one for clear English money context", () => {
  const cases: Array<[string, string]> = [
    ["spent 000 on groceries", "spent 1000 on groceries"],
    ["paid 000 dollars for rent", "paid 1000 dollars for rent"],
    ["received 000 salary", "received 1000 salary"],
    ["salary 000 today", "salary 1000 today"],
  ];

  for (const [input, expected] of cases) {
    const actual = repairVoiceTranscript(input, "en-US");
    if (actual !== expected) {
      throw new Error(`repair "${input}" -> "${actual}", expected "${expected}"`);
    }
  }
});

Deno.test("repairVoiceTranscript leaves unrelated zero runs alone", () => {
  const cases = [
    "code 000 opened the door",
    "room 000 was empty",
    "I saw 000 on the screen",
  ];

  for (const input of cases) {
    const actual = repairVoiceTranscript(input, "en-US");
    if (actual !== input) {
      throw new Error(`unexpected repair "${input}" -> "${actual}"`);
    }
  }
});

Deno.test("repairVoiceTranscript does not rewrite non-English transcripts", () => {
  const input = "spent 000 on groceries";
  const actual = repairVoiceTranscript(input, "tr-TR");
  if (actual !== input) {
    throw new Error(`non-English transcript was changed: "${actual}"`);
  }
});
