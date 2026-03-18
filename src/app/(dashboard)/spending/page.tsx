export const dynamic = "force-dynamic";

import { createServerSupabaseClient } from '@/lib/supabase/server';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

function getPeriods() {
  const periods = [];
  let start = new Date(2025, 11, 15); // Dec 15, 2025
  const now = new Date();
  
  while (start < now) {
    const end = new Date(start);
    end.setMonth(end.getMonth() + 1);
    end.setDate(14);
    
    const label = `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${end > now ? 'Present' : end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
    periods.push({
      label,
      start: start.toISOString().split('T')[0],
      end: (end > now ? now : end).toISOString().split('T')[0],
    });
    
    start = new Date(end);
    start.setDate(15);
  }
  return periods;
}

export default async function SpendingPage() {
  const supabase = createServerSupabaseClient();
  const periods = getPeriods();

  const { data: transactions } = await supabase
    .from('transactions')
    .select(`
      amount,
      date,
      merchant_name,
      user_category_id,
      entity_id,
      budget_categories!transactions_user_category_id_fkey(name),
      entities!transactions_entity_id_fkey(name)
    `)
    .is('deleted_at', null)
    .order('date', { ascending: false });

  const txns = transactions ?? [];

  const periodData = periods.map((period) => {
    const periodTxns = txns.filter(
      (t) => t.date >= period.start && t.date <= period.end
    );

    const expenses = periodTxns.filter((t) => t.amount > 0);
    const income = periodTxns.filter((t) => t.amount < 0);

    const categoryMap = new Map<string, { amount: number; count: number; entity: string }>();
    for (const t of expenses) {
      const catName = (t.budget_categories as any)?.name ?? 'Uncategorized';
      const entName = (t.entities as any)?.name ?? 'Unknown';
      const key = `${catName}|||${entName}`;
      const existing = categoryMap.get(key) ?? { amount: 0, count: 0, entity: entName };
      existing.amount += Number(t.amount);
      existing.count += 1;
      categoryMap.set(key, existing);
    }

    const categories = Array.from(categoryMap.entries())
      .map(([key, data]) => ({
        category: key.split('|||')[0],
        entity: data.entity,
        amount: data.amount,
        count: data.count,
      }))
      .sort((a, b) => b.amount - a.amount);

    const totalExpenses = expenses.reduce((sum, t) => sum + Number(t.amount), 0);
    const totalIncome = income.reduce((sum, t) => sum + Math.abs(Number(t.amount)), 0);

    return {
      ...period,
      categories,
      totalExpenses,
      totalIncome,
      netCashflow: totalIncome - totalExpenses,
    };
  });

  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Spending Breakdown</h1>
        <p className="text-sm text-muted-foreground">
          Category spending by pay period (15th to 14th)
        </p>
      </div>

      {periodData.reverse().map((period) => (
        <Card key={period.label}>
          <CardHeader>
            <CardTitle>{period.label}</CardTitle>
            <CardDescription>
              <span className="text-green-600 font-medium">Income: {fmt(period.totalIncome)}</span>
              {' \u00b7 '}
              <span className="text-red-600 font-medium">Expenses: {fmt(period.totalExpenses)}</span>
              {' \u00b7 '}
              <span className={period.netCashflow >= 0 ? 'text-green-600 font-medium' : 'text-red-600 font-medium'}>
                Net: {fmt(period.netCashflow)}
              </span>
            </CardDescription>
          </CardHeader>
          <CardContent>
            {period.categories.length === 0 ? (
              <p className="text-sm text-muted-foreground">No transactions in this period.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="pb-2 font-medium">Category</th>
                      <th className="pb-2 font-medium">Entity</th>
                      <th className="pb-2 font-medium text-right">Amount</th>
                      <th className="pb-2 font-medium text-right">Txns</th>
                    </tr>
                  </thead>
                  <tbody>
                    {period.categories.map((cat, i) => (
                      <tr key={i} className="border-b last:border-0">
                        <td className="py-2">{cat.category}</td>
                        <td className="py-2 text-muted-foreground">{cat.entity}</td>
                        <td className="py-2 text-right font-mono">{fmt(cat.amount)}</td>
                        <td className="py-2 text-right text-muted-foreground">{cat.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
