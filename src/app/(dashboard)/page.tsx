export const dynamic = "force-dynamic";

import Link from 'next/link';
import DailyBriefing from "@/components/daily-briefing";
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { PlaidLink } from '@/components/plaid-link';
import { NetWorthChart } from '@/components/net-worth-chart';
import { CashFlowForecast } from '@/components/cash-flow-forecast';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { formatCurrency, formatRelativeTime, maskAccount } from '@/lib/format';
import {
  DollarSign,
  Wallet,
  TrendingDown,
  TrendingUp,
  Landmark,
  CreditCard,
  CircleDot,
  AlertTriangle,
  CalendarClock,
  Clock,
} from 'lucide-react';

export default async function DashboardPage() {
  const supabase = createServerSupabaseClient();

  const now = new Date();
  // Budget period: 15th to 14th
  const day = now.getDate();
  const periodStart = day >= 15
    ? new Date(now.getFullYear(), now.getMonth(), 15)
    : new Date(now.getFullYear(), now.getMonth() - 1, 15);
  const periodEnd = day >= 15
    ? new Date(now.getFullYear(), now.getMonth() + 1, 14)
    : new Date(now.getFullYear(), now.getMonth(), 14);
  const monthStart = periodStart.toISOString().split('T')[0];
  const today = now.toISOString().split('T')[0];
  const periodLabel = `${periodStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${periodEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

  // Parallel data fetching
  const [entitiesRes, accountsRes, plaidItemsRes, txRes, holdingsRes, recurringRes, budgetRes, bucketsRes, incomeRes, ccConfigRes, plannedRes, catTxRes] = await Promise.all([
    supabase.from('entities').select('id, name, type').eq('is_active', true),
    supabase
      .from('accounts')
      .select('id, name, type, subtype, current_balance, available_balance, mask, is_active, plaid_item_id, entity_id')
      .eq('is_active', true)
      .is('deleted_at', null),
    supabase
      .from('plaid_items')
      .select('id, institution_name, status, last_successful_sync, error_count, last_error_code'),
    supabase
      .from('transactions')
      .select('amount')
      .is('deleted_at', null)
      .gte('date', monthStart)
      .lte('date', today),
    supabase
      .from('holdings')
      .select('value')
      .is('deleted_at', null),
    supabase
      .from('recurring_patterns')
      .select('estimated_amount, frequency, next_expected_date')
      .eq('is_active', true),
    supabase
      .from('budget_categories')
      .select('id, name, entity_id, monthly_budget_amount')
      .eq('is_active', true),
    supabase
      .from('savings_buckets')
      .select('id, name, target_amount, account_id, status, priority, notes')
      .in('status', ['active', 'not_opened'])
      .order('priority', { ascending: true }),
    supabase
      .from('income_sources')
      .select('name, type, rate_amount, rate_type, estimated_monthly, start_date, end_date, entity_id, merchant_patterns')
      .eq('is_active', true)
      .order('estimated_monthly', { ascending: false }),
    supabase
      .from('credit_card_config')
      .select('account_id, credit_limit, statement_close_day, payment_due_day, notes'),
    supabase
      .from('planned_expenses')
      .select('id, name, amount, expected_date, notes, is_completed, entity_id')
      .eq('is_completed', false)
      .order('expected_date', { ascending: true }),
    supabase
      .from('transactions')
      .select('amount, user_category_id, entity_id, merchant_name, date')
      .is('deleted_at', null)
      .gte('date', monthStart)
      .lte('date', today),
  ]);

  const entities = entitiesRes.data ?? [];
  const accounts = accountsRes.data ?? [];
  const plaidItems = plaidItemsRes.data ?? [];
  const transactions = txRes.data ?? [];
  const holdings = holdingsRes.data ?? [];
  const recurringPatterns = recurringRes.data ?? [];
  const budgetCategories = budgetRes.data ?? [];
  const ccConfigs = ccConfigRes.data ?? [];
  const savingsBuckets = bucketsRes.data ?? [];
  const incomeSources = incomeRes.data ?? [];
  
  // Income projection
  const activeIncome = incomeSources.filter(s => {
    const started = !s.start_date || new Date(s.start_date) <= now;
    const notEnded = !s.end_date || new Date(s.end_date) > now;
    return started && notEnded;
  });
  const upcomingIncome = incomeSources.filter(s => {
    return s.start_date && new Date(s.start_date) > now;
  });
  const endingIncome = incomeSources.filter(s => {
    if (!s.end_date) return false;
    const endDate = new Date(s.end_date);
    const daysUntilEnd = Math.round((endDate.getTime() - now.getTime()) / 86400000);
    return daysUntilEnd > 0 && daysUntilEnd <= 90;
  });
  
  const currentMonthlyIncome = activeIncome.reduce((sum, s) => sum + Number(s.estimated_monthly), 0);
  const w2Income = activeIncome.filter(s => s.type === 'w2').reduce((sum, s) => sum + Number(s.estimated_monthly), 0);
  const income1099 = activeIncome.filter(s => s.type === '1099').reduce((sum, s) => sum + Number(s.estimated_monthly), 0);
  const rentalIncome = activeIncome.filter(s => s.type === 'rental').reduce((sum, s) => sum + Number(s.estimated_monthly), 0);
  
  // Future income (after all upcoming sources start)
  const futureMonthlyIncome = incomeSources
    .filter(s => !s.end_date || new Date(s.end_date) > now)
    .reduce((sum, s) => sum + Number(s.estimated_monthly), 0);
  const ccConfigMap = new Map(ccConfigs.map(c => [c.account_id, c]));
  const plannedExpenses = plannedRes.data ?? [];
  const totalPlanned = plannedExpenses.reduce((sum, p) => sum + Number(p.amount), 0);
  const allMtdTransactions = catTxRes.data ?? [];

  // Investable Cash Calculations
  const personalEntityId = entities.find(e => e.type === 'personal')?.id;
  
  // Plan-based: Income budget minus expense budgets
  const expenseBudgets = budgetCategories.filter(
    c => c.name !== 'Income' && c.name !== 'Credit Card Payments' && Number(c.monthly_budget_amount) > 0
  );
  const totalMonthlyBudget = expenseBudgets.reduce((sum, c) => sum + Number(c.monthly_budget_amount), 0);
  
  // Actual-based: Real income minus real spending this month
  const actualIncome = allMtdTransactions
    .filter(t => Number(t.amount) < 0)
    .reduce((sum, t) => sum + Math.abs(Number(t.amount)), 0);
  const actualExpenses = allMtdTransactions
    .filter(t => Number(t.amount) > 0)
    .reduce((sum, t) => sum + Number(t.amount), 0);
  
  // Credit card payment transactions (transfers, not real expenses)
  const ccPaymentCategoryIds = budgetCategories
    .filter(c => c.name === 'Credit Card Payments')
    .map(c => c.id);
  const actualSpendingExCCPayments = allMtdTransactions
    .filter(t => Number(t.amount) > 0 && !ccPaymentCategoryIds.includes(t.user_category_id ?? ''))
    .reduce((sum, t) => sum + Number(t.amount), 0);

  // Budget breakdown by purpose
  const taxCategories = budgetCategories.filter(c => c.name === 'Tax Payments');
  const taxBudget = taxCategories.reduce((sum, c) => sum + Number(c.monthly_budget_amount), 0);
  
  const tithingCategory = budgetCategories.find(c => c.name === 'Tithing');
  const tithingBudget = Number(tithingCategory?.monthly_budget_amount || 0);
  
  const vcgEntityId = '33333333-3333-3333-3333-333333333333';
  const vdEntityId = '22222222-2222-2222-2222-222222222222';
  
  const rentalCostCategories = ['Mortgage Payments', 'Property Repairs & Maintenance', 'Property Insurance', 'Property Management', 'Utilities'];
  const rentalCostsBudget = budgetCategories
    .filter(c => c.entity_id === vcgEntityId && rentalCostCategories.includes(c.name))
    .reduce((sum, c) => sum + Number(c.monthly_budget_amount), 0);
  
  const vdExpenseCategories = ['Software & SaaS', 'Professional Services', 'Office & Equipment', 'Travel & Business Meals', 'Marketing', 'Insurance', 'Miscellaneous'];
  const vdExpensesBudget = budgetCategories
    .filter(c => c.entity_id === vdEntityId && vdExpenseCategories.includes(c.name))
    .reduce((sum, c) => sum + Number(c.monthly_budget_amount), 0);
  
  const personalLivingCategories = ['Groceries', 'Dining & Delivery', 'Shopping & Household', 'Entertainment', 'Kids & Family', 'Personal Care', 'Car Expenses', 'Transportation', 'Medical & Health', 'Subscriptions', 'Utilities & Phone', 'Housing', 'Insurance - Auto/Home', 'Miscellaneous', 'Travel & Vacation'];
  const personalLivingBudget = budgetCategories
    .filter(c => c.entity_id === personalEntityId && personalLivingCategories.includes(c.name))
    .reduce((sum, c) => sum + Number(c.monthly_budget_amount), 0);

  const planInvestable = currentMonthlyIncome - taxBudget - tithingBudget - rentalCostsBudget - vdExpensesBudget - personalLivingBudget;
  const actualInvestable = actualIncome - actualSpendingExCCPayments;

  // Credit card accounts grouped by entity
  const creditCards = accounts
    .filter(a => a.type === 'credit')
    .sort((a, b) => (Number(b.current_balance) || 0) - (Number(a.current_balance) || 0));
  const totalCreditBalance = creditCards.reduce((sum, c) => sum + (Number(c.current_balance) || 0), 0);
  
  const entityMap = new Map(entities.map(e => [e.id, e.name]));
  const ccByEntity = new Map<string, typeof creditCards>();
  for (const card of creditCards) {
    const entityName = entityMap.get(card.entity_id) || 'Unknown';
    const existing = ccByEntity.get(entityName) || [];
    existing.push(card);
    ccByEntity.set(entityName, existing);
  }

  // Compute metrics
  const totalCash = accounts
    .filter((a) => a.type === 'depository')
    .reduce((sum, a) => sum + (Number(a.current_balance) || 0), 0);

  const totalCredit = accounts
    .filter((a) => a.type === 'credit')
    .reduce((sum, a) => sum + (Number(a.current_balance) || 0), 0);

  const totalInvestments = holdings.reduce((sum, h) => sum + (Number(h.value) || 0), 0);

  const totalLoans = accounts
    .filter((a) => a.type === 'loan')
    .reduce((sum, a) => sum + (Number(a.current_balance) || 0), 0);

  const netWorth = totalCash + totalInvestments - totalCredit - totalLoans;

  const mtdSpending = transactions
    .filter((t) => Number(t.amount) > 0)
    .reduce((sum, t) => sum + Number(t.amount), 0);

  const mtdIncome = transactions
    .filter((t) => Number(t.amount) < 0)
    .reduce((sum, t) => sum + Math.abs(Number(t.amount)), 0);

  // 30-day cash flow forecast based on recurring patterns
  const forecastDate = new Date(now.getTime() + 30 * 86_400_000);
  let forecast30d = 0;
  for (const pattern of recurringPatterns) {
    const amt = Number(pattern.estimated_amount) || 0;
    const next = pattern.next_expected_date ? new Date(pattern.next_expected_date) : null;
    if (!next || next > forecastDate) continue;

    const freqMultiplier: Record<string, number> = {
      weekly: 4,
      biweekly: 2,
      monthly: 1,
      annual: 0,
    };
    const occurrences = freqMultiplier[pattern.frequency] ?? 1;
    forecast30d += amt * occurrences;
  }
  // If no recurring patterns, estimate from MTD pace
  if (recurringPatterns.length === 0 && mtdSpending > 0) {
    const dayOfMonth = now.getDate();
    const dailyRate = mtdSpending / dayOfMonth;
    forecast30d = dailyRate * 30;
  }

  // Spending Intelligence
  const subscriptionCategoryId = budgetCategories.find(c => c.name === 'Subscriptions' && c.entity_id === personalEntityId)?.id;
  const subscriptionTxns = allMtdTransactions.filter(t => t.user_category_id === subscriptionCategoryId && Number(t.amount) > 0);
  const subscriptionTotal = subscriptionTxns.reduce((sum, t) => sum + Number(t.amount), 0);

  // Budget vs actual by category (expenses only, personal)
  const overBudgetCategories = budgetCategories
    .filter(c => c.name !== 'Income' && c.name !== 'Credit Card Payments' && Number(c.monthly_budget_amount) > 0)
    .map(c => {
      const spent = allMtdTransactions
        .filter(t => t.user_category_id === c.id && Number(t.amount) > 0)
        .reduce((sum, t) => sum + Number(t.amount), 0);
      const budget = Number(c.monthly_budget_amount);
      const pct = budget > 0 ? Math.round((spent / budget) * 100) : 0;
      return { id: c.id, name: c.name, spent, budget, pct, over: spent > budget };
    })
    .filter(c => c.spent > 0)
    .sort((a, b) => b.pct - a.pct);

  const categoriesOverBudget = overBudgetCategories.filter(c => c.over);
  const categoriesNearBudget = overBudgetCategories.filter(c => !c.over && c.pct >= 70);

  // Spending pace: are we on track?
  const periodDays = Math.round((periodEnd.getTime() - periodStart.getTime()) / 86400000);
  const elapsedDays = Math.round((now.getTime() - periodStart.getTime()) / 86400000);
  const dayOfMonth = elapsedDays;
  const daysInMonth = periodDays;
  const monthPct = elapsedDays / periodDays;
  const projectedSpending = monthPct > 0 ? actualSpendingExCCPayments / monthPct : 0;
  const budgetPace = totalMonthlyBudget > 0 ? Math.round((projectedSpending / totalMonthlyBudget) * 100) : 0;

  // Emergency Fund check — essential personal expenses only
  const essentialCategories = ['Groceries', 'Housing', 'Utilities & Phone', 'Transportation', 'Insurance - Auto/Home', 'Medical & Health', 'Dining & Delivery', 'Kids & Family'];
  const essentialMonthly = budgetCategories
    .filter(c => essentialCategories.includes(c.name) && c.entity_id === personalEntityId)
    .reduce((sum, c) => sum + Number(c.monthly_budget_amount), 0);
  const emergencyTarget = essentialMonthly * 6;
  const citiSavings = accounts.find(a => a.name?.includes('Accelerate'));
  const emergencyBalance = Number(citiSavings?.current_balance || 0);
  const emergencyPct = emergencyTarget > 0 ? Math.round((emergencyBalance / emergencyTarget) * 100) : 0;

  // Tax reserve check
  const quarterlyTaxTarget = 17000;
  const taxPaymentCategoryIds = budgetCategories.filter(c => c.name === 'Tax Payments').map(c => c.id);
  const ytdTaxPayments = allMtdTransactions
    .filter(t => taxPaymentCategoryIds.includes(t.user_category_id ?? '') && Number(t.amount) > 0)
    .reduce((sum, t) => sum + Number(t.amount), 0);

  // Tithing tracker — running ledger approach
  const tithingRate = 0.10;
  const tithingTransactions = allMtdTransactions.filter(t => {
    const name = (t.merchant_name || '').toLowerCase();
    return name.includes('north point') || name.includes('community ch');
  });
  const actualTithing = tithingTransactions
    .filter(t => Number(t.amount) > 0)
    .reduce((sum, t) => sum + Number(t.amount), 0);

  // Match deposits against merchant_patterns from income_sources
  const matchIncomeSource = (merchantName: string) => {
    const merchant = (merchantName || '').toLowerCase();
    if (!merchant) return null;
    for (const s of incomeSources) {
      const raw = (s as any).merchant_patterns;
      if (!raw) continue; // skip sources without explicit merchant patterns
      const patterns = (typeof raw === 'string' ? raw : String(raw))
        .split(',').map((p: string) => p.trim().toLowerCase()).filter(Boolean);
      if (patterns.length > 0 && patterns.some((p: string) => merchant.includes(p))) return s;
    }
    return null;
  };

  // Income deposits: only transactions matching an income_source merchant pattern
  const incomeDeposits = allMtdTransactions
    .filter(t => Number(t.amount) < 0)
    .map(t => {
      const source = matchIncomeSource(t.merchant_name || '');
      if (!source) return null;
      return {
        amount: Math.abs(Number(t.amount)),
        titheOwed: Math.abs(Number(t.amount)) * tithingRate,
        date: t.date as string,
        source: source.name as string,
        entityId: t.entity_id as string,
      };
    })
    .filter((d): d is NonNullable<typeof d> => d !== null)
    .sort((a, b) => a.date.localeCompare(b.date));

  const totalIncomeReceived = incomeDeposits.reduce((sum, d) => sum + d.amount, 0);
  const expectedTithe = totalIncomeReceived * tithingRate;
  const tithingGap = Math.max(0, expectedTithe - actualTithing);
  const tithingIsCurrent = actualTithing >= expectedTithe;

  // Running ledger: apply tithe payments against deposits in chronological order
  // Only deposits whose 10% isn't covered show up as warnings
  let runningCredit = actualTithing;
  const uncoveredDeposits: typeof incomeDeposits = [];
  for (const deposit of incomeDeposits) {
    if (runningCredit >= deposit.titheOwed) {
      runningCredit -= deposit.titheOwed;
    } else {
      const uncoveredAmount = deposit.titheOwed - runningCredit;
      uncoveredDeposits.push({ ...deposit, titheOwed: uncoveredAmount });
      runningCredit = 0;
    }
  }

  // Entity-level: aggregate income and tithe payments per entity
  const entityIds = [
    { id: personalEntityId, name: 'Personal' },
    { id: vdEntityId, name: 'Veteran Digital' },
    { id: vcgEntityId, name: 'Veteran Capital Group' },
  ];
  const entityTithingData = entityIds.map(({ id, name }) => {
    const income = incomeDeposits
      .filter(d => d.entityId === id)
      .reduce((sum, d) => sum + d.amount, 0);
    const paid = tithingTransactions
      .filter(t => t.entity_id === id && Number(t.amount) > 0)
      .reduce((sum, t) => sum + Number(t.amount), 0);
    const owed = income * tithingRate;
    return { id, name, income, paid, owed, gap: Math.max(0, owed - paid), isCurrent: paid >= owed };
  }).filter(e => e.income > 0 || e.paid > 0);

  // Credit card payment alerts
  const ccAlerts = creditCards
    .filter(card => {
      const config = ccConfigs.find(c => c.account_id === card.id);
      if (!config?.statement_close_day) return false;
      const balance = Number(card.current_balance) || 0;
      if (balance <= 0) return false;
      const closeDay = config.statement_close_day;
      const thisMonth = new Date(now.getFullYear(), now.getMonth(), closeDay);
      const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, closeDay);
      const target = thisMonth > now ? thisMonth : nextMonth;
      const daysUntil = Math.round((target.getTime() - now.getTime()) / 86400000);
      return daysUntil <= 7;
    })
    .map(card => {
      const config = ccConfigs.find(c => c.account_id === card.id);
      const closeDay = config!.statement_close_day;
      const thisMonth = new Date(now.getFullYear(), now.getMonth(), closeDay);
      const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, closeDay);
      const target = thisMonth > now ? thisMonth : nextMonth;
      const daysUntil = Math.round((target.getTime() - now.getTime()) / 86400000);
      return { name: card.name, mask: card.mask, balance: Number(card.current_balance), daysUntil };
    });

  const hasAccounts = accounts.length > 0;

  // Latest sync timestamp across all institutions
  const latestSync = plaidItems
    .map((i) => i.last_successful_sync)
    .filter(Boolean)
    .sort()
    .pop();

  const accountTypeIcon: Record<string, typeof Landmark> = {
    depository: Landmark,
    credit: CreditCard,
    investment: TrendingUp,
    loan: AlertTriangle,
    other: CircleDot,
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Overview</h2>
          <p className="text-muted-foreground">
            Budget period: {periodLabel}
          </p>
        </div>
        {latestSync && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            Last synced {formatRelativeTime(latestSync)}
          </div>
        )}
      </div>

      <DailyBriefing />

      {/* Urgent Credit Card Alerts */}
      {ccAlerts.length > 0 && (
        <div className="rounded-lg border-2 border-red-400 bg-white p-4 space-y-2">
          <div className="flex items-center gap-2">
            <CreditCard className="h-5 w-5 text-red-600" />
            <p className="text-sm font-bold text-red-600">PAY NOW — Statement closing soon</p>
          </div>
          {ccAlerts.map((alert) => (
            <div key={alert.name} className="flex justify-between items-center text-sm">
              <span className="text-gray-900">{alert.name} ····{alert.mask}</span>
              <div className="text-right">
                <span className="font-bold text-red-600 tabular-nums">{formatCurrency(alert.balance)}</span>
                <span className="text-xs text-red-600 ml-2">{alert.daysUntil === 0 ? 'TODAY' : alert.daysUntil === 1 ? 'TOMORROW' : `${alert.daysUntil} days`}</span>
              </div>
            </div>
          ))}
          <p className="text-xs text-gray-600">
            Pay these balances in full to report $0 utilization on your statement.
          </p>
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Net Worth</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {hasAccounts ? formatCurrency(netWorth) : '--'}
            </div>
            <p className="text-xs text-muted-foreground">
              {hasAccounts
                ? `${formatCurrency(totalCash + totalInvestments)} assets — ${formatCurrency(totalCredit + totalLoans)} liabilities`
                : 'Connect accounts to see'}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Cash</CardTitle>
            <Wallet className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {hasAccounts ? formatCurrency(totalCash) : '--'}
            </div>
            <p className="text-xs text-muted-foreground">
              {hasAccounts
                ? `Across ${accounts.filter((a) => a.type === 'depository').length} account(s)`
                : 'Across all accounts'}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">MTD Income</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              {hasAccounts ? formatCurrency(mtdIncome) : '--'}
            </div>
            <p className="text-xs text-muted-foreground">
              {hasAccounts ? `Since ${monthStart}` : 'This month'}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">MTD Spending</CardTitle>
            <TrendingDown className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {hasAccounts ? formatCurrency(mtdSpending) : '--'}
            </div>
            <p className="text-xs text-muted-foreground">
              {hasAccounts ? `Since ${monthStart}` : 'This month'}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">30-Day Forecast</CardTitle>
            <CalendarClock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {hasAccounts ? formatCurrency(forecast30d) : '--'}
            </div>
            <p className="text-xs text-muted-foreground">
              {recurringPatterns.length > 0
                ? `Based on ${recurringPatterns.length} recurring pattern(s)`
                : hasAccounts
                ? 'Projected from MTD pace'
                : 'Estimated outflow'}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Investable Cash */}
      {hasAccounts && (
        <Card>
          <CardHeader>
            <CardTitle>Investable Cash</CardTitle>
            <CardDescription>
              How much is available to invest this month — planned vs actual
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              <div className="space-y-3">
                <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Monthly Waterfall</h4>
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span>Expected Income</span>
                    <span className="font-mono text-green-600">{formatCurrency(currentMonthlyIncome)}</span>
                  </div>
                  <div className="flex justify-between text-sm text-muted-foreground">
                    <span>Taxes (reserve)</span>
                    <span className="font-mono">-{formatCurrency(taxBudget)}</span>
                  </div>
                  <div className="flex justify-between text-sm text-muted-foreground">
                    <span>Tithing</span>
                    <span className="font-mono">-{formatCurrency(tithingBudget)}</span>
                  </div>
                  <div className="flex justify-between text-sm text-muted-foreground">
                    <span>Rental Property Costs</span>
                    <span className="font-mono">-{formatCurrency(rentalCostsBudget)}</span>
                  </div>
                  <div className="flex justify-between text-sm text-muted-foreground">
                    <span>Business Expenses (VD)</span>
                    <span className="font-mono">-{formatCurrency(vdExpensesBudget)}</span>
                  </div>
                  <div className="flex justify-between text-sm text-muted-foreground">
                    <span>Personal Living Expenses</span>
                    <span className="font-mono">-{formatCurrency(personalLivingBudget)}</span>
                  </div>
                  <Separator />
                  <div className="flex justify-between text-sm font-bold">
                    <span>Available to Invest/Save</span>
                    <span className={planInvestable >= 0 ? 'text-green-600 font-mono' : 'text-red-600 font-mono'}>
                      {formatCurrency(planInvestable)}
                    </span>
                  </div>
                </div>
              </div>
              <div className="space-y-3">
                <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Reality</h4>
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span>MTD Income</span>
                    <span className="font-mono text-green-600">{formatCurrency(actualIncome)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span>Actual Spending (ex. CC payments)</span>
                    <span className="font-mono text-red-600">-{formatCurrency(actualSpendingExCCPayments)}</span>
                  </div>
                  <Separator />
                  <div className="flex justify-between text-sm font-bold">
                    <span>Actually Available</span>
                    <span className={actualInvestable >= 0 ? 'text-green-600 font-mono' : 'text-red-600 font-mono'}>
                      {formatCurrency(actualInvestable)}
                    </span>
                  </div>
                </div>
              </div>
            </div>
            {actualInvestable > 5000 && (
              <div className="mt-4 rounded-lg border border-green-300 bg-white p-3">
                <p className="text-sm text-gray-900">
                  <strong>{formatCurrency(actualInvestable)}</strong> is sitting uninvested this month.
                  {' '}Consider: tax reserve (Q1 due Apr 15), Solo 401(k), or brokerage.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Tithing Tracker */}
      {hasAccounts && (
        <Card>
          <CardHeader>
            <CardTitle>Tithing — 10% Commitment</CardTitle>
            <CardDescription>
              {tithingIsCurrent
                ? 'You are current on your tithe this period.'
                : `You owe ${formatCurrency(tithingGap)} more to reach 10% of income received.`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {/* Overall progress */}
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium">Period Progress</span>
                <span className={`text-sm tabular-nums font-medium ${tithingIsCurrent ? 'text-green-700' : 'text-yellow-700'}`}>
                  Total paid: {formatCurrency(actualTithing)} of {formatCurrency(expectedTithe)} owed
                </span>
              </div>
              <div className="h-3 rounded-full bg-gray-100 overflow-hidden">
                <div
                  className={`h-full rounded-full ${tithingIsCurrent ? 'bg-green-500' : actualTithing / expectedTithe > 0.5 ? 'bg-yellow-500' : 'bg-red-500'}`}
                  style={{ width: `${Math.min(100, expectedTithe > 0 ? (actualTithing / expectedTithe) * 100 : 0)}%` }}
                />
              </div>

              {tithingIsCurrent ? (
                <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 p-3 text-green-800">
                  <span className="text-lg">&#10003;</span>
                  <span className="text-sm font-medium">You&apos;re current on tithing this period</span>
                </div>
              ) : (
                <div className="space-y-2">
                  {uncoveredDeposits.map((deposit, i) => (
                    <div key={i} className="flex items-start gap-2 rounded-lg border border-yellow-200 bg-yellow-50 p-3">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600" />
                      <p className="text-sm">
                        <strong className="text-yellow-800">Tithe {formatCurrency(deposit.titheOwed)}</strong>
                        <span className="text-yellow-700">
                          {' '}for {deposit.source} payment on{' '}
                          {new Date(deposit.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </span>
                      </p>
                    </div>
                  ))}
                  <div className="rounded-lg border border-yellow-300 bg-white p-3">
                    <p className="text-sm text-gray-900">
                      <strong className="text-yellow-600">Remaining gap: {formatCurrency(tithingGap)}</strong> — tithe this before your next deposit hits.
                    </p>
                  </div>
                </div>
              )}

              {/* By entity */}
              <Separator />
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">By Entity</p>
              <div className="space-y-2">
                {entityTithingData.map(entity => (
                  <div key={entity.id} className="flex justify-between items-center text-sm rounded-lg border p-3">
                    <div>
                      <span className="font-medium">{entity.name}</span>
                      <span className="ml-2 text-xs text-muted-foreground">Income: {formatCurrency(entity.income)}</span>
                    </div>
                    <div className="text-right">
                      <span className="font-bold tabular-nums">{formatCurrency(entity.paid)}</span>
                      <span className="text-xs text-muted-foreground ml-1">/ {formatCurrency(entity.owed)}</span>
                      {entity.isCurrent ? (
                        <p className="text-xs text-green-600">Current</p>
                      ) : (
                        <p className="text-xs text-yellow-600">Gap: {formatCurrency(entity.gap)}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Income Projection */}
      {hasAccounts && incomeSources.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Income Projection</CardTitle>
            <CardDescription>
              Expected monthly income: {formatCurrency(currentMonthlyIncome)} now → {formatCurrency(futureMonthlyIncome)} when all sources active
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Income breakdown by type */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground uppercase tracking-wider">W-2 Income</p>
                <p className="text-xl font-bold tabular-nums mt-1">{formatCurrency(w2Income)}</p>
                <p className="text-xs text-muted-foreground">Taxes withheld by employer</p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground uppercase tracking-wider">1099 Income</p>
                <p className="text-xl font-bold tabular-nums mt-1">{formatCurrency(income1099)}</p>
                <p className="text-xs text-red-600">You owe estimated taxes on this</p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground uppercase tracking-wider">Rental Income</p>
                <p className="text-xl font-bold tabular-nums mt-1">{formatCurrency(rentalIncome)}</p>
                <p className="text-xs text-muted-foreground">Passive — VCG portfolio</p>
              </div>
            </div>

            {/* Active sources */}
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Active Now</p>
              <div className="space-y-2">
                {activeIncome.map((source) => (
                  <div key={source.name} className="flex justify-between items-center text-sm rounded-lg border p-3">
                    <div>
                      <span className="font-medium">{source.name}</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {source.type === 'w2' ? 'W-2' : source.type === '1099' ? '1099' : 'Rental'}
                        {' · '}{entityMap.get(source.entity_id) || 'Unknown'}
                      </span>
                    </div>
                    <span className="font-bold tabular-nums">{formatCurrency(Number(source.estimated_monthly))}/mo</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Upcoming sources */}
            {upcomingIncome.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-green-600 uppercase tracking-wider mb-2">Starting Soon</p>
                <div className="space-y-2">
                  {upcomingIncome.map((source) => {
                    const startDate = new Date(source.start_date!);
                    const daysUntil = Math.round((startDate.getTime() - now.getTime()) / 86400000);
                    return (
                      <div key={source.name} className="flex justify-between items-center text-sm rounded-lg border border-green-200 bg-white p-3">
                        <div>
                          <span className="font-medium">{source.name}</span>
                          <span className="ml-2 text-xs text-green-600">
                            Starts {startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ({daysUntil} days)
                          </span>
                        </div>
                        <span className="font-bold tabular-nums text-green-700">+{formatCurrency(Number(source.estimated_monthly))}/mo</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Ending sources warning */}
            {endingIncome.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-red-600 uppercase tracking-wider mb-2">Ending Soon</p>
                <div className="space-y-2">
                  {endingIncome.map((source) => {
                    const endDate = new Date(source.end_date!);
                    const daysUntil = Math.round((endDate.getTime() - now.getTime()) / 86400000);
                    return (
                      <div key={source.name} className="flex justify-between items-center text-sm rounded-lg border border-red-200 bg-white p-3">
                        <div>
                          <span className="font-medium">{source.name}</span>
                          <span className="ml-2 text-xs text-red-600">
                            Ends {endDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ({daysUntil} days)
                          </span>
                        </div>
                        <span className="font-bold tabular-nums text-red-600">-{formatCurrency(Number(source.estimated_monthly))}/mo</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Tax warning for 1099 income */}
            {income1099 > 10000 && (
              <div className="rounded-lg border border-red-300 bg-white p-3">
                <p className="text-sm text-gray-900">
                  <strong className="text-red-600">Tax Alert:</strong> {formatCurrency(income1099)}/mo in 1099 income requires quarterly estimated payments of approximately <strong>{formatCurrency(income1099 * 0.35)}/quarter</strong>. 
                  {' '}Without S-Corp election, you also owe ~{formatCurrency(income1099 * 0.153)}/mo in SE tax.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Savings Deployment */}
      {savingsBuckets.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Savings Deployment</CardTitle>
            <CardDescription>
              Three buckets — fund in priority order, top to bottom
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {savingsBuckets.map((bucket, index) => {
                const linkedAccount = accounts.find(a => a.id === bucket.account_id);
                const currentBalance = linkedAccount ? Number(linkedAccount.current_balance) || 0 : 0;
                const target = Number(bucket.target_amount);
                const pct = target > 0 ? Math.min(Math.round((currentBalance / target) * 100), 100) : 0;
                const gap = target - currentBalance;
                const isNotOpened = bucket.status === 'not_opened';
                const isFunded = pct >= 100;

                return (
                  <div key={bucket.id} className={`rounded-lg border p-4 ${isNotOpened ? 'border-red-300' : isFunded ? 'border-green-300' : 'border-yellow-300'}`}>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">{index + 1}</span>
                        <p className="text-sm font-semibold">{bucket.name}</p>
                        {isNotOpened && <Badge variant="danger">Not Opened</Badge>}
                        {!isNotOpened && isFunded && <Badge variant="success">Funded</Badge>}
                        {!isNotOpened && !isFunded && <Badge variant="warning">{pct}%</Badge>}
                      </div>
                      <div className="text-right">
                        <p className="text-lg font-bold tabular-nums">
                          {isNotOpened ? '$0.00' : formatCurrency(currentBalance)}
                        </p>
                        <p className="text-xs text-muted-foreground">of {formatCurrency(target)} target</p>
                      </div>
                    </div>

                    {/* Progress bar */}
                    {!isNotOpened && (
                      <div className="h-2.5 rounded-full bg-gray-100 overflow-hidden mb-2">
                        <div
                          className={`h-full rounded-full ${isFunded ? 'bg-green-500' : pct > 50 ? 'bg-yellow-500' : 'bg-red-500'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    )}

                    {/* Notes */}
                    <p className="text-xs text-muted-foreground">{bucket.notes}</p>

                    {/* Gap callout */}
                    {isNotOpened && (
                      <p className="mt-2 text-xs font-medium text-red-600">
                        ACTION: Open this account and fund with {formatCurrency(target)}
                      </p>
                    )}
                    {!isNotOpened && !isFunded && gap > 0 && (
                      <p className="mt-2 text-xs font-medium text-yellow-600">
                        Gap: {formatCurrency(gap)} — fund from VD checking ({formatCurrency(Number(accounts.find(a => a.mask === '7092')?.current_balance || 0))} available)
                      </p>
                    )}
                  </div>
                );
              })}

              <Separator />

              {/* Redeployment plan */}
              <div className="rounded-lg border bg-white p-4">
                <p className="text-sm font-semibold mb-2">VD Checking Redeployment Plan</p>
                <div className="space-y-1">
                  <div className="flex justify-between text-sm">
                    <span>Current VD Checking Balance</span>
                    <span className="font-mono">{formatCurrency(Number(accounts.find(a => a.mask === '7092')?.current_balance || 0))}</span>
                  </div>
                  <div className="flex justify-between text-sm text-muted-foreground">
                    <span>→ Tax Reserve HYSA</span>
                    <span className="font-mono">-{formatCurrency(35000)}</span>
                  </div>
                  <div className="flex justify-between text-sm text-muted-foreground">
                    <span>→ Top up Emergency Fund</span>
                    <span className="font-mono">-{formatCurrency(Math.max(0, 54000 - (Number(accounts.find(a => a.mask === '9300')?.current_balance || 0))))}</span>
                  </div>
                  <div className="flex justify-between text-sm text-muted-foreground">
                    <span>→ Seed Opportunity Fund</span>
                    <span className="font-mono">-{formatCurrency(30000)}</span>
                  </div>
                  <Separator />
                  <div className="flex justify-between text-sm font-bold">
                    <span>Remaining as Operating Cash</span>
                    <span className="font-mono">{formatCurrency(Number(accounts.find(a => a.mask === '7092')?.current_balance || 0) - 35000 - Math.max(0, 54000 - (Number(accounts.find(a => a.mask === '9300')?.current_balance || 0))) - 30000)}</span>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Spending Intelligence */}
      {hasAccounts && (
        <Card>
          <CardHeader>
            <CardTitle>Spending Intelligence</CardTitle>
            <CardDescription>Auto-detected insights from your transaction data</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Spending pace */}
            <div className="rounded-lg border p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">Monthly Spending Pace</p>
                  <p className="text-xs text-muted-foreground">
                    {Math.round(monthPct * 100)}% through the month
                  </p>
                </div>
                <div className="text-right">
                  <p className={`text-lg font-bold tabular-nums ${budgetPace > 100 ? 'text-red-600' : 'text-green-600'}`}>
                    {budgetPace}%
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Projected: {formatCurrency(projectedSpending)}
                  </p>
                </div>
              </div>
              {budgetPace > 110 && (
                <p className="mt-2 text-xs text-red-600">
                  At this pace you will exceed your {formatCurrency(totalMonthlyBudget)} monthly budget by {formatCurrency(projectedSpending - totalMonthlyBudget)}.
                </p>
              )}
            </div>

            {/* Over budget alerts */}
            {categoriesOverBudget.length > 0 && (
              <div className="rounded-lg border border-red-300 bg-white p-4">
                <div className="flex items-center gap-2 mb-2">
                  <AlertTriangle className="h-4 w-4 text-red-600" />
                  <p className="text-sm font-semibold text-red-600">Over Budget ({categoriesOverBudget.length})</p>
                </div>
                <div className="space-y-1">
                  {categoriesOverBudget.map(c => (
                    <div key={c.name} className="flex justify-between text-sm">
                      <Link href={`/transactions?category=${c.id}`} className="text-gray-900 underline hover:text-red-600">{c.name}</Link>
                      <span className="font-mono text-red-600">
                        {formatCurrency(c.spent)} / {formatCurrency(c.budget)} ({c.pct}%)
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Near budget warnings */}
            {categoriesNearBudget.length > 0 && (
              <div className="rounded-lg border border-yellow-300 bg-white p-4">
                <p className="text-sm font-semibold text-yellow-600 mb-2">Approaching Budget ({categoriesNearBudget.length})</p>
                <div className="space-y-1">
                  {categoriesNearBudget.map(c => (
                    <div key={c.name} className="flex justify-between text-sm">
                      <Link href={`/transactions?category=${c.id}`} className="text-gray-900 underline hover:text-yellow-600">{c.name}</Link>
                      <span className="font-mono text-yellow-600">
                        {formatCurrency(c.spent)} / {formatCurrency(c.budget)} ({c.pct}%)
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Subscription audit */}
            <div className="rounded-lg border p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">Subscription Spend (MTD)</p>
                  <p className="text-xs text-muted-foreground">{subscriptionTxns.length} recurring charges detected</p>
                </div>
                <p className="text-lg font-bold tabular-nums">{formatCurrency(subscriptionTotal)}</p>
              </div>
              {subscriptionTotal > 400 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  That is {formatCurrency(subscriptionTotal * 12)}/year in subscriptions. Consider auditing for unused services.
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Investment Waterfall */}
      {hasAccounts && (
        <Card>
          <CardHeader>
            <CardTitle>Where Should Your Next Dollar Go?</CardTitle>
            <CardDescription>
              Prioritized investment waterfall — work top to bottom
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {/* Step 1: Emergency Fund */}
              <div className={`rounded-lg border p-4 ${emergencyPct >= 100 ? 'border-green-300 bg-white' : 'border-red-300 bg-white'}`}>
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">1</span>
                      <p className="text-sm font-semibold">Emergency Fund</p>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">Target: 6 months expenses ({formatCurrency(emergencyTarget)})</p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-bold tabular-nums">{formatCurrency(emergencyBalance)}</p>
                    <p className="text-xs text-muted-foreground">{emergencyPct}% funded</p>
                  </div>
                </div>
                {emergencyPct < 100 && (
                  <p className="mt-2 text-xs font-medium text-red-600">
                    Gap: {formatCurrency(emergencyTarget - emergencyBalance)} — fund this before investing elsewhere
                  </p>
                )}
              </div>

              {/* Step 2: Tax Reserves */}
              <div className="rounded-lg border border-red-300 bg-white p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-red-600 text-white text-xs font-bold">2</span>
                      <p className="text-sm font-semibold">Q1 Tax Reserve</p>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">Estimated quarterly payment due April 15</p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-bold tabular-nums text-red-600">{formatCurrency(quarterlyTaxTarget)}</p>
                    <p className="text-xs text-red-600 font-medium">27 days left</p>
                  </div>
                </div>
                <p className="mt-2 text-xs font-medium text-red-600">
                  ACTION REQUIRED: Open HYSA and set aside {formatCurrency(quarterlyTaxTarget)} before April 15.
                  Underpayment penalties are automatic.
                </p>
              </div>

              {/* Step 3: S-Corp Election */}
              <div className="rounded-lg border border-yellow-300 bg-white p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-yellow-500 text-white text-xs font-bold">3</span>
                      <p className="text-sm font-semibold">S-Corp Election</p>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">Estimated annual savings: $35K–$87K in SE tax</p>
                  </div>
                  <div className="text-right">
                    <Badge variant="warning">Not Filed</Badge>
                  </div>
                </div>
                <p className="mt-2 text-xs text-yellow-600">
                  Requires CPA engagement. This is the single highest-ROI financial move available to you right now.
                </p>
              </div>

              {/* Step 4: Solo 401(k) */}
              <div className="rounded-lg border p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">4</span>
                      <p className="text-sm font-semibold">Solo 401(k)</p>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">Max $69,000/year (2025). Requires S-Corp first.</p>
                  </div>
                  <div className="text-right">
                    <Badge variant="secondary">Not Set Up</Badge>
                  </div>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Once S-Corp is elected, open a Solo 401(k) at Fidelity or Schwab. Employee + employer contributions up to $69K/year tax-deferred.
                </p>
              </div>

              {/* Step 5: Backdoor Roth IRA */}
              <div className="rounded-lg border p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">5</span>
                      <p className="text-sm font-semibold">Backdoor Roth IRA</p>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">$7,000/year per person ($14,000 for you + wife)</p>
                  </div>
                  <div className="text-right">
                    <Badge variant="secondary">Unknown</Badge>
                  </div>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Your income exceeds direct Roth IRA limits. Use the backdoor method: contribute to Traditional IRA, then convert. Consult CPA first.
                </p>
              </div>

              {/* Step 6: Taxable Brokerage */}
              <div className="rounded-lg border p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">6</span>
                      <p className="text-sm font-semibold">Taxable Brokerage</p>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">No limits. Index funds (VTI/VXUS) for long-term growth.</p>
                  </div>
                  <div className="text-right">
                    <Badge variant="secondary">Not Set Up</Badge>
                  </div>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  After maxing tax-advantaged accounts, invest excess here. Low-cost index funds. This is where your idle {formatCurrency(totalCash)} starts working for you.
                </p>
              </div>

              {/* Step 7: Business Acquisition Fund */}
              <div className="rounded-lg border p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">7</span>
                      <p className="text-sm font-semibold">Business Acquisition Fund</p>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">Laundromats, self-storage, car washes via Kingdom Laundromats LLC</p>
                  </div>
                  <div className="text-right">
                    <Badge variant="secondary">Sourcing</Badge>
                  </div>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Keep a dedicated acquisition fund. Target: $50K–$100K liquid for down payments. VCI is actively sourcing deals.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Upcoming Planned Expenses */}
      {hasAccounts && (
        <Card>
          <CardHeader>
            <CardTitle>Upcoming Expenses</CardTitle>
            <CardDescription>
              Known upcoming expenses — {plannedExpenses.length} pending, totaling {formatCurrency(totalPlanned)}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {plannedExpenses.length === 0 ? (
              <p className="text-sm text-muted-foreground">No upcoming expenses planned. Add them in the database to track here.</p>
            ) : (
              <div className="space-y-3">
                {plannedExpenses.map((expense) => {
                  const daysUntil = Math.round((new Date(expense.expected_date).getTime() - now.getTime()) / 86400000);
                  const isUrgent = daysUntil <= 14;
                  const isPast = daysUntil < 0;
                  return (
                    <div key={expense.id} className={`flex flex-col gap-2 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between ${isPast ? 'border-red-300' : isUrgent ? 'border-yellow-300' : ''}`}>
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium">{expense.name}</p>
                          {isPast && <Badge variant="danger">Overdue</Badge>}
                          {!isPast && isUrgent && <Badge variant="warning">{daysUntil} days</Badge>}
                          {!isPast && !isUrgent && <Badge variant="secondary">{daysUntil} days</Badge>}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Due: {new Date(expense.expected_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                          {expense.notes ? ` — ${expense.notes}` : ''}
                        </p>
                      </div>
                      <p className={`text-lg font-bold tabular-nums ${isPast ? 'text-red-600' : ''}`}>
                        {formatCurrency(Number(expense.amount))}
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Credit Card Intelligence */}
      {creditCards.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Credit Cards</CardTitle>
            <CardDescription>
              Pay in full before statement close for 0% utilization
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-6">
              {Array.from(ccByEntity.entries()).map(([entityName, cards]) => (
                <div key={entityName}>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">{entityName}</p>
                  <div className="space-y-3">
              {cards.map((card) => {
                const config = ccConfigMap.get(card.id);
                const balance = Number(card.current_balance) || 0;
                const limit = config ? Number(config.credit_limit) : (balance + (Number(card.available_balance) || 0));
                const utilization = limit > 0 ? Math.round((balance / limit) * 100) : 0;
                const closeDay = config?.statement_close_day;
                const dueDay = config?.payment_due_day;

                // Calculate days until statement close
                let daysUntilClose = null;
                if (closeDay) {
                  const thisMonth = new Date(now.getFullYear(), now.getMonth(), closeDay);
                  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, closeDay);
                  const target = thisMonth > now ? thisMonth : nextMonth;
                  daysUntilClose = Math.round((target.getTime() - now.getTime()) / 86400000);
                }

                const isUrgent = daysUntilClose !== null && daysUntilClose <= 5 && balance > 0;
                const isWarning = daysUntilClose !== null && daysUntilClose <= 10 && balance > 0;

                return (
                  <div key={card.id} className={`rounded-lg border p-4 ${isUrgent ? 'border-red-300' : isWarning ? 'border-yellow-300' : ''}`}>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <CreditCard className="h-4 w-4 text-muted-foreground" />
                          <p className="text-sm font-medium">{card.name}</p>
                          <span className="text-xs text-muted-foreground">{maskAccount(card.mask, '')}</span>
                        </div>
                        <div className="flex items-center gap-3 text-xs text-muted-foreground">
                          <span>Limit: {formatCurrency(limit)}</span>
                          <span>Utilization: {utilization}%</span>
                        </div>
                        {closeDay && (
                          <div className="flex items-center gap-3 text-xs">
                            <span className="text-muted-foreground">Statement closes: {closeDay}th</span>
                            {dueDay && <span className="text-muted-foreground">Due: {dueDay}th</span>}
                            {daysUntilClose !== null && balance > 0 && (
                              <span className={isUrgent ? 'text-red-600 font-semibold' : isWarning ? 'text-yellow-600 font-semibold' : 'text-muted-foreground'}>
                                {daysUntilClose} days to close
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="text-right">
                        <p className={`text-lg font-bold tabular-nums ${balance > 0 ? 'text-red-600' : 'text-green-600'}`}>
                          {formatCurrency(balance)}
                        </p>
                        {balance > 0 && isUrgent && (
                          <p className="text-xs text-red-600 font-medium">Pay now!</p>
                        )}
                        {balance > 0 && isWarning && !isUrgent && (
                          <p className="text-xs text-yellow-600 font-medium">Pay soon</p>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              </div>
                </div>
              ))}
              <Separator />
              <div className="flex justify-between items-center pt-1">
                <span className="text-sm font-medium">Total Balance</span>
                <span className="text-lg font-bold tabular-nums text-red-600">{formatCurrency(totalCreditBalance)}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Net Worth Trend & Cash Flow Forecast */}
      {hasAccounts && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Net Worth Trend</CardTitle>
              <CardDescription>
                Daily snapshots over the last 90 days.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <NetWorthChart />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Cash Flow Forecast</CardTitle>
              <CardDescription>
                Projected net cash flow based on recurring patterns.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CashFlowForecast
                recurringPatterns={recurringPatterns.map((p) => ({
                  estimated_amount: Number(p.estimated_amount),
                  frequency: p.frequency,
                  next_expected_date: p.next_expected_date,
                }))}
                mtdSpending={mtdSpending}
                mtdIncome={mtdIncome}
                dayOfMonth={now.getDate()}
              />
            </CardContent>
          </Card>
        </div>
      )}

      {/* Connect Bank Account */}
      <Card>
        <CardHeader>
          <CardTitle>Connect Bank Account</CardTitle>
          <CardDescription>
            Link your bank, credit card, or investment account via Plaid.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PlaidLink entities={entities} />
        </CardContent>
      </Card>

      {/* Connected Institutions */}
      <Card>
        <CardHeader>
          <CardTitle>Connected Institutions</CardTitle>
          <CardDescription>
            {plaidItems.length === 0
              ? 'No accounts connected yet.'
              : `${plaidItems.length} institution(s) linked`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {plaidItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Use the form above to connect your bank accounts.
            </p>
          ) : (
            <div className="space-y-4">
              {plaidItems.map((item) => (
                <div key={item.id} className="flex flex-col gap-2 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium leading-none">
                        {item.institution_name ?? 'Unknown Institution'}
                      </p>
                      <ConnectionBadge status={item.status} />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Last synced:{' '}
                      {item.last_successful_sync
                        ? formatRelativeTime(item.last_successful_sync)
                        : 'Never'}
                    </p>
                    {item.last_error_code && (
                      <p className="text-xs text-destructive">
                        Error: {item.last_error_code} (retries: {item.error_count})
                      </p>
                    )}
                  </div>
                </div>
              ))}

              <Separator />

              {/* Accounts under institutions */}
              <div>
                <h4 className="mb-3 text-sm font-medium">Accounts</h4>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {accounts.map((acct) => {
                    const Icon = accountTypeIcon[acct.type] ?? CircleDot;
                    return (
                      <div key={acct.id} className="flex items-center gap-3 rounded-lg border p-3">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted">
                          <Icon className="h-4 w-4 text-muted-foreground" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium leading-none truncate">{acct.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {acct.type}{acct.subtype ? ` · ${acct.subtype}` : ''}{' '}
                            {maskAccount(acct.mask, '')}
                          </p>
                        </div>
                        <p className="text-sm font-semibold tabular-nums whitespace-nowrap">
                          {acct.current_balance != null
                            ? formatCurrency(Number(acct.current_balance))
                            : '--'}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Entities */}
      {entities.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Entities</CardTitle>
            <CardDescription>Business and personal entities.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {entities.map((entity) => (
                <div key={entity.id} className="rounded-lg border p-4">
                  <p className="font-medium">{entity.name}</p>
                  <Badge variant="secondary" className="mt-1">
                    {entity.type}
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ConnectionBadge({ status }: { status: string }) {
  const config: Record<string, { variant: 'success' | 'warning' | 'danger' | 'secondary'; label: string }> = {
    connected: { variant: 'success', label: 'Connected' },
    degraded: { variant: 'warning', label: 'Degraded' },
    disconnected: { variant: 'danger', label: 'Disconnected' },
    reauth_required: { variant: 'warning', label: 'Reauth Required' },
  };

  const { variant, label } = config[status] ?? { variant: 'secondary' as const, label: status };

  return <Badge variant={variant}>{label}</Badge>;
}
