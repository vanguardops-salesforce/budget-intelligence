/**
 * Tithe owed-vs-paid aggregation for Check B.
 *
 * Groups tithe_log rows into budget months (the 11th–10th cycle, via the shared
 * budgetMonth helpers that mirror the SQL get_budget_month function) and sums
 * tithe_owed vs tithe_paid per entity across a window of recent budget months.
 */
import {
  getBudgetMonth,
  formatBudgetMonth,
  getCurrentBudgetMonth,
  addBudgetMonths,
  parseIsoDate,
} from '../budgetMonth';
import type { AuditTitheRow } from './types';

export interface TitheAggregate {
  entityId: string;
  owed: number;
  paid: number;
  gap: number;
}

/** Budget-month label ("May 2026") that an income date falls into. */
export function titheBudgetMonthLabel(incomeDate: string): string {
  return formatBudgetMonth(getBudgetMonth(parseIsoDate(incomeDate)));
}

/** Labels for the current budget month plus the trailing (count - 1) months. */
export function recentBudgetMonthLabels(now: Date, count: number): string[] {
  const current = getCurrentBudgetMonth(now);
  const labels: string[] = [];
  for (let i = 0; i < count; i++) {
    labels.push(formatBudgetMonth(addBudgetMonths(current, -i)));
  }
  return labels;
}

/**
 * Sum owed vs paid per entity, restricted to rows whose income_date falls in
 * one of the supplied budget-month labels. Rows without an income_date are
 * ignored (they cannot be placed in a period).
 */
export function aggregateTitheByEntity(
  rows: AuditTitheRow[],
  windowLabels: Set<string>
): TitheAggregate[] {
  const map = new Map<string, { owed: number; paid: number }>();
  for (const row of rows) {
    if (!row.income_date) continue;
    if (!windowLabels.has(titheBudgetMonthLabel(row.income_date))) continue;
    const entry = map.get(row.entity_id) ?? { owed: 0, paid: 0 };
    entry.owed += Number(row.tithe_owed) || 0;
    entry.paid += Number(row.tithe_paid) || 0;
    map.set(row.entity_id, entry);
  }
  return Array.from(map.entries()).map(([entityId, v]) => ({
    entityId,
    owed: v.owed,
    paid: v.paid,
    gap: Math.max(0, v.owed - v.paid),
  }));
}
