'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

interface BriefingData {
  expectedIncome: number;
  receivedIncome: number;
  incomeByEntity: { entity: string; expected: number; received: number }[];
  totalTitheOwed: number;
  totalTithePaid: number;
  titheByEntity: { entity: string; incomeReceived: number; tithePaid: number; gap: number }[];
  tithingItems: { sourceName: string; sourceType: string; entity: string; entityId: string; date: string; income: number; titheOwed: number; paid: boolean }[];
  totalTaxReserveNeeded: number;
  creditCards: { name: string; balance: number }[];
  actions: { label: string; status: 'overdue' | 'due' | 'upcoming' | 'done'; detail: string }[];
  periodStart: string;
  periodEnd: string;
}

function CheckIcon() {
  return (
    <svg className="w-4 h-4 text-emerald-500 mr-2 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg className="w-4 h-4 text-red-500 mr-2 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M12 2l10 18H2L12 2z" />
    </svg>
  );
}

function WarnIcon() {
  return (
    <svg className="w-4 h-4 text-amber-500 mr-2 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01" />
    </svg>
  );
}

function StatusDot({ status }: { status: 'good' | 'warn' | 'alert' | 'info' }) {
  const colors = { good: 'bg-emerald-500', warn: 'bg-amber-500', alert: 'bg-red-500', info: 'bg-blue-400' };
  return <span className={`inline-block w-2 h-2 rounded-full ${colors[status]} mr-2 flex-shrink-0 mt-1.5`} />;
}

const fmt = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);

const ENTITY_IDS: Record<string, string> = {
  personal: '11111111-1111-1111-1111-111111111111',
  vd: '22222222-2222-2222-2222-222222222222',
  vcg: '33333333-3333-3333-3333-333333333333',
};

const ENTITY_LABELS: Record<string, string> = {
  '11111111-1111-1111-1111-111111111111': 'Personal (W-2)',
  '22222222-2222-2222-2222-222222222222': 'Veteran Digital',
  '33333333-3333-3333-3333-333333333333': 'Veteran Capital Group',
};

function isTithingTransaction(merchantName: string): boolean {
  const name = (merchantName || '').toLowerCase();
  return name.includes('north point') || name.includes('community ch');
}

function getCurrentPeriod() {
  const today = new Date();
  const day = today.getDate();
  let start: Date, end: Date;
  if (day >= 15) {
    start = new Date(today.getFullYear(), today.getMonth(), 15);
    end = new Date(today.getFullYear(), today.getMonth() + 1, 14);
  } else {
    start = new Date(today.getFullYear(), today.getMonth() - 1, 15);
    end = new Date(today.getFullYear(), today.getMonth(), 14);
  }
  const f = (d: Date) => d.toISOString().split('T')[0];
  const label = `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  return { start: f(start), end: f(end), label };
}

export default function DailyBriefing() {
  const supabase = createClient();
  const [data, setData] = useState<BriefingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;
        const period = getCurrentPeriod();

        const { data: txns } = await supabase
          .from('transactions')
          .select('id, date, amount, merchant_name, entity_id, account_id')
          .gte('date', period.start)
          .lte('date', period.end)
          .is('deleted_at', null)
          .eq('user_id', user.id);

        const { data: incomeSources } = await supabase
          .from('income_sources')
          .select('*')
          .eq('user_id', user.id)
          .eq('is_active', true);

        const { data: accounts } = await supabase
          .from('accounts')
          .select('id, name, type, subtype, balance_current, entity_id')
          .eq('user_id', user.id)
          .is('deleted_at', null);

        const transactions = txns || [];
        const sources = incomeSources || [];
        const allAccounts = accounts || [];

        const expectedIncome = sources.reduce((sum: number, s: any) => sum + Number(s.estimated_monthly || 0), 0);

        // Match deposits against merchant_patterns from income_sources
        const matchSource = (t: any) => {
          const merchant = (t.merchant_name || t.name || '').toLowerCase();
          if (!merchant) return null;
          for (const s of sources) {
            const raw = s.merchant_patterns;
            if (!raw) continue; // skip sources without explicit merchant patterns
            const patterns = (typeof raw === 'string' ? raw : String(raw))
              .split(',').map((p: string) => p.trim().toLowerCase()).filter(Boolean);
            if (patterns.length > 0 && patterns.some((p: string) => merchant.includes(p))) {
              return s;
            }
          }
          return null;
        };

        // Build individual income items with source info
        const incomeItems: { txn: any; source: any; amount: number }[] = [];
        for (const t of transactions) {
          if (Number(t.amount) >= 0) continue;
          const source = matchSource(t);
          if (source) {
            incomeItems.push({ txn: t, source, amount: Math.abs(Number(t.amount)) });
          }
        }

        const incomeTransactions = incomeItems.map(i => i.txn);
        const receivedIncome = incomeItems.reduce((sum, i) => sum + i.amount, 0);

        const entityIds = [ENTITY_IDS.personal, ENTITY_IDS.vd, ENTITY_IDS.vcg];
        const incomeByEntity = entityIds.map(eid => {
          const entitySources = sources.filter((s: any) => s.entity_id === eid);
          const expected = entitySources.reduce((sum: number, s: any) => sum + Number(s.estimated_monthly || 0), 0);
          const received = incomeItems
            .filter(i => i.txn.entity_id === eid)
            .reduce((sum, i) => sum + i.amount, 0);
          return { entity: ENTITY_LABELS[eid] || eid, expected, received };
        }).filter(e => e.expected > 0 || e.received > 0);

        // Build per-paycheck tithing items
        const tithingItems = incomeItems.map(i => {
          const titheOwed = i.amount * 0.1;
          return {
            sourceName: i.source.name,
            sourceType: i.source.type,
            entity: ENTITY_LABELS[i.txn.entity_id] || i.txn.entity_id,
            entityId: i.txn.entity_id,
            date: i.txn.date,
            income: i.amount,
            titheOwed,
          };
        });

        // Get total tithe paid by entity
        const tithePaidByEntity: Record<string, number> = {};
        for (const eid of entityIds) {
          tithePaidByEntity[eid] = transactions
            .filter((t: any) => t.entity_id === eid && Number(t.amount) > 0 && isTithingTransaction(t.merchant_name))
            .reduce((sum: number, t: any) => sum + Number(t.amount), 0);
        }

        const totalTitheOwed = tithingItems.reduce((sum, i) => sum + i.titheOwed, 0);
        const totalTithePaid = Object.values(tithePaidByEntity).reduce((sum, v) => sum + v, 0);

        // Keep titheByEntity for backward compat
        const titheByEntity = entityIds.map(eid => {
          const entityIncome = incomeItems
            .filter(i => i.txn.entity_id === eid)
            .reduce((sum, i) => sum + i.amount, 0);
          const tithePaid = tithePaidByEntity[eid] || 0;
          const gap = (entityIncome * 0.1) - tithePaid;
          return { entity: ENTITY_LABELS[eid] || eid, incomeReceived: entityIncome, tithePaid, gap: Math.max(0, gap) };
        }).filter(e => e.incomeReceived > 0 || e.tithePaid > 0);

        const income1099 = incomeItems
          .filter(i => i.source.type === '1099')
          .reduce((sum, i) => sum + i.amount, 0);
        const totalTaxReserveNeeded = income1099 * 0.38;

        const creditCardAccounts = allAccounts.filter((a: any) => a.type === 'credit' || a.subtype === 'credit card');
        const creditCards = creditCardAccounts.map((a: any) => ({
          name: a.name || 'Unknown Card',
          balance: Math.abs(Number(a.balance_current || 0)),
        }));

        const today = new Date();
        const actions: BriefingData['actions'] = [];

        const totalTitheGap = totalTitheOwed - totalTithePaid;
        if (totalTitheGap > 50) {
          actions.push({ label: `Tithe gap: ${fmt(totalTitheGap)} owed`, status: 'due', detail: 'Pay before next deposit lands' });
        }

        if (totalTaxReserveNeeded > 0) {
          actions.push({ label: `Move ${fmt(totalTaxReserveNeeded)} to tax reserve HYSA`, status: income1099 > 0 ? 'due' : 'upcoming', detail: '38% of 1099 income this period' });
        }

        const apr15 = new Date(2026, 3, 15);
        const daysToApr15 = Math.ceil((apr15.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        if (daysToApr15 > 0 && daysToApr15 <= 60) {
          actions.push({ label: `Q1 estimated tax due in ${daysToApr15} days`, status: daysToApr15 <= 14 ? 'overdue' : 'upcoming', detail: 'April 15 — file via IRS Direct Pay' });
        }

        actions.push({ label: 'S-Corp election — not filed', status: 'overdue', detail: 'Costing ~$3,000/mo in unnecessary SE tax' });
        actions.push({ label: 'IUL — still paying $2,760/mo', status: 'overdue', detail: 'Reduce to minimum premium or surrender' });
        actions.push({ label: 'CPA — not yet engaged', status: 'overdue', detail: 'Required for S-Corp, quarterly estimates, REP status' });
        actions.push({ label: 'Emergency fund: ~$20K of $60K target', status: 'upcoming', detail: 'Transfer $5,000/mo to Citi Accelerate' });

        // Running ledger: apply tithe payments against income deposits chronologically
        // Sort by date ascending so earliest paychecks get covered first
        const sortedTithingItems = [...tithingItems].sort((a, b) => a.date.localeCompare(b.date));
        let remainingCredit = totalTithePaid;
        const ledgerItems = sortedTithingItems.map(item => {
          if (remainingCredit >= item.titheOwed) {
            remainingCredit -= item.titheOwed;
            return { ...item, paid: true };
          } else if (remainingCredit > 0) {
            const uncovered = item.titheOwed - remainingCredit;
            remainingCredit = 0;
            return { ...item, paid: false, titheOwed: uncovered };
          }
          return { ...item, paid: false };
        });

        setData({
          expectedIncome, receivedIncome, incomeByEntity,
          totalTitheOwed, totalTithePaid, titheByEntity,
          tithingItems: ledgerItems,
          totalTaxReserveNeeded, creditCards, actions,
          periodStart: period.start, periodEnd: period.end,
        });
      } catch (err) {
        console.error('Daily briefing error:', err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [supabase]);

  if (loading) {
    return (
      <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-4 mb-6 animate-pulse">
        <div className="h-5 w-48 bg-zinc-700 rounded mb-3" />
        <div className="space-y-2">
          <div className="h-4 w-full bg-zinc-700 rounded" />
          <div className="h-4 w-3/4 bg-zinc-700 rounded" />
        </div>
      </div>
    );
  }

  if (!data) return null;

  const period = getCurrentPeriod();
  const titheGap = Math.max(0, data.totalTitheOwed - data.totalTithePaid);
  const incomePercent = data.expectedIncome > 0 ? Math.round((data.receivedIncome / data.expectedIncome) * 100) : 0;
  const overdueCount = data.actions.filter(a => a.status === 'overdue').length;
  const dueCount = data.actions.filter(a => a.status === 'due').length;

  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-100 mb-6 overflow-hidden">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center justify-between p-4 hover:bg-zinc-800 transition-colors text-left"
      >
        <div className="flex items-center gap-3">
          <span className="text-lg font-semibold tracking-tight">Daily Briefing</span>
          <span className="text-xs text-zinc-400 font-medium">{period.label}</span>
          {overdueCount > 0 && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-900/40 text-red-400">
              {overdueCount} overdue
            </span>
          )}
          {dueCount > 0 && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-900/40 text-amber-400">
              {dueCount} due now
            </span>
          )}
          {overdueCount === 0 && dueCount === 0 && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-900/40 text-emerald-400">
              All clear
            </span>
          )}
        </div>
        <svg className={`w-5 h-5 text-zinc-400 transition-transform ${collapsed ? '' : 'rotate-180'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {!collapsed && (
        <div className="px-4 pb-4 space-y-4">
          <div className="h-px bg-zinc-700 -mx-4" />

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-2">Tithing — 10%</h3>
            <div className="space-y-1.5">
              {data.tithingItems.length === 0 ? (
                <div className="flex items-start text-sm">
                  <StatusDot status="info" />
                  <span className="text-zinc-400">No income received this period yet</span>
                </div>
              ) : data.totalTithePaid >= data.totalTitheOwed ? (
                <div className="flex items-start text-sm">
                  <CheckIcon />
                  <span className="text-emerald-400">Current on tithing this period</span>
                </div>
              ) : (
                <>
                  {data.tithingItems.filter(item => !item.paid).map((item, i) => {
                    const dateStr = new Date(item.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
                    return (
                      <div key={i} className="flex items-start text-sm">
                        <AlertIcon />
                        <span>
                          <span className="text-red-400">Tithe {fmt(item.titheOwed)} for {item.sourceName} payment on {dateStr}</span>
                          <span className="text-zinc-500 ml-1">({fmt(item.income)} gross)</span>
                        </span>
                      </div>
                    );
                  })}
                  <div className="flex items-start text-sm mt-1">
                    <StatusDot status="warn" />
                    <span className="text-amber-400">
                      Remaining gap: {fmt(data.totalTitheOwed - data.totalTithePaid)}
                    </span>
                  </div>
                </>
              )}
              <div className="flex items-start text-sm mt-2 pt-2 border-t border-zinc-700">
                <StatusDot status={data.totalTithePaid >= data.totalTitheOwed ? 'good' : 'warn'} />
                <span className={data.totalTithePaid >= data.totalTitheOwed ? 'text-emerald-400' : 'text-zinc-400'}>
                  Total paid: {fmt(data.totalTithePaid)} of {fmt(data.totalTitheOwed)} owed
                </span>
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-2">Income — Expected vs Received</h3>
            <div className="space-y-1.5">
              <div className="flex items-start text-sm">
                <StatusDot status={incomePercent >= 80 ? 'good' : incomePercent >= 40 ? 'warn' : 'info'} />
                <span>
                  <span className="font-medium">{fmt(data.receivedIncome)}</span>
                  <span className="text-zinc-400"> of {fmt(data.expectedIncome)} expected ({incomePercent}%)</span>
                </span>
              </div>
              {data.incomeByEntity.map((e, i) => {
                const pct = e.expected > 0 ? Math.round((e.received / e.expected) * 100) : 0;
                return (
                  <div key={i} className="flex items-start text-sm pl-4">
                    <span className="text-zinc-400 mr-1">•</span>
                    <span>{e.entity}: {fmt(e.received)}{e.expected > 0 && <span className="text-zinc-400"> / {fmt(e.expected)} ({pct}%)</span>}</span>
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-2">Tax Reserve — 38% of 1099 Income</h3>
            <div className="space-y-1.5">
              {data.totalTaxReserveNeeded > 0 ? (
                <div className="flex items-start text-sm">
                  <WarnIcon />
                  <span><span className="font-medium">{fmt(data.totalTaxReserveNeeded)}</span><span className="text-zinc-400"> should be in tax reserve HYSA this period</span></span>
                </div>
              ) : (
                <div className="flex items-start text-sm">
                  <StatusDot status="info" />
                  <span className="text-zinc-400">No 1099 income received this period yet</span>
                </div>
              )}
            </div>
          </div>

          {data.creditCards.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-2">Credit Cards</h3>
              <div className="space-y-1.5">
                {data.creditCards.map((cc, i) => (
                  <div key={i} className="flex items-start text-sm">
                    {cc.balance <= 0 ? <CheckIcon /> : <StatusDot status="info" />}
                    <span><span className="font-medium">{cc.name}:</span> {cc.balance <= 0 ? <span className="text-emerald-400">$0 balance</span> : <span>{fmt(cc.balance)} — pay before statement close</span>}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-2">Retirement — $5M Target</h3>
            <div className="space-y-1.5">
              <div className="flex items-start text-sm">
                <StatusDot status="info" />
                <span className="text-zinc-400">~$150K estimated · No accounts linked yet · Target: age 50–55</span>
              </div>
              <div className="flex items-start text-sm pl-4">
                <span className="text-zinc-400 mr-1">•</span>
                <span className="text-zinc-400">Find old TSP/401(k) accounts → Open Solo 401(k) at Fidelity → Start contributing</span>
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-2">Action Items</h3>
            <div className="space-y-1.5">
              {data.actions
                .sort((a, b) => {
                  const order = { overdue: 0, due: 1, upcoming: 2, done: 3 };
                  return order[a.status] - order[b.status];
                })
                .map((action, i) => (
                  <div key={i} className="flex items-start text-sm">
                    {action.status === 'done' ? <CheckIcon /> : action.status === 'overdue' ? <AlertIcon /> : action.status === 'due' ? <WarnIcon /> : <StatusDot status="info" />}
                    <div>
                      <span className={`font-medium ${action.status === 'overdue' ? 'text-red-400' : ''}`}>{action.label}</span>
                      <span className="text-zinc-400 ml-1">— {action.detail}</span>
                    </div>
                  </div>
                ))}
            </div>
          </div>

          <div className="h-px bg-zinc-700 -mx-4" />
          <p className="text-xs text-zinc-400 text-center">
            Priority: Tithe first → Tax reserve → Bills → Emergency fund → Retirement → Surplus
          </p>
        </div>
      )}
    </div>
  );
}
