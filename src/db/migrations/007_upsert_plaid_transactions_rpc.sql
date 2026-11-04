-- ============================================================================
-- 007: Plaid transaction upsert that never overwrites user-owned fields
--
-- The sync previously wrote transactions with
--   supabase.from('transactions').upsert(rows, { onConflict: 'plaid_transaction_id' })
-- PostgREST turns that into ON CONFLICT DO UPDATE SET <every column in the
-- payload>. The payload carries entity_id and is_recurring, so every Plaid
-- "modified" event — and every row of a full cursor-reset replay — reset:
--   - is_recurring to Plaid's LOAN_PAYMENTS / RENT_AND_UTILITIES rule, wiping
--     flags set by the app's recurring detection (subscriptions);
--   - entity_id to the item's default entity, undoing per-transaction
--     reassignment via /api/accounts/assign-entity.
--
-- This function separates the two cases:
--   INSERT (new plaid_transaction_id): every column, as before, including the
--     item entity_id and the computed is_recurring.
--   UPDATE (conflict on plaid_transaction_id): ONLY the Plaid-owned columns
--     amount, date, merchant_name, plaid_category, account_id, updated_at.
--     Never entity_id, is_recurring, user_id, user_category_id,
--     recurring_pattern_id, notes or deleted_at.
--
-- merchant_name stays Plaid-owned: nothing in the app writes it except the
-- sync itself (checked across src/ at the time of writing).
--
-- SECURITY INVOKER, not DEFINER: the caller is the service-role client, which
-- already holds INSERT/UPDATE on public.transactions. Running as the caller
-- means the function can never grant more than the caller already has.
--
-- Returns the number of rows inserted plus updated, which is what the sync
-- reports as rows actually written.
--
-- Additive. Rollback:
--   DROP FUNCTION public.upsert_plaid_transactions(jsonb);
-- ============================================================================

CREATE OR REPLACE FUNCTION public.upsert_plaid_transactions(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RETURN 0;
  END IF;

  INSERT INTO public.transactions (
    user_id,
    entity_id,
    account_id,
    plaid_transaction_id,
    amount,
    date,
    merchant_name,
    plaid_category,
    is_recurring
  )
  SELECT
    r.user_id,
    r.entity_id,
    r.account_id,
    r.plaid_transaction_id,
    r.amount,
    r.date,
    r.merchant_name,
    r.plaid_category,
    COALESCE(r.is_recurring, false)
  FROM jsonb_to_recordset(p_rows) AS r(
    user_id              uuid,
    entity_id            uuid,
    account_id           uuid,
    plaid_transaction_id text,
    amount               numeric(14, 2),
    date                 date,
    merchant_name        text,
    plaid_category       jsonb,
    is_recurring         boolean
  )
  ON CONFLICT (plaid_transaction_id) DO UPDATE SET
    -- Plaid-owned columns only. Everything else on an existing row belongs
    -- to the user or to the app's own enrichment and must survive a sync.
    amount         = EXCLUDED.amount,
    date           = EXCLUDED.date,
    merchant_name  = EXCLUDED.merchant_name,
    plaid_category = EXCLUDED.plaid_category,
    account_id     = EXCLUDED.account_id,
    updated_at     = NOW();

  -- For INSERT ... ON CONFLICT DO UPDATE, ROW_COUNT is inserted + updated.
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Public functions are reachable through PostgREST at /rest/v1/rpc/, so lock
-- this down to the service role, matching get_plaid_token (migration 005).
REVOKE ALL ON FUNCTION public.upsert_plaid_transactions(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_plaid_transactions(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.upsert_plaid_transactions(jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_plaid_transactions(jsonb) TO service_role;
