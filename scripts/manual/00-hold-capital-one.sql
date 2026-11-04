-- ============================================================================
-- STEP 0 of 3 — Park Capital One so no sync touches it before you are ready
--
-- ⚠️  RUN THIS FIRST, BEFORE MERGING THE PR.
--
-- Item: ccffe6d8-3b5c-4da5-a02b-c166359b436e  (Capital One, Venture X ····9950)
--
-- Why this exists: /api/sync/heal runs at 03:00 UTC every day and selects
-- items with status IN ('connected','degraded'). Capital One is currently
-- 'degraded', so it is in that set. If the heal job runs after the fix is
-- deployed but before you have re-pointed the account row, the pre-sync
-- account refresh will CREATE a second accounts row under the new
-- plaid_account_id — and then re-pointing the original row fails, because
-- accounts.plaid_account_id is UNIQUE and the new id is taken. You would be
-- back to needing a merge step.
--
-- Setting the status to 'disconnected' removes it from the sweep. This works
-- both before and after the deploy, which is why it is used here rather than
-- the error_count ceiling (that only exists post-deploy).
--
-- Released in 02 §C, immediately before the cursor reset.
--
-- Scope: Capital One only. Every other item keeps syncing normally.
-- ============================================================================

-- ── Pre-flight ──────────────────────────────────────────────────────────────
SELECT id, institution_name, status, last_error_code, error_count,
       last_successful_sync, LEFT(transactions_cursor, 24) AS cursor_prefix
FROM plaid_items
WHERE id = 'ccffe6d8-3b5c-4da5-a02b-c166359b436e';
-- Expect: status 'degraded'. Note the cursor_prefix — 02 §C records it before
-- clearing it, but keep your own copy here too.

-- ── Apply ───────────────────────────────────────────────────────────────────
BEGIN;

UPDATE plaid_items
SET status     = 'disconnected',
    updated_at = NOW()
WHERE id = 'ccffe6d8-3b5c-4da5-a02b-c166359b436e'
  AND status IN ('connected', 'degraded');

-- Expect: UPDATE 1.
SELECT id, status FROM plaid_items
WHERE id = 'ccffe6d8-3b5c-4da5-a02b-c166359b436e';

COMMIT;
-- ROLLBACK; -- use instead of COMMIT if the row above does not look right

-- ── While the hold is in place ──────────────────────────────────────────────
-- The dashboard will show Capital One as "Disconnected" with a "Re-link
-- Account" button. DO NOT click it: a re-link would run relink-complete, which
-- upserts accounts and would create the second row this hold exists to avoid.
--
-- The hold is released in 02 §C. If you abandon the recovery, restore it with:
--
--   UPDATE plaid_items SET status = 'degraded', updated_at = NOW()
--   WHERE id = 'ccffe6d8-3b5c-4da5-a02b-c166359b436e';
