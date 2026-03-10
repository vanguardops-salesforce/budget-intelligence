export const dynamic = "force-dynamic";

import { createServerSupabaseClient } from '@/lib/supabase/server';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { TransactionTable } from '@/components/transaction-table';
import { formatCurrency, formatRelativeTime } from '@/lib/format';
import { Receipt, ArrowDownLeft, ArrowUpRight, Clock } from 'lucide-react';

export default async function TransactionsPage() {
  const supabase = createServerSupabaseClient();

  const [transactionsRes, accountsRes, categoriesRes, plaidItemsRes] = await Promise.all([
    supabase
      .from('transactions')
      .select('id, amount, date, merchant_name, plaid_category, user_category_id, is_recurring, account_id')
      .is('deleted_at', null)
      .order('date', { ascending: false })
      .limit(500),
    supabase
      .from('accounts')
      .select('id, name, mask, type')
      .eq('is_active', true)
      .is('deleted_at', null),
    supabase
      .from('budget_categories')
      .select('id, name')
      .eq('is_active', true)
      .order('name'),
    supabase
      .from('plaid_items')
      .select('last_successful_sync')
      .order('last_successful_sync', { ascending: false })
      .limit(1),
  ]);

  const transactions = transactionsRes.data ?? [];
  const accounts = accountsRes.data ?? [];
  const categories = categoriesRes.data ?? [];
  const lastSync = plaidItemsRes.data?.[0]?.last_successful_sync;

  const totalSpending = transactions
    .filter((t) => Number(t.amount) > 0)
    .reduce((sum, t) => sum + Number(t.amount), 0);

  const totalIncome = transactions
    .filter((t) => Number(t.amount) < 0)
    .reduce((sum, t) => sum + Math.abs(Number(t.amount)), 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Transactions</h2>
          <p className="text-muted-foreground">
            Recent transactions across all linked accounts.
          </p>
        </div>
        {lastSync && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            Last synced {formatRelativeTime(lastSync)}
          </div>
        )}
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Transactions</CardTitle>
            <Receipt className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{transactions.length}</div>
            <p className="text-xs text-muted-foreground">Showing up to 500 most recent</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Money Out</CardTitle>
            <ArrowUpRight className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(totalSpending)}</div>
            <p className="text-xs text-muted-foreground">Debits in visible range</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Money In</CardTitle>
            <ArrowDownLeft className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{formatCurrency(totalIncome)}</div>
            <p className="text-xs text-muted-foreground">Credits in visible range</p>
          </CardContent>
        </Card>
      </div>

      {/* Transaction table with search, sort, pagination, and category override */}
      <Card>
        <CardHeader>
          <CardTitle>All Transactions</CardTitle>
          <CardDescription>
            Search, sort, and override categories. Changes are saved immediately.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TransactionTable
            transactions={transactions}
            accounts={accounts}
            categories={categories}
          />
        </CardContent>
      </Card>
    </div>
  );
}
