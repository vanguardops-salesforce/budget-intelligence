# Manual production steps — Plaid sync recovery

Run **in order**. Nothing here runs automatically; each step changes production
data or production Plaid items.

| # | File | What it does | When |
|---|---|---|---|
| 0 | `00-hold-capital-one.sql` | Parks Capital One so no sync touches it | **Before merging the PR** |
| 1 | `01-stop-amex-retry-loop.sql` | Sets Amex `18dedaa2` → `reauth_required` | Any time |
| 2 | `02-recover-capital-one.sql` | Re-points the account, resets the cursor, dedupe preflight | After deploy, §A first |
| 3 | `03-webhook-backfill.ts` | Registers the webhook URL on the 8 legacy items | After deploy; dry-run first |

Read-only helpers: `../verify-account-mapping.ts` (which account ids Plaid
returns vs. what we hold), `../probe-transaction-ids.ts` (were transaction_ids
reissued — decides whether the cursor reset is safe), and
`../silent-sync-check.sql`.

## The two things that make ordering matter

**1. The nightly heal job runs at 03:00 UTC** and sweeps every item with status
`connected` or `degraded`. Capital One is `degraded`, so it is in that set. If
the heal runs after the fix is deployed but before the account row is
re-pointed, the pre-sync refresh creates a *second* accounts row under the new
`plaid_account_id` — and then re-pointing the original fails, because
`accounts.plaid_account_id` is UNIQUE and the new id is taken.

Step 0 parks the item (`status = 'disconnected'`) so the sweep skips it. It
works before and after the deploy, which is why it is used rather than the
post-deploy `error_count` ceiling. Scope is Capital One only; everything else
keeps syncing. The hold is released in 02 §C.

**2. A cursor reset is only idempotent if Plaid still returns the same
`transaction_id`s.** Transactions upsert on `plaid_transaction_id` (UNIQUE). If
the 2026-09-21 relink reissued transaction ids along with the account ids, a
reset re-pulls the full history under ids that match nothing, and duplicates
every existing row instead of updating it.

`probe-transaction-ids.ts` answers this before you commit to anything: it asks
Plaid for a window we already hold and compares the id sets. **STABLE** →
proceed. **REISSUED** → stop at 02 §E; the originals carry 643 categorisations
and 248 recurring links, so they cannot simply be replaced.

## Recommended sequence

1. **Run `00-hold-capital-one.sql`** — before anything else, while the PR is
   still unmerged.
2. Merge PR #18 and let it deploy.
3. Read the two probes:
   ```
   npx tsx --env-file=.env.local scripts/verify-account-mapping.ts ccffe6d8-3b5c-4da5-a02b-c166359b436e
   npx tsx --env-file=.env.local scripts/probe-transaction-ids.ts  ccffe6d8-3b5c-4da5-a02b-c166359b436e
   ```
   The first prints the new `plaid_account_id` (a `MISSING` line). The second
   gives the STABLE / REISSUED verdict.
4. Run `01-stop-amex-retry-loop.sql`, then re-link the Amex card in the UI.
5. Work through `02-recover-capital-one.sql`: §A → §B (re-point) → §E1
   (baseline) → §C (release hold + reset cursor) → §D (verify) → §E2/E3.
6. Dry-run `03-webhook-backfill.ts`, review the plan, then `--apply`.
7. Confirm `../silent-sync-check.sql` returns no critical rows.

Capital One's history stays attached to one account row throughout — no second
row, no merge step, `entity_id` never rewritten.

## Rollback

Steps 0, 1 and 2 are transaction-wrapped with a `ROLLBACK` line commented out
beside each `COMMIT`, and each ends with a `SELECT` to check before committing.
Every `UPDATE` is guarded on the expected current state, so re-running a step
that already applied reports `UPDATE 0` rather than doing something unexpected.

To abandon the recovery after step 0, restore the item:

```sql
UPDATE plaid_items SET status = 'degraded', updated_at = NOW()
WHERE id = 'ccffe6d8-3b5c-4da5-a02b-c166359b436e';
```

The cursor reset in 02 §C is the only step that is not trivially reversible;
the previous cursor is written to `audit_log` first, so it can be restored by
hand. Step 3 is idempotent and re-runnable.

**No file in this directory deletes a transaction.** 02 §E reports duplicates
and stops.
