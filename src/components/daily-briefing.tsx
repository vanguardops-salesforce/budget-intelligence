'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

type ActionStatus = 'overdue' | 'due' | 'upcoming' | 'done' | 'in_progress' | 'on_track' | 'snoozed';
type TitheStatus = 'owed' | 'partial' | 'paid';

interface BriefingData {
  expectedIncome: number;
  receivedIncome: number;
  incomeByEntity: { entity: string; expected: number; received: number }[];
  totalTitheOwed: number;
  totalTithePaid: number;
  outstandingTithes: { id: string; source: string; entity: string; entityId: string; date: string; income: number; titheOwed: number; tithePaid: number; status: TitheStatus; gap: number }[];
  totalTaxReserveNeeded: number;
  creditCards: { name: string; balance: number }[];
  actions: { label: string; status: ActionStatus; detail: string }[];
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

function ProgressIcon() {
  return (
    <svg className="w-4 h-4 text-blue-400 mr-2 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 12a8 8 0 0116 0M20 12a8 8 0 01-8 8" />
    </svg>
  );
}

function StatusDot({ status }: { status: 'good' | 'warn' | 'alert' | 'info' }) {
  const colors = { good: 'bg-emerald-500', warn: 'bg-amber-500', alert: 'bg-red-500', info: 'bg-blue-400' };
  return <span className={`inline-block w-2 h-2 rounded-full ${colors[status]} mr-2 flex-shrink-0 mt-1.5`} />;
}

function actionIcon(status: ActionStatus) {
  switch (status) {
    case 'done': return <CheckIcon />;
    case 'overdue': return <AlertIcon />;
    case 'due': return <WarnIcon />;
    case 'in_progress': return <ProgressIcon />;
    case 'on_track': return <StatusDot status="good" />;
    default: return <StatusDot status="info" />;
  }
}

function actionLabelClass(status: ActionStatus) {
  switch (status) {
    case 'overdue': return 'text-red-400';
    case 'due': return 'text-amber-400';
    case 'in_progress': return 'text-blue-400';
    case 'on_track': return 'text-emerald-400';
    case 'done': return 'text-zinc-500 line-through';
    default: return '';
  }
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

        const { data: persistentActions } = await supabase
          .from('action_items')
          .select('label, detail, status, sort_order, due_date')
          .eq('user_id', user.id)
          .eq('is_active', true)
          .neq('status', 'snoozed')
          .order('sort_order', { ascending: true });

        // Tithing now reads from the ledger, not recomputed
        const { data: outstandingTithesRaw } = await supabase
          .from('tithe_log')
          .select('id, entity_id, income_date, income_source, income_amount, tithe_owed, tithe_paid, status')
          .eq('user_id', user.id)
          .eq('is_bonus', false)
          .in('status', ['owed', 'partial'])
          .order('income_date', { ascending: true });

        // Period totals from ledger (paid + owed) for the "Total paid of owed" line
        const { data: periodTithes } = await supabase
          .from('tithe_log')
          .select('tithe_owed, tithe_paid, status')
          .eq('user_id', user.id)
          .eq('is_bonus', false)
          .gte('income_date', period.start)
          .lte('income_date', period.end);

        const transactions = txns || [];
        const sources = incomeSources || [];
        const allAccounts = accounts || [];

        const expectedIncome = sources.reduce((sum: number, s: any) => sum + Number(s.estimated_monthly || 0), 0);

        const matchSource = (t: any) => {
          const merchant = (t.merchant_name || t.name || '').toLowerCase();
          if (!merchant) return null;
          for (const s of sources) {
            const raw = s.merchant_patterns;
            if (!raw) continue;
            const rawArray = Array.isArray(raw)
              ? raw
              : String(raw).replace(/^\{|\}$/g, '').split(',');
            const patterns = rawArray
              .map((p: string) => p.trim().replace(/^["']|["']$/g, '').replace(/%/g, '').toLowerCase())
              .filter(Boolean);
            if (patterns.length > 0 && patterns.some((p: string) => merchant.includes(p))) {
              return s;
            }
          }
          return null;
        };

        const incomeItems: { txn: any; source: any; amount: number }[] = [];
        for (const t of transactions) {
          if (Number(t.amount) >= 0) continue;
          const source = matchSource(t);
          if (source) {
            incomeItems.push({ txn: t, source, amount: Math.abs(Number(t.amount)) });
          }
        }

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

        // Build outstanding tithes from ledger
        const outstandingTithes = (outstandingTithesRaw || []).map((row: any) => ({
          id: row.id,
          source: row.income_source,
          entity: ENTITY_LABELS[row.entity_id] || row.entity_id,
          entityId: row.entity_id,
          date: row.income_date,
          income: Number(row.income_amount),
          titheOwed: Number(row.tithe_owed),
          tithePaid: Number(row.tithe_paid),
          status: row.status as TitheStatus,
          gap: Number(row.tithe_owed) - Number(row.tithe_paid),
        }));

        // Period totals (this period's obligations)
        const totalTitheOwed = (periodTithes || []).reduce((sum: number, r: any) => sum + Number(r.tithe_owed), 0);
        const totalTithePaid = (periodTithes || []).reduce((sum: number, r: any) => sum + Number(r.tithe_paid), 0);

        const income1099 = incomeItems
          .filter(i => i.source.type === '1099')
          .reduce((sum, i) => sum + i.amount, 0);
        const totalTaxReserveNeeded = income1099 * 0.38;

        const creditCardAccounts = allAccounts.filter((a: any) => a.type === 'credit' || a.subtype === 'credit card');
        const creditCards = creditCardAccounts.map((a: any) => ({
          name: a.name || 'Unknown Card',
          balance: Math.abs(Number(a.balance_current || 0)),
        }));

        const actions: BriefingData['actions'] = [];

        // Total outstanding tithe across ALL time, not just this period
        const totalOutstanding = outstandingTithes.reduce((sum, t) => sum + t.gap, 0);
        if (totalOutstanding > 0.5) {
          actions.push({ label: `Tithe outstanding: ${fmt(totalOutstanding)}`, status: 'due', detail: `${outstandingTithes.length} unpaid paycheck${outstandingTithes.length === 1 ? '' : 's'}` });
        }

        if (totalTaxReserveNeeded > 0) {
          actions.push({ label: `Move ${fmt(totalTaxReserveNeeded)} to tax reserve HYSA`, status: income1099 > 0 ? 'due' : 'upcoming', detail: '38% of 1099 income this period' });
        }

        for (const a of persistentActions || []) {
          actions.push({
            label: a.label,
            detail: a.detail || '',
            status: a.status as ActionStatus,
          });
        }

        setData({
          expectedIncome, receivedIncome, incomeByEntity,
          totalTitheOwed, totalTithePaid,
          outstandingTithes,
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
  const incomePercent = data.expectedIncome > 0 ? Math.round((data.receivedIncome / data.expectedIncome) * 100) : 0;
  const overdueCount = data.actions.filter(a => a.status === 'overdue').length;
  const dueCount = data.actions.filter(a => a.status === 'due').length;
  const inProgressCount = data.actions.filter(a => a.status === 'in_progress').length;
  const totalOutstanding = data.outstandingTithes.reduce((sum, t) => sum + t.gap, 0);

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
          {inProgressCount > 0 && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-900/40 text-blue-400">
              {inProgressCount} in progress
            </span>
          )}
          {overdueCount === 0 && dueCount === 0 && inProgressCount === 0 && (
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
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-2">Tithing — 10% (from ledger)</h3>
            <div className="space-y-1.5">
              {data.outstandingTithes.length === 0 ? (
                <div className="flex items-start text-sm">
                  <CheckIcon />
                  <span className="text-emerald-400">All paychecks tithed — fully reconciled</span>
                </div>
              ) : (
                <>
                  {data.outstandingTithes.map((item) => {
                    const dateStr = new Date(item.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
                    return (
                      <div key={item.id} className="flex items-start text-sm">
                        {item.status === 'partial' ? <WarnIcon /> : <AlertIcon />}
                        <span>
                          <span className={item.status === 'partial' ? 'text-amber-400' : 'text-red-400'}>
                            {item.status === 'partial' ? `Partial: ${fmt(item.gap)} still owed` : `Tithe ${fmt(item.titheOwed)} owed`}
                          </span>
                          <span className="text-zinc-400 ml-1">— {item.entity} · {item.source} · {dateStr} ({fmt(item.income)} gross)</span>
                        </span>
                      </div>
                    );
                  })}
                  <div className="flex items-start text-sm mt-1 pt-2 border-t border-zinc-700">
                    <StatusDot status="warn" />
                    <span className="text-amber-400">
                      Total outstanding: {fmt(totalOutstanding)} across {data.outstandingTithes.length} paycheck{data.outstandingTithes.length === 1 ? '' : 's'}
                    </span>
                  </div>
                </>
              )}
              {data.totalTitheOwed > 0 && (
                <div className="flex items-start text-sm mt-2 pt-2 border-t border-zinc-700">
                  <StatusDot status={data.totalTithePaid >= data.totalTitheOwed ? 'good' : 'warn'} />
                  <span className={data.totalTithePaid >= data.totalTitheOwed ? 'text-emerald-400' : 'text-zinc-400'}>
                    This period: {fmt(data.totalTithePaid)} of {fmt(data.totalTitheOwed)} owed
                  </span>
                </div>
              )}
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
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-2">Retirement — $3M Target (Work-Optional)</h3>
            <div className="space-y-1.5">
              <div className="flex items-start text-sm">
                <StatusDot status="info" />
                <span className="text-zinc-400">~$317K invested · ~$58K/yr rental NOI · Target: age 46–48</span>
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
                  const order: Record<ActionStatus, number> = { overdue: 0, due: 1, in_progress: 2, on_track: 3, upcoming: 4, done: 5, snoozed: 6 };
                  return order[a.status] - order[b.status];
                })
                .map((action, i) => (
                  <div key={i} className="flex items-start text-sm">
                    {actionIcon(action.status)}
                    <div>
                      <span className={`font-medium ${actionLabelClass(action.status)}`}>{action.label}</span>
                      {action.detail && <span className="text-zinc-400 ml-1">— {action.detail}</span>}
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