-- ============================================================================
-- STEP 2 of 3 — Recover the Capital One transactions lost since 2026-08-08
--
-- Item:    ccffe6d8-3b5c-4da5-a02b-c166359b436e
--          Capital One — "Venture X" ····9950
-- Account: 3fc1ca01-e89e-4d09-bbd0-3ef6bec4d3b5
-- Stored:  plaid_account_id 'nPj7wRObAdUYXe8jRqYwUd5z8k5JNEfBzr7vP',
--          693 transactions, newest 2026-08-08, balances frozen at 2026-08-10.
--
-- What happened: on 2026-09-22 03:20:57 the sync logged added: 254 and wrote
-- none of it. The request log for that run shows a GET on accounts, then NO
-- POST to transactions and NO PATCH to accounts, then the cursor PATCH — every
-- transaction and every balance missed the account map, so the item's
-- account_id(s) at Plaid no longer match the stored one. The cursor then
-- advanced past those 254 rows, and /transactions/sync never re-offers a page.
--
-- SEQUENCE — re-point BEFORE any sync runs, so no second accounts row is ever
-- created and entity_id is preserved untouched:
--
--   §A  verify the mapping and read the new plaid_account_id   (read only)
--   §B  re-point the existing Venture X row to that id
--   §C  release the 00 hold and reset the cursor
--   §D  let one sync run, then verify
--   §E  dedupe preflight — report only, no deletes
--
-- ⚠️  PRECONDITIONS for §B onward:
--     1. scripts/manual/00-hold-capital-one.sql has been run (item parked), AND
--     2. the fix is deployed (PR #18 merged), AND
--     3. scripts/probe-transaction-ids.ts says ids are STABLE — see §E first
--        if it says REISSUED.
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION A — Pre-flight. Read only.
-- ════════════════════════════════════════════════════════════════════════════

-- A1. The item must still be parked by step 00. If this reads 'degraded' or
--     'connected', the nightly heal may already have run — check A3 before
--     continuing, because a second accounts row may now exist.
SELECT id, status, last_error_code, error_count, last_successful_sync,
       LEFT(transactions_cursor, 24) AS cursor_prefix
FROM plaid_items
WHERE id = 'ccffe6d8-3b5c-4da5-a02b-c166359b436e';
-- Expect: status 'disconnected' (the hold).

-- A2. Get the new plaid_account_id from Plaid. Run OUTSIDE psql:
--
--   npx tsx --env-file=.env.local scripts/verify-account-mapping.ts \
--     ccffe6d8-3b5c-4da5-a02b-c166359b436e
--
-- It prints a MISSING line per account Plaid returns that we do not hold —
-- that id, for the ····9950 card, is what §B re-points to. It also prints an
-- ORPHAN line for 'nPj7wRObAdUYXe8jRqYwUd5z8k5JNEfBzr7vP', confirming Plaid
-- no longer returns the stored id.
--
-- Also run the transaction-id probe, which decides whether §C is safe:
--
--   npx tsx --env-file=.env.local scripts/probe-transaction-ids.ts \
--     ccffe6d8-3b5c-4da5-a02b-c166359b436e
--
-- STABLE     → continue.
-- REISSUED   → stop and read §E.
-- INCONCLUSIVE → stop; re-run with a wider window ending before 2026-09-21.

-- A3. Exactly ONE accounts row should exist for this item. If there are two,
--     a sync ran despite the hold — stop and reconcile by hand before §B, as
--     the UNIQUE index on plaid_account_id will block the re-point.
SELECT a.id, a.name, a.mask, a.plaid_account_id, a.entity_id, a.deleted_at,
       a.created_at, a.updated_at,
       (SELECT COUNT(*) FROM transactions t WHERE t.account_id = a.id) AS txn_count
FROM accounts a
WHERE a.plaid_item_id = 'ccffe6d8-3b5c-4da5-a02b-c166359b436e'
ORDER BY a.created_at;
-- Expect: 1 row, 693 transactions, plaid_account_id 'nPj7wRO…'.
-- Record entity_id — §B must leave it unchanged.


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION B — Re-point the existing account row to the new plaid_account_id.
--
-- This is what avoids a second accounts row entirely. Once the row carries the
-- id Plaid now returns, refreshAccountsForItem matches it and takes the UPDATE
-- path (Plaid-owned fields only), so entity_id and the 693 transactions stay
-- exactly as they are — no insert, no merge, no re-attribution.
--
-- Substitute <NEW_PLAID_ACCOUNT_ID> with the MISSING id from A2.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- B1. Guard: the new id must not already be held by another row anywhere.
--     accounts.plaid_account_id is UNIQUE across the whole table.
SELECT id, plaid_item_id, name, mask
FROM accounts
WHERE plaid_account_id = '<NEW_PLAID_ACCOUNT_ID>';
-- Expect: 0 rows. If this returns anything, STOP and ROLLBACK.

-- B2. Record the old id in the audit trail before overwriting it.
INSERT INTO audit_log (user_id, action, entity_type, entity_id, details)
SELECT a.user_id,
       'PLAID_ACCOUNTS_DISCOVERED',
       'plaid_item',
       a.plaid_item_id::text,
       jsonb_build_object(
         'reason', 'Manual re-point after 2026-09-21 relink reissued the account_id',
         'account_id', a.id,
         'mask', a.mask,
         'previous_plaid_account_id', a.plaid_account_id,
         'new_plaid_account_id', '<NEW_PLAID_ACCOUNT_ID>',
         'repointed_at', NOW()
       )
FROM accounts a
WHERE a.id = '3fc1ca01-e89e-4d09-bbd0-3ef6bec4d3b5';

-- B3. Re-point. entity_id, user_id, name and the transactions are untouched.
UPDATE accounts
SET plaid_account_id = '<NEW_PLAID_ACCOUNT_ID>',
    updated_at       = NOW()
WHERE id = '3fc1ca01-e89e-4d09-bbd0-3ef6bec4d3b5'
  AND plaid_account_id = 'nPj7wRObAdUYXe8jRqYwUd5z8k5JNEfBzr7vP';

-- Expect: UPDATE 1. If 0, the row was already changed — STOP and ROLLBACK.
SELECT id, name, mask, plaid_account_id, entity_id,
       (SELECT COUNT(*) FROM transactions t WHERE t.account_id = accounts.id) AS txn_count
FROM accounts
WHERE id = '3fc1ca01-e89e-4d09-bbd0-3ef6bec4d3b5';
-- Expect: new plaid_account_id, SAME entity_id as A3, still 693 transactions.

COMMIT;
-- ROLLBACK; -- use instead of COMMIT if anything above does not match


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION C — Release the hold and reset the cursor.
--
-- Clearing transactions_cursor makes the next /transactions/sync replay the
-- item's full available history. With §B applied, every transaction maps to
-- the existing account row.
--
-- Idempotency depends on the probe verdict from A2: transactions upsert on
-- plaid_transaction_id (UNIQUE), so a replay updates rows in place IF Plaid
-- still returns the same ids. If the probe said REISSUED, do not run this —
-- read §E.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- C1. Keep the old cursor in the audit trail before discarding it.
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

-- C2. Release the 00 hold and clear the cursor in one statement, so the item
--     is never sweepable with a stale cursor.
UPDATE plaid_items
SET transactions_cursor = NULL,
    status              = 'connected',
    last_error_code     = NULL,
    error_count         = 0,
    updated_at          = NOW()
WHERE id = 'ccffe6d8-3b5c-4da5-a02b-c166359b436e'
  AND status = 'disconnected';      -- refuse unless the hold is still in place

-- Expect: UPDATE 1. If 0, the hold was already released — STOP and ROLLBACK.
SELECT id, status, transactions_cursor FROM plaid_items
WHERE id = 'ccffe6d8-3b5c-4da5-a02b-c166359b436e';

COMMIT;
-- ROLLBACK; -- use instead of COMMIT if the row above does not look right


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION D — Let one sync run, then verify.
--
-- Either wait for the 03:00 UTC heal job, or trigger it by hand:
--   curl -sS -H "Authorization: Bearer $CRON_SECRET" \
--     https://<your-app-domain>/api/sync/heal
-- ════════════════════════════════════════════════════════════════════════════

-- D1. What did the run actually write? 'added' now means rows written.
SELECT action, details, created_at
FROM audit_log
WHERE entity_id = 'ccffe6d8-3b5c-4da5-a02b-c166359b436e'
  AND action IN ('PLAID_SYNC_COMPLETED', 'PLAID_SYNC_FAILED')
ORDER BY created_at DESC
LIMIT 5;
-- A PLAID_SYNC_FAILED with error_code 'UNMAPPED_ACCOUNT' means §B did not take
-- effect — the cursor was NOT advanced, so nothing is lost. Return to §A.

-- D2. Did the history come back, and is it still one account?
SELECT a.id, a.name, a.mask, a.plaid_account_id, a.entity_id,
       COUNT(t.id) AS txn_count,
       MIN(t.date) AS oldest_txn,
       MAX(t.date) AS newest_txn
FROM accounts a
LEFT JOIN transactions t ON t.account_id = a.id AND t.deleted_at IS NULL
WHERE a.plaid_item_id = 'ccffe6d8-3b5c-4da5-a02b-c166359b436e'
  AND a.deleted_at IS NULL
GROUP BY a.id, a.name, a.mask, a.plaid_account_id, a.entity_id;
-- Expect: ONE row, newest_txn recent (not 2026-08-08), entity_id unchanged.
-- txn_count around 693 + the recovered rows. A number near 1386 means the
-- history was duplicated — go straight to §E.

-- D3. Categorisation must have survived. 643 of the original 693 rows carry a
--     user_category_id and 248 a recurring_pattern_id; those counts must not
--     drop. (They can rise as rules are applied to recovered rows.)
SELECT COUNT(*)                                              AS total,
       COUNT(*) FILTER (WHERE user_category_id IS NOT NULL)  AS categorized,
       COUNT(*) FILTER (WHERE recurring_pattern_id IS NOT NULL) AS recurring_linked,
       COUNT(*) FILTER (WHERE notes IS NOT NULL)             AS with_notes
FROM transactions
WHERE account_id = '3fc1ca01-e89e-4d09-bbd0-3ef6bec4d3b5'
  AND deleted_at IS NULL;
-- Expect: categorized >= 643, recurring_linked >= 248, with_notes >= 2.


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION E — Dedupe preflight. REPORT ONLY. Deletes nothing.
--
-- Run E1 BEFORE §C to establish a baseline, then E2/E3 after §D. The delta is
-- what the replay introduced; anything in the baseline is pre-existing and not
-- caused by this recovery.
--
-- If probe-transaction-ids.ts said REISSUED, the replay will insert a full
-- second copy of the history under new ids. Do NOT bulk-delete in that case:
-- the ORIGINAL rows carry the 643 categorisations and 248 recurring links, and
-- the NEW rows carry the ids future syncs will reference. Reconciling them
-- means copying user fields from old to new before retiring the old — bring
-- the E3 output back for a reviewed migration rather than deleting anything.
-- ════════════════════════════════════════════════════════════════════════════

-- E1 / E2. Duplicate groups on (account_id, date, amount, merchant_name).
--          Run once before §C and once after §D and compare the totals.
SELECT COUNT(*)                        AS duplicate_groups,
       COALESCE(SUM(copies - 1), 0)    AS extra_rows,
       COALESCE(SUM(ABS(amount) * (copies - 1)), 0) AS extra_amount
FROM (
  SELECT account_id, date, amount, merchant_name, COUNT(*) AS copies
  FROM transactions
  WHERE account_id = '3fc1ca01-e89e-4d09-bbd0-3ef6bec4d3b5'
    AND deleted_at IS NULL
  GROUP BY account_id, date, amount, merchant_name
  HAVING COUNT(*) > 1
) g;
-- Baseline (before §C) is expected to be small but non-zero: a card can carry
-- genuinely identical same-day charges. Only the INCREASE is this recovery's.

-- E3. The offending groups in detail, newest first, with which copy holds the
--     user's categorisation. This is the input to any reconciliation.
SELECT t.date,
       t.merchant_name,
       t.amount,
       COUNT(*)                                                   AS copies,
       COUNT(*) FILTER (WHERE t.user_category_id IS NOT NULL)     AS copies_categorized,
       ARRAY_AGG(t.plaid_transaction_id ORDER BY t.created_at)    AS plaid_txn_ids,
       ARRAY_AGG(t.created_at           ORDER BY t.created_at)    AS created_ats
FROM transactions t
WHERE t.account_id = '3fc1ca01-e89e-4d09-bbd0-3ef6bec4d3b5'
  AND t.deleted_at IS NULL
GROUP BY t.date, t.merchant_name, t.amount
HAVING COUNT(*) > 1
ORDER BY t.date DESC
LIMIT 200;
-- A group whose plaid_txn_ids differ AND whose created_ats straddle the reset
-- is a reissue duplicate. A group with one old id and one new id, where only
-- the older copy is categorized, is the reconciliation case described above.

-- E4. Sanity: how many rows arrived in the replay at all?
SELECT DATE_TRUNC('day', created_at) AS ingested_on, COUNT(*) AS rows_written
FROM transactions
WHERE account_id = '3fc1ca01-e89e-4d09-bbd0-3ef6bec4d3b5'
GROUP BY 1
ORDER BY 1 DESC
LIMIT 10;

-- NOTHING IN THIS FILE DELETES A TRANSACTION. If §E shows duplicates that need
-- removing, bring the output back for a reviewed migration.
