-- ============================================================================
-- STEP 1 of 2 — Stop the Amex 18dedaa2 retry loop
--
-- Run by hand. Safe to run BEFORE the code fix is deployed: it only changes
-- one item's status, and the nightly heal sweep already excludes
-- 'reauth_required' items, so the effect is immediate.
--
-- Item:  18dedaa2-37f4-4f80-94f8-84f87e754437
--        American Express — "Business Platinum Card®" ····1003
-- State: status 'degraded', last_error_code 'HEAL_SYNC_ERROR', error_count 39,
--        failing daily since 2026-08-14, transactions end 2026-08-10.
--
-- Why by hand: 'HEAL_SYNC_ERROR' is an invented literal that carries no
-- diagnosis, so the true Plaid error was never recorded. The strong inference
-- is ITEM_LOGIN_REQUIRED (the item has no webhook registered, so the webhook
-- path that would have set reauth_required could never fire for it). Once the
-- code fix is deployed the real error_code is persisted and this escalation
-- happens automatically — this statement just stops the bleeding now.
--
-- Effect: the item drops out of the nightly sweep and the UI shows the
-- "Re-link Account" button.
-- ============================================================================

-- ── Pre-flight: confirm the item is in the state described above ────────────
SELECT id, institution_name, status, last_error_code, error_count,
       last_successful_sync
FROM plaid_items
WHERE id = '18dedaa2-37f4-4f80-94f8-84f87e754437';
-- Expect: degraded / HEAL_SYNC_ERROR / 39 / 2026-08-14

-- ── Apply ───────────────────────────────────────────────────────────────────
BEGIN;

UPDATE plaid_items
SET status          = 'reauth_required',
    last_error_code = 'ITEM_LOGIN_REQUIRED',
    updated_at      = NOW()
WHERE id = '18dedaa2-37f4-4f80-94f8-84f87e754437'
  AND status = 'degraded';          -- no-op if something already changed it

-- Expect: UPDATE 1. If it reports 0, STOP and re-read the pre-flight output.
SELECT id, status, last_error_code, error_count
FROM plaid_items
WHERE id = '18dedaa2-37f4-4f80-94f8-84f87e754437';

COMMIT;
-- ROLLBACK; -- use instead of COMMIT if the row above does not look right

-- ── After committing ────────────────────────────────────────────────────────
-- Re-link the card in the UI. With the fix deployed, the relink-complete
-- handler resets status, upserts any newly selected accounts, and requeues
-- webhook events that were failed while the item was in reauth.
--
-- NOTE: error_count is deliberately left at 39 as a record of the loop. The
-- relink handler resets it to 0 on success.
