export const dynamic = "force-dynamic";

import { createServerSupabaseClient } from '@/lib/supabase/server';
import { formatCurrency } from '@/lib/format';

export default async function QuickCheckPage() {
  const supabase = createServerSupabaseClient();

  const now = new Date();
  const day = now.getDate();
  const periodStart = day >= 15
    ? new Date(now.getFullYear(), now.getMonth(), 15)
    : new Date(now.getFullYear(), now.getMonth() - 1, 15);
  const periodEnd = day >= 15
    ? new Date(now.getFullYear(), now.getMonth() + 1, 14)
    : new Date(now.getFullYear(), now.getMonth(), 14);
  const startDate = periodStart.toISOString().split('T')[0];
  const today = now.toISOString().split('T')[0];
  const periodDays = Math.round((periodEnd.getTime() - periodStart.getTime()) / 86400000);
  const elapsedDays = Math.round((now.getTime() - periodStart.getTime()) / 86400000);
  const pctThrough = Math.round((elapsedDays / periodDays) * 100);

  const [categoriesRes, txRes] = await Promise.all([
    supabase
      .from('budget_categories')
      .select('id, name, entity_id, monthly_budget_amount')
      .eq('is_active', true)
      .gt('monthly_budget_amount', 0),
    supabase
      .from('transactions')
      .select('amount, user_category_id')
      .is('deleted_at', null)
      .gte('date', startDate)
      .lte('date', today)
      .gt('amount', 0),
  ]);

  const categories = categoriesRes.data ?? [];
  const transactions = txRes.data ?? [];

  // Get personal entity
  const { data: entities } = await supabase
    .from('entities')
    .select('id, name, type')
    .eq('is_active', true);
  const personalEntityId = entities?.find(e => e.type === 'personal')?.id;

  // Build spending by category
  const spendingMap = new Map<string, number>();
  for (const tx of transactions) {
    if (tx.user_category_id) {
      spendingMap.set(
        tx.user_category_id,
        (spendingMap.get(tx.user_category_id) || 0) + Number(tx.amount)
      );
    }
  }

  // Filter to personal spending categories only
  const spendingCategories = ['Groceries', 'Dining & Delivery', 'Shopping & Household', 'Entertainment',
    'Kids & Family', 'Personal Care', 'Car Expenses', 'Medical & Health', 'Subscriptions',
    'Travel & Vacation', 'Utilities & Phone', 'Housing', 'Miscellaneous'];

  const rows = categories
    .filter(c => c.entity_id === personalEntityId && spendingCategories.includes(c.name))
    .map(c => {
      const spent = spendingMap.get(c.id) || 0;
      const budget = Number(c.monthly_budget_amount);
      const remaining = budget - spent;
      const pct = budget > 0 ? Math.round((spent / budget) * 100) : 0;
      return { name: c.name, spent, budget, remaining, pct };
    })
    .sort((a, b) => {
      // Over budget first, then by % used descending
      if (a.remaining < 0 && b.remaining >= 0) return -1;
      if (b.remaining < 0 && a.remaining >= 0) return 1;
      return b.pct - a.pct;
    });

  const totalBudget = rows.reduce((sum, r) => sum + r.budget, 0);
  const totalSpent = rows.reduce((sum, r) => sum + r.spent, 0);
  const totalRemaining = totalBudget - totalSpent;

  return (
    <div className="min-h-screen bg-background p-4 max-w-lg mx-auto">
      <div className="mb-4">
        <h1 className="text-xl font-bold">Quick Budget Check</h1>
        <p className="text-xs text-muted-foreground">
          {periodStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – {periodEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · {pctThrough}% through period
        </p>
      </div>

      {/* Total remaining banner */}
      <div className={`rounded-lg p-4 mb-4 ${totalRemaining >= 0 ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
        <div className="flex justify-between items-center">
          <span className="text-sm font-medium">Total Remaining</span>
          <span className={`text-2xl font-bold tabular-nums ${totalRemaining >= 0 ? 'text-green-700' : 'text-red-700'}`}>
            {formatCurrency(Math.abs(totalRemaining))}
          </span>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          {formatCurrency(totalSpent)} spent of {formatCurrency(totalBudget)}
        </p>
      </div>

      {/* Category cards */}
      <div className="space-y-2">
        {rows.map((row) => {
          const isOver = row.remaining < 0;
          const isWarning = !isOver && row.pct >= 70;
          const barColor = isOver ? 'bg-red-500' : isWarning ? 'bg-yellow-500' : 'bg-green-500';
          const barWidth = Math.min(row.pct, 100);

          return (
            <div key={row.name} className={`rounded-lg border p-3 ${isOver ? 'border-red-200' : ''}`}>
              <div className="flex justify-between items-center mb-1">
                <span className="text-sm font-medium">{row.name}</span>
                <span className={`text-sm font-bold tabular-nums ${isOver ? 'text-red-600' : 'text-green-700'}`}>
                  {isOver ? '-' : ''}{formatCurrency(Math.abs(row.remaining))}
                  <span className="text-xs font-normal text-muted-foreground ml-1">
                    {isOver ? 'over' : 'left'}
                  </span>
                </span>
              </div>
              {/* Progress bar */}
              <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
                <div className={`h-full rounded-full ${barColor}`} style={{ width: `${barWidth}%` }} />
              </div>
              <div className="flex justify-between mt-1">
                <span className="text-xs text-muted-foreground">{formatCurrency(row.spent)} spent</span>
                <span className="text-xs text-muted-foreground">{formatCurrency(row.budget)} budget</span>
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-center text-xs text-muted-foreground mt-6">
        Pull this up before any purchase. Green = go. Yellow = slow down. Red = stop.
      </p>
    </div>
  );
}
