/**
 * Data Health audit runner.
 *
 * Performs all database IO, invokes the pure checks, persists an audit_run plus
 * its audit_findings, and reconciles action_items. Read-only against financial
 * data: the only writes are to audit_runs, audit_findings, and action_items.
 *
 * Intended to be called with a service-role client (cron, or the manual route
 * after authorizing the user) and scoped to a single user_id.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../logger';
import {
  checkUnclassifiedDeposits,
  checkTitheGaps,
  checkStaleBalances,
  checkDuplicateTransactions,
  checkPlaidItemHealth,
  checkTitheIdempotency,
} from './checks';
import { reconcileActionItems } from './actionItems';
import type {
  AuditAccount,
  AuditEntity,
  AuditIncomeSource,
  AuditPlaidItem,
  AuditSummary,
  AuditTitheRow,
  AuditTransaction,
  Finding,
  Severity,
  TriggeredBy,
} from './types';

export interface AuditRunResult {
  runId: string | null;
  status: 'completed' | 'failed';
  findings: Finding[];
  summary: AuditSummary;
}

const PAGE_SIZE = 1000;

/** Fetch every non-deleted transaction for a user, paging past the 1000-row cap. */
async function fetchAllTransactions(
  supabase: SupabaseClient,
  userId: string
): Promise<AuditTransaction[]> {
  const rows: AuditTransaction[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('transactions')
      .select('id, account_id, entity_id, amount, date, merchant_name')
      .eq('user_id', userId)
      .is('deleted_at', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw new Error(`transactions fetch failed: ${error.message}`);
    const page = data ?? [];
    for (const t of page) {
      rows.push({
        id: t.id,
        account_id: t.account_id,
        entity_id: t.entity_id,
        amount: Number(t.amount),
        date: t.date,
        merchant_name: t.merchant_name,
      });
    }
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

function buildSummary(findings: Finding[], syncState?: AuditSummary['syncState']): AuditSummary {
  const counts: Record<Severity, number> = { info: 0, warn: 0, critical: 0 };
  for (const f of findings) counts[f.severity]++;
  return { counts, totalFindings: findings.length, syncState };
}

export async function runDataHealthAudit(
  supabase: SupabaseClient,
  userId: string,
  triggeredBy: TriggeredBy,
  syncState?: AuditSummary['syncState']
): Promise<AuditRunResult> {
  try {
    const [accountsRes, plaidItemsRes, incomeSourcesRes, titheRes, entitiesRes, transactions] =
      await Promise.all([
        supabase
          .from('accounts')
          .select('id, name, type, subtype, current_balance, updated_at, is_active, entity_id, plaid_item_id')
          .eq('user_id', userId)
          .is('deleted_at', null),
        supabase
          .from('plaid_items')
          .select('id, institution_name, status, last_successful_sync, error_count, last_error_code')
          .eq('user_id', userId),
        supabase
          .from('income_sources')
          .select('id, name, entity_id, merchant_patterns')
          .eq('user_id', userId)
          .eq('is_active', true),
        supabase
          .from('tithe_log')
          .select('id, entity_id, income_date, tithe_owed, tithe_paid, income_transaction_id')
          .eq('user_id', userId),
        supabase.from('entities').select('id, name').eq('user_id', userId),
        fetchAllTransactions(supabase, userId),
      ]);

    for (const [name, res] of [
      ['accounts', accountsRes],
      ['plaid_items', plaidItemsRes],
      ['income_sources', incomeSourcesRes],
      ['tithe_log', titheRes],
      ['entities', entitiesRes],
    ] as const) {
      if (res.error) throw new Error(`${name} fetch failed: ${res.error.message}`);
    }

    const accounts: AuditAccount[] = (accountsRes.data ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      subtype: a.subtype,
      current_balance: a.current_balance == null ? null : Number(a.current_balance),
      updated_at: a.updated_at,
      is_active: a.is_active,
      entity_id: a.entity_id,
      plaid_item_id: a.plaid_item_id,
    }));
    const plaidItems = (plaidItemsRes.data ?? []) as AuditPlaidItem[];
    const incomeSources = (incomeSourcesRes.data ?? []) as AuditIncomeSource[];
    const titheRows: AuditTitheRow[] = (titheRes.data ?? []).map((r) => ({
      id: r.id,
      entity_id: r.entity_id,
      income_date: r.income_date,
      tithe_owed: Number(r.tithe_owed) || 0,
      tithe_paid: Number(r.tithe_paid) || 0,
      income_transaction_id: r.income_transaction_id,
    }));
    const entities = (entitiesRes.data ?? []) as AuditEntity[];

    const titheIncomeTxnIds = new Set(
      titheRows.map((r) => r.income_transaction_id).filter((id): id is string => !!id)
    );

    const now = new Date();
    const findings: Finding[] = [
      ...checkUnclassifiedDeposits(transactions, accounts, incomeSources, titheIncomeTxnIds),
      ...checkTitheGaps(titheRows, entities, now),
      ...checkStaleBalances(accounts, transactions, now),
      ...checkDuplicateTransactions(transactions, accounts),
      ...checkPlaidItemHealth(plaidItems, accounts, undefined, now),
      ...checkTitheIdempotency(titheRows),
    ];

    const summary = buildSummary(findings, syncState);

    const { data: run, error: runError } = await supabase
      .from('audit_runs')
      .insert({ user_id: userId, triggered_by: triggeredBy, status: 'completed', summary })
      .select('id')
      .single();

    if (runError || !run) throw new Error(`audit_runs insert failed: ${runError?.message}`);

    if (findings.length > 0) {
      const { error: findingsError } = await supabase.from('audit_findings').insert(
        findings.map((f) => ({
          run_id: run.id,
          user_id: userId,
          check_key: f.checkKey,
          severity: f.severity,
          title: f.title,
          detail: f.detail,
          item_count: f.itemCount,
          total_amount: f.totalAmount,
          period: f.period,
        }))
      );
      if (findingsError) throw new Error(`audit_findings insert failed: ${findingsError.message}`);
    }

    const reconciled = await reconcileActionItems(supabase, userId, findings);

    logger.info('Data Health audit completed', {
      user_id: userId,
      triggered_by: triggeredBy,
      findings: findings.length,
      critical: summary.counts.critical,
      warn: summary.counts.warn,
      action_items: reconciled,
    });

    return { runId: run.id, status: 'completed', findings, summary };
  } catch (error) {
    const message = String(error);
    logger.error('Data Health audit failed', { user_id: userId, error_message: message });
    // Best-effort record of the failed run so the panel can show it.
    await supabase
      .from('audit_runs')
      .insert({
        user_id: userId,
        triggered_by: triggeredBy,
        status: 'failed',
        summary: { error: message.slice(0, 500), syncState },
      });
    throw error;
  }
}

// ── Read helpers for the dashboard panel and manual route response ──

export interface AuditRunRow {
  id: string;
  run_at: string;
  triggered_by: string;
  status: string;
  summary: AuditSummary & { error?: string };
}

export interface AuditFindingRow {
  id: string;
  check_key: string;
  severity: Severity;
  title: string;
  detail: Record<string, unknown>;
  item_count: number;
  total_amount: number;
  period: string | null;
  resolved_at: string | null;
}

export interface LatestAudit {
  run: AuditRunRow;
  findings: AuditFindingRow[];
}

/** Most recent run for a user plus its findings, or null if none exist yet. */
export async function getLatestAudit(
  supabase: SupabaseClient,
  userId: string
): Promise<LatestAudit | null> {
  const { data: run, error } = await supabase
    .from('audit_runs')
    .select('id, run_at, triggered_by, status, summary')
    .eq('user_id', userId)
    .order('run_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`audit_runs fetch failed: ${error.message}`);
  if (!run) return null;

  const { data: findings, error: findingsError } = await supabase
    .from('audit_findings')
    .select('id, check_key, severity, title, detail, item_count, total_amount, period, resolved_at')
    .eq('run_id', run.id)
    .order('severity', { ascending: true });

  if (findingsError) throw new Error(`audit_findings fetch failed: ${findingsError.message}`);

  return { run: run as AuditRunRow, findings: (findings ?? []) as AuditFindingRow[] };
}
