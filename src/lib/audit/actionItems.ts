/**
 * Reconciles Data Health findings into public.action_items so they surface in
 * the user's existing action-item workflow.
 *
 * Idempotency: items are namespaced with category = 'data_health' and keyed on
 * a deterministic label (effectively check_key + period). A nightly run UPDATES
 * the matching item instead of creating a new one; when a finding clears, its
 * item is marked done and the corresponding open findings get resolved_at set.
 *
 * action_items.status is constrained to
 * ('overdue','in_progress','on_track','done','snoozed') — 'open' is NOT valid.
 * We map critical → 'overdue', warn → 'in_progress', cleared → 'done'.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { ACTION_ITEM_CATEGORY } from './config';
import { logger } from '../logger';
import { formatCurrency } from '../format';
import type { Finding } from './types';

interface ReconcileResult {
  created: number;
  updated: number;
  resolved: number;
}

function severityToStatus(severity: Finding['severity']): string {
  return severity === 'critical' ? 'overdue' : 'in_progress';
}

function severityToPriority(severity: Finding['severity']): number {
  return severity === 'critical' ? 1 : 3;
}

function summarizeFinding(finding: Finding): string {
  const parts: string[] = [];
  parts.push(`${finding.itemCount} item${finding.itemCount === 1 ? '' : 's'}`);
  if (finding.totalAmount > 0) parts.push(formatCurrency(finding.totalAmount));
  if (finding.period) parts.push(finding.period);
  return `${finding.title} — ${parts.join(', ')}. Surfaced by the nightly Data Health audit.`;
}

export async function reconcileActionItems(
  supabase: SupabaseClient,
  userId: string,
  findings: Finding[]
): Promise<ReconcileResult> {
  const material = findings.filter(
    (f) => f.severity === 'warn' || f.severity === 'critical'
  );

  // Deterministic desired state, keyed by label (last finding with a given
  // label wins, though titles are unique within a run).
  const desired = new Map<string, Finding>();
  for (const f of material) desired.set(f.title, f);

  const { data: existing, error: fetchError } = await supabase
    .from('action_items')
    .select('id, label, status')
    .eq('user_id', userId)
    .eq('category', ACTION_ITEM_CATEGORY);

  if (fetchError) {
    logger.error('Failed to fetch existing action items', { error_message: fetchError.message });
    throw new Error(`action_items fetch failed: ${fetchError.message}`);
  }

  const existingByLabel = new Map((existing ?? []).map((row) => [row.label as string, row]));
  const result: ReconcileResult = { created: 0, updated: 0, resolved: 0 };
  const now = new Date().toISOString();

  // Upsert current findings.
  for (const [label, finding] of desired) {
    const payload = {
      detail: summarizeFinding(finding),
      status: severityToStatus(finding.severity),
      priority: severityToPriority(finding.severity),
      category: ACTION_ITEM_CATEGORY,
      sort_order: finding.severity === 'critical' ? 20 : 40,
      is_active: true,
      updated_at: now,
    };

    const match = existingByLabel.get(label);
    if (match) {
      const { error } = await supabase.from('action_items').update(payload).eq('id', match.id);
      if (error) logger.error('Failed to update action item', { error_message: error.message, label });
      else result.updated++;
    } else {
      const { error } = await supabase
        .from('action_items')
        .insert({ user_id: userId, label, ...payload });
      if (error) logger.error('Failed to insert action item', { error_message: error.message, label });
      else result.created++;
    }
  }

  // Resolve items whose finding has cleared.
  for (const [label, row] of existingByLabel) {
    if (desired.has(label)) continue;
    if (row.status === 'done') continue;

    const { error } = await supabase
      .from('action_items')
      .update({ status: 'done', is_active: false, updated_at: now })
      .eq('id', row.id);
    if (error) {
      logger.error('Failed to resolve action item', { error_message: error.message, label });
      continue;
    }
    result.resolved++;

    // Stamp resolved_at on the now-cleared findings for this check.
    await supabase
      .from('audit_findings')
      .update({ resolved_at: now })
      .eq('user_id', userId)
      .eq('title', label)
      .is('resolved_at', null);
  }

  return result;
}
