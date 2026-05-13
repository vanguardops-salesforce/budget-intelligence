import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { requireMFA } from '@/lib/supabase/auth-config';
import { toClientError, ValidationError } from '@/lib/errors';
import { writeAuditLog, getClientIP } from '@/lib/audit';
import { logger } from '@/lib/logger';

const schema = z.object({
  account_id: z.string().uuid(),
  entity_id: z.string().uuid(),
});

/**
 * PATCH /api/accounts/assign-entity
 * Reassign a linked account to a different entity.
 * Also updates all transactions belonging to that account.
 */
export async function PATCH(request: Request) {
  try {
    const supabase = createServerSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
    }

    await requireMFA(supabase);

    const body = await request.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid request body');
    }

    const { account_id, entity_id } = parsed.data;

    // Verify entity ownership (RLS enforces user_id match)
    const { data: entity, error: entityError } = await supabase
      .from('entities')
      .select('id')
      .eq('id', entity_id)
      .eq('is_active', true)
      .single();

    if (entityError || !entity) {
      return NextResponse.json({ error: 'Invalid entity.' }, { status: 400 });
    }

    // Verify account ownership (RLS enforces user_id match)
    const { data: account, error: acctError } = await supabase
      .from('accounts')
      .select('id, entity_id')
      .eq('id', account_id)
      .single();

    if (acctError || !account) {
      return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
    }

    const previousEntityId = account.entity_id;

    // Update the account's entity
    const { error: updateError } = await supabase
      .from('accounts')
      .update({ entity_id })
      .eq('id', account_id);

    if (updateError) {
      logger.error('Failed to update account entity', { error_message: updateError.message });
      return NextResponse.json({ error: 'Failed to reassign account.' }, { status: 500 });
    }

    // Update all transactions for this account to the new entity
    const { error: txUpdateError } = await supabase
      .from('transactions')
      .update({ entity_id })
      .eq('account_id', account_id);

    if (txUpdateError) {
      logger.warn('Failed to update transaction entities', { error_message: txUpdateError.message });
    }

    const ip = getClientIP(request.headers) ?? 'unknown';
    await writeAuditLog(supabase, {
      userId: user.id,
      action: 'PLAID_ITEM_LINKED',
      entityType: 'account',
      entityId: account_id,
      details: {
        previous_entity_id: previousEntityId,
        new_entity_id: entity_id,
        action: 'entity_reassignment',
      },
      ipAddress: ip,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('Account entity assignment error', { error_message: String(error) });
    const clientError = toClientError(error);
    return NextResponse.json({ error: clientError.error }, { status: clientError.status });
  }
}
