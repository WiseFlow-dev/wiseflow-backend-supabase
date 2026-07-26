// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { normalizeMerchant } from "../_shared/normalize.ts";

const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")               ?? "";
const SERVICE_ROLE  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")  ?? "";
const ANON_KEY      = Deno.env.get("SUPABASE_ANON_KEY")          ?? "";

// ─── Merchant pool ────────────────────────────────────────────────────────────
// Each entry mirrors what Plaid puts in transactions.name / merchant_name.
// amount[0..1] = [min, max] in dollars  |  income:true = negative amount (money IN)
const MERCHANTS: Array<{
  name: string;
  merchant: string | null;
  amount: [number, number];
  income?: boolean;
}> = [
  // ── Food & Dining ─────────────────────────────────────────────────────────
  { name: "STARBUCKS #12047 NEW YORK NY",       merchant: "Starbucks",              amount: [4.50,  12.00] },
  { name: "CHIPOTLE ONLINE 8291",               merchant: "Chipotle Mexican Grill", amount: [9.50,  22.00] },
  { name: "DOORDASH*MCDONALDS",                 merchant: "McDonald's",             amount: [8.00,  35.00] },
  { name: "UBER EATS*9BF2A74E",                 merchant: "Uber Eats",              amount: [18.00, 55.00] },
  { name: "SWEETGREEN NEW YORK",                merchant: "Sweetgreen",             amount: [11.00, 18.00] },
  { name: "DUNKIN #349812 BOSTON",              merchant: "Dunkin'",                amount: [2.75,   9.00] },
  { name: "PANERA BREAD 205713",                merchant: "Panera Bread",           amount: [8.00,  20.00] },
  { name: "SUBWAY 00123456",                    merchant: "Subway",                 amount: [6.00,  15.00] },
  { name: "GRUBHUB*ORDER 29F3",                 merchant: "Grubhub",                amount: [14.00, 48.00] },
  { name: "THE CHEESECAKE FACTORY",             merchant: "The Cheesecake Factory", amount: [22.00, 85.00] },
  { name: "WHOLE FOODS MARKET #10385",          merchant: "Whole Foods Market",     amount: [18.00, 120.00]},
  { name: "TRADER JOES #0581 AUSTIN TX",        merchant: "Trader Joe's",           amount: [15.00, 90.00] },

  // ── Shopping ──────────────────────────────────────────────────────────────
  { name: "AMAZON.COM*AB3CD4EF5",               merchant: "Amazon",                 amount: [12.99, 289.00]},
  { name: "WALMART SUPERCENTER #4521",          merchant: "Walmart",                amount: [22.00, 180.00]},
  { name: "TARGET 0481 AUSTIN TX",              merchant: "Target",                 amount: [15.00, 120.00]},
  { name: "APPLE.COM/BILL",                     merchant: "Apple",                  amount: [0.99,  29.99] },
  { name: "BEST BUY #00123456",                 merchant: "Best Buy",               amount: [49.00, 800.00]},
  { name: "COSTCO WHSE #0123",                  merchant: "Costco Wholesale",       amount: [45.00, 320.00]},
  { name: "ZARA USA 00342",                     merchant: "Zara",                   amount: [29.00, 130.00]},
  { name: "NIKE.COM PURCHASE",                  merchant: "Nike",                   amount: [60.00, 180.00]},
  { name: "ETSY INC",                           merchant: "Etsy",                   amount: [8.00,  75.00] },

  // ── Transportation ────────────────────────────────────────────────────────
  { name: "UBER *TRIP J7K2L",                   merchant: "Uber",                   amount: [8.00,  55.00] },
  { name: "LYFT *RIDE 1A2B3C",                  merchant: "Lyft",                   amount: [9.00,  50.00] },
  { name: "SHELL OIL 5744123 NEW YORK",         merchant: "Shell Oil",              amount: [42.00, 88.00] },
  { name: "CHEVRON 009812",                     merchant: "Chevron",                amount: [38.00, 95.00] },
  { name: "DELTA AIR 006234",                   merchant: "Delta Air Lines",        amount: [180.00,650.00]},
  { name: "UNITED AIRLINES 01623",              merchant: "United Airlines",        amount: [160.00,580.00]},
  { name: "NYC TRANSIT METROCARD",              merchant: "NYC MTA",                amount: [2.90,  33.00] },
  { name: "PARKWHIZ INC",                       merchant: "ParkWhiz",               amount: [12.00, 40.00] },

  // ── Subscriptions / Software ──────────────────────────────────────────────
  { name: "NETFLIX.COM",                        merchant: "Netflix",                amount: [15.49, 22.99] },
  { name: "SPOTIFY USA",                        merchant: "Spotify",                amount: [9.99,  15.99] },
  { name: "HULU 7823AB",                        merchant: "Hulu",                   amount: [7.99,  17.99] },
  { name: "DISNEY PLUS",                        merchant: "Disney+",                amount: [7.99,  13.99] },
  { name: "ADOBE SYSTEMS INC",                  merchant: "Adobe Systems",          amount: [9.99,  54.99] },
  { name: "OPENAI *CHATGPT",                    merchant: "OpenAI",                 amount: [20.00, 20.00] },
  { name: "GOOGLE*CLOUD 123456",                merchant: "Google Cloud",           amount: [12.00, 200.00]},
  { name: "GITHUB INC",                         merchant: "GitHub",                 amount: [4.00,  21.00] },
  { name: "NOTION LABS INC",                    merchant: "Notion",                 amount: [8.00,  16.00] },

  // ── Health & Fitness ──────────────────────────────────────────────────────
  { name: "CVS/PHARMACY #01234 BOSTON",         merchant: "CVS Pharmacy",           amount: [8.00,  65.00] },
  { name: "WALGREENS #7891 CHICAGO IL",         merchant: "Walgreens",              amount: [10.00, 80.00] },
  { name: "PLANET FITNESS #0234",               merchant: "Planet Fitness",         amount: [10.00, 25.00] },
  { name: "PELOTON INTERACTIVE INC",            merchant: "Peloton",                amount: [12.99, 44.99] },
  { name: "CVS MINUTE CLINIC",                  merchant: "CVS MinuteClinic",       amount: [80.00, 200.00]},

  // ── Entertainment ─────────────────────────────────────────────────────────
  { name: "AMC THEATERS #0045",                 merchant: "AMC Theatres",           amount: [12.00, 28.00] },
  { name: "TICKETMASTER*EVENT 99A1",            merchant: "Ticketmaster",           amount: [45.00, 250.00]},
  { name: "STEAM GAMES",                        merchant: "Steam",                  amount: [4.99,  59.99] },

  // ── Utilities / Bills ─────────────────────────────────────────────────────
  { name: "CON EDISON PAYMENT",                 merchant: "Con Edison",             amount: [60.00, 180.00]},
  { name: "VERIZON WIRELESS PMT",               merchant: "Verizon Wireless",       amount: [55.00, 120.00]},
  { name: "AT&T PAYMENT",                       merchant: "AT&T",                   amount: [50.00, 110.00]},
  { name: "SPECTRUM CABLE PMT",                 merchant: "Spectrum",               amount: [70.00, 130.00]},

  // ── Hotels & Travel ───────────────────────────────────────────────────────
  { name: "MARRIOTT HOTELS MIAMI FL",           merchant: "Marriott Hotels",        amount: [120.00,350.00]},
  { name: "AIRBNB *HMABCD1234",                 merchant: "Airbnb",                 amount: [85.00, 400.00]},
  { name: "HILTON HONORS",                      merchant: "Hilton Hotels",          amount: [110.00,320.00]},

  // ── Income (negative = money IN, Plaid convention) ────────────────────────
  { name: "PAYROLL DIRECT DEPOSIT",             merchant: null,                     amount: [2500.00, 6000.00], income: true },
  { name: "VENMO PAYMENT FROM JOHN D",          merchant: "Venmo",                  amount: [20.00,  300.00],   income: true },
  { name: "ZELLE PAYMENT FROM SARAH",           merchant: "Zelle",                  amount: [50.00,  500.00],   income: true },
  { name: "COINBASE INC",                       merchant: "Coinbase",               amount: [50.00,  800.00],   income: true },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────
const rand  = (min: number, max: number) => Math.random() * (max - min) + min;
const randI = (min: number, max: number) => Math.floor(rand(min, max + 1));

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0];
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── Main handler ─────────────────────────────────────────────────────────────
serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" } });
  }

  // Verify caller
  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) return json({ ok: false, error: "Unauthorized" }, 401);

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  const body = await req.json().catch(() => ({}));
  const action: string = body?.action ?? "seed";

  // ── CLEANUP action ──────────────────────────────────────────────────────────
  // Deletes all test transactions for this user (identified by raw->>'_seed_test' = 'true')
  if (action === "cleanup") {
    const { data: testTxns } = await sb
      .from("transactions")
      .select("txn_id")
      .eq("user_id", user.id)
      .eq("raw->_seed_test", "true");

    const ids = (testTxns ?? []).map((r: any) => r.txn_id);

    if (ids.length > 0) {
      await sb.from("ai_categorization_queue").delete().in("txn_id", ids);
      await sb.from("transactions").delete().in("txn_id", ids).eq("user_id", user.id);
    }

    return json({ ok: true, deleted: ids.length });
  }

  // ── SEED action ─────────────────────────────────────────────────────────────
  const accountId: string = body?.account_id;
  const itemId: string    = body?.item_id ?? "";
  const count: number     = Math.min(body?.count ?? 40, 100); // cap at 100

  if (!accountId) return json({ ok: false, error: "account_id is required" }, 400);

  // Build random transaction rows
  const pool = [...MERCHANTS];
  const txnRows: any[]   = [];
  const queueRows: any[] = [];

  for (let i = 0; i < count; i++) {
    const entry  = pool[randI(0, pool.length - 1)];
    const daysBack = randI(1, 60);
    const txnDate  = daysAgo(daysBack);
    const txnId    = `seed_${crypto.randomUUID()}`;

    // Plaid sign convention: positive = expense (money OUT), negative = income (money IN)
    const rawAmount = rand(entry.amount[0], entry.amount[1]);
    const amount    = entry.income ? -rawAmount : rawAmount;
    // Amount stored in queue as cents, always positive magnitude
    const amountCents = Math.round(Math.abs(rawAmount) * 100);

    const merchantNorm = normalizeMerchant(entry.merchant ?? entry.name);

    txnRows.push({
      txn_id:          txnId,
      account_id:      accountId,
      item_id:         itemId,
      user_id:         user.id,
      name:            entry.name,
      merchant_name:   entry.merchant,
      amount:          +amount.toFixed(2),
      txn_date:        txnDate,
      currency:        "USD",
      pending:         false,
      provider:        "plaid",
      raw:             { _seed_test: true }, // marker for cleanup
    });

    queueRows.push({
      txn_id:              txnId,
      provider:            "plaid",
      user_id:             user.id,
      merchant_raw:        entry.name,
      merchant_normalized: merchantNorm,
      amount_cents:        amountCents,
      account_subtype:     null,
      status:              "pending",
    });
  }

  // Insert transactions
  const { error: txnErr } = await sb.from("transactions").insert(txnRows);
  if (txnErr) return json({ ok: false, error: `transactions insert: ${txnErr.message}` }, 500);

  // Insert queue rows (upsert in case any txn_id already exists)
  const { error: qErr } = await sb.from("ai_categorization_queue").upsert(queueRows, { onConflict: "txn_id" });
  if (qErr) return json({ ok: false, error: `queue insert: ${qErr.message}` }, 500);

  return json({
    ok:        true,
    seeded:    count,
    account_id: accountId,
    note:      "Call ai-categorize-batch to process. Use action:'cleanup' to remove all seed data.",
  });
});
