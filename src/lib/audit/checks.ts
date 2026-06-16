/**
 * The six Data Health checks. Each is a pure function over already-fetched data
 * and returns zero or more Findings, so they can be unit-tested without a DB.
 *
 * Safety: these functions never mutate their inputs and never perform IO. All
 * transaction inputs are expected to be pre-filtered to deleted_at IS NULL by
 * the runner.
 */
import {
  UNCLASSIFIED_DEPOSIT_MIN,
  UNCLASSIFIED_DEPOSIT_CRITICAL_TOTAL,
  TITHE_LOOKBACK_MONTHS,
  TITHE_GAP_CRITICAL,
  STALE_BALANCE_MAX_AGE_DAYS,
  PLAID_ITEM_STALE_HOURS,
  DUPLICATE_MERCHANT_EXCLUSIONS,
  EXPECTED_ACCOUNT_NAME_FRAGMENTS,
} from './config';
import { isClassifiedIncome } from './patterns';
import { balanceAgeDays, estimateAccountBalance } from './balance';
import {
  aggregateTitheByEntity,
  recentBudgetMonthLabels,
  titheBudgetMonthLabel,
} from './tithe';
import { getCurrentBudgetMonth, formatBudgetMonth } from '../budgetMonth';
import type {
  AuditAccount,
  AuditEntity,
  AuditIncomeSource,
  AuditPlaidItem,
  AuditTitheRow,
  AuditTransaction,
  Finding,
} from './types';

const MAX_DETAIL_ROWS = 100;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Check A — Unclassified deposits.
 * Depository money-in transactions ≥ $500 that match no income source and have
 * no tithe_log income row. The silent-bypass killer (mobile checks, Zelle,
 * intermediaries like Talution).
 */
export function checkUnclassifiedDeposits(
  transactions: AuditTransaction[],
  accounts: AuditAccount[],
  incomeSources: AuditIncomeSource[],
  titheIncomeTxnIds: Set<string>
): Finding[] {
  const depositoryIds = new Set(
    accounts.filter((a) => a.type === 'depository').map((a) => a.id)
  );
  const accountName = new Map(accounts.map((a) => [a.id, a.name]));

  const offending = transactions.filter((t) => {
    if (!depositoryIds.has(t.account_id)) return false;
    const amt = Number(t.amount);
    if (amt >= 0) return false; // money-in on depository is negative
    if (Math.abs(amt) < UNCLASSIFIED_DEPOSIT_MIN) return false;
    if (isClassifiedIncome(t.merchant_name, incomeSources)) return false;
    if (titheIncomeTxnIds.has(t.id)) return false;
    return true;
  });

  if (offending.length === 0) return [];

  const total = round2(offending.reduce((s, t) => s + Math.abs(Number(t.amount)), 0));
  const rows = [...offending]
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, MAX_DETAIL_ROWS)
    .map((t) => ({
      date: t.date,
      merchant: t.merchant_name,
      amount: round2(Math.abs(Number(t.amount))),
      account: accountName.get(t.account_id) ?? t.account_id,
    }));

  return [{
    checkKey: 'unclassified_deposits',
    severity: total > UNCLASSIFIED_DEPOSIT_CRITICAL_TOTAL ? 'critical' : 'warn',
    title: 'Unclassified deposits need review',
    detail: { rows, truncated: offending.length > MAX_DETAIL_ROWS },
    itemCount: offending.length,
    totalAmount: total,
    period: null,
  }];
}

/**
 * Check B — Tithe owed vs paid, per entity, over the recent budget-month window.
 * One finding per entity with a positive gap.
 */
export function checkTitheGaps(
  titheRows: AuditTitheRow[],
  entities: AuditEntity[],
  now: Date = new Date()
): Finding[] {
  const labels = recentBudgetMonthLabels(now, TITHE_LOOKBACK_MONTHS);
  const window = new Set(labels);
  const entityName = new Map(entities.map((e) => [e.id, e.name]));
  const period = formatBudgetMonth(getCurrentBudgetMonth(now));

  return aggregateTitheByEntity(titheRows, window)
    .filter((agg) => agg.gap > 0)
    .map((agg) => ({
      checkKey: 'tithe_gaps' as const,
      severity: agg.gap >= TITHE_GAP_CRITICAL ? ('critical' as const) : ('warn' as const),
      title: `Tithe gap — ${entityName.get(agg.entityId) ?? 'Unknown entity'}`,
      detail: {
        entity: entityName.get(agg.entityId) ?? agg.entityId,
        owed: round2(agg.owed),
        paid: round2(agg.paid),
        gap: round2(agg.gap),
        months: labels,
      },
      itemCount: 1,
      totalAmount: round2(agg.gap),
      period,
    }));
}

/**
 * Check C — Stale balances. Flags active accounts whose snapshot is older than
 * the threshold and reports the estimated live balance alongside the stale one.
 */
export function checkStaleBalances(
  accounts: AuditAccount[],
  transactions: AuditTransaction[],
  now: Date = new Date()
): Finding[] {
  const stale = accounts
    .filter((a) => a.is_active)
    .map((a) => ({ account: a, ageDays: balanceAgeDays(a.updated_at, now) }))
    .filter((x) => x.ageDays > STALE_BALANCE_MAX_AGE_DAYS);

  if (stale.length === 0) return [];

  const rows = stale
    .sort((a, b) => b.ageDays - a.ageDays)
    .slice(0, MAX_DETAIL_ROWS)
    .map(({ account, ageDays }) => ({
      account: account.name,
      type: account.type,
      ageDays,
      storedBalance: round2(Number(account.current_balance) || 0),
      estimatedBalance: round2(estimateAccountBalance(account, transactions)),
    }));

  return [{
    checkKey: 'stale_balances',
    severity: 'warn',
    title: 'Account balances are stale',
    detail: { rows, truncated: stale.length > MAX_DETAIL_ROWS },
    itemCount: stale.length,
    totalAmount: 0,
    period: null,
  }];
}

/**
 * Check D — Duplicate transactions: same account + amount + date appearing more
 * than once, excluding configured legitimate repeats (Delta tickets, HOA dues).
 */
export function checkDuplicateTransactions(
  transactions: AuditTransaction[],
  accounts: AuditAccount[],
  exclusions: string[] = DUPLICATE_MERCHANT_EXCLUSIONS
): Finding[] {
  const accountName = new Map(accounts.map((a) => [a.id, a.name]));
  const groups = new Map<string, AuditTransaction[]>();

  for (const t of transactions) {
    const merchant = (t.merchant_name ?? '').toLowerCase();
    if (exclusions.some((ex) => ex && merchant.includes(ex.toLowerCase()))) continue;
    const key = `${t.account_id}|${Number(t.amount)}|${t.date}`;
    const arr = groups.get(key) ?? [];
    arr.push(t);
    groups.set(key, arr);
  }

  const dupGroups = Array.from(groups.values()).filter((g) => g.length > 1);
  if (dupGroups.length === 0) return [];

  let extraRows = 0;
  let total = 0;
  const rows = dupGroups
    .sort((a, b) => (a[0].date < b[0].date ? 1 : -1))
    .slice(0, MAX_DETAIL_ROWS)
    .map((g) => {
      extraRows += g.length - 1;
      total += Math.abs(Number(g[0].amount)) * (g.length - 1);
      return {
        account: accountName.get(g[0].account_id) ?? g[0].account_id,
        date: g[0].date,
        amount: round2(Number(g[0].amount)),
        merchant: g[0].merchant_name,
        count: g.length,
      };
    });
  // Account for groups beyond the detail cap in the totals.
  for (const g of dupGroups.slice(MAX_DETAIL_ROWS)) {
    extraRows += g.length - 1;
    total += Math.abs(Number(g[0].amount)) * (g.length - 1);
  }

  return [{
    checkKey: 'duplicate_transactions',
    severity: 'warn',
    title: 'Possible duplicate transactions',
    detail: { rows, groupCount: dupGroups.length, truncated: dupGroups.length > MAX_DETAIL_ROWS },
    itemCount: extraRows,
    totalAmount: round2(total),
    period: null,
  }];
}

/**
 * Check E — Plaid item health. Flags items that have not synced within the
 * threshold (null = never synced counts as dead) and any expected account that
 * is not present among the linked active accounts.
 */
export function checkPlaidItemHealth(
  plaidItems: AuditPlaidItem[],
  accounts: AuditAccount[],
  expectedFragments: string[] = EXPECTED_ACCOUNT_NAME_FRAGMENTS,
  now: Date = new Date()
): Finding[] {
  const staleMs = PLAID_ITEM_STALE_HOURS * 3_600_000;

  const staleItems = plaidItems
    .filter((item) => {
      if (!item.last_successful_sync) return true; // never synced
      return now.getTime() - new Date(item.last_successful_sync).getTime() > staleMs;
    })
    .map((item) => ({
      institution: item.institution_name ?? 'Unknown institution',
      status: item.status,
      lastSync: item.last_successful_sync,
      errorCode: item.last_error_code,
    }));

  const activeNames = accounts
    .filter((a) => a.is_active)
    .map((a) => a.name.toLowerCase());
  const missingAccounts = expectedFragments.filter(
    (frag) => frag && !activeNames.some((n) => n.includes(frag.toLowerCase()))
  );

  const count = staleItems.length + missingAccounts.length;
  if (count === 0) return [];

  return [{
    checkKey: 'plaid_item_health',
    severity: 'critical',
    title: 'Plaid connections need attention',
    detail: { staleItems, missingAccounts },
    itemCount: count,
    totalAmount: 0,
    period: null,
  }];
}

/**
 * Check F — Tithe idempotency. Reports duplicate income_transaction_id values in
 * tithe_log (each should be unique; duplicates double-count tithe). Report only.
 */
export function checkTitheIdempotency(titheRows: AuditTitheRow[]): Finding[] {
  const byTxn = new Map<string, number>();
  for (const row of titheRows) {
    if (!row.income_transaction_id) continue;
    byTxn.set(row.income_transaction_id, (byTxn.get(row.income_transaction_id) ?? 0) + 1);
  }

  const dups = Array.from(byTxn.entries()).filter(([, c]) => c > 1);
  if (dups.length === 0) return [];

  return [{
    checkKey: 'tithe_idempotency',
    severity: 'warn',
    title: 'Duplicate tithe_log entries',
    detail: {
      duplicates: dups
        .slice(0, MAX_DETAIL_ROWS)
        .map(([incomeTransactionId, count]) => ({ incomeTransactionId, count })),
    },
    itemCount: dups.length,
    totalAmount: 0,
    period: null,
  }];
}

/** Convenience used by tests to confirm the budget-month label of a date. */
export { titheBudgetMonthLabel };
