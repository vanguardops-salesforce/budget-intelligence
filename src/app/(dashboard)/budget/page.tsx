import { createServerSupabaseClient } from '@/lib/supabase/server';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { formatCurrency } from '@/lib/format';
import { PieChart, AlertTriangle, CheckCircle2 } from 'lucide-react';

export default async function BudgetPage() {
  const supabase = createServerSupabaseClient();

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  const today = now.toISOString().split('T')[0];
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dayOfMonth = now.getDate();
  const monthProgress = Math.round((dayOfMonth / daysInMonth) * 100);

  // Fetch categories and transactions in parallel
  const [categoriesRes, transactionsRes] = await Promise.all([
    supabase
      .from('budget_categories')
      .select('id, name, entity_id, monthly_budget_amount, is_active')
      .eq('is_active', true)
      .order('name'),
    supabase
      .from('transactions')
      .select('amount, user_category_id, plaid_category')
      .is('deleted_at', null)
      .gte('date', monthStart)
      .lte('date', today),
  ]);

  const categories = categoriesRes.data ?? [];
  const transactions = transactionsRes.data ?? [];

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
  const budgetRows = categories.map((cat) => {
    const spent = spendingByCategory.get(cat.id) || 0;
    const budget = Number(cat.monthly_budget_amount) || 0;
    const pct = budget > 0 ? Math.min(Math.round((spent / budget) * 100), 100) : 0;
    const remaining = budget - spent;
    const overBudget = spent > budget && budget > 0;
    return { ...cat, spent, budget, pct, remaining, overBudget };
  });

  const totalBudget = budgetRows.reduce((sum, r) => sum + r.budget, 0);
  const totalSpent = budgetRows.reduce((sum, r) => sum + r.spent, 0) + uncategorizedSpending;
  const totalRemaining = totalBudget - totalSpent;

  const monthName = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Budget</h2>
        <p className="text-muted-foreground">{monthName} — Day {dayOfMonth} of {daysInMonth}</p>
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
              {categories.length} active categories
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
        <Card>
          <CardHeader>
            <CardTitle>Budget vs Actual</CardTitle>
            <CardDescription>Monthly budget tracking by category</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-6">
              {budgetRows.map((row) => (
                <div key={row.id} className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{row.name}</span>
                      {row.overBudget && (
                        <Badge variant="danger" className="text-[10px]">Over</Badge>
                      )}
                    </div>
                    <div className="text-right">
                      <span className="text-sm font-semibold tabular-nums">
                        {formatCurrency(row.spent)}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {' / '}{row.budget > 0 ? formatCurrency(row.budget) : 'No budget'}
                      </span>
                    </div>
                  </div>
                  <Progress
                    value={row.pct}
                    className="h-2.5"
                    indicatorClassName={
                      row.overBudget
                        ? 'bg-destructive'
                        : row.pct > 80
                        ? 'bg-yellow-500'
                        : 'bg-green-500'
                    }
                  />
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>{row.pct}% used</span>
                    <span>
                      {row.remaining >= 0
                        ? `${formatCurrency(row.remaining)} remaining`
                        : `${formatCurrency(Math.abs(row.remaining))} over`}
                    </span>
                  </div>
                </div>
              ))}

              {/* Uncategorized spending */}
              {uncategorizedSpending > 0 && (
                <>
                  <div className="border-t pt-4">
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
                  </div>
                </>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
