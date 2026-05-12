/**
 * Custom budget month cycle: the 11th of one calendar month through the 10th
 * of the next. A budget month is labeled by the calendar month it STARTS in.
 *
 *   "May 2026"  = May 11, 2026  -> June 10, 2026
 *   "June 2026" = June 11, 2026 -> July 10, 2026
 *
 * This TS implementation mirrors the SQL functions `get_budget_month(DATE)`
 * and `get_budget_month_range(DATE)`. All dates are interpreted in UTC to
 * stay consistent with the way Postgres treats plain DATE values and to
 * avoid drift across timezones.
 */

const MONTH_NAMES_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const MONTH_NAMES_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * Mirror of the SQL `get_budget_month(d)` function. Returns the first day of
 * the calendar month the budget month is labeled by, as a UTC midnight Date.
 */
export function getBudgetMonth(date: Date): Date {
  const day = date.getUTCDate();
  const year = date.getUTCFullYear();
  const monthIndex = date.getUTCMonth();
  if (day >= 11) {
    return new Date(Date.UTC(year, monthIndex, 1));
  }
  return new Date(Date.UTC(year, monthIndex - 1, 1));
}

/**
 * Mirror of the SQL `get_budget_month_range(budget_month)` function. Given
 * the first day of the labeled calendar month, returns the inclusive start
 * (the 11th of that month) and end (the 10th of the following month) of
 * the budget window.
 */
export function getBudgetMonthRange(budgetMonth: Date): { start: Date; end: Date } {
  const year = budgetMonth.getUTCFullYear();
  const monthIndex = budgetMonth.getUTCMonth();
  return {
    start: new Date(Date.UTC(year, monthIndex, 11)),
    end: new Date(Date.UTC(year, monthIndex + 1, 10)),
  };
}

/** Format a budget month as "May 2026" (the label of the START month). */
export function formatBudgetMonth(budgetMonth: Date): string {
  const name = MONTH_NAMES_LONG[budgetMonth.getUTCMonth()];
  return `${name} ${budgetMonth.getUTCFullYear()}`;
}

/** Format a budget month as "May 11 – Jun 10" (the actual window). */
export function formatBudgetMonthRange(budgetMonth: Date): string {
  const { start, end } = getBudgetMonthRange(budgetMonth);
  const startName = MONTH_NAMES_SHORT[start.getUTCMonth()];
  const endName = MONTH_NAMES_SHORT[end.getUTCMonth()];
  return `${startName} ${start.getUTCDate()} – ${endName} ${end.getUTCDate()}`;
}

/** Return the budget month for today (UTC). */
export function getCurrentBudgetMonth(now: Date = new Date()): Date {
  return getBudgetMonth(now);
}

/** Format a Date as YYYY-MM-DD for use with Postgres DATE columns. */
export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Parse a YYYY-MM-DD string as a UTC midnight Date. Useful when reading DATE
 * columns out of Supabase, which arrive as plain strings.
 */
export function parseIsoDate(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

/** Add (or subtract) months to a budget month and return the new label. */
export function addBudgetMonths(budgetMonth: Date, delta: number): Date {
  return new Date(Date.UTC(
    budgetMonth.getUTCFullYear(),
    budgetMonth.getUTCMonth() + delta,
    1,
  ));
}
