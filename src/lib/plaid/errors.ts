/**
 * Plaid error interpretation.
 *
 * The Plaid Node SDK surfaces API failures as Axios errors whose response body
 * carries the real diagnosis: `error_code`, `error_type` and a display message.
 * Before this module the sync paths discarded all of that and persisted their
 * own invented literals (`HEAL_SYNC_ERROR`, `SYNC_ERROR`), which made every
 * possible failure — expired credentials, a network blip, an institution
 * outage, a bug in our own upsert — indistinguishable in `plaid_items`, and
 * made escalation impossible because nothing had a code to branch on.
 */

/** What we managed to learn about a failed Plaid call. */
export interface PlaidErrorInfo {
  /** Plaid's `error_code`, or a local sentinel when the call never reached Plaid. */
  errorCode: string;
  /** Plaid's `error_type`, when present. */
  errorType: string | null;
  /** Display message, truncated for storage. */
  errorMessage: string;
}

/** Used when an error carries no Plaid error_code (network, DNS, our own bug). */
export const UNKNOWN_ERROR_CODE = 'UNKNOWN_SYNC_ERROR';

/**
 * Plaid error codes that mean the user must re-authenticate. These never
 * resolve on their own, so retrying them nightly is pure waste — an item
 * hitting one of these is escalated to `reauth_required` immediately rather
 * than after the consecutive-failure threshold.
 *
 * https://plaid.com/docs/errors/item/
 */
export const REAUTH_ERROR_CODES: ReadonlySet<string> = new Set([
  'ITEM_LOGIN_REQUIRED',
  'PENDING_EXPIRATION',
  'PENDING_DISCONNECT',
  'ITEM_LOCKED',
  'INVALID_CREDENTIALS',
  'INVALID_MFA',
  'INVALID_UPDATED_USERNAME',
  'USER_PERMISSION_REVOKED',
  'USER_INPUT_TIMEOUT',
]);

/** True when the code means "the user must log in again". */
export function requiresReauth(errorCode: string | null | undefined): boolean {
  return !!errorCode && REAUTH_ERROR_CODES.has(errorCode);
}

interface PlaidErrorBody {
  error_code?: unknown;
  error_type?: unknown;
  error_message?: unknown;
  display_message?: unknown;
}

/**
 * Pull the Plaid error details out of whatever was thrown.
 *
 * Handles the Axios shape the Plaid SDK throws (`error.response.data`), and
 * falls back to a sentinel code plus the stringified error for anything else,
 * so callers always get a usable `errorCode` and never have to null-check.
 */
export function extractPlaidError(error: unknown): PlaidErrorInfo {
  const body = (error as { response?: { data?: PlaidErrorBody } } | null)?.response?.data;

  const errorCode = typeof body?.error_code === 'string' && body.error_code
    ? body.error_code
    : UNKNOWN_ERROR_CODE;
  const errorType = typeof body?.error_type === 'string' && body.error_type
    ? body.error_type
    : null;

  const message =
    (typeof body?.error_message === 'string' && body.error_message) ||
    (typeof body?.display_message === 'string' && body.display_message) ||
    (error instanceof Error ? error.message : String(error));

  return {
    errorCode,
    errorType,
    errorMessage: String(message).slice(0, 500),
  };
}

/**
 * Thrown when /transactions/sync returns transactions for a plaid_account_id
 * that has no row in `accounts` even after the pre-sync account refresh.
 *
 * This must abort the run: the alternative — the previous behaviour — was to
 * drop the rows with a log line and still commit the advanced cursor, which
 * loses them permanently because /transactions/sync never re-offers a page.
 */
export class UnknownAccountError extends Error {
  constructor(
    public readonly plaidItemDbId: string,
    public readonly unknownAccountIds: string[],
    public readonly droppedCount: number
  ) {
    super(
      `Plaid returned ${droppedCount} transaction(s) for ${unknownAccountIds.length} ` +
        `unmapped account(s) on item ${plaidItemDbId}: ${unknownAccountIds.join(', ')}. ` +
        'Aborting before the cursor advances so no transactions are lost.'
    );
    this.name = 'UnknownAccountError';
  }
}

/** Local sentinel recorded when a sync aborts on unmapped accounts. */
export const UNMAPPED_ACCOUNT_ERROR_CODE = 'UNMAPPED_ACCOUNT';
