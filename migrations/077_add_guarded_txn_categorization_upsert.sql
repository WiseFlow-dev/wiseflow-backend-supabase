-- Phase 5: atomic guard so category_user is never overwritten by automated writes.

CREATE OR REPLACE FUNCTION public.upsert_txn_categorization_model_guarded(
  p_user_id UUID,
  p_txn_id TEXT,
  p_category_model TEXT,
  p_category_confidence REAL,
  p_is_suggested BOOLEAN,
  p_merchant_normalized TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows INTEGER;
BEGIN
  INSERT INTO public.txn_categorization (
    user_id,
    txn_id,
    category_model,
    category_confidence,
    is_suggested,
    merchant_normalized,
    updated_at
  )
  VALUES (
    p_user_id,
    p_txn_id,
    p_category_model,
    p_category_confidence,
    COALESCE(p_is_suggested, false),
    p_merchant_normalized,
    now()
  )
  ON CONFLICT (user_id, txn_id)
  DO UPDATE SET
    category_model = EXCLUDED.category_model,
    category_confidence = EXCLUDED.category_confidence,
    is_suggested = EXCLUDED.is_suggested,
    merchant_normalized = EXCLUDED.merchant_normalized,
    updated_at = EXCLUDED.updated_at
  WHERE public.txn_categorization.category_user IS NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_txn_categorization_model_guarded(UUID, TEXT, TEXT, REAL, BOOLEAN, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_txn_categorization_model_guarded(UUID, TEXT, TEXT, REAL, BOOLEAN, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_txn_categorization_model_guarded(UUID, TEXT, TEXT, REAL, BOOLEAN, TEXT) TO service_role;
