import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { maybeResolveSemanticCategory } from "../semanticResolver.ts";

Deno.test("semantic resolver rescues streaming merchant from broad digital concept", () => {
  const decision = maybeResolveSemanticCategory(
    { broadConcept: "Digital Media", merchantClean: "spotify" },
    "spotify mar 20",
    "Spotify: Mar_20",
    ["Streaming Services", "Entertainment", "Uncategorized"],
    "Uncategorized",
    "Uncategorized",
    false
  );
  assertEquals(decision?.categoryKey, "Streaming Services");
});

Deno.test("semantic resolver rescues internet merchant from connectivity concept", () => {
  const decision = maybeResolveSemanticCategory(
    { broadConcept: "Connectivity", merchantClean: "hkbn" },
    "hkbn svc chr",
    "HKBN SVC CHR",
    ["Internet", "Phone", "Uncategorized"],
    "Uncategorized",
    "Uncategorized",
    false
  );
  assertEquals(decision?.categoryKey, "Internet");
});

Deno.test("semantic resolver declines when AI already resolved to a specific category", () => {
  const decision = maybeResolveSemanticCategory(
    { broadConcept: "Digital Media", merchantClean: "spotify" },
    "spotify mar 20",
    "Spotify: Mar_20",
    ["Streaming Services", "Entertainment", "Uncategorized"],
    "Streaming Services",
    "Uncategorized",
    false
  );
  assertEquals(decision, null);
});
