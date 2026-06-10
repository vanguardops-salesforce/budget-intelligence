/**
 * Tithing panels read straight from the canonical ledger (`tithe_log`): the DB
 * already holds the correct owed/paid per income row, so the UI must never
 * re-derive per-deposit amounts by allocating payment totals across deposits.
 * Per-row remaining = tithe_owed - tithe_paid; the model is cumulative
 * ("10% of all income"), so overpayments carry forward in the ledger itself.
 */
import { getBudgetMonth, parseIsoDate } from './budgetMonth';

export interface TitheLedgerRow {
  entityId: string;
  incomeDate: string; // YYYY-MM-DD
  incomeSource: string | null;
  titheOwed: number;
  tithePaid: number;
  status: string;
}

export interface RunningLedgerEntry {
  entityId: string;
  incomeDate: string;
  incomeSource: string | null;
  remaining: number;
  status: string;
}

export interface EntityTitheTotals {
  entityId: string;
  owed: number;
  paid: number;
  gap: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function isInBudgetMonth(incomeDate: string, budgetMonth: Date): boolean {
  return getBudgetMonth(parseIsoDate(incomeDate)).getTime() === budgetMonth.getTime();
}

/**
 * Unpaid rows of the given budget cycle, ordered by income date then entity
 * name. `remaining` is read verbatim from the ledger (owed - paid).
 */
export function buildRunningLedger(
  rows: TitheLedgerRow[],
  budgetMonth: Date,
  entityNames: Map<string, string>,
): RunningLedgerEntry[] {
  return rows
    .filter((r) => r.status !== 'paid' && isInBudgetMonth(r.incomeDate, budgetMonth))
    .map((r) => ({
      entityId: r.entityId,
      incomeDate: r.incomeDate,
      incomeSource: r.incomeSource,
      remaining: round2(r.titheOwed - r.tithePaid),
      status: r.status,
    }))
    .sort((a, b) =>
      a.incomeDate === b.incomeDate
        ? (entityNames.get(a.entityId) ?? '').localeCompare(entityNames.get(b.entityId) ?? '')
        : a.incomeDate.localeCompare(b.incomeDate),
    );
}

/** Owed/paid sums across ALL rows of the given budget cycle (paid ones included). */
export function sumCycleTotals(
  rows: TitheLedgerRow[],
  budgetMonth: Date,
): { owed: number; paid: number } {
  let owed = 0;
  let paid = 0;
  for (const r of rows) {
    if (!isInBudgetMonth(r.incomeDate, budgetMonth)) continue;
    owed += r.titheOwed;
    paid += r.tithePaid;
  }
  return { owed: round2(owed), paid: round2(paid) };
}

/**
 * All-time owed vs paid per entity — the cumulative model, summed over the
 * same ledger rows the running ledger reads, so the two panels always agree.
 */
export function aggregateTitheAllTime(rows: TitheLedgerRow[]): EntityTitheTotals[] {
  const map = new Map<string, { owed: number; paid: number }>();
  for (const r of rows) {
    const entry = map.get(r.entityId) ?? { owed: 0, paid: 0 };
    entry.owed += r.titheOwed;
    entry.paid += r.tithePaid;
    map.set(r.entityId, entry);
  }
  return Array.from(map.entries()).map(([entityId, v]) => ({
    entityId,
    owed: round2(v.owed),
    paid: round2(v.paid),
    gap: round2(Math.max(0, v.owed - v.paid)),
  }));
}
