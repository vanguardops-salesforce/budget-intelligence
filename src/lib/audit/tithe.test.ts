import { describe, it, expect } from 'vitest';
import {
  aggregateTitheByEntity,
  recentBudgetMonthLabels,
  titheBudgetMonthLabel,
} from './tithe';
import type { AuditTitheRow } from './types';

describe('titheBudgetMonthLabel — 11th–10th cycle', () => {
  it('places the 15th in the month it starts', () => {
    expect(titheBudgetMonthLabel('2026-05-15')).toBe('May 2026');
  });
  it('places the 10th in the previous budget month', () => {
    expect(titheBudgetMonthLabel('2026-05-10')).toBe('April 2026');
  });
});

describe('recentBudgetMonthLabels', () => {
  it('returns current plus trailing months', () => {
    const now = new Date('2026-05-29T00:00:00Z');
    expect(recentBudgetMonthLabels(now, 3)).toEqual(['May 2026', 'April 2026', 'March 2026']);
  });
});

describe('aggregateTitheByEntity', () => {
  const rows: AuditTitheRow[] = [
    { id: '1', entity_id: 'A', income_date: '2026-05-15', tithe_owed: 100, tithe_paid: 40, income_transaction_id: 'tx1' },
    { id: '2', entity_id: 'A', income_date: '2026-05-20', tithe_owed: 50, tithe_paid: 50, income_transaction_id: 'tx2' },
    { id: '3', entity_id: 'B', income_date: '2026-05-12', tithe_owed: 200, tithe_paid: 0, income_transaction_id: 'tx3' },
    // Outside the window (Dec 2025) — excluded.
    { id: '4', entity_id: 'A', income_date: '2026-01-05', tithe_owed: 999, tithe_paid: 0, income_transaction_id: 'tx4' },
    // No income_date — ignored.
    { id: '5', entity_id: 'B', income_date: null, tithe_owed: 12, tithe_paid: 0, income_transaction_id: null },
  ];
  const window = new Set(['May 2026', 'April 2026', 'March 2026']);

  it('sums owed and paid per entity within the window and computes the gap', () => {
    const result = aggregateTitheByEntity(rows, window);
    const a = result.find((r) => r.entityId === 'A');
    const b = result.find((r) => r.entityId === 'B');

    expect(a).toEqual({ entityId: 'A', owed: 150, paid: 90, gap: 60 });
    expect(b).toEqual({ entityId: 'B', owed: 200, paid: 0, gap: 200 });
  });

  it('excludes rows outside the window and rows without a date', () => {
    const result = aggregateTitheByEntity(rows, window);
    // The Dec 2025 owed:999 row must not inflate entity A.
    const a = result.find((r) => r.entityId === 'A');
    expect(a?.owed).toBe(150);
  });
});
