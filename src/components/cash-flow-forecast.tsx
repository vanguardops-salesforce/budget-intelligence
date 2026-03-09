'use client';

import { formatCurrency } from '@/lib/format';

interface RecurringPatternInput {
  estimated_amount: number;
  frequency: string;
  next_expected_date: string | null;
}

interface CashFlowForecastProps {
  recurringPatterns: RecurringPatternInput[];
  mtdSpending: number;
  mtdIncome: number;
  dayOfMonth: number;
}

export function CashFlowForecast({
  recurringPatterns,
  mtdSpending,
  mtdIncome,
  dayOfMonth,
}: CashFlowForecastProps) {
  const forecast = computeForecast(recurringPatterns, mtdSpending, mtdIncome, dayOfMonth);
  const isPatternBased = recurringPatterns.length > 0;

  const bars = [
    { label: '30 Days', value: forecast.net30, spending: forecast.spending30, income: forecast.income30 },
    { label: '60 Days', value: forecast.net60, spending: forecast.spending60, income: forecast.income60 },
    { label: '90 Days', value: forecast.net90, spending: forecast.spending90, income: forecast.income90 },
  ];

  const maxAbsValue = Math.max(
    ...bars.map((b) => Math.max(Math.abs(b.spending), Math.abs(b.income)))
  ) || 1;

  return (
    <div className="space-y-4">
      {bars.map((bar) => (
        <div key={bar.label} className="space-y-1.5">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">{bar.label}</span>
            <span className={bar.value >= 0 ? 'text-green-600' : 'text-red-600'}>
              {bar.value >= 0 ? '+' : ''}{formatCurrency(bar.value)}
            </span>
          </div>
          <div className="flex gap-1 h-3">
            <div
              className="rounded-sm bg-green-500/70"
              style={{ width: `${(bar.income / maxAbsValue) * 50}%` }}
              title={`Income: ${formatCurrency(bar.income)}`}
            />
            <div
              className="rounded-sm bg-red-500/50"
              style={{ width: `${(bar.spending / maxAbsValue) * 50}%` }}
              title={`Spending: ${formatCurrency(bar.spending)}`}
            />
          </div>
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>Income: {formatCurrency(bar.income)}</span>
            <span>Spending: {formatCurrency(bar.spending)}</span>
          </div>
        </div>
      ))}
      <p className="text-[11px] text-muted-foreground pt-1">
        {isPatternBased
          ? `Based on ${recurringPatterns.length} detected recurring pattern(s)`
          : 'Estimated from month-to-date spending pace'}
      </p>
    </div>
  );
}

function computeForecast(
  patterns: RecurringPatternInput[],
  mtdSpending: number,
  mtdIncome: number,
  dayOfMonth: number
) {
  if (patterns.length === 0) {
    // Extrapolate from MTD pace
    const dailySpending = dayOfMonth > 0 ? mtdSpending / dayOfMonth : 0;
    const dailyIncome = dayOfMonth > 0 ? mtdIncome / dayOfMonth : 0;

    return {
      spending30: round2(dailySpending * 30),
      income30: round2(dailyIncome * 30),
      net30: round2((dailyIncome - dailySpending) * 30),
      spending60: round2(dailySpending * 60),
      income60: round2(dailyIncome * 60),
      net60: round2((dailyIncome - dailySpending) * 60),
      spending90: round2(dailySpending * 90),
      income90: round2(dailyIncome * 90),
      net90: round2((dailyIncome - dailySpending) * 90),
    };
  }

  let spending30 = 0, spending60 = 0, spending90 = 0;
  let income30 = 0, income60 = 0, income90 = 0;

  const now = new Date();

  for (const p of patterns) {
    const amt = p.estimated_amount;
    const occ = countOccurrences(p.frequency, p.next_expected_date, now);

    if (amt > 0) {
      // Positive = spending in Plaid convention
      spending30 += amt * occ.in30;
      spending60 += amt * occ.in60;
      spending90 += amt * occ.in90;
    } else {
      // Negative = income
      income30 += Math.abs(amt) * occ.in30;
      income60 += Math.abs(amt) * occ.in60;
      income90 += Math.abs(amt) * occ.in90;
    }
  }

  return {
    spending30: round2(spending30),
    income30: round2(income30),
    net30: round2(income30 - spending30),
    spending60: round2(spending60),
    income60: round2(income60),
    net60: round2(income60 - spending60),
    spending90: round2(spending90),
    income90: round2(income90),
    net90: round2(income90 - spending90),
  };
}

function countOccurrences(
  frequency: string,
  nextExpectedDate: string | null,
  now: Date
): { in30: number; in60: number; in90: number } {
  const intervalDays: Record<string, number> = {
    weekly: 7,
    biweekly: 14,
    monthly: 30,
    annual: 365,
  };

  const interval = intervalDays[frequency] ?? 30;
  const start = nextExpectedDate ? new Date(nextExpectedDate) : now;
  const dayOffset = Math.max(0, (start.getTime() - now.getTime()) / 86_400_000);

  const countInWindow = (windowDays: number): number => {
    if (dayOffset > windowDays) return 0;
    const remainingDays = windowDays - dayOffset;
    return Math.max(1, Math.floor(remainingDays / interval) + 1);
  };

  return {
    in30: countInWindow(30),
    in60: countInWindow(60),
    in90: countInWindow(90),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
