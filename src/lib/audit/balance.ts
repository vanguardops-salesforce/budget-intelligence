/**
 * Estimated-balance math for Check C (stale balances).
 *
 * accounts.current_balance is a persistently stale snapshot taken at
 * accounts.updated_at. We never trust it as truth; instead we estimate the
 * live balance as:  snapshot + net transaction activity since the snapshot.
 *
 * Sign convention (spec rule #3):
 *   - Depository: a positive `amount` is money OUT (reduces cash), a negative
 *     `amount` is money IN. So cash delta = -sum(amount).
 *   - Credit card: reversed — a positive `amount` is a charge (increases the
 *     balance owed), a negative `amount` is a payment. So owed delta = +sum(amount).
 *   - Other types (investment/loan): no transaction-driven estimate; the
 *     snapshot is returned unchanged.
 */
import type { AccountType, AuditAccount, AuditTransaction } from './types';

/** Apply net transaction activity to a snapshot balance, respecting sign convention. */
export function applyActivityToBalance(
  type: AccountType,
  currentBalance: number,
  netTxnAmount: number
): number {
  if (type === 'depository') return currentBalance - netTxnAmount;
  if (type === 'credit') return currentBalance + netTxnAmount;
  return currentBalance;
}

/** Whole-day age of a snapshot timestamp relative to `now`. */
export function balanceAgeDays(updatedAt: string, now: Date = new Date()): number {
  const snapshot = new Date(updatedAt).getTime();
  return Math.floor((now.getTime() - snapshot) / 86_400_000);
}

/**
 * Estimate an account's live balance from its snapshot plus the net of all
 * non-deleted transactions dated on/after the snapshot day.
 */
export function estimateAccountBalance(
  account: AuditAccount,
  transactions: AuditTransaction[]
): number {
  const snapshotDay = account.updated_at.slice(0, 10);
  const net = transactions
    .filter((t) => t.account_id === account.id && t.date >= snapshotDay)
    .reduce((sum, t) => sum + Number(t.amount), 0);
  return applyActivityToBalance(account.type, Number(account.current_balance) || 0, net);
}
