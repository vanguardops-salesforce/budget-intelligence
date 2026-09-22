-- Silent Plaid sync failure check (read-only).
--
-- Flags any plaid_item that claims a recent successful sync but whose accounts
-- have received no new transaction in more than 5 days, then grades how serious
-- that is by asking whether the run actually wrote an account row.
--
-- syncTransactionsForItem persists balances from the same /transactions/sync
-- response it ingests transactions from, so on a run that genuinely reached the
-- institution accounts.updated_at lands within seconds of last_successful_sync:
--
--   balances fresh -> the sync reached Plaid and Plaid had nothing new. Usually
--                     a genuinely quiet account (savings, an unused card). WARN.
--   balances stale -> the run stamped last_successful_sync without writing any
--                     account row, which is what happens when Plaid returns data
--                     for a plaid_account_id that has no `accounts` row: the rows
--                     are dropped, the cursor still advances, and the run is
--                     recorded as a success. CRITICAL.
--
-- Mirrors checkSilentSyncFailure() in src/lib/audit/checks.ts. Safe to run
-- against production at any time; performs no writes.
WITH item_txn AS (
  SELECT
    i.id,
    i.institution_name,
    i.status,
    i.last_successful_sync,
    COUNT(DISTINCT a.id) AS account_count,
    MAX(t.date)          AS newest_txn,
    MAX(a.updated_at)    AS newest_balance
  FROM plaid_items i
  JOIN accounts a
    ON a.plaid_item_id = i.id
   AND a.deleted_at IS NULL
  LEFT JOIN transactions t
    ON t.account_id = a.id
   AND t.deleted_at IS NULL
  GROUP BY i.id, i.institution_name, i.status, i.last_successful_sync
)
SELECT
  id,
  institution_name,
  status,
  last_successful_sync,
  account_count,
  newest_txn,
  (CURRENT_DATE - newest_txn) AS days_since_newest_txn,
  ROUND(EXTRACT(EPOCH FROM (last_successful_sync - newest_balance)) / 3600) AS balance_lag_hours,
  CASE
    WHEN last_successful_sync - newest_balance > INTERVAL '24 hours'
      THEN 'CRITICAL: sync reported success without writing any account row — transactions are being dropped'
    ELSE 'WARN: sync refreshed balances but Plaid returned no new transactions — likely a quiet account'
  END AS verdict
FROM item_txn
WHERE last_successful_sync IS NOT NULL
  -- Claiming success: items staler than this are caught by the existing
  -- plaid_item_health check instead, so they are not double-reported here.
  AND NOW() - last_successful_sync <= INTERVAL '36 hours'
  AND (newest_txn IS NULL OR CURRENT_DATE - newest_txn > 5)
ORDER BY
  (last_successful_sync - newest_balance > INTERVAL '24 hours') DESC,
  (newest_txn IS NOT NULL),
  days_since_newest_txn DESC;
