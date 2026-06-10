import { describe, it, expect } from 'vitest';
import {
  aggregateTitheAllTime,
  buildRunningLedger,
  sumCycleTotals,
  type TitheLedgerRow,
} from './titheLedger';
import { getBudgetMonth, parseIsoDate } from './budgetMonth';

// May 2026 budget cycle = May 11 – Jun 10, 2026.
const mayCycle = getBudgetMonth(parseIsoDate('2026-06-10'));

const entityNames = new Map([
  ['personal', 'Personal'],
  ['vcg', 'Veteran Capital Group LLC'],
  ['vd', 'Veteran Digital LLC'],
]);

function row(partial: Partial<TitheLedgerRow> & Pick<TitheLedgerRow, 'entityId' | 'incomeDate' | 'titheOwed'>): TitheLedgerRow {
  return { incomeSource: null, tithePaid: 0, status: 'owed', ...partial };
}

// Mirror of the 2026-06-10 ledger rebuild used as ground truth in the fix spec.
const rows: TitheLedgerRow[] = [
  // Prior cycle, fully paid — must not appear in the running ledger but must
  // count toward the all-time tracker.
  row({ entityId: 'personal', incomeDate: '2026-04-15', titheOwed: 500, tithePaid: 500, status: 'paid' }),
  // Personal — current cycle
  row({ entityId: 'personal', incomeDate: '2026-05-27', incomeSource: 'LEIDOS INC PAYROLL', titheOwed: 426, tithePaid: 100, status: 'partial' }),
  row({ entityId: 'personal', incomeDate: '2026-05-28', incomeSource: 'Nike', titheOwed: 519 }),
  row({ entityId: 'personal', incomeDate: '2026-05-28', incomeSource: 'THRIVENT PAYROLL PAYROLL', titheOwed: 521 }),
  // Veteran Capital Group — current cycle
  row({ entityId: 'vcg', incomeDate: '2026-06-01', incomeSource: 'ProPay', titheOwed: 160 }),
  row({ entityId: 'vcg', incomeDate: '2026-06-02', incomeSource: 'ProPay', titheOwed: 175 }),
  row({ entityId: 'vcg', incomeDate: '2026-06-03', incomeSource: 'ProPay', titheOwed: 160 }),
  row({ entityId: 'vcg', incomeDate: '2026-06-04', incomeSource: 'ProPay', titheOwed: 87 }),
  row({ entityId: 'vcg', incomeDate: '2026-06-05', incomeSource: 'ProPay', titheOwed: 157 }),
  row({ entityId: 'vcg', incomeDate: '2026-06-08', incomeSource: 'ProPay', titheOwed: 310 }),
  // Veteran Digital — current cycle
  row({ entityId: 'vd', incomeDate: '2026-05-21', incomeSource: 'Medix', titheOwed: 440 }),
  row({ entityId: 'vd', incomeDate: '2026-05-22', incomeSource: 'Talution', titheOwed: 400 }),
  row({ entityId: 'vd', incomeDate: '2026-05-28', incomeSource: 'Medix', titheOwed: 352 }),
  row({ entityId: 'vd', incomeDate: '2026-05-29', incomeSource: 'Talution', titheOwed: 400 }),
  row({ entityId: 'vd', incomeDate: '2026-06-04', incomeSource: 'Medix', titheOwed: 352 }),
  row({ entityId: 'vd', incomeDate: '2026-06-05', incomeSource: 'Talution', titheOwed: 400 }),
];

describe('buildRunningLedger', () => {
  const ledger = buildRunningLedger(rows, mayCycle, entityNames);

  it('reads remaining verbatim from the ledger — Nike shows $519, not an allocated sliver', () => {
    const nike = ledger.find((e) => e.incomeSource === 'Nike');
    expect(nike?.remaining).toBe(519);
  });

  it('shows the unpaid remainder of a partial row', () => {
    const leidos = ledger.find((e) => e.incomeSource === 'LEIDOS INC PAYROLL');
    expect(leidos?.remaining).toBe(326);
    expect(leidos?.status).toBe('partial');
  });

  it('excludes paid rows and rows from other cycles', () => {
    expect(ledger).toHaveLength(15);
    expect(ledger.some((e) => e.incomeDate === '2026-04-15')).toBe(false);
  });

  it('orders by income date, then entity name', () => {
    expect(ledger[0]).toMatchObject({ incomeDate: '2026-05-21', entityId: 'vd' });
    const jun4 = ledger.filter((e) => e.incomeDate === '2026-06-04');
    expect(jun4.map((e) => e.entityId)).toEqual(['vcg', 'vd']);
  });

  it('per-entity cycle sums match the ground-truth totals', () => {
    const sums = new Map<string, number>();
    for (const e of ledger) sums.set(e.entityId, (sums.get(e.entityId) ?? 0) + e.remaining);
    expect(sums.get('personal')).toBe(1366);
    expect(sums.get('vcg')).toBe(1049);
    expect(sums.get('vd')).toBe(2344);
  });
});

describe('sumCycleTotals', () => {
  it('sums owed and paid across all rows of the cycle, including paid portions', () => {
    const totals = sumCycleTotals(rows, mayCycle);
    expect(totals.owed).toBe(4859);
    expect(totals.paid).toBe(100);
  });
});

describe('aggregateTitheAllTime', () => {
  it('agrees with the running ledger and includes prior fully-paid cycles', () => {
    const byEntity = new Map(aggregateTitheAllTime(rows).map((e) => [e.entityId, e]));
    expect(byEntity.get('personal')).toEqual({ entityId: 'personal', owed: 1966, paid: 600, gap: 1366 });
    expect(byEntity.get('vcg')).toEqual({ entityId: 'vcg', owed: 1049, paid: 0, gap: 1049 });
    expect(byEntity.get('vd')).toEqual({ entityId: 'vd', owed: 2344, paid: 0, gap: 2344 });
  });
});
