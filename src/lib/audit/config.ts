/**
 * Tunable thresholds and exclude-lists for the Data Health audit.
 * Kept in one place so the rules can be adjusted without touching check logic.
 */

/** Check A — minimum absolute deposit amount that warrants classification. */
export const UNCLASSIFIED_DEPOSIT_MIN = 500;
/** Check A — total unclassified $ above which the finding escalates to critical. */
export const UNCLASSIFIED_DEPOSIT_CRITICAL_TOTAL = 2000;

/** Check B — how many budget months to evaluate (current + trailing N-1). */
export const TITHE_LOOKBACK_MONTHS = 3;
/** Check B — entity tithe gap above which the finding escalates to critical. */
export const TITHE_GAP_CRITICAL = 1000;

/** Check C — balance snapshot age (days) beyond which it is considered stale. */
export const STALE_BALANCE_MAX_AGE_DAYS = 3;

/** Check E — last_successful_sync age (hours) beyond which an item looks dead. */
export const PLAID_ITEM_STALE_HOURS = 36;

/**
 * Check G — silent sync failure ("green light, no data").
 *
 * An item whose last_successful_sync is recent is *claiming* health. If its
 * accounts have nevertheless received no new transaction in more than this many
 * days, the sync is reporting success while ingesting nothing — the exact
 * failure mode that let Capital One item ccffe6d8 drop 254 transactions on
 * 2026-09-22 while showing a green "synced today".
 *
 * 5 days is deliberately wider than a long holiday weekend, so a genuinely
 * quiet card does not trip the check.
 */
export const SILENT_SYNC_MAX_TXN_AGE_DAYS = 5;

/**
 * Check G — how recent last_successful_sync must be for an item to count as
 * "claiming success". Items staler than this are already reported by Check E,
 * so they are excluded here to avoid double-reporting the same connection.
 */
export const SILENT_SYNC_FRESH_SYNC_HOURS = 36;

/**
 * Check G — how far an item's newest account balance snapshot may lag its
 * last_successful_sync before we conclude the sync never actually touched the
 * account rows.
 *
 * This is the discriminator between the two ways an item can have no new
 * transactions. `syncTransactionsForItem` persists balances (and so bumps
 * accounts.updated_at) from the same /transactions/sync response it ingests
 * transactions from, so on any run that genuinely reached the institution the
 * two timestamps land within seconds of each other:
 *
 *   - balances fresh  → the sync really did reach Plaid and Plaid returned no
 *     new transactions. Usually a genuinely quiet account (a savings account,
 *     a card that went unused). Reported as `warn`.
 *   - balances stale  → the run stamped last_successful_sync without ever
 *     writing an account row, which is what happens when Plaid returns data
 *     for a plaid_account_id that has no matching `accounts` row: the rows are
 *     dropped, the cursor still advances, and the run is recorded as a success.
 *     Reported as `critical`.
 *
 * On 2026-09-22 this cleanly separated Capital One ccffe6d8 (balances 1038h
 * stale, 254 transactions silently dropped) from Chase, Citi and Navy Federal
 * (balances 6h fresh, genuinely quiet accounts).
 */
export const SILENT_SYNC_BALANCE_TOLERANCE_HOURS = 24;

/**
 * Check D — known-legitimate repeated charges to exclude from duplicate
 * detection. Matched as a case-insensitive substring against merchant_name.
 *   - Delta: multiple airline tickets purchased same day at the same price.
 *   - HOA: separate dues for multiple properties billed identically.
 */
export const DUPLICATE_MERCHANT_EXCLUSIONS: string[] = ['delta', 'hoa'];

/**
 * Check E — accounts that are known to exist but may not be linked in Plaid.
 * Matched case-insensitively against linked account names; any expected entry
 * with no matching active account is surfaced as a critical gap.
 *
 * Seeded empty: the canonical example (Marriott Bonvoy Brilliant) is already a
 * linked account whose Plaid item has simply never synced, so it surfaces via
 * the last_successful_sync arm of Check E instead. Add fragments here for cards
 * or accounts that have no `accounts` row at all.
 */
export const EXPECTED_ACCOUNT_NAME_FRAGMENTS: string[] = [];

/** action_items namespace for everything this audit creates. */
export const ACTION_ITEM_CATEGORY = 'data_health';
