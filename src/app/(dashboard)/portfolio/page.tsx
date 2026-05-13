export const dynamic = "force-dynamic";

import { createServerSupabaseClient } from '@/lib/supabase/server';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatCurrency, formatRelativeTime } from '@/lib/format';
import { TrendingUp, TrendingDown, BarChart3, Layers, Clock } from 'lucide-react';

export default async function PortfolioPage() {
  const supabase = createServerSupabaseClient();

  const [holdingsRes, accountsRes, plaidItemsRes] = await Promise.all([
    supabase
      .from('holdings')
      .select('id, security_name, ticker, quantity, price, value, cost_basis, account_id')
      .is('deleted_at', null)
      .order('value', { ascending: false }),
    supabase
      .from('accounts')
      .select('id, name, mask, type')
      .eq('type', 'investment')
      .eq('is_active', true)
      .is('deleted_at', null),
    supabase
      .from('plaid_items')
      .select('last_successful_sync')
      .order('last_successful_sync', { ascending: false })
      .limit(1),
  ]);

  const holdings = holdingsRes.data ?? [];
  const accounts = accountsRes.data ?? [];
  const lastSync = plaidItemsRes.data?.[0]?.last_successful_sync;

  const accountMap = new Map(accounts.map((a) => [a.id, a]));

  const totalValue = holdings.reduce((sum, h) => sum + (Number(h.value) || 0), 0);
  const totalCostBasis = holdings
    .filter((h) => h.cost_basis != null)
    .reduce((sum, h) => sum + Number(h.cost_basis!), 0);
  const totalGainLoss = totalValue - totalCostBasis;
  const totalGainLossPct = totalCostBasis > 0 ? ((totalGainLoss / totalCostBasis) * 100) : 0;

  // Build allocation by security for the bar chart
  const topHoldings = holdings.slice(0, 10);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Portfolio</h2>
          <p className="text-muted-foreground">
            Investment positions from linked brokerage accounts.
            <span className="ml-2 text-xs text-muted-foreground/70">READ-ONLY — No trade execution.</span>
          </p>
        </div>
        {lastSync && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            Last synced {formatRelativeTime(lastSync)}
          </div>
        )}
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Portfolio Value</CardTitle>
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(totalValue)}</div>
            <p className="text-xs text-muted-foreground">
              {holdings.length} position{holdings.length !== 1 ? 's' : ''}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Gain/Loss</CardTitle>
            {totalGainLoss >= 0 ? (
              <TrendingUp className="h-4 w-4 text-green-600" />
            ) : (
              <TrendingDown className="h-4 w-4 text-destructive" />
            )}
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${totalGainLoss >= 0 ? 'text-green-600' : 'text-destructive'}`}>
              {totalGainLoss >= 0 ? '+' : ''}{formatCurrency(totalGainLoss)}
            </div>
            <p className="text-xs text-muted-foreground">
              {totalGainLossPct >= 0 ? '+' : ''}{totalGainLossPct.toFixed(2)}% overall
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Accounts</CardTitle>
            <Layers className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{accounts.length}</div>
            <p className="text-xs text-muted-foreground">Investment accounts</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Last Updated</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-sm font-medium">
              {lastSync
                ? new Date(lastSync).toLocaleString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  })
                : '—'}
            </div>
            <p className="text-xs text-muted-foreground">From Plaid sync</p>
          </CardContent>
        </Card>
      </div>

      {/* Allocation bars (top 10) */}
      {topHoldings.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Top Holdings by Allocation</CardTitle>
            <CardDescription>
              Portfolio weight of your largest positions
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {topHoldings.map((h) => {
                const allocation = totalValue > 0 ? (Number(h.value) / totalValue) * 100 : 0;
                return (
                  <div key={h.id} className="space-y-1.5">
                    <div className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{h.ticker ?? h.security_name}</span>
                        {h.ticker && (
                          <span className="text-xs text-muted-foreground">{h.security_name}</span>
                        )}
                      </div>
                      <span className="font-semibold tabular-nums">{allocation.toFixed(1)}%</span>
                    </div>
                    <Progress value={allocation} className="h-2" />
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Holdings Table */}
      <Card>
        <CardHeader>
          <CardTitle>All Holdings</CardTitle>
          <CardDescription>
            Detailed view of all investment positions.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {holdings.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-sm text-muted-foreground">
                No holdings data. Connect an investment account via Plaid.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Security</TableHead>
                  <TableHead className="hidden sm:table-cell">Account</TableHead>
                  <TableHead className="text-right">Shares</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead className="text-right hidden md:table-cell">Cost Basis</TableHead>
                  <TableHead className="text-right">Gain/Loss</TableHead>
                  <TableHead className="text-right hidden lg:table-cell">Allocation</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {holdings.map((h) => {
                  const gainLoss = h.cost_basis != null ? Number(h.value) - Number(h.cost_basis) : null;
                  const gainPct = h.cost_basis && Number(h.cost_basis) > 0
                    ? ((gainLoss! / Number(h.cost_basis)) * 100)
                    : null;
                  const allocation = totalValue > 0 ? (Number(h.value) / totalValue * 100) : 0;
                  const account = accountMap.get(h.account_id);

                  return (
                    <TableRow key={h.id}>
                      <TableCell>
                        <div>
                          <p className="font-medium">{h.ticker ?? '—'}</p>
                          <p className="text-xs text-muted-foreground truncate max-w-[200px]">
                            {h.security_name}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">
                        {account ? `${account.name} ${account.mask ? `····${account.mask}` : ''}` : '—'}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{Number(h.quantity).toFixed(2)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCurrency(Number(h.price))}</TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">
                        {formatCurrency(Number(h.value))}
                      </TableCell>
                      <TableCell className="text-right tabular-nums hidden md:table-cell">
                        {h.cost_basis != null ? formatCurrency(Number(h.cost_basis)) : '—'}
                      </TableCell>
                      <TableCell className="text-right">
                        {gainLoss !== null ? (
                          <div className="flex flex-col items-end">
                            <span className={`font-semibold tabular-nums ${gainLoss >= 0 ? 'text-green-600' : 'text-destructive'}`}>
                              {gainLoss >= 0 ? '+' : ''}{formatCurrency(gainLoss)}
                            </span>
                            {gainPct !== null && (
                              <Badge
                                variant={gainPct >= 0 ? 'success' : 'danger'}
                                className="mt-0.5 text-[10px]"
                              >
                                {gainPct >= 0 ? '+' : ''}{gainPct.toFixed(1)}%
                              </Badge>
                            )}
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums hidden lg:table-cell">
                        {allocation.toFixed(1)}%
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
