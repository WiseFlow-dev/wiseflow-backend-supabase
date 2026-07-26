-- Backfill wallet_transactions categories from txn_categorization.
-- v2: skip AI results of 'Uncategorized' (only apply real categories),
--     and use a wider ±3-day window to tolerate provider date rounding.

CREATE OR REPLACE FUNCTION public.backfill_wallet_categories(p_user_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_actor UUID;
  v_target UUID;
  v_updated INTEGER := 0;
BEGIN
  v_role := auth.role();
  v_actor := auth.uid();

  IF v_role IS DISTINCT FROM 'authenticated' AND v_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF v_role = 'service_role' THEN
    v_target := p_user_id;
    IF v_target IS NULL THEN
      RAISE EXCEPTION 'p_user_id_required';
    END IF;
  ELSE
    v_target := COALESCE(p_user_id, v_actor);
    IF v_target IS NULL OR v_target IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'forbidden';
    END IF;
  END IF;

  WITH matched AS (
    SELECT
      wt.id AS wallet_tx_id,
      tc.category_model,
      COALESCE(tc.is_suggested, false) AS is_suggested,
      (
        SELECT c.id
        FROM public.categories c
        WHERE (c.user_id = tc.user_id OR c.is_system = true)
          AND lower(trim(c.name)) = lower(trim(tc.category_model))
        ORDER BY
          CASE WHEN c.user_id = tc.user_id THEN 0 ELSE 1 END,
          c.created_at DESC
        LIMIT 1
      ) AS category_id
    FROM public.wallet_transactions wt
    JOIN public.transactions t
      ON t.user_id = wt.user_id
     AND t.name = wt.title
     -- ±3-day window: tolerates provider rounding (e.g. TrueLayer month-start dates)
     AND wt.date >= ((t.txn_date::date) - interval '3 days')::timestamptz
     AND wt.date <  ((t.txn_date::date) + interval '4 days')::timestamptz
     AND abs(round((wt.amount::numeric) * 100)) = abs(round((t.amount::numeric) * 100))
    JOIN public.txn_categorization tc
      ON tc.user_id = t.user_id
     AND tc.txn_id = t.txn_id
    WHERE wt.user_id = v_target
      AND tc.category_model IS NOT NULL
      AND tc.category_model <> 'Uncategorized'
      AND tc.category_user IS NULL
      AND (wt.category IS NULL OR wt.category = 'Uncategorized')
  ),
  dedup AS (
    SELECT DISTINCT ON (wallet_tx_id)
      wallet_tx_id,
      category_model,
      is_suggested,
      category_id
    FROM matched
    ORDER BY wallet_tx_id
  )
  UPDATE public.wallet_transactions wt
     SET category = d.category_model,
         category_id = COALESCE(d.category_id, wt.category_id),
         is_suggested = d.is_suggested
    FROM dedup d
   WHERE wt.id = d.wallet_tx_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok', true,
    'updated_count', v_updated,
    'user_id', v_target
  );
END;
$$;

REVOKE ALL ON FUNCTION public.backfill_wallet_categories(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.backfill_wallet_categories(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_wallet_categories(UUID) TO service_role;
