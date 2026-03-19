export const dynamic = "force-dynamic";

import { createServerSupabaseClient } from '@/lib/supabase/server';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { formatCurrency, formatRelativeTime } from '@/lib/format';
import { BudgetRow } from '@/components/budget-row';
import { PieChart, AlertTriangle, CheckCircle2, Clock } from 'lucide-react';

export default async function BudgetPage() {
  const supabase = createServerSupabaseClient();

  const now = new Date();
  const day = now.getDate();
  const periodStart = day >= 15
    ? new Date(now.getFullYear(), now.getMonth(), 15)
    : new Date(now.getFullYear(), now.getMonth() - 1, 15);
  const periodEnd = day >= 15
    ? new Date(now.getFullYear(), now.getMonth() + 1, 14)
    : new Date(now.getFullYear(), now.getMonth(), 14);
  const monthStart = periodStart.toISOString().split('T')[0];
  const today = now.toISOString().split('T')[0];
  const periodDays = Math.round((periodEnd.getTime() - periodStart.getTime()) / 86400000);
  const elapsedDays = Math.round((now.getTime() - periodStart.getTime()) / 86400000);
  const daysInMonth = periodDays;
  const dayOfMonth = elapsedDays;
  const monthProgress = Math.round((elapsedDays / periodDays) * 100);
  const periodLabel = `${periodStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${periodEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

  // Fetch categories, transactions, sync status, and entities in parallel
  const [categoriesRes, transactionsRes, plaidItemsRes, entitiesRes] = await Promise.all([
    supabase
      .from('budget_categories')
      .select('id, name, entity_id, monthly_budget_amount, is_active, rationale')
      .eq('is_active', true)
      .order('name'),
    supabase
      .from('transactions')
      .select('amount, user_category_id, plaid_category')
      .is('deleted_at', null)
      .gte('date', monthStart)
      .lte('date', today),
    supabase
      .from('plaid_items')
      .select('last_successful_sync')
      .order('last_successful_sync', { ascending: false })
      .limit(1),
    supabase
      .from('entities')
      .select('id, name')
      .eq('is_active', true),
  ]);

  const categories = categoriesRes.data ?? [];
  const transactions = transactionsRes.data ?? [];
  const lastSync = plaidItemsRes.data?.[0]?.last_successful_sync;
  const entities = entitiesRes.data ?? [];
  const entityMap = new Map(entities.map(e => [e.id, e.name]));

  // Filter out non-spending categories
  const hiddenCategories = ['Income', 'Credit Card Payments', 'Insurance - IUL'];
  const visibleCategories = categories.filter(c => !hiddenCategories.includes(c.name));

  // Build spending by category
  const spendingByCategory = new Map<string, number>();
  let uncategorizedSpending = 0;

  for (const tx of transactions) {
    const amount = Number(tx.amount);
    if (amount <= 0) continue; // skip income

    if (tx.user_category_id) {
      spendingByCategory.set(
        tx.user_category_id,
        (spendingByCategory.get(tx.user_category_id) || 0) + amount
      );
    } else {
      uncategorizedSpending += amount;
    }
  }

  // Enrich categories with actual spending
  const budgetRows = visibleCategories.map((cat) => {
    const spent = spendingByCategory.get(cat.id) || 0;
    const budget = Number(cat.monthly_budget_amount) || 0;
    const pct = budget > 0 ? Math.min(Math.round((spent / budget) * 100), 100) : 0;
    const remaining = budget - spent;
    const overBudget = spent > budget && budget > 0;
    const entityName = entityMap.get(cat.entity_id) || 'Unknown';
    return { ...cat, spent, budget, pct, remaining, overBudget, entityName };
  });

  // Group by entity
  const budgetByEntity = new Map<string, typeof budgetRows>();
  for (const row of budgetRows) {
    const existing = budgetByEntity.get(row.entityName) || [];
    existing.push(row);
    budgetByEntity.set(row.entityName, existing);
  }

  const totalBudget = budgetRows.reduce((sum, r) => sum + r.budget, 0);
  const totalCategories = visibleCategories.length;
  const totalSpent = budgetRows.reduce((sum, r) => sum + r.spent, 0) + uncategorizedSpending;
  const totalRemaining = totalBudget - totalSpent;

  const monthName = periodLabel;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Budget</h2>
          <p className="text-muted-foreground">{monthName} — Day {dayOfMonth} of {daysInMonth}</p>
        </div>
        {lastSync && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            Last synced {formatRelativeTime(lastSync)}
          </div>
        )}
      </div>

      {/* Month summary cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Budget</CardTitle>
            <PieChart className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(totalBudget)}</div>
            <p className="text-xs text-muted-foreground">
              {totalCategories} active categories
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Spent So Far</CardTitle>
            {totalSpent > totalBudget ? (
              <AlertTriangle className="h-4 w-4 text-destructive" />
            ) : (
              <CheckCircle2 className="h-4 w-4 text-green-600" />
            )}
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${totalSpent > totalBudget ? 'text-destructive' : ''}`}>
              {formatCurrency(totalSpent)}
            </div>
            <p className="text-xs text-muted-foreground">
              {monthProgress}% through the month
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Remaining</CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${totalRemaining < 0 ? 'text-destructive' : 'text-green-600'}`}>
              {formatCurrency(Math.abs(totalRemaining))}
            </div>
            <p className="text-xs text-muted-foreground">
              {totalRemaining < 0 ? 'Over budget' : 'Left to spend'}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Month progress */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Month Progress</CardTitle>
        </CardHeader>
        <CardContent>
          <Progress value={monthProgress} className="h-2" />
          <p className="mt-2 text-xs text-muted-foreground">
            {dayOfMonth} of {daysInMonth} days elapsed ({monthProgress}%)
          </p>
        </CardContent>
      </Card>

      {/* Budget vs Actual */}
      {categories.length === 0 ? (
        <Card>
          <CardContent className="py-8">
            <p className="text-center text-sm text-muted-foreground">
              No budget categories configured. Run the seed SQL to create default categories.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {Array.from(budgetByEntity.entries()).map(([entityName, rows]) => (
            <Card key={entityName}>
              <CardHeader>
                <CardTitle>{entityName}</CardTitle>
                <CardDescription>Budget vs actual for {entityName}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-6">
                  {rows.map((row) => (
                    <BudgetRow
                      key={row.id}
                      id={row.id}
                      name={row.name}
                      spent={row.spent}
                      budget={row.budget}
                      pct={row.pct}
                      remaining={row.remaining}
                      overBudget={row.overBudget}
                      rationale={row.rationale}
                    />
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}

          {/* Uncategorized spending */}
          {uncategorizedSpending > 0 && (
            <Card>
              <CardContent className="py-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-muted-foreground">Uncategorized</span>
                    <Badge variant="secondary" className="text-[10px]">Unassigned</Badge>
                  </div>
                  <span className="text-sm font-semibold tabular-nums">
                    {formatCurrency(uncategorizedSpending)}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Assign categories to transactions for better tracking.
                </p>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
