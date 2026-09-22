-- Silent Plaid sync failure check (read-only).
--
-- Flags any plaid_item that claims a recent successful sync but whose accounts
-- have received no new transaction in more than 5 days. This is the "green
-- light, no data" failure mode: last_successful_sync is stamped even when
-- /transactions/sync ingested nothing.
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
    MAX(t.date)          AS newest_txn
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
  CASE
    WHEN newest_txn IS NULL
      THEN 'FLAG: claims success, has never ingested a transaction'
    ELSE 'FLAG: claims success, no new transactions in '
         || (CURRENT_DATE - newest_txn) || ' days'
  END AS verdict
FROM item_txn
WHERE last_successful_sync IS NOT NULL
  -- Claiming success: items staler than this are caught by the existing
  -- plaid_item_health check instead, so they are not double-reported here.
  AND NOW() - last_successful_sync <= INTERVAL '36 hours'
  AND (newest_txn IS NULL OR CURRENT_DATE - newest_txn > 5)
ORDER BY (newest_txn IS NOT NULL), days_since_newest_txn DESC;
