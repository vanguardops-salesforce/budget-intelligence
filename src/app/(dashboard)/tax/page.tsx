export const dynamic = "force-dynamic";

import { createServerSupabaseClient } from '@/lib/supabase/server';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { formatCurrency } from '@/lib/format';
import { AlertTriangle, CheckCircle2, Calculator, TrendingDown } from 'lucide-react';

export default async function TaxPage() {
  const supabase = createServerSupabaseClient();

  const now = new Date();
  const currentYear = now.getFullYear();

  const [incomeRes, txRes, plannedRes] = await Promise.all([
    supabase
      .from('income_sources')
      .select('name, type, estimated_monthly, start_date, end_date, entity_id')
      .eq('is_active', true),
    supabase
      .from('transactions')
      .select('amount, merchant_name, date, user_category_id')
      .is('deleted_at', null)
      .gte('date', `${currentYear}-01-01`)
      .ilike('merchant_name', '%internal revenue%'),
    supabase
      .from('planned_expenses')
      .select('name, amount, expected_date, is_completed')
      .ilike('name', '%tax%')
      .eq('is_completed', false),
  ]);

  const incomeSources = incomeRes.data ?? [];
  const irsPayments = txRes.data ?? [];
  const plannedTax = plannedRes.data ?? [];

  // Calculate 1099 income
  const active1099Sources = incomeSources.filter(s => {
    if (s.type !== '1099') return false;
    const started = !s.start_date || new Date(s.start_date) <= now;
    const notEnded = !s.end_date || new Date(s.end_date) > now;
    return started && notEnded;
  });

  const all1099Sources = incomeSources.filter(s => s.type === '1099');
  const activeW2Sources = incomeSources.filter(s => {
    if (s.type !== 'w2') return false;
    const started = !s.start_date || new Date(s.start_date) <= now;
    const notEnded = !s.end_date || new Date(s.end_date) > now;
    return started && notEnded;
  });

  const monthly1099 = active1099Sources.reduce((sum, s) => sum + Number(s.estimated_monthly), 0);
  const monthlyW2 = activeW2Sources.reduce((sum, s) => sum + Number(s.estimated_monthly), 0);
  const monthlyTotal = monthly1099 + monthlyW2;

  // Project annual 1099 income (account for start/end dates)
  let projected1099Annual = 0;
  for (const source of all1099Sources) {
    const start = source.start_date ? new Date(source.start_date) : new Date(currentYear, 0, 1);
    const end = source.end_date ? new Date(source.end_date) : new Date(currentYear, 11, 31);
    const effectiveStart = start < new Date(currentYear, 0, 1) ? new Date(currentYear, 0, 1) : start;
    const effectiveEnd = end > new Date(currentYear, 11, 31) ? new Date(currentYear, 11, 31) : end;
    const months = Math.max(0, (effectiveEnd.getTime() - effectiveStart.getTime()) / (30 * 86400000));
    projected1099Annual += Number(source.estimated_monthly) * months;
  }

  let projectedW2Annual = 0;
  for (const source of activeW2Sources) {
    const start = source.start_date ? new Date(source.start_date) : new Date(currentYear, 0, 1);
    const end = source.end_date ? new Date(source.end_date) : new Date(currentYear, 11, 31);
    const effectiveStart = start < new Date(currentYear, 0, 1) ? new Date(currentYear, 0, 1) : start;
    const effectiveEnd = end > new Date(currentYear, 11, 31) ? new Date(currentYear, 11, 31) : end;
    const months = Math.max(0, (effectiveEnd.getTime() - effectiveStart.getTime()) / (30 * 86400000));
    projectedW2Annual += Number(source.estimated_monthly) * months;
  }

  const projectedTotalAnnual = projected1099Annual + projectedW2Annual;

  // Tax calculations (estimated — not tax advice)
  const SE_TAX_RATE = 0.153; // 15.3% Social Security + Medicare
  const FEDERAL_EFFECTIVE_RATE = 0.28; // Estimated effective federal rate at this income
  const GA_STATE_RATE = 0.0549; // Georgia flat rate (2026)
  const REASONABLE_SALARY = 150000; // Estimated reasonable S-Corp salary

  // Without S-Corp
  const annualSETax = projected1099Annual * SE_TAX_RATE;
  const annualFederalTax = projectedTotalAnnual * FEDERAL_EFFECTIVE_RATE;
  const annualStateTax = projectedTotalAnnual * GA_STATE_RATE;
  const totalTaxWithout = annualSETax + annualFederalTax + annualStateTax;

  // With S-Corp
  const sCorpSETax = REASONABLE_SALARY * SE_TAX_RATE;
  const sCorpSavings = annualSETax - sCorpSETax;
  const totalTaxWith = sCorpSETax + annualFederalTax + annualStateTax;

  // Quarterly estimated payments (1099 portion only — W2 has withholding)
  const effectiveTaxRate1099 = SE_TAX_RATE + FEDERAL_EFFECTIVE_RATE + GA_STATE_RATE;
  const quarterlyPayment = (projected1099Annual * effectiveTaxRate1099) / 4;
  const monthlySetAside = (projected1099Annual * effectiveTaxRate1099) / 12;

  // With S-Corp quarterly
  const effectiveTaxRate1099SCorp = (REASONABLE_SALARY / projected1099Annual * SE_TAX_RATE) + FEDERAL_EFFECTIVE_RATE + GA_STATE_RATE;
  const quarterlyPaymentSCorp = (projected1099Annual * effectiveTaxRate1099SCorp) / 4;

  // IRS payments made this year
  const totalPaid = irsPayments.reduce((sum, t) => sum + Number(t.amount), 0);
  
  // Quarterly deadlines
  const quarters = [
    { name: 'Q1', deadline: `${currentYear}-04-15`, period: 'Jan 1 - Mar 31' },
    { name: 'Q2', deadline: `${currentYear}-06-16`, period: 'Apr 1 - May 31' },
    { name: 'Q3', deadline: `${currentYear}-09-15`, period: 'Jun 1 - Aug 31' },
    { name: 'Q4', deadline: `${currentYear + 1}-01-15`, period: 'Sep 1 - Dec 31' },
  ];

  const getQuarterStatus = (deadline: string) => {
    const d = new Date(deadline);
    const daysUntil = Math.round((d.getTime() - now.getTime()) / 86400000);
    if (daysUntil < 0) return { status: 'past', daysUntil, label: 'Past due' };
    if (daysUntil <= 14) return { status: 'urgent', daysUntil, label: `${daysUntil} days` };
    if (daysUntil <= 30) return { status: 'upcoming', daysUntil, label: `${daysUntil} days` };
    return { status: 'future', daysUntil, label: `${daysUntil} days` };
  };

  // Monthly cost of NOT having S-Corp
  const monthlySCorpCost = sCorpSavings / 12;

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Tax Strategy</h1>
        <p className="text-sm text-muted-foreground">
          Estimated tax obligations and S-Corp savings analysis. This is education, not tax advice — consult your CPA.
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <Card>
          <CardContent className="pt-6">
            <p className="text-xs text-muted-foreground uppercase">Projected Annual Income</p>
            <p className="text-2xl font-bold mt-1">{formatCurrency(projectedTotalAnnual)}</p>
            <p className="text-xs text-muted-foreground">{formatCurrency(projected1099Annual)} (1099) + {formatCurrency(projectedW2Annual)} (W-2)</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-xs text-red-600 uppercase">Est. Annual Tax (No S-Corp)</p>
            <p className="text-2xl font-bold mt-1 text-red-600">{formatCurrency(totalTaxWithout)}</p>
            <p className="text-xs text-muted-foreground">Effective rate: {Math.round((totalTaxWithout / projectedTotalAnnual) * 100)}%</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-xs text-green-600 uppercase">Est. Annual Tax (With S-Corp)</p>
            <p className="text-2xl font-bold mt-1 text-green-700">{formatCurrency(totalTaxWith)}</p>
            <p className="text-xs text-muted-foreground">Effective rate: {Math.round((totalTaxWith / projectedTotalAnnual) * 100)}%</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-xs text-green-600 uppercase">S-Corp Savings</p>
            <p className="text-2xl font-bold mt-1 text-green-700">{formatCurrency(sCorpSavings)}/yr</p>
            <p className="text-xs text-red-600 font-medium">Losing {formatCurrency(monthlySCorpCost)}/mo without it</p>
          </CardContent>
        </Card>
      </div>

      {/* S-Corp Deep Dive */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <TrendingDown className="h-5 w-5 text-green-600" />
            <CardTitle>S-Corp Election Savings</CardTitle>
          </div>
          <CardDescription>
            How S-Corp election reduces your self-employment tax
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            <div className="space-y-3">
              <h4 className="text-sm font-semibold text-red-600 uppercase tracking-wider">Without S-Corp (Current)</h4>
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span>1099 Income</span>
                  <span className="font-mono">{formatCurrency(projected1099Annual)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span>SE Tax (15.3% on ALL 1099)</span>
                  <span className="font-mono text-red-600">{formatCurrency(annualSETax)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span>Federal Income Tax (~{Math.round(FEDERAL_EFFECTIVE_RATE * 100)}%)</span>
                  <span className="font-mono">{formatCurrency(annualFederalTax)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span>Georgia State Tax ({(GA_STATE_RATE * 100).toFixed(2)}%)</span>
                  <span className="font-mono">{formatCurrency(annualStateTax)}</span>
                </div>
                <Separator />
                <div className="flex justify-between text-sm font-bold">
                  <span>Total Estimated Tax</span>
                  <span className="text-red-600 font-mono">{formatCurrency(totalTaxWithout)}</span>
                </div>
              </div>
            </div>
            <div className="space-y-3">
              <h4 className="text-sm font-semibold text-green-600 uppercase tracking-wider">With S-Corp Election</h4>
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span>Reasonable Salary</span>
                  <span className="font-mono">{formatCurrency(REASONABLE_SALARY)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span>SE Tax (15.3% on salary ONLY)</span>
                  <span className="font-mono text-green-600">{formatCurrency(sCorpSETax)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span>Federal Income Tax (~{Math.round(FEDERAL_EFFECTIVE_RATE * 100)}%)</span>
                  <span className="font-mono">{formatCurrency(annualFederalTax)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span>Georgia State Tax ({(GA_STATE_RATE * 100).toFixed(2)}%)</span>
                  <span className="font-mono">{formatCurrency(annualStateTax)}</span>
                </div>
                <Separator />
                <div className="flex justify-between text-sm font-bold">
                  <span>Total Estimated Tax</span>
                  <span className="text-green-700 font-mono">{formatCurrency(totalTaxWith)}</span>
                </div>
              </div>
            </div>
          </div>
          <div className="mt-4 rounded-lg border border-green-300 bg-white p-4">
            <p className="text-sm text-gray-900">
              <strong className="text-green-700">Annual savings with S-Corp: {formatCurrency(sCorpSavings)}</strong> — that is {formatCurrency(monthlySCorpCost)} every month you delay filing.
              {' '}Since January 1, you have already lost approximately <strong className="text-red-600">{formatCurrency(monthlySCorpCost * now.getMonth())}</strong> by not having the election in place.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Quarterly Payment Schedule */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Calculator className="h-5 w-5" />
            <CardTitle>Quarterly Estimated Payments</CardTitle>
          </div>
          <CardDescription>
            IRS Form 1040-ES schedule for {currentYear}. Pay via irs.gov/directpay.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 mb-4">
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground uppercase">Without S-Corp</p>
                <p className="text-xl font-bold text-red-600 mt-1">{formatCurrency(quarterlyPayment)}/quarter</p>
                <p className="text-xs text-muted-foreground">Set aside {formatCurrency(monthlySetAside)}/mo</p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground uppercase">With S-Corp</p>
                <p className="text-xl font-bold text-green-700 mt-1">{formatCurrency(quarterlyPaymentSCorp)}/quarter</p>
                <p className="text-xs text-muted-foreground">Set aside {formatCurrency(quarterlyPaymentSCorp / 3)}/mo</p>
              </div>
            </div>

            {quarters.map(q => {
              const status = getQuarterStatus(q.deadline);
              return (
                <div key={q.name} className={`flex flex-col gap-2 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between ${
                  status.status === 'urgent' ? 'border-red-300' : 
                  status.status === 'upcoming' ? 'border-yellow-300' : ''
                }`}>
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold">{q.name} — {q.period}</p>
                      {status.status === 'urgent' && <Badge variant="danger">{status.label}</Badge>}
                      {status.status === 'upcoming' && <Badge variant="warning">{status.label}</Badge>}
                      {status.status === 'future' && <Badge variant="secondary">{status.label}</Badge>}
                      {status.status === 'past' && <Badge variant="danger">Past Due</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Due: {new Date(q.deadline).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-bold tabular-nums">{formatCurrency(quarterlyPayment)}</p>
                    <p className="text-xs text-muted-foreground">estimated payment</p>
                  </div>
                </div>
              );
            })}

            <Separator />

            <div className="flex justify-between items-center">
              <span className="text-sm font-medium">YTD IRS Payments Made</span>
              <span className="text-lg font-bold tabular-nums">{formatCurrency(totalPaid)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm font-medium">YTD Should Have Paid (Q1)</span>
              <span className="text-lg font-bold tabular-nums text-red-600">{formatCurrency(quarterlyPayment)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm font-medium text-red-600">Shortfall</span>
              <span className="text-lg font-bold tabular-nums text-red-600">{formatCurrency(Math.max(0, quarterlyPayment - totalPaid))}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 1099 Source Breakdown */}
      <Card>
        <CardHeader>
          <CardTitle>1099 Income Sources</CardTitle>
          <CardDescription>Each source generates SE tax liability without S-Corp</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {all1099Sources.map(source => {
              const annual = Number(source.estimated_monthly) * 12;
              const seTax = annual * SE_TAX_RATE;
              const isActive = (!source.start_date || new Date(source.start_date) <= now) && 
                              (!source.end_date || new Date(source.end_date) > now);
              return (
                <div key={source.name} className="flex flex-col gap-1 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium">{source.name}</p>
                      {isActive ? <Badge variant="success">Active</Badge> : <Badge variant="secondary">Starting Soon</Badge>}
                      {source.end_date && <Badge variant="warning">Ends {new Date(source.end_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground">{formatCurrency(Number(source.estimated_monthly))}/mo</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-bold tabular-nums">{formatCurrency(seTax)}/yr SE tax</p>
                    <p className="text-xs text-red-600">Without S-Corp</p>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Action Items */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-red-600" />
            <CardTitle>Required Actions</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="rounded-lg border border-red-300 p-4">
              <p className="text-sm font-semibold">1. Make Q1 Estimated Payment — Due April 15</p>
              <p className="text-xs text-muted-foreground mt-1">
                Pay {formatCurrency(quarterlyPayment)} via irs.gov/directpay. Your Wealthfront tax reserve has $35K earmarked for this. 
                Do not wait — underpayment penalties are automatic.
              </p>
            </div>
            <div className="rounded-lg border border-red-300 p-4">
              <p className="text-sm font-semibold">2. Engage CPA and File S-Corp Election</p>
              <p className="text-xs text-muted-foreground mt-1">
                Every month without S-Corp costs you {formatCurrency(monthlySCorpCost)} in avoidable SE tax. 
                Since January, you have lost approximately {formatCurrency(monthlySCorpCost * now.getMonth())}. 
                File Form 2553 with a CPA who understands reasonable compensation rules.
              </p>
            </div>
            <div className="rounded-lg border border-yellow-300 p-4">
              <p className="text-sm font-semibold">3. Open Solo 401(k) After S-Corp</p>
              <p className="text-xs text-muted-foreground mt-1">
                Max contribution: $69,000/year (2026). Requires S-Corp. Open at Fidelity or Schwab. 
                Employee ($23,500) + employer (25% of salary) contributions. 
                This reduces your taxable income by up to $69K.
              </p>
            </div>
            <div className="rounded-lg border p-4">
              <p className="text-sm font-semibold">4. Backdoor Roth IRA — $14,000/year</p>
              <p className="text-xs text-muted-foreground mt-1">
                $7,000 each for you and your wife. Contribute to Traditional IRA, convert to Roth. 
                Tax-free growth for 27+ years. Consult CPA about pro-rata rule before executing.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground text-center">
        All calculations are estimates for educational purposes. Tax rates are approximate and based on 2026 projected brackets. 
        Consult a licensed CPA or tax attorney before making tax elections or estimated payments.
      </p>
    </div>
  );
}
