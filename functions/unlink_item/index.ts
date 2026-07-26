// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.3";

serve(async (req) => {
  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Use POST" }), { status: 405 });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const authHeader = req.headers.get("Authorization") ?? "";

    const supabase = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: auth } = await supabase.auth.getUser();
    const userId = auth?.user?.id;
    if (!userId) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });

    const body = await req.json().catch(() => ({}));
    const itemId: string | undefined = body.item_id;
    const accountId: string | undefined = body.account_id;

    if (!itemId && !accountId) {
      return new Response(JSON.stringify({ error: "Provide item_id or account_id" }), { status: 400 });
    }

    // Helper: fetch accounts for this user
    const fetchAccountsByItem = async (iid: string) => {
      const { data, error } = await supabase
        .from("accounts")
        .select("account_id")
        .eq("user_id", userId)
        .eq("item_id", iid);
      if (error) throw error;
      return (data ?? []).map((r: any) => r.account_id as string);
    };

    const fetchItemByAccount = async (aid: string) => {
      const { data, error } = await supabase
        .from("accounts")
        .select("item_id")
        .eq("user_id", userId)
        .eq("account_id", aid)
        .maybeSingle();
      if (error) throw error;
      return data?.item_id as string | undefined;
    };

    let targetItemId = itemId;
    if (!targetItemId && accountId) {
      targetItemId = await fetchItemByAccount(accountId);
      if (!targetItemId) {
        return new Response(JSON.stringify({ error: "account not found for user" }), { status: 404 });
      }
    }

    // All accounts under the item
    const accountIds = await fetchAccountsByItem(targetItemId!);

    // Delete transactions first
    if (accountIds.length > 0) {
      const { error: delTxErr } = await supabase
        .from("transactions")
        .delete()
        .in("account_id", accountIds)
        .eq("user_id", userId);
      if (delTxErr) throw delTxErr;
    }

    // Delete accounts
    const { error: delAccErr, count: accCount } = await supabase
      .from("accounts")
      .delete({ count: "exact" })
      .eq("user_id", userId)
      .eq("item_id", targetItemId!);
    if (delAccErr) throw delAccErr;

    // Delete the item
    const { error: delItemErr } = await supabase
      .from("plaid_items")
      .delete()
      .eq("user_id", userId)
      .eq("item_id", targetItemId!);
    if (delItemErr) throw delItemErr;

    return new Response(
      JSON.stringify({
        ok: true,
        item_id: targetItemId,
        removed_accounts: accCount ?? accountIds.length,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message ?? e) }), { status: 500 });
  }
});
