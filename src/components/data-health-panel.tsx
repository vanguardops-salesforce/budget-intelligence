'use client';

import { useState, useCallback } from 'react';
import { Badge } from '@/components/ui/badge';
import { formatCurrency, formatRelativeTime } from '@/lib/format';
import type { LatestAudit, AuditFindingRow } from '@/lib/audit/runner';
import {
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  ChevronRight,
  RefreshCw,
} from 'lucide-react';

interface CheckMeta {
  key: string;
  label: string;
  description: string;
}

// Ordered to match the spec's checks A–F.
const CHECKS: CheckMeta[] = [
  { key: 'unclassified_deposits', label: 'Unclassified deposits', description: 'Deposits ≥ $500 with no income source or tithe match' },
  { key: 'tithe_gaps', label: 'Tithe owed vs paid', description: 'Per-entity gaps across recent budget months' },
  { key: 'stale_balances', label: 'Stale balances', description: 'Account snapshots older than 3 days' },
  { key: 'duplicate_transactions', label: 'Duplicate transactions', description: 'Same account, amount, and date' },
  { key: 'plaid_item_health', label: 'Plaid connections', description: 'Items not syncing or accounts not linked' },
  { key: 'tithe_idempotency', label: 'Tithe idempotency', description: 'Duplicate tithe_log income entries' },
];

interface DataHealthPanelProps {
  initial: LatestAudit | null;
}

export function DataHealthPanel({ initial }: DataHealthPanelProps) {
  const [latest, setLatest] = useState<LatestAudit | null>(initial);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const runNow = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch('/api/audit/run', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Audit failed to run.');
      }
      const data = await res.json();
      setLatest(data.latest ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Audit failed to run.');
    } finally {
      setRunning(false);
    }
  }, []);

  const findings = latest?.findings ?? [];
  const findingsByCheck = new Map<string, AuditFindingRow[]>();
  for (const f of findings.filter((f) => !f.resolved_at)) {
    const arr = findingsByCheck.get(f.check_key) ?? [];
    arr.push(f);
    findingsByCheck.set(f.check_key, arr);
  }

  const criticalCount = findings.filter((f) => !f.resolved_at && f.severity === 'critical').length;
  const warnCount = findings.filter((f) => !f.resolved_at && f.severity === 'warn').length;
  const overall = criticalCount > 0 ? 'critical' : warnCount > 0 ? 'warn' : 'clear';

  const overallConfig = {
    clear: { Icon: ShieldCheck, color: 'text-green-600', bg: 'bg-green-50 border-green-200', label: 'All clear' },
    warn: { Icon: ShieldAlert, color: 'text-yellow-600', bg: 'bg-yellow-50 border-yellow-200', label: `${warnCount} warning${warnCount === 1 ? '' : 's'}` },
    critical: { Icon: ShieldX, color: 'text-red-600', bg: 'bg-red-50 border-red-200', label: `${criticalCount} critical` },
  }[overall];
  const OverallIcon = overallConfig.Icon;

  return (
    <div className="space-y-4">
      {/* Overall status + Run now */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className={`flex items-center gap-3 rounded-lg border p-3 ${overallConfig.bg} flex-1`}>
          <OverallIcon className={`h-5 w-5 shrink-0 ${overallConfig.color}`} />
          <div className="flex-1 min-w-0">
            <p className={`text-sm font-medium ${overallConfig.color}`}>{overallConfig.label}</p>
            <p className="text-xs text-muted-foreground">
              {latest
                ? `Last run ${formatRelativeTime(latest.run.run_at)} · ${latest.run.triggered_by}${latest.run.status === 'failed' ? ' · run failed' : ''}`
                : 'No audit has run yet'}
            </p>
          </div>
        </div>
        <button
          onClick={runNow}
          disabled={running}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border bg-background px-3 py-2 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 shrink-0"
        >
          <RefreshCw className={`h-4 w-4 ${running ? 'animate-spin' : ''}`} />
          {running ? 'Running…' : 'Run now'}
        </button>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 p-3">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Per-check rows */}
      <div className="divide-y rounded-lg border">
        {CHECKS.map((check) => {
          const checkFindings = findingsByCheck.get(check.key) ?? [];
          const hasFindings = checkFindings.length > 0;
          const isCritical = checkFindings.some((f) => f.severity === 'critical');
          const count = checkFindings.reduce((s, f) => s + f.item_count, 0);
          const total = checkFindings.reduce((s, f) => s + Number(f.total_amount), 0);
          const isOpen = expanded === check.key;

          return (
            <div key={check.key}>
              <button
                onClick={() => setExpanded(isOpen ? null : check.key)}
                disabled={!hasFindings}
                className="flex w-full items-center gap-3 p-3 text-left disabled:cursor-default"
              >
                <span className="shrink-0">
                  {!hasFindings ? (
                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                  ) : isCritical ? (
                    <XCircle className="h-4 w-4 text-red-500" />
                  ) : (
                    <AlertTriangle className="h-4 w-4 text-yellow-500" />
                  )}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium leading-none">{check.label}</span>
                  <span className="block text-xs text-muted-foreground mt-0.5 truncate">{check.description}</span>
                </span>
                {hasFindings && (
                  <span className="flex items-center gap-2 shrink-0">
                    {total > 0 && (
                      <span className="text-sm font-semibold tabular-nums">{formatCurrency(total)}</span>
                    )}
                    <Badge variant={isCritical ? 'danger' : 'warning'}>{count}</Badge>
                    <ChevronRight className={`h-4 w-4 text-muted-foreground transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                  </span>
                )}
              </button>

              {isOpen && hasFindings && (
                <div className="border-t bg-muted/30 p-3">
                  {checkFindings.map((f) => (
                    <FindingDetail key={f.id} finding={f} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FindingDetail({ finding }: { finding: AuditFindingRow }) {
  const detail = finding.detail as Record<string, unknown>;
  const rows = Array.isArray(detail.rows) ? (detail.rows as Record<string, unknown>[]) : null;
  const staleItems = Array.isArray(detail.staleItems) ? (detail.staleItems as Record<string, unknown>[]) : null;
  const missingAccounts = Array.isArray(detail.missingAccounts) ? (detail.missingAccounts as string[]) : null;
  const duplicates = Array.isArray(detail.duplicates) ? (detail.duplicates as Record<string, unknown>[]) : null;

  return (
    <div className="space-y-2 text-xs">
      <p className="font-medium text-foreground">{finding.title}{finding.period ? ` · ${finding.period}` : ''}</p>

      {/* Tithe gap shape */}
      {finding.check_key === 'tithe_gaps' && (
        <p className="text-muted-foreground">
          Owed {formatCurrency(Number(detail.owed) || 0)} · Paid {formatCurrency(Number(detail.paid) || 0)} ·{' '}
          <span className="font-medium text-yellow-700">Gap {formatCurrency(Number(detail.gap) || 0)}</span>
        </p>
      )}

      {rows && <DetailTable rows={rows} />}

      {staleItems && staleItems.length > 0 && (
        <ul className="space-y-1">
          {staleItems.map((it, i) => (
            <li key={i} className="text-muted-foreground">
              <span className="font-medium text-foreground">{String(it.institution)}</span>
              {' — last sync '}
              {it.lastSync ? formatRelativeTime(String(it.lastSync)) : 'never'}
              {it.status ? ` (${String(it.status)})` : ''}
            </li>
          ))}
        </ul>
      )}

      {missingAccounts && missingAccounts.length > 0 && (
        <p className="text-muted-foreground">Not linked: {missingAccounts.join(', ')}</p>
      )}

      {duplicates && (
        <ul className="space-y-1">
          {duplicates.map((d, i) => (
            <li key={i} className="text-muted-foreground tabular-nums">
              txn {String(d.incomeTransactionId)} ×{String(d.count)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DetailTable({ rows }: { rows: Record<string, unknown>[] }) {
  if (rows.length === 0) return null;
  const columns = Object.keys(rows[0]);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="text-muted-foreground">
            {columns.map((c) => (
              <th key={c} className="pr-3 pb-1 font-medium capitalize">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-t border-border/50">
              {columns.map((c) => (
                <td key={c} className="pr-3 py-1 tabular-nums">{formatCell(c, row[c])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatCell(column: string, value: unknown): string {
  if (value == null) return '—';
  if (typeof value === 'number' && /amount|balance/i.test(column)) {
    return formatCurrency(value);
  }
  return String(value);
}
