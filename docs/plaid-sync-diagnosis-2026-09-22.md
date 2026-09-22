# Plaid sync silent-failure diagnosis — 2026-09-22

Read-only investigation of Supabase project `wqgqbfubmrsxmxjldgha` plus the
application source. No production deploys and no data changes were made.

Note on timing: `vercel.json` schedules `/api/sync/heal` at `0 3 * * *` and
`/api/sync/transactions` at `0 10 * * *`. The ~03:20 UTC run in the evidence is
therefore the **heal job**, which is what writes `last_successful_sync` for
every item nightly. That matters for all four findings below.

---

## 1. False success — `last_successful_sync` written when nothing was ingested

### Root cause

Three defects compound, all in `src/lib/plaid/sync.ts`.

**(a) Transactions for an unknown `plaid_account_id` are silently dropped while
the cursor still advances — permanent data loss.**

`upsertTransactions` (`src/lib/plaid/sync.ts:237-265`) maps each Plaid
transaction through `accountMap`, which is built only from existing
`accounts` rows (`sync.ts:64-78`). A transaction whose `account_id` has no
matching row is logged at `warn` and turned into `null`:

```ts
const accountId = accountMap.get(txn.account_id);
if (!accountId) {
  logger.warn('Unknown account_id in transaction, skipping', { ... });
  return null;                     // dropped
}
...
if (rows.length === 0) return;     // sync.ts:265 — silent no-op
```

Meanwhile the caller counts Plaid's array length, not rows actually written:

```ts
await upsertTransactions(supabase, added, userId, entityId, accountMap);
totalAdded += added.length;        // sync.ts:100 — counts dropped rows
```

and the loop then commits the new cursor (`sync.ts:113`, persisted at
`sync.ts:143-151`). Because `/transactions/sync` is cursor-based, **those
transactions are never offered again.**

This is not theoretical. The audit trail for Capital One item `ccffe6d8`:

| when | action | details |
|---|---|---|
| 2026-09-21 23:52:39 | `PLAID_ITEM_REAUTH` | `relink_token_created` |
| 2026-09-22 03:20:57 | `PLAID_SYNC_COMPLETED` | **`added: 254`**, `cursor_updated: true` |

Yet `max(transactions.date)` for that item is still `2026-08-08` and its newest
inserted row is `2026-08-10`. Plaid handed us 254 transactions, all 254 were
dropped as unknown accounts, the run was recorded as a success, and the cursor
moved past them. The corroborating detail is `accounts.updated_at` for
Venture X 9950, still `2026-08-10` — the balance-persist loop (`sync.ts:120-140`)
skips on the same `accountMap` miss.

The trigger was the 9/21 relink: the re-authorized item came back with
`account_id`s that have no row in `accounts` (see finding 3 — nothing upserts
accounts after a relink).

**(b) `status` is never reset on success, so `degraded` is permanently sticky.**

The success path updates four columns (`sync.ts:143-151`):

```ts
.update({
  transactions_cursor: cursor,
  last_successful_sync: new Date().toISOString(),
  last_error_code: null,
  error_count: 0,
})                                  // status is NOT touched
```

`recordSyncFailure` sets `status = 'degraded'` at 5 consecutive failures
(`sync.ts:333-335`) and nothing ever sets it back. That is the exact fingerprint
you spotted — `status 'degraded'`, `error_count 0`, `last_error_code NULL` — an
item that failed ≥5 times, then later "succeeded". Amex `82883c40` proves the
point independently: it is genuinely healthy (transactions through 9/20, rows
inserted 9/22) and still reads `degraded`.

**(c) "Success" means "no exception was thrown", never "data was ingested".**

There is no assertion anywhere that the run produced rows, and the
`/accounts/balance/get` refresh that would otherwise reveal the problem is
wrapped in a `try/catch` that only logs (`sync.ts:163-195`).

### Proposed fixes

1. **Fail loudly on unknown accounts.** In `upsertTransactions`, collect the
   unmapped `account_id`s and `throw` instead of dropping them, so the cursor is
   not committed and the run is recorded as a failure. Safer still: before the
   pagination loop, call `/accounts/get` and upsert any `plaid_account_id` not
   already in `accounts` (`onConflict: 'plaid_account_id'`), then rebuild
   `accountMap` — this self-heals new cards and makes finding 3 disappear too.
2. **Return real counts.** Have `upsertTransactions` return the number of rows
   written and accumulate *that* into `totalAdded`, so `PLAID_SYNC_COMPLETED`
   details stop lying.
3. **Reset status on success**: add `status: 'connected'` to the `sync.ts:143`
   update.
4. **Only stamp `last_successful_sync` after a verified write** — i.e. after the
   upserts succeeded and no account was unmapped.
5. Record `cursor_updated` honestly and add `rows_written` to the audit detail.

### Recovering the 254 lost transactions

Because the cursor advanced, re-running the sync will not return them. Recovery
requires either resetting the cursor (`transactions_cursor = NULL` forces a full
re-sync from scratch — safe, since `plaid_transaction_id` is the upsert key) or
a `/transactions/get` backfill over 2026-08-08 → today. **Not done — this is a
data change and needs your sign-off.**

---

## 2. Retry loop — `HEAL_SYNC_ERROR` never escalates to `reauth_required`

### Root cause

**`HEAL_SYNC_ERROR` is an app-invented string, not a Plaid error code.** It is a
hardcoded literal in `src/app/api/sync/heal/route.ts:85`:

```ts
} catch (error) {
  const errorMessage = String(error);       // the real Plaid error — only logged
  ...
  await recordSyncFailure(supabase, item.id, item.user_id, 'HEAL_SYNC_ERROR');
}
```

The actual Plaid error code (almost certainly `ITEM_LOGIN_REQUIRED` for Amex
`18dedaa2`, which is a Plaid API error carrying `response.data.error_code`) is
caught, stringified into a log line, and **thrown away**. What lands in
`plaid_items.last_error_code` is a constant that is identical for every possible
failure — expired credentials, a network blip, an institution outage, a bug in
our own upsert. `/api/sync/transactions/route.ts:124` has the same defect with
its own literal, `'SYNC_ERROR'`.

**Nothing can escalate, because nothing inspects the code.** `recordSyncFailure`
(`src/lib/plaid/sync.ts:313-348`) has exactly one state transition:

```ts
if (newErrorCount >= ERROR_THRESHOLD) {
  updates.status = 'degraded';            // the only status it can ever set
}
```

There is no branch to `reauth_required` anywhere in the sync path — that status
is only ever set by the inbound `ITEM`/`ERROR` webhook handler
(`src/app/api/plaid/webhook/route.ts:88`). Amex `18dedaa2` was created 2026-03-18
and so has **no webhook registered** (finding 4), meaning the one code path that
could mark it `reauth_required` can never fire for it.

The result is a closed loop: heal selects `status IN ('connected','degraded')`
(`heal/route.ts:33`), the item fails, gets marked `degraded`, stays in the
selection set, and is retried every night. `error_count` has reached **39**,
incrementing daily since 8/14 — the audit log shows an unbroken
`PLAID_SYNC_FAILED` chain. Capital One `ccffe6d8` was in the same loop
(`error_count` 38 on 9/21) until the relink.

### Proposed fixes

1. **Extract and persist the real Plaid error code.** Add a helper that reads
   `error.response?.data?.error_code` from a Plaid `AxiosError` and pass it to
   `recordSyncFailure` from both `heal/route.ts:85` and
   `transactions/route.ts:124`, falling back to `'UNKNOWN_SYNC_ERROR'`. Store
   `error_type` and `error_message` too.
2. **Escalate on the codes that require user action.** In `recordSyncFailure`,
   map `ITEM_LOGIN_REQUIRED`, `PENDING_EXPIRATION`, `ITEM_LOCKED`,
   `INVALID_CREDENTIALS`, `INVALID_MFA` → `status = 'reauth_required'`
   immediately, on the *first* occurrence, bypassing the count threshold. These
   never self-heal, so retrying is pure waste.
3. **Cap the futile retries.** Stop the daily attempt once `error_count` crosses
   a ceiling (e.g. 10) without a code that justifies retrying; surface it as an
   action item instead.
4. Backfill: item `18dedaa2` should be set to `reauth_required` so it stops
   looping and the UI offers the re-link button. **Not done — data change.**

---

## 3. Relink doesn't persist

### A correction to the premise

The audit log does **not** show a relink of `6aa22001` (Bonvoy 1005) on 9/21.
Every `PLAID_ITEM_REAUTH` row:

| when | item | which card |
|---|---|---|
| 2026-09-21 23:52:39 | `ccffe6d8` | Capital One Venture X 9950 |
| 2026-09-21 23:51:46 | `82883c40` | Amex (healthy one) |
| 2026-09-21 23:49:22 | `82883c40` | Amex (healthy one) |
| **2026-08-17 12:18:15** | **`6aa22001`** | **Amex Bonvoy 1005 — most recent** |

So `6aa22001`'s last relink attempt was **2026-08-17**, five weeks ago, not 9/21.
The 9/21 session relinked Capital One and the healthy Amex. Worth confirming
which card you were actually in front of — but the code defects below explain
why *both* the 8/17 and the 9/21 relinks failed to stick.

### Root cause

**(a) `update.account_selection_enabled` is not set.** `linkTokenCreate` in
`src/app/api/plaid/create-relink-token/route.ts:74-81` passes `access_token` (so
Link does open in update mode) but no `update` object at all:

```ts
const response = await plaidClient.linkTokenCreate({
  user: { client_user_id: user.id },
  client_name: 'Budget Intelligence',
  country_codes: [CountryCode.Us],
  language: 'en',
  webhook: webhookUrl,
  access_token: accessToken,
  // no `update: { account_selection_enabled: true }`
});
```

Without it, the user re-authenticates but is never shown the account picker, so
a card that was not part of the original consent — **Biz Plat 1008** — cannot be
added. That alone explains "no new accounts were created".

**(b) There is no post-Link success handler.** `connection-health.tsx:61-66`:

```ts
await openPlaidLinkForReauth(link_token);

// 3. On success, mark item as re-connected on backend
// (Plaid handles this automatically via webhook — the update mode flow
// sends an ITEM webhook with code LOGIN_REPAIRED)
router.refresh();
```

The comment is the whole implementation. `openPlaidLinkForReauth` discards
Plaid's `onSuccess` metadata entirely (`connection-health.tsx:243-246` — the
callback takes no arguments), no endpoint is called, and the client just
re-renders. Nothing resets `status`, clears `last_error_code`/`error_count`, or
upserts accounts.

The webhook the comment relies on cannot save it, for three separate reasons:
`6aa22001` is the only item with webhooks at all (finding 4); `LOGIN_REPAIRED`
has `webhook_type = 'ITEM'`, which the sync cron's filter excludes (finding 4);
and no handler for it exists anywhere in the codebase — `grep` finds no
occurrence of `LOGIN_REPAIRED`.

**(c) The one signal that did arrive was never processed.** After the 8/17
relink, Plaid sent `ITEM` / `NEW_ACCOUNTS_AVAILABLE` at `2026-08-17 11:50:05`.
That row is **still `status = 'pending'`** five weeks later. That is almost
certainly your missing Biz Plat 1008 — Plaid told us about it and we never read
the message.

### Proposed fixes

1. Add `update: { account_selection_enabled: true }` to the relink
   `linkTokenCreate` call.
2. Add a `POST /api/plaid/relink-complete` endpoint, called from
   `onSuccess`, that: sets `status = 'connected'`, clears `last_error_code` and
   `error_count`, calls `/accounts/get` and upserts every returned account
   (`onConflict: 'plaid_account_id'`), and writes an audit row. Change
   `openPlaidLinkForReauth`'s `onSuccess` to forward the metadata rather than
   dropping it.
3. Handle `ITEM`/`NEW_ACCOUNTS_AVAILABLE` and `ITEM`/`LOGIN_REPAIRED` by
   re-running account discovery for the item.
4. Fix (1)+(2) together — (1) without (2) still leaves the new account unstored.

---

## 4. Webhooks registered on one item only

### Root cause

**(a) The 8 items created 2026-03-18 predate the webhook URL, exactly as you
suspected.** `plaid_webhook_events` has 159 rows, every one for `6aa22001`
(created 2026-05-29). Plaid binds the webhook URL to the item **at link time**
from `link_token_create`; `create-link-token/route.ts:59` passes it now, but the
March items were linked before that and there is no code anywhere that calls
`/item/webhook/update` for an existing item. Those 8 items will never receive a
webhook, which is why the nightly heal job is the only thing keeping them alive —
and why finding 2's `ITEM`/`ERROR` escalation path is dead for all of them.

**(b) The processor marks events `failed` for reauth items and never retries.**
`src/app/api/sync/transactions/route.ts:82-89`:

```ts
if (item.status === 'reauth_required' || item.status === 'disconnected') {
  await markEvents(supabase, eventIds, 'failed', `Item status: ${item.status}`);
  continue;
}
```

`failed` is terminal — the cron only ever selects `status = 'pending'`
(`route.ts:35`), so nothing re-examines these. 128 events are stranded this way:
53 `SYNC_UPDATES_AVAILABLE`, 49 `DEFAULT_UPDATE`, 24 `TRANSACTIONS_REMOVED`,
plus one `INITIAL_UPDATE` and one `HISTORICAL_UPDATE`. Every one of them is a
notification of data we still do not have.

**(c) A third defect, not in your list: `ITEM`-type webhooks are never processed
at all.** The cron filters on `webhook_type`:

```ts
.in('webhook_type', ['TRANSACTIONS', 'INITIAL_UPDATE', 'HISTORICAL_UPDATE', 'DEFAULT_UPDATE'])
```

`INITIAL_UPDATE`, `HISTORICAL_UPDATE` and `DEFAULT_UPDATE` are webhook
**codes**, not types — the column only ever holds `TRANSACTIONS` or `ITEM` for
these. So three of the four entries match nothing, and `ITEM` is absent, meaning
no `ITEM` event is ever picked up. This is why the `NEW_ACCOUNTS_AVAILABLE`
event from finding 3 and an `ITEM`/`ERROR` event from 2026-08-14 both sit
`pending` forever.

### Proposed fixes

1. **Backfill webhook registration**: a one-off authenticated admin route that
   loops the 8 legacy items and calls
   `plaidClient.itemWebhookUpdate({ access_token, webhook: webhookUrl })`.
   **Not run — this is a production data change and needs your review.**
2. Use `'pending_reauth'` instead of `'failed'` for the reauth skip, and requeue
   those rows to `'pending'` in the relink-complete handler from finding 3.
3. Fix the cron filter to `.in('webhook_type', ['TRANSACTIONS', 'ITEM'])` and
   branch on `webhook_code` inside the loop.
4. Add a retry/dead-letter policy: an `attempt_count`, and an alert for any
   event `pending` for more than ~24h.

---

## Health check (deliverable 4)

Implemented as **Check G — `silent_sync_failure`** in the existing Data Health
audit framework, so it runs nightly after the sync and flows into
`audit_findings` and `action_items` with no new infrastructure.

- `src/lib/audit/checks.ts` — `checkSilentSyncFailure()`, a pure function
- `src/lib/audit/config.ts` — `SILENT_SYNC_MAX_TXN_AGE_DAYS = 5`,
  `SILENT_SYNC_FRESH_SYNC_HOURS = 36`
- `src/lib/audit/runner.ts` — wired into the nightly run
- `src/lib/audit/silentSync.test.ts` — 9 tests

An item is flagged `critical` when **both** hold:

1. it is *claiming* success — `last_successful_sync` is within 36h (staler items
   are already reported by Check E, so they are not double-reported); **and**
2. the newest transaction across its non-deleted accounts is more than 5 days
   old, **or it has never ingested one at all**.

Check E asks "did the sync run?". Check G asks "did the sync produce data?" —
the question that would have caught this on 2026-08-11 instead of 2026-09-22.

### What it flags against production today

| institution | status | last "successful" sync | newest txn | days | verdict |
|---|---|---|---|---|---|
| Capital One | degraded | 2026-09-22 03:20 | 2026-08-08 | 45 | **FLAG** |
| Citibank Online | **connected** | 2026-09-22 03:20 | 2026-09-09 | 13 | **FLAG** |
| Chase | **connected** | 2026-09-22 03:20 | 2026-09-11 | 11 | **FLAG** |
| Navy Federal | degraded | 2026-09-22 03:21 | 2026-09-15 | 7 | **FLAG** |
| USAA | connected | 2026-09-22 03:21 | 2026-09-18 | 4 | ok |
| Navy Federal | connected | 2026-09-22 03:21 | 2026-09-18 | 4 | ok |
| American Express `82883c40` | degraded | 2026-09-22 03:21 | 2026-09-20 | 2 | ok |
| American Express `6aa22001` | reauth_required | 2026-08-14 | 2026-08-09 | 44 | skip → Check E |
| American Express `18dedaa2` | degraded | 2026-08-14 | 2026-08-10 | 43 | skip → Check E |

**The problem is wider than the one item you flagged.** Citibank and Chase are
both `connected` with `error_count = 0`, `last_error_code NULL`, and a green
"synced today" — and neither has ingested a transaction in over a week. They
show the same signature as Capital One and were invisible to every existing
check.

`scripts/silent-sync-check.sql` is the standalone read-only version of this
query for ad-hoc use.
