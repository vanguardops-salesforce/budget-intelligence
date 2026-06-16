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
