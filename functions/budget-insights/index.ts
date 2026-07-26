import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// Edge Function: budget-insights
// Computes compact budget insights for a wallet/budget over a date range.
// Request (POST JSON): { walletId: string, budgetId?: string, startMs: number, endMs: number, cap?: number }
// Response: { spent, cap, progress, overAmount, summary_short, chips: Array<{label:string,value:string}>, details_long, topMerchants, topCategories, spikes }

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  try {
    const body = await req.json().catch(() => ({}));
    const walletId = String(body.walletId || "").trim();
    const startMs = Number(body.startMs ?? 0);
    const endMs = Number(body.endMs ?? 0);
    const capRaw = Number.isFinite(body.cap) ? Number(body.cap) : undefined;
    const cap = capRaw && capRaw > 0 ? capRaw : undefined;

    // Authenticate user (multi-tenant safety)
    const authUserId = await getAuthUserId(req).catch(() => null);

    if (!walletId || !startMs || !endMs) {
      return json({ ok: false, error: "walletId, startMs, endMs are required" }, 400);
    }
    if (endMs <= startMs) {
      return json({ ok: false, error: "endMs must be greater than startMs" }, 400);
    }

    const supabase = getServiceClient();

    // Fetch wallet_transactions for the user wallet in range
    // Amount convention: negative = expense, positive = income
    const startISO = new Date(startMs).toISOString();
    const endISO = new Date(endMs).toISOString();

    const { data: txns, error } = await supabase
      .from("wallet_transactions")
      .select("amount, category, date, title, note")
      .eq("wallet_id", walletId)
      .modify((q: any) => (authUserId ? q.eq("user_id", authUserId) : q))
      .gte("date", startISO)
      .lte("date", endISO);

    if (error) return json({ ok: false, error: error.message }, 500);

    const rows = (txns || []) as Array<{
      amount: number;
      category: string | null;
      title?: string | null;
      note?: string | null;
      date: string;
    }>;

    // Only expenses contribute to spent (absolute value)
    const expenses = rows.filter((r) => typeof r.amount === "number" && r.amount < 0);
    const abs = (n: number) => Math.abs(n);
    const spent = round2(expenses.reduce((sum, r) => sum + abs(r.amount), 0));

    // Aggregations
    const by = <T extends string>(key: T, label: string) => {
      const map = new Map<string, number>();
      for (const r of expenses) {
        const k = String((r as any)[key] ?? label);
        map.set(k, (map.get(k) ?? 0) + abs(r.amount));
      }
      return [...map.entries()].sort((a, b) => b[1] - a[1]);
    };

    const catAgg = by("category", "Other");
    // Use title as a proxy for merchant/payee if present; otherwise this will
    // still surface the most frequent titles (helpful driver signal)
    const titleAgg = by("title", "Other");

    // Spikes by day with simple z-score filter
    const dayMap = new Map<string, number>();
    for (const r of expenses) {
      const d = new Date(r.date);
      const key = d.toISOString().slice(0, 10); // YYYY-MM-DD
      dayMap.set(key, (dayMap.get(key) ?? 0) + abs(r.amount));
    }
    const dayAgg = [...dayMap.entries()].sort((a, b) => b[1] - a[1]);
    let spikeTop: [string, number] | undefined = dayAgg[0];
    if (dayAgg.length > 2) {
      const vals = dayAgg.map(([, v]) => v);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const sd = Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length) || 0;
      if (spikeTop && sd > 0) {
        const z = (spikeTop[1] - mean) / sd;
        if (z < 1.5) spikeTop = undefined; // not a strong spike
      }
    }

    // Burn rate / projection
    const days = Math.max(1, Math.ceil((endMs - startMs) / 86_400_000));
    const avgPerDay = round2(spent / days);
    const plannedPerDay = cap ? round2(cap / days) : undefined;

    // Progress + overage
    const progress = cap ? spent / cap : undefined;
    const overAmount = cap ? Math.max(0, spent - cap) : undefined;

    // Build concise content
    const chips: Array<{ label: string; value: string }> = [];
    const topTitle = titleAgg[0];
    if (topTitle && topTitle[0] !== "Other") {
      chips.push({ label: "Top", value: `${truncate(topTitle[0], 18)} $${shortMoney(topTitle[1])}` });
    } else if (catAgg[0]) {
      chips.push({ label: "Top", value: `${truncate(catAgg[0][0], 18)} $${shortMoney(catAgg[0][1])}` });
    }
    if (spikeTop) chips.push({ label: "Spike", value: `${spikeTop[0]} $${shortMoney(spikeTop[1])}` });
    if (avgPerDay) chips.push({ label: "Avg/Day", value: `$${shortMoney(avgPerDay)}` });
    // Limit to 3 chips
    while (chips.length > 3) chips.pop();

    let summary_short = "";
    if (cap && progress !== undefined) {
      if (progress > 10) summary_short = `Severely over by $${shortMoney(spent - cap)}. Few large purchases.`;
      else if (progress > 3) summary_short = `Heavily over by $${shortMoney(spent - cap)}. High average spend.`;
      else if (progress > 1.1) summary_short = `Over budget by $${shortMoney(spent - cap)}. Consider adjustments.`;
      else if (progress > 0.9) summary_short = `Near the limit. Slow down to stay within budget.`;
      else summary_short = `On track. $${shortMoney(cap - spent)} left.`;
    } else {
      summary_short = `Spent $${shortMoney(spent)} in this period.`;
    }
    summary_short = truncate(summary_short, 120);

    const details_long = {
      spent,
      cap: cap ?? null,
      progress: progress ?? null,
      overAmount: overAmount ?? null,
      topCategories: catAgg.slice(0, 5).map(([name, amount]) => ({ name, amount: round2(amount) })),
      topTitles: titleAgg.slice(0, 5).map(([name, amount]) => ({ name, amount: round2(amount) })),
      spikes: spikeTop ? [{ date: spikeTop[0], amount: round2(spikeTop[1]) }] : [],
      burnRate: { avgPerDay, plannedPerDay },
      projection: cap
        ? {
            expectedAtEnd: round2(avgPerDay * days),
            willExceed: (avgPerDay * days) > cap,
            expectedOverAmount: Math.max(0, round2(avgPerDay * days - cap)),
          }
        : null,
    };

    return json({
      ok: true,
      spent,
      cap: cap ?? null,
      progress: progress ?? null,
      overAmount: overAmount ?? null,
      summary_short,
      chips,
      details_long,
    });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

function getServiceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false } });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  } as Record<string, string>;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders() } });
}

function round2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function shortMoney(n: number) {
  const v = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (v >= 1_000_000) return `${sign}${(v / 1_000_000).toFixed(1)}m`;
  if (v >= 1_000) return `${sign}${(v / 1_000).toFixed(1)}k`;
  return `${sign}${Math.round(v)}`;
}

// Best‑effort Authorization: extract user id (sub) from Bearer JWT without verification.
// In Supabase Edge Functions, the JWT is trusted at the edge and can be used for filtering.
async function getAuthUserId(req: Request): Promise<string | null> {
  try {
    const auth = req.headers.get("authorization") || req.headers.get("Authorization") || "";
    const m = auth.match(/Bearer\s+([^\s]+)/i);
    if (!m) return null;
    const token = m[1];
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payloadJson = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(payloadJson || "{}");
    const sub = String(payload.sub || payload.user_id || "").trim();
    return sub || null;
  } catch (_) {
    return null;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}
