import { type SupabaseClient } from '@supabase/supabase-js';
import type { FinancialState } from '../types';
import { logger } from '../logger';

/**
 * Compute a compact FinancialState summary (~1,500 tokens) for AI context.
 * Queries accounts, transactions, holdings, budget categories, and recurring patterns
 * to build a comprehensive snapshot of the user's financial position.
 */
export async function computeFinancialState(
  supabase: SupabaseClient,
  userId: string
): Promise<FinancialState> {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    .toISOString()
    .split('T')[0];

  // Run all queries in parallel for performance
  const [
    entitiesRes,
    accountsRes,
    txRes,
    holdingsRes,
    budgetRes,
    recurringRes,
  ] = await Promise.all([
    supabase
      .from('entities')
      .select('id, name, type')
      .eq('user_id', userId)
      .eq('is_active', true),
    supabase
      .from('accounts')
      .select('id, entity_id, type, current_balance')
      .eq('user_id', userId)
      .eq('is_active', true)
      .is('deleted_at', null),
    supabase
      .from('transactions')
      .select('entity_id, amount, user_category_id')
      .eq('user_id', userId)
      .is('deleted_at', null)
      .gte('date', monthStart)
      .lte('date', today),
    supabase
      .from('holdings')
      .select('entity_id, account_id, security_name, ticker, value, cost_basis')
      .eq('user_id', userId)
      .is('deleted_at', null),
    supabase
      .from('budget_categories')
      .select('id, entity_id, name, monthly_budget_amount')
      .eq('user_id', userId)
      .eq('is_active', true),
    supabase
      .from('recurring_patterns')
      .select('entity_id, merchant_pattern, estimated_amount, frequency, next_expected_date, confidence_score')
      .eq('user_id', userId)
      .eq('is_active', true),
  ]);

  const entities = entitiesRes.data ?? [];
  const accounts = accountsRes.data ?? [];
  const transactions = txRes.data ?? [];
  const holdings = holdingsRes.data ?? [];
  const budgetCategories = budgetRes.data ?? [];
  const recurringPatterns = recurringRes.data ?? [];

  // --- Net Worth ---
  const totalCash = accounts
    .filter((a) => a.type === 'depository')
    .reduce((sum, a) => sum + (Number(a.current_balance) || 0), 0);

  const totalInvestments = holdings.reduce(
    (sum, h) => sum + (Number(h.value) || 0),
    0
  );

  const totalCredit = accounts
    .filter((a) => a.type === 'credit')
    .reduce((sum, a) => sum + (Number(a.current_balance) || 0), 0);

  const totalLoans = accounts
    .filter((a) => a.type === 'loan')
    .reduce((sum, a) => sum + (Number(a.current_balance) || 0), 0);

  const totalAssets = totalCash + totalInvestments;
  const totalLiabilities = totalCredit + totalLoans;

  // --- Per-entity breakdown ---
  const entitySummaries = entities.map((entity) => {
    const entityAccounts = accounts.filter((a) => a.entity_id === entity.id);
    const entityTx = transactions.filter((t) => t.entity_id === entity.id);
    const entityBudgets = budgetCategories.filter(
      (b) => b.entity_id === entity.id
    );

    const cashBalance = entityAccounts
      .filter((a) => a.type === 'depository')
      .reduce((sum, a) => sum + (Number(a.current_balance) || 0), 0);

    const mtdIncome = entityTx
      .filter((t) => Number(t.amount) < 0)
      .reduce((sum, t) => sum + Math.abs(Number(t.amount)), 0);

    const mtdSpending = entityTx
      .filter((t) => Number(t.amount) > 0)
      .reduce((sum, t) => sum + Number(t.amount), 0);

    // Budget variance: sum of (budget - actual) for all categories with a budget
    const totalBudget = entityBudgets.reduce(
      (sum, b) => sum + (Number(b.monthly_budget_amount) || 0),
      0
    );
    const budgetVariance = totalBudget > 0 ? totalBudget - mtdSpending : 0;

    // Runway: days of cash at current daily burn rate
    const dayOfMonth = now.getDate();
    const dailyBurn = dayOfMonth > 0 ? mtdSpending / dayOfMonth : 0;
    const runwayDays =
      dailyBurn > 0 ? Math.round(cashBalance / dailyBurn) : 9999;

    return {
      name: entity.name,
      type: entity.type,
      cash_balance: round2(cashBalance),
      mtd_income: round2(mtdIncome),
      mtd_spending: round2(mtdSpending),
      budget_variance: round2(budgetVariance),
      runway_days: runwayDays,
    };
  });

  // --- Portfolio allocation ---
  const allocationMap = new Map<string, number>();
  for (const h of holdings) {
    const category = h.ticker ?? h.security_name ?? 'Other';
    allocationMap.set(category, (allocationMap.get(category) || 0) + Number(h.value || 0));
  }
  const allocation = Array.from(allocationMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10) // Top 10 to keep compact
    .map(([category, value]) => ({
      category,
      percentage: totalInvestments > 0 ? round2((value / totalInvestments) * 100) : 0,
      value: round2(value),
    }));

  // --- Cash flow forecast ---
  const forecast = computeCashFlowForecast(recurringPatterns, transactions, now);

  // --- Top spending categories ---
  const categorySpending = new Map<string, number>();
  const categoryBudgets = new Map<string, number | null>();
  const categoryNames = new Map<string, string>();

  for (const bc of budgetCategories) {
    categoryNames.set(bc.id, bc.name);
    if (bc.monthly_budget_amount) {
      categoryBudgets.set(bc.id, Number(bc.monthly_budget_amount));
    }
  }

  for (const tx of transactions) {
    if (Number(tx.amount) <= 0) continue; // Skip income
    const catId = tx.user_category_id || 'uncategorized';
    categorySpending.set(
      catId,
      (categorySpending.get(catId) || 0) + Number(tx.amount)
    );
  }

  const topSpending = Array.from(categorySpending.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([catId, amount]) => ({
      category: categoryNames.get(catId) ?? 'Uncategorized',
      amount: round2(amount),
      budget: categoryBudgets.get(catId) ?? null,
    }));

  // --- Alerts ---
  const alerts = generateAlerts(entitySummaries, totalLiabilities, totalAssets);

  const state: FinancialState = {
    snapshot_date: today,
    net_worth: {
      total: round2(totalAssets - totalLiabilities),
      assets: round2(totalAssets),
      liabilities: round2(totalLiabilities),
    },
    entities: entitySummaries,
    portfolio: {
      total_value: round2(totalInvestments),
      allocation,
    },
    cash_flow_forecast: forecast,
    top_spending_categories: topSpending,
    alerts,
  };

  logger.info('Financial state computed', {
    user_id: userId,
    net_worth: state.net_worth.total,
    entity_count: entities.length,
    account_count: accounts.length,
  });

  return state;
}

/**
 * Compute 30/60/90 day cash flow forecast based on recurring patterns.
 * Falls back to MTD run-rate extrapolation if no patterns exist.
 */
export function computeCashFlowForecast(
  recurringPatterns: Array<{
    estimated_amount: number;
    frequency: string;
    next_expected_date: string | null;
    confidence_score?: number;
  }>,
  transactions: Array<{ amount: number }>,
  now: Date
): { next_30_days: number; next_60_days: number; next_90_days: number } {
  if (recurringPatterns.length === 0) {
    // Fallback: extrapolate from MTD spending pace
    const dayOfMonth = now.getDate();
    const mtdSpending = transactions
      .filter((t) => Number(t.amount) > 0)
      .reduce((sum, t) => sum + Number(t.amount), 0);
    const mtdIncome = transactions
      .filter((t) => Number(t.amount) < 0)
      .reduce((sum, t) => sum + Math.abs(Number(t.amount)), 0);

    const dailyNet = dayOfMonth > 0 ? (mtdIncome - mtdSpending) / dayOfMonth : 0;

    return {
      next_30_days: round2(dailyNet * 30),
      next_60_days: round2(dailyNet * 60),
      next_90_days: round2(dailyNet * 90),
    };
  }

  // Project each recurring pattern forward
  let net30 = 0;
  let net60 = 0;
  let net90 = 0;

  for (const pattern of recurringPatterns) {
    const amt = Number(pattern.estimated_amount) || 0;
    const confidence = Number(pattern.confidence_score ?? 1);
    const weightedAmt = amt * Math.min(confidence, 1);

    // Determine occurrences in each window
    const occurrences = countOccurrences(pattern.frequency, pattern.next_expected_date, now);

    // Amount is negative for income (Plaid convention: positive = spending)
    net30 -= weightedAmt * occurrences.in30;
    net60 -= weightedAmt * occurrences.in60;
    net90 -= weightedAmt * occurrences.in90;
  }

  return {
    next_30_days: round2(net30),
    next_60_days: round2(net60),
    next_90_days: round2(net90),
  };
}

/**
 * Count how many times a recurring pattern occurs within 30/60/90 day windows.
 */
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

  // If we have a next expected date, count forward from it
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

/**
 * Generate financial alerts based on current state.
 */
function generateAlerts(
  entities: Array<{
    name: string;
    cash_balance: number;
    runway_days: number;
    budget_variance: number;
    mtd_spending: number;
  }>,
  totalLiabilities: number,
  totalAssets: number
): string[] {
  const alerts: string[] = [];

  for (const entity of entities) {
    if (entity.runway_days < 30 && entity.runway_days < 9999) {
      alerts.push(
        `Low cash runway: ${entity.name} has ~${entity.runway_days} days at current burn rate`
      );
    }

    if (entity.budget_variance < 0) {
      alerts.push(
        `Over budget: ${entity.name} is $${Math.abs(entity.budget_variance).toFixed(0)} over budget this month`
      );
    }

    if (entity.cash_balance < 1000 && entity.mtd_spending > 0) {
      alerts.push(`Low cash balance: ${entity.name} has $${entity.cash_balance.toFixed(0)} remaining`);
    }
  }

  if (totalAssets > 0 && totalLiabilities / totalAssets > 0.8) {
    alerts.push(
      `High debt ratio: liabilities are ${((totalLiabilities / totalAssets) * 100).toFixed(0)}% of assets`
    );
  }

  return alerts.slice(0, 5); // Keep compact
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
