import { createServerSupabaseClient } from '@/lib/supabase/server';
import { PlaidLink } from '@/components/plaid-link';
import { NetWorthChart } from '@/components/net-worth-chart';
import { CashFlowForecast } from '@/components/cash-flow-forecast';
import { ConnectionHealth } from '@/components/connection-health';
import { AccountEntityAssignment } from '@/components/account-entity-assignment';
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
  CheckCircle2,
} from 'lucide-react';

export default async function DashboardPage() {
  const supabase = createServerSupabaseClient();

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  const today = now.toISOString().split('T')[0];

  // Parallel data fetching
  const [entitiesRes, accountsRes, plaidItemsRes, txRes, txDetailRes, holdingsRes, recurringRes, incomeSourcesRes] = await Promise.all([
    supabase.from('entities').select('id, name, type').eq('is_active', true),
    supabase
      .from('accounts')
      .select('id, name, type, subtype, current_balance, available_balance, mask, is_active, plaid_item_id, entity_id')
      .eq('is_active', true)
      .is('deleted_at', null),
    supabase
      .from('plaid_items')
      .select('id, institution_name, status, last_successful_sync, error_count, last_error_code, consent_expiration'),
    supabase
      .from('transactions')
      .select('amount')
      .is('deleted_at', null)
      .gte('date', monthStart)
      .lte('date', today),
    // Detailed transactions for tithing calculation
    supabase
      .from('transactions')
      .select('amount, date, merchant_name, entity_id, account_id')
      .is('deleted_at', null)
      .gte('date', monthStart)
      .lte('date', today)
      .order('date', { ascending: true }),
    supabase
      .from('holdings')
      .select('value')
      .is('deleted_at', null),
    supabase
      .from('recurring_patterns')
      .select('estimated_amount, frequency, next_expected_date')
      .eq('is_active', true),
    supabase
      .from('income_sources')
      .select('id, name, entity_id, merchant_patterns')
      .eq('is_active', true),
  ]);

  const entities = entitiesRes.data ?? [];
  const accounts = accountsRes.data ?? [];
  const plaidItems = plaidItemsRes.data ?? [];
  const transactions = txRes.data ?? [];
  const detailedTransactions = txDetailRes.data ?? [];
  const holdings = holdingsRes.data ?? [];
  const recurringPatterns = recurringRes.data ?? [];
  const incomeSources = incomeSourcesRes.data ?? [];

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

  // ── Tithing calculation (running ledger) ──
  const TITHE_RATE = 0.10;
  const tithePatterns = ['north point', 'community ch'];

  function isTithePayment(merchantName: string | null): boolean {
    if (!merchantName) return false;
    const lower = merchantName.toLowerCase();
    return tithePatterns.some((p) => lower.includes(p));
  }

  function isIncomeDeposit(merchantName: string | null): boolean {
    if (!merchantName) return false;
    const lower = merchantName.toLowerCase();
    return incomeSources.some((src) =>
      (src.merchant_patterns as string[]).some((pattern: string) =>
        lower.includes(pattern.toLowerCase())
      )
    );
  }

  // Identify income deposits and tithe payments for the period
  const incomeDeposits = detailedTransactions
    .filter((t) => Number(t.amount) < 0 && isIncomeDeposit(t.merchant_name))
    .map((t) => ({
      amount: Math.abs(Number(t.amount)),
      titheOwed: Math.abs(Number(t.amount)) * TITHE_RATE,
      date: t.date as string,
      source: t.merchant_name as string,
      entityId: t.entity_id as string,
    }));

  const tithePayments = detailedTransactions
    .filter((t) => Number(t.amount) > 0 && isTithePayment(t.merchant_name))
    .map((t) => ({
      amount: Number(t.amount),
      date: t.date as string,
      entityId: t.entity_id as string,
    }));

  // Running ledger: apply tithe payments against income deposits in chronological order
  const totalTitheOwed = incomeDeposits.reduce((sum, d) => sum + d.titheOwed, 0);
  const totalTithePaid = tithePayments.reduce((sum, p) => sum + p.amount, 0);

  // Determine which paychecks are uncovered
  let runningCredit = totalTithePaid;
  const uncoveredDeposits: typeof incomeDeposits = [];
  for (const deposit of incomeDeposits) {
    if (runningCredit >= deposit.titheOwed) {
      runningCredit -= deposit.titheOwed;
    } else {
      // Partially or fully uncovered
      const uncoveredAmount = deposit.titheOwed - runningCredit;
      uncoveredDeposits.push({ ...deposit, titheOwed: uncoveredAmount });
      runningCredit = 0;
    }
  }

  const tithingIsCurrent = totalTithePaid >= totalTitheOwed;
  const tithingGap = Math.max(0, totalTitheOwed - totalTithePaid);

  // Entity-level tithing breakdown
  const entityTithingMap = new Map<string, { owed: number; paid: number }>();
  for (const deposit of incomeDeposits) {
    const entry = entityTithingMap.get(deposit.entityId) ?? { owed: 0, paid: 0 };
    entry.owed += deposit.titheOwed;
    entityTithingMap.set(deposit.entityId, entry);
  }
  for (const payment of tithePayments) {
    const entry = entityTithingMap.get(payment.entityId) ?? { owed: 0, paid: 0 };
    entry.paid += payment.amount;
    entityTithingMap.set(payment.entityId, entry);
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

      {/* Tithing — 10% */}
      {hasAccounts && incomeSources.length > 0 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* Daily Briefing: Tithing alerts */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                TITHING &mdash; 10%
                {tithingIsCurrent ? (
                  <Badge variant="secondary" className="bg-green-100 text-green-800">Current</Badge>
                ) : (
                  <Badge variant="secondary" className="bg-yellow-100 text-yellow-800">Gap</Badge>
                )}
              </CardTitle>
              <CardDescription>
                Running ledger for {new Date(monthStart).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {tithingIsCurrent ? (
                <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 p-3 text-green-800">
                  <CheckCircle2 className="h-5 w-5 shrink-0" />
                  <span className="text-sm font-medium">You&apos;re current on tithing this period</span>
                </div>
              ) : (
                <div className="space-y-2">
                  {uncoveredDeposits.map((deposit, i) => (
                    <div key={i} className="flex items-start gap-2 rounded-lg border border-yellow-200 bg-yellow-50 p-3">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600" />
                      <div className="text-sm">
                        <span className="font-medium text-yellow-800">
                          Tithe {formatCurrency(deposit.titheOwed)}
                        </span>
                        <span className="text-yellow-700">
                          {' '}for {deposit.source} payment on{' '}
                          {new Date(deposit.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </span>
                      </div>
                    </div>
                  ))}
                  <div className="flex items-center gap-2 rounded-lg border border-yellow-200 bg-yellow-50/50 p-2 text-sm text-yellow-800">
                    <AlertTriangle className="h-4 w-4 shrink-0 text-yellow-600" />
                    <span>Remaining gap: <strong>{formatCurrency(tithingGap)}</strong></span>
                  </div>
                </div>
              )}

              {/* Summary line */}
              <div className={`text-sm font-medium ${tithingIsCurrent ? 'text-green-700' : 'text-yellow-700'}`}>
                Total paid: {formatCurrency(totalTithePaid)} of {formatCurrency(totalTitheOwed)} owed
              </div>
            </CardContent>
          </Card>

          {/* Entity-level Tithing Tracker */}
          <Card>
            <CardHeader>
              <CardTitle>Tithing Tracker</CardTitle>
              <CardDescription>Breakdown by entity</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {Array.from(entityTithingMap.entries()).map(([entityId, { owed, paid }]) => {
                  const entity = entities.find((e) => e.id === entityId);
                  const entityCurrent = paid >= owed;
                  const entityGap = Math.max(0, owed - paid);
                  return (
                    <div key={entityId} className="rounded-lg border p-3">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">{entity?.name ?? 'Unknown'}</span>
                        {entityCurrent ? (
                          <Badge variant="secondary" className="bg-green-100 text-green-800 text-xs">
                            Current
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="bg-yellow-100 text-yellow-800 text-xs">
                            Gap: {formatCurrency(entityGap)}
                          </Badge>
                        )}
                      </div>
                      <div className={`mt-1 text-xs ${entityCurrent ? 'text-green-600' : 'text-yellow-600'}`}>
                        Paid {formatCurrency(paid)} of {formatCurrency(owed)} owed
                      </div>
                    </div>
                  );
                })}
                {entityTithingMap.size === 0 && (
                  <p className="text-sm text-muted-foreground">No income recorded this period.</p>
                )}
              </div>
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

      {/* Connection Health */}
      {plaidItems.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Connection Health</CardTitle>
            <CardDescription>
              Plaid connection status, sync activity, and re-authentication.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ConnectionHealth plaidItems={plaidItems} />
          </CardContent>
        </Card>
      )}

      {/* Accounts & Entity Assignment */}
      {accounts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Linked Accounts</CardTitle>
            <CardDescription>
              Assign each account to an entity (Personal, Veteran Digital, VCG, etc.)
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {/* Account entity assignment */}
              <AccountEntityAssignment
                accounts={accounts.map((a) => ({
                  id: a.id,
                  name: a.name,
                  mask: a.mask,
                  type: a.type,
                  entity_id: a.entity_id,
                }))}
                entities={entities}
              />

              <Separator />

              {/* Account balances */}
              <div>
                <h4 className="mb-3 text-sm font-medium">Account Balances</h4>
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
          </CardContent>
        </Card>
      )}

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

