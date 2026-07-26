-- Phase 3 extension: apply a user merchant rule to all matching transactions.
-- Preserves category_user by never overwriting rows where category_user is set.

CREATE OR REPLACE FUNCTION public.apply_user_merchant_rule_backfill(
  p_user_id UUID,
  p_merchant_normalized TEXT,
  p_category_key TEXT
)
RETURNS TABLE (
  scanned_count INTEGER,
  updated_count INTEGER,
  preserved_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_norm_merchant TEXT;
  v_scanned INTEGER := 0;
  v_updated INTEGER := 0;
  v_preserved INTEGER := 0;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_norm_merchant := normalize_merchant(p_merchant_normalized);
  IF v_norm_merchant IS NULL OR v_norm_merchant = '' THEN
    RETURN QUERY SELECT 0, 0, 0;
    RETURN;
  END IF;

  WITH matched AS (
    SELECT t.txn_id
    FROM public.transactions t
    WHERE t.user_id = p_user_id
      AND normalize_merchant(COALESCE(t.merchant_name, t.merchant, t.name, '')) = v_norm_merchant
  ),
  preserved AS (
    SELECT COUNT(*)::INTEGER AS cnt
    FROM matched m
    JOIN public.txn_categorization tc
      ON tc.user_id = p_user_id
     AND tc.txn_id = m.txn_id
    WHERE tc.category_user IS NOT NULL
  ),
  upserted AS (
    INSERT INTO public.txn_categorization (
      user_id,
      txn_id,
      category_model,
      category_confidence,
      merchant_normalized,
      updated_at
    )
    SELECT
      p_user_id,
      m.txn_id,
      p_category_key,
      1.0,
      v_norm_merchant,
      now()
    FROM matched m
    LEFT JOIN public.txn_categorization tc
      ON tc.user_id = p_user_id
     AND tc.txn_id = m.txn_id
    WHERE tc.txn_id IS NULL OR tc.category_user IS NULL
    ON CONFLICT (user_id, txn_id)
    DO UPDATE SET
      category_model = EXCLUDED.category_model,
      category_confidence = EXCLUDED.category_confidence,
      merchant_normalized = EXCLUDED.merchant_normalized,
      updated_at = EXCLUDED.updated_at
    WHERE public.txn_categorization.category_user IS NULL
    RETURNING 1
  )
  SELECT
    (SELECT COUNT(*)::INTEGER FROM matched),
    COALESCE((SELECT COUNT(*)::INTEGER FROM upserted), 0),
    COALESCE((SELECT cnt FROM preserved), 0)
  INTO v_scanned, v_updated, v_preserved;

  RETURN QUERY SELECT v_scanned, v_updated, v_preserved;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_user_merchant_rule_backfill(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_user_merchant_rule_backfill(UUID, TEXT, TEXT) TO authenticated;
