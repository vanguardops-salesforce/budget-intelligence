import { createServerSupabaseClient } from '@/lib/supabase/server';
import { PlaidLink } from '@/components/plaid-link';
import { NetWorthChart } from '@/components/net-worth-chart';
import { CashFlowForecast } from '@/components/cash-flow-forecast';
import { ConnectionHealth } from '@/components/connection-health';
import { AccountEntityAssignment } from '@/components/account-entity-assignment';
import { DataHealthPanel } from '@/components/data-health-panel';
import { getLatestAudit, type LatestAudit } from '@/lib/audit/runner';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { formatCurrency, formatRelativeTime, maskAccount } from '@/lib/format';
import {
  formatBudgetMonth,
  formatBudgetMonthRange,
  getBudgetMonthRange,
  getCurrentBudgetMonth,
  toIsoDate,
} from '@/lib/budgetMonth';
import {
  aggregateTitheAllTime,
  buildRunningLedger,
  sumCycleTotals,
  type TitheLedgerRow,
} from '@/lib/titheLedger';
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

  const { data: { user } } = await supabase.auth.getUser();
  let latestAudit: LatestAudit | null = null;
  if (user) {
    try {
      latestAudit = await getLatestAudit(supabase, user.id);
    } catch {
      // Audit history is non-critical to the dashboard — render the panel empty.
      latestAudit = null;
    }
  }

  const now = new Date();
  const budgetMonth = getCurrentBudgetMonth(now);
  const { start: budgetMonthStart, end: budgetMonthEnd } = getBudgetMonthRange(budgetMonth);
  const monthStart = toIsoDate(budgetMonthStart);
  const monthEnd = toIsoDate(budgetMonthEnd);
  const today = toIsoDate(now);
  // Clamp the window to today so we don't query future dates.
  const windowEnd = today < monthEnd ? today : monthEnd;
  const budgetMonthLabel = formatBudgetMonth(budgetMonth);
  const budgetMonthRangeLabel = formatBudgetMonthRange(budgetMonth);

  // Parallel data fetching
  const [entitiesRes, accountsRes, plaidItemsRes, txRes, titheLogRes, holdingsRes, recurringRes] = await Promise.all([
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
      .lte('date', windowEnd),
    // Canonical tithing ledger — both tithing panels read from this.
    supabase
      .from('tithe_log')
      .select('entity_id, income_date, income_source, tithe_owed, tithe_paid, status')
      .not('income_date', 'is', null)
      .order('income_date', { ascending: true }),
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
  const daysElapsedInBudgetMonth = Math.max(
    1,
    Math.floor((now.getTime() - budgetMonthStart.getTime()) / 86_400_000) + 1,
  );
  if (recurringPatterns.length === 0 && mtdSpending > 0) {
    const dailyRate = mtdSpending / daysElapsedInBudgetMonth;
    forecast30d = dailyRate * 30;
  }

  // ── Tithing — single source of truth is tithe_log; never recompute paid here ──
  const titheLedgerRows: TitheLedgerRow[] = (titheLogRes.data ?? []).map((r) => ({
    entityId: r.entity_id as string,
    incomeDate: r.income_date as string,
    incomeSource: (r.income_source as string | null) ?? null,
    titheOwed: Number(r.tithe_owed) || 0,
    tithePaid: Number(r.tithe_paid) || 0,
    status: (r.status as string) ?? 'owed',
  }));

  const entityNameById = new Map(entities.map((e) => [e.id, e.name]));

  // Running ledger: this cycle's unpaid rows, remaining read verbatim from the ledger.
  const runningLedger = buildRunningLedger(titheLedgerRows, budgetMonth, entityNameById);
  const { owed: totalTitheOwed, paid: totalTithePaid } = sumCycleTotals(titheLedgerRows, budgetMonth);
  const tithingIsCurrent = runningLedger.length === 0;
  const tithingGap = runningLedger.reduce((sum, e) => sum + e.remaining, 0);

  // Entity tracker: all-time (cumulative) owed vs paid over the same ledger rows.
  const entityTithing = aggregateTitheAllTime(titheLedgerRows);

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
            <p className="text-xs text-muted-foreground" title={budgetMonthRangeLabel}>
              {hasAccounts ? `${budgetMonthLabel} (${budgetMonthRangeLabel})` : 'This budget month'}
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
            <p className="text-xs text-muted-foreground" title={budgetMonthRangeLabel}>
              {hasAccounts ? `${budgetMonthLabel} (${budgetMonthRangeLabel})` : 'This budget month'}
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

      {/* Data Health self-audit */}
      <Card>
        <CardHeader>
          <CardTitle>Data Health</CardTitle>
          <CardDescription>
            Automated nightly integrity audit — unclassified deposits, tithe gaps, stale balances,
            duplicates, and Plaid connection health.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DataHealthPanel initial={latestAudit} />
        </CardContent>
      </Card>

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
                dayOfMonth={daysElapsedInBudgetMonth}
              />
            </CardContent>
          </Card>
        </div>
      )}

      {/* Tithing — 10% */}
      {hasAccounts && titheLedgerRows.length > 0 && (
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
              <CardDescription title={budgetMonthRangeLabel}>
                Running ledger for {budgetMonthLabel}
                <span className="block text-xs text-muted-foreground/80">{budgetMonthRangeLabel}</span>
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
                  {runningLedger.map((entry, i) => (
                    <div key={i} className="flex items-start gap-2 rounded-lg border border-yellow-200 bg-yellow-50 p-3">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600" />
                      <div className="text-sm">
                        <span className="font-medium text-yellow-800">
                          Tithe {formatCurrency(entry.remaining)}
                        </span>
                        <span className="text-yellow-700">
                          {' '}for {entry.incomeSource ?? entityNameById.get(entry.entityId) ?? 'income'} payment on{' '}
                          {new Date(entry.incomeDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          {entry.status === 'partial' && ' (partially paid)'}
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
              <CardDescription>All-time owed vs paid, by entity</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {entityTithing.map(({ entityId, owed, paid, gap: entityGap }) => {
                  const entityCurrent = paid >= owed;
                  return (
                    <div key={entityId} className="rounded-lg border p-3">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">{entityNameById.get(entityId) ?? 'Unknown'}</span>
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
                {entityTithing.length === 0 && (
                  <p className="text-sm text-muted-foreground">No income recorded.</p>
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

