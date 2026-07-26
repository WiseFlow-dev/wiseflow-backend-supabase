import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  classifyGeminiResponse,
  GEMINI_FLASH_LITE_MODEL,
  GEMINI_FLASH_MODEL,
  getWiseyBusyMessage,
  loadGeminiApiKeys,
  requestGeminiWithResilience,
  shouldPersistWiseyResponse,
} from "./geminiModelFallback.ts";

const keys = loadGeminiApiKeys([
  { slot: "key_0", value: "alpha" },
  { slot: "key_1", value: "bravo" },
  { slot: "key_2", value: "charlie" },
]);

Deno.test("loads configured keys in order and removes missing or duplicate values", () => {
  assertEquals(
    loadGeminiApiKeys([
      { slot: "key_0", value: " alpha " },
      { slot: "key_1", value: "" },
      { slot: "key_2", value: "alpha" },
      { slot: "key_3", value: "charlie" },
    ]),
    [
      { slot: "key_0", value: "alpha" },
      { slot: "key_3", value: "charlie" },
    ],
  );
});

Deno.test("classifies Vertex temporary and terminal errors", async () => {
  assertEquals(
    await classifyGeminiResponse(new Response("busy", { status: 503 })),
    "temporary",
  );
  assertEquals(
    await classifyGeminiResponse(new Response("quota", { status: 429 })),
    "temporary",
  );
  assertEquals(
    await classifyGeminiResponse(
      new Response('{"message":"API key not valid"}', { status: 400 }),
    ),
    "terminal",
  );
  assertEquals(
    await classifyGeminiResponse(
      new Response('{"message":"Malformed contents"}', { status: 400 }),
    ),
    "terminal",
  );
  assertEquals(
    await classifyGeminiResponse(new Response("unauthorized", { status: 401 })),
    "terminal",
  );
  assertEquals(
    await classifyGeminiResponse(new Response("forbidden", { status: 403 })),
    "terminal",
  );
});

Deno.test("successful preferred request uses one key and no delays", async () => {
  const calls: string[] = [];
  const delays: number[] = [];
  const result = await requestGeminiWithResilience(
    GEMINI_FLASH_MODEL,
    keys,
    async (model, key) => {
      calls.push(`${model}:${key.slot}`);
      return new Response("ok", { status: 200 });
    },
    {
      operation: "test",
      sleep: async (delay) => {
        delays.push(delay);
      },
    },
  );

  assertEquals(calls, [`${GEMINI_FLASH_MODEL}:key_0`]);
  assertEquals(delays, []);
  assertEquals(result.outcome, "response");
});

Deno.test("Vertex 429 switches models instead of cycling credentials", async () => {
  const calls: string[] = [];
  const result = await requestGeminiWithResilience(
    GEMINI_FLASH_MODEL,
    keys,
    async (model, key) => {
      calls.push(`${model}:${key.slot}`);
      return model === GEMINI_FLASH_LITE_MODEL
        ? new Response("ok", { status: 200 })
        : new Response("quota", { status: 429 });
    },
    { operation: "test", sleep: async () => {} },
  );

  assertEquals(calls, [
    `${GEMINI_FLASH_MODEL}:key_0`,
    `${GEMINI_FLASH_LITE_MODEL}:key_0`,
  ]);
  assertEquals(result.outcome, "response");
});

Deno.test("temporary outage switches models instead of cycling keys", async () => {
  const calls: string[] = [];
  const delays: number[] = [];
  const result = await requestGeminiWithResilience(
    GEMINI_FLASH_MODEL,
    keys,
    async (model, key) => {
      calls.push(`${model}:${key.slot}`);
      return model === GEMINI_FLASH_MODEL
        ? new Response("busy", { status: 503 })
        : new Response("ok", { status: 200 });
    },
    {
      operation: "test",
      sleep: async (delay) => {
        delays.push(delay);
      },
    },
  );

  assertEquals(calls, [
    `${GEMINI_FLASH_MODEL}:key_0`,
    `${GEMINI_FLASH_LITE_MODEL}:key_0`,
  ]);
  assertEquals(delays, [1000]);
  assertEquals(result.outcome, "response");
});

Deno.test("Flash Lite switches to Flash during a temporary outage", async () => {
  const calls: string[] = [];
  const result = await requestGeminiWithResilience(
    GEMINI_FLASH_LITE_MODEL,
    keys,
    async (model, key) => {
      calls.push(`${model}:${key.slot}`);
      return model === GEMINI_FLASH_LITE_MODEL
        ? new Response("busy", { status: 503 })
        : new Response("ok", { status: 200 });
    },
    { operation: "test", sleep: async () => {} },
  );

  assertEquals(calls, [
    `${GEMINI_FLASH_LITE_MODEL}:key_0`,
    `${GEMINI_FLASH_MODEL}:key_0`,
  ]);
  assertEquals(result.outcome, "response");
});

Deno.test("uses 1s then 3s delays and performs one final preferred-model retry", async () => {
  const calls: string[] = [];
  const delays: number[] = [];
  let callCount = 0;
  const result = await requestGeminiWithResilience(
    GEMINI_FLASH_MODEL,
    keys,
    async (model, key) => {
      calls.push(`${model}:${key.slot}`);
      callCount++;
      return callCount === 3
        ? new Response("ok", { status: 200 })
        : new Response("busy", { status: 503 });
    },
    {
      operation: "test",
      sleep: async (delay) => {
        delays.push(delay);
      },
    },
  );

  assertEquals(calls, [
    `${GEMINI_FLASH_MODEL}:key_0`,
    `${GEMINI_FLASH_LITE_MODEL}:key_0`,
    `${GEMINI_FLASH_MODEL}:key_0`,
  ]);
  assertEquals(delays, [1000, 3000]);
  assertEquals(result.outcome, "response");
});

Deno.test("three temporary failures return a bounded exhausted result", async () => {
  const calls: string[] = [];
  const result = await requestGeminiWithResilience(
    GEMINI_FLASH_MODEL,
    keys,
    async (model, key) => {
      calls.push(`${model}:${key.slot}`);
      return new Response("busy", { status: 503 });
    },
    { operation: "test", sleep: async () => {} },
  );

  assertEquals(calls.length, 3);
  assertEquals(result, {
    outcome: "exhausted",
    reason: "temporary_unavailable",
    attempts: 3,
    lastStatus: 503,
  });
});

Deno.test("network failure follows the model fallback path", async () => {
  const calls: string[] = [];
  const result = await requestGeminiWithResilience(
    GEMINI_FLASH_MODEL,
    keys,
    async (model, key) => {
      calls.push(`${model}:${key.slot}`);
      if (model === GEMINI_FLASH_MODEL) {
        throw new TypeError("network unavailable");
      }
      return new Response("ok", { status: 200 });
    },
    { operation: "test", sleep: async () => {} },
  );

  assertEquals(calls, [
    `${GEMINI_FLASH_MODEL}:key_0`,
    `${GEMINI_FLASH_LITE_MODEL}:key_0`,
  ]);
  assertEquals(result.outcome, "response");
});

Deno.test("authentication and permission failures stop immediately", async () => {
  for (const status of [401, 403]) {
    const calls: string[] = [];
    const delays: number[] = [];
    const result = await requestGeminiWithResilience(
      GEMINI_FLASH_MODEL,
      keys,
      async (model, key) => {
        calls.push(`${model}:${key.slot}`);
        return new Response("denied", { status });
      },
      {
        operation: "test",
        sleep: async (delay) => {
          delays.push(delay);
        },
      },
    );

    assertEquals(calls, [`${GEMINI_FLASH_MODEL}:key_0`]);
    assertEquals(delays, []);
    assertEquals(result.outcome, "response");
  }
});

Deno.test("output already sent prevents retries", async () => {
  const calls: string[] = [];
  const result = await requestGeminiWithResilience(
    GEMINI_FLASH_MODEL,
    keys,
    async (model, key) => {
      calls.push(`${model}:${key.slot}`);
      return new Response("busy", { status: 503 });
    },
    {
      operation: "test",
      hasOutputStarted: () => true,
      sleep: async () => {},
    },
  );

  assertEquals(calls, []);
  assertEquals(result.outcome, "exhausted");
  if (result.outcome === "exhausted") {
    assertEquals(result.reason, "output_started");
  }
});

Deno.test("terminal request errors return immediately", async () => {
  const calls: string[] = [];
  const result = await requestGeminiWithResilience(
    GEMINI_FLASH_MODEL,
    keys,
    async (model, key) => {
      calls.push(`${model}:${key.slot}`);
      return new Response("malformed", { status: 400 });
    },
    { operation: "test", sleep: async () => {} },
  );

  assertEquals(calls.length, 1);
  assertEquals(result.outcome, "response");
});

Deno.test("non-network request exceptions still fail immediately", async () => {
  await assertRejects(() =>
    requestGeminiWithResilience(
      GEMINI_FLASH_MODEL,
      keys,
      async () => {
        throw new Error("local parsing failure");
      },
      { operation: "test", sleep: async () => {} },
    )
  );
});

Deno.test("busy copy is localized with English fallback", () => {
  assertEquals(
    getWiseyBusyMessage("tr"),
    "Wisey şu anda meşgul. Lütfen birazdan tekrar deneyin.",
  );
  assertEquals(
    getWiseyBusyMessage("unknown"),
    "Wisey is temporarily busy. Please try again in a moment.",
  );
});

Deno.test("availability fallbacks are never persisted", () => {
  assertEquals(shouldPersistWiseyResponse(true), false);
  assertEquals(shouldPersistWiseyResponse(false), true);
  assertEquals(shouldPersistWiseyResponse(undefined), true);
});
