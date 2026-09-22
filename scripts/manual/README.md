# Manual production steps — Plaid sync recovery

Run **in order**. Nothing here runs automatically; each step is deliberately
manual because it changes production data or production Plaid items.

| # | File | What it does | When |
|---|---|---|---|
| 1 | `01-stop-amex-retry-loop.sql` | Sets Amex `18dedaa2` → `reauth_required` | Any time — safe before deploy |
| 2 | `02-recover-capital-one.sql` | Resets the Capital One cursor to re-pull lost history | **Only after** the fix is deployed and §A passes |
| 3 | `03-webhook-backfill.ts` | Registers the webhook URL on the 8 legacy items | After deploy; dry-run first |

Supporting, read-only: `../verify-account-mapping.ts` compares Plaid's current
`account_id`s against `accounts` rows, and `../silent-sync-check.sql` is the
standalone form of the Data Health check.

## Order matters

Step 2 is the one with a hard precondition. Clearing `transactions_cursor`
makes the next sync replay the item's full history; if the account mapping is
still broken when that happens, the replay lands in the same hole. With the fix
deployed the run now aborts loudly rather than dropping rows, so the failure is
visible either way — but you still have to fix the mapping before the data
lands. §A of that file is the check.

The mapping largely repairs itself once deployed: every sync now reconciles
`accounts` against Plaid first, creating any account that is missing. Step 2 §B
covers the one thing the code will not do on its own — deciding that an old
account row and a newly created one are the same physical card, and merging
their history. That is a judgement call, so it is left to you.

## Recommended sequence

1. Deploy the fix (merge PR #18).
2. `npx tsx --env-file=.env.local scripts/verify-account-mapping.ts` — see which
   items have accounts Plaid knows about that we do not.
3. Run `01-stop-amex-retry-loop.sql`, then re-link the Amex card in the UI.
4. Let one nightly sync run (or trigger `/api/sync/heal` by hand). The account
   refresh creates the missing Capital One account row.
5. Work through `02-recover-capital-one.sql` §A → §B (if it applies) → §C.
6. Dry-run `03-webhook-backfill.ts`, review the plan, then `--apply`.
7. Confirm `../silent-sync-check.sql` returns no critical rows.

## Rollback

Steps 1 and 2 are wrapped in explicit transactions with a `ROLLBACK` line
commented out beside each `COMMIT`; verify the `SELECT` output before
committing. Step 3 is idempotent and re-runnable — re-pointing a webhook URL
has no effect on stored data, and can be reverted by running it again against a
different `NEXT_PUBLIC_APP_URL`.

The cursor reset in step 2 §C is the only step that is not trivially
reversible, and it is non-destructive in practice: transactions upsert on
`plaid_transaction_id` (UNIQUE), so a replay updates rows in place rather than
duplicating them. The previous cursor is written to `audit_log` first.
