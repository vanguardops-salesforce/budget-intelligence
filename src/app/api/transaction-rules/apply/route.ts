import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { requireMFA } from '@/lib/supabase/auth-config';
import { toClientError } from '@/lib/errors';
import { writeAuditLog, getClientIP } from '@/lib/audit';
import { logger } from '@/lib/logger';

/**
 * POST /api/transaction-rules/apply
 * Retroactively apply all active rules to uncategorized transactions.
 * Matches merchant_pattern (case-insensitive substring) against merchant_name.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = createServerSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
    }

    await requireMFA(supabase);

    // Fetch all active rules for this user
    const { data: rules, error: rulesError } = await supabase
      .from('transaction_rules')
      .select('id, entity_id, merchant_pattern, category_id, priority')
      .eq('is_active', true)
      .order('priority', { ascending: false });

    if (rulesError) {
      logger.error('Failed to fetch rules for apply', { error_message: rulesError.message });
      return NextResponse.json({ error: 'Failed to fetch rules.' }, { status: 500 });
    }

    if (!rules || rules.length === 0) {
      return NextResponse.json({ applied: 0, message: 'No active rules to apply.' });
    }

    // Fetch uncategorized transactions
    const { data: transactions, error: txError } = await supabase
      .from('transactions')
      .select('id, entity_id, merchant_name')
      .is('user_category_id', null)
      .is('deleted_at', null)
      .not('merchant_name', 'is', null);

    if (txError) {
      logger.error('Failed to fetch transactions for rule apply', { error_message: txError.message });
      return NextResponse.json({ error: 'Failed to fetch transactions.' }, { status: 500 });
    }

    let appliedCount = 0;

    for (const tx of transactions ?? []) {
      if (!tx.merchant_name) continue;

      const merchantLower = tx.merchant_name.toLowerCase();

      // Find first matching rule (highest priority first)
      const matchingRule = rules.find(
        (rule) =>
          rule.entity_id === tx.entity_id &&
          merchantLower.includes(rule.merchant_pattern.toLowerCase())
      );

      if (matchingRule) {
        const { error: updateError } = await supabase
          .from('transactions')
          .update({ user_category_id: matchingRule.category_id })
          .eq('id', tx.id);

        if (!updateError) {
          appliedCount++;
        }
      }
    }

    const ip = getClientIP(request.headers) ?? 'unknown';
    await writeAuditLog(supabase, {
      userId: user.id,
      action: 'BUDGET_MODIFIED',
      entityType: 'transaction_rule',
      details: { action: 'bulk_apply', transactions_updated: appliedCount },
      ipAddress: ip,
    });

    logger.info('Transaction rules applied retroactively', {
      user_id: user.id,
      rules_count: rules.length,
      applied: appliedCount,
    });

    return NextResponse.json({ applied: appliedCount });
  } catch (error) {
    logger.error('Transaction rules apply error', { error_message: String(error) });
    const clientError = toClientError(error);
    return NextResponse.json({ error: clientError.error }, { status: clientError.status });
  }
}
