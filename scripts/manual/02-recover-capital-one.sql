-- ============================================================================
-- STEP 2 of 2 — Recover the Capital One transactions lost since 2026-08-08
--
-- Item:    ccffe6d8-3b5c-4da5-a02b-c166359b436e
--          Capital One — "Venture X" ····9950
-- Stored:  plaid_account_id 'nPj7wRObAdUYXe8jRqYwUd5z8k5JNEfBzr7vP',
--          693 transactions, newest 2026-08-08, balances frozen at 2026-08-10.
--
-- What happened: on 2026-09-22 03:20:57 the sync logged added: 254 and wrote
-- none of it. The server-side request log for that run shows a GET on accounts,
-- then NO POST to transactions and NO PATCH to accounts, followed by the cursor
-- PATCH — every transaction and every balance missed the account map, so the
-- item's account_id(s) at Plaid no longer match the stored one. The cursor then
-- advanced past those 254 rows, and /transactions/sync never re-offers a page.
--
-- ⚠️  DO NOT RUN THIS UNTIL ALL THREE ARE TRUE:
--     1. the sync-engine fix is deployed to production;
--     2. at least one sync has run since the deploy (the pre-sync account
--        refresh creates the missing account row automatically); and
--     3. Section A below confirms the mapping is repaired.
--
-- Running it earlier re-pulls the full history straight back into the same
-- broken mapping and drops it again — except that with the fix deployed the
-- run now aborts loudly instead, so the damage is bounded either way.
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION A — Pre-flight. Read only. All three must pass.
-- ════════════════════════════════════════════════════════════════════════════

-- A1. How many accounts does the item have now, and when were they last
--     written? After a post-deploy sync there should be a row whose updated_at
--     is recent. A row still stuck at 2026-08-10 means the fix has not run yet.
SELECT a.id, a.name, a.mask, a.plaid_account_id, a.updated_at, a.created_at,
       (SELECT COUNT(*) FROM transactions t WHERE t.account_id = a.id) AS txn_count,
       (SELECT MAX(t.date) FROM transactions t WHERE t.account_id = a.id) AS newest_txn
FROM accounts a
WHERE a.plaid_item_id = 'ccffe6d8-3b5c-4da5-a02b-c166359b436e'
  AND a.deleted_at IS NULL
ORDER BY a.created_at;

-- A2. The item must not be in an error state.
SELECT id, status, last_error_code, error_count, last_successful_sync,
       LEFT(transactions_cursor, 24) AS cursor_prefix
FROM plaid_items
WHERE id = 'ccffe6d8-3b5c-4da5-a02b-c166359b436e';
-- Expect: status 'connected', last_error_code NULL.
-- If last_error_code = 'UNMAPPED_ACCOUNT', the fix is deployed and correctly
-- refusing to advance the cursor — but the mapping is NOT yet repaired.
-- Investigate with scripts/verify-account-mapping.ts before going further.

-- A3. Did the post-deploy sync write anything at all?
SELECT details, created_at
FROM audit_log
WHERE entity_id = 'ccffe6d8-3b5c-4da5-a02b-c166359b436e'
  AND action IN ('PLAID_SYNC_COMPLETED', 'PLAID_SYNC_FAILED')
ORDER BY created_at DESC
LIMIT 5;
-- 'added' here now means rows actually written, so a non-zero value proves the
-- mapping works end to end.


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION B — OPTIONAL: re-point the historical account row.
--
-- Only relevant if A1 shows TWO rows for the same physical card: the original
-- (693 transactions, plaid_account_id nPj7wRO…) and a new one the refresh
-- created under the reissued id. The code deliberately does NOT merge these
-- automatically — guessing that two accounts are the same card is exactly the
-- kind of silent assumption that caused this incident.
--
-- Re-pointing keeps all 693 transactions attached to one account instead of
-- splitting the card's history across two rows.
--
-- ⚠️  Verify by hand that both rows are the same card (same mask ····9950,
--     same type, same item) before running anything here.
-- ════════════════════════════════════════════════════════════════════════════

-- B1. Inspect the candidates side by side.
SELECT id, name, mask, type, subtype, plaid_account_id, current_balance,
       created_at, updated_at,
       (SELECT COUNT(*) FROM transactions t WHERE t.account_id = accounts.id) AS txn_count
FROM accounts
WHERE plaid_item_id = 'ccffe6d8-3b5c-4da5-a02b-c166359b436e'
ORDER BY created_at;

-- B2. If — and only if — they are the same card, move the history onto the new
--     row and retire the old one. Fill in the two UUIDs from B1 first.
--
-- BEGIN;
--
-- UPDATE transactions
-- SET account_id = '<NEW_ACCOUNT_UUID>'
-- WHERE account_id = '<OLD_ACCOUNT_UUID>';
--
-- UPDATE accounts
-- SET deleted_at = NOW(), is_active = false, updated_at = NOW()
-- WHERE id = '<OLD_ACCOUNT_UUID>';
--
-- -- Confirm: one active row, holding the full history.
-- SELECT a.id, a.name, a.plaid_account_id, a.deleted_at,
--        (SELECT COUNT(*) FROM transactions t WHERE t.account_id = a.id) AS txn_count
-- FROM accounts a
-- WHERE a.plaid_item_id = 'ccffe6d8-3b5c-4da5-a02b-c166359b436e';
--
-- COMMIT;
-- -- ROLLBACK; -- if the counts do not add up


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION C — The cursor reset. Run only after A (and B, if it applied) pass.
--
-- Clearing transactions_cursor makes the next /transactions/sync replay the
-- item's full available history from scratch.
--
-- Safe to re-run: transactions are upserted on plaid_transaction_id (UNIQUE),
-- so replayed rows update in place rather than duplicating. The 254 lost
-- transactions come back as long as they are still inside Plaid's retention
-- window for the item.
--
-- Cost: one full history pull (Capital One has ~693 rows on file, so this is
-- a handful of 500-row pages, not a large job).
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- Keep the old cursor in the audit trail before discarding it.
INSERT INTO audit_log (user_id, action, entity_type, entity_id, details)
SELECT user_id,
       'PLAID_SYNC_FAILED',
       'plaid_item',
       id::text,
       jsonb_build_object(
         'error_code', 'MANUAL_CURSOR_RESET',
         'reason', 'Recovering 254 transactions dropped by unmapped-account bug on 2026-09-22',
         'previous_cursor', transactions_cursor,
         'reset_at', NOW()
       )
FROM plaid_items
WHERE id = 'ccffe6d8-3b5c-4da5-a02b-c166359b436e';

UPDATE plaid_items
SET transactions_cursor = NULL,
    updated_at          = NOW()
WHERE id = 'ccffe6d8-3b5c-4da5-a02b-c166359b436e'
  AND status = 'connected';         -- refuse to reset an item still in error

-- Expect: UPDATE 1. If 0, the item is not 'connected' — STOP, return to A2.
SELECT id, status, transactions_cursor
FROM plaid_items
WHERE id = 'ccffe6d8-3b5c-4da5-a02b-c166359b436e';

COMMIT;
-- ROLLBACK; -- use instead of COMMIT if the row above does not look right


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION D — Verify after the next sync (or trigger the heal job manually).
-- ════════════════════════════════════════════════════════════════════════════

-- D1. Did the history come back? newest_txn should now be recent, not 2026-08-08.
SELECT a.name, a.mask,
       COUNT(t.id)   AS txn_count,
       MIN(t.date)   AS oldest_txn,
       MAX(t.date)   AS newest_txn
FROM accounts a
LEFT JOIN transactions t ON t.account_id = a.id AND t.deleted_at IS NULL
WHERE a.plaid_item_id = 'ccffe6d8-3b5c-4da5-a02b-c166359b436e'
  AND a.deleted_at IS NULL
GROUP BY a.id, a.name, a.mask;

-- D2. Confirm the Data Health check no longer flags the item.
--     (Full version: scripts/silent-sync-check.sql)
SELECT i.institution_name, i.status, i.last_successful_sync,
       MAX(t.date) AS newest_txn,
       (CURRENT_DATE - MAX(t.date)) AS days_since_newest_txn
FROM plaid_items i
JOIN accounts a ON a.plaid_item_id = i.id AND a.deleted_at IS NULL
LEFT JOIN transactions t ON t.account_id = a.id AND t.deleted_at IS NULL
WHERE i.id = 'ccffe6d8-3b5c-4da5-a02b-c166359b436e'
GROUP BY i.id, i.institution_name, i.status, i.last_successful_sync;
