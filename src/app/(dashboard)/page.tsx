export const dynamic = "force-dynamic";

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
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  const today = now.toISOString().split('T')[0];

  // Parallel data fetching
  const [entitiesRes, accountsRes, plaidItemsRes, txRes, holdingsRes, recurringRes] = await Promise.all([
    supabase.from('entities').select('id, name, type').eq('is_active', true),
    supabase
      .from('accounts')
      .select('id, name, type, subtype, current_balance, available_balance, mask, is_active, plaid_item_id')
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
  ]);

  const entities = entitiesRes.data ?? [];
  const accounts = accountsRes.data ?? [];
  const plaidItems = plaidItemsRes.data ?? [];
  const transactions = txRes.data ?? [];
  const holdings = holdingsRes.data ?? [];
  const recurringPatterns = recurringRes.data ?? [];

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
            Your financial snapshot at a glance.
          </p>
        </div>
        {latestSync && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            Last synced {formatRelativeTime(latestSync)}
          </div>
        )}
      </div>

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
