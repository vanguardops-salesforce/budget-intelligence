import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { requireMFA } from '@/lib/supabase/auth-config';
import { toClientError, ValidationError } from '@/lib/errors';
import { writeAuditLog, getClientIP } from '@/lib/audit';
import { logger } from '@/lib/logger';

const createSchema = z.object({
  entity_id: z.string().uuid(),
  merchant_pattern: z.string().min(1).max(200),
  category_id: z.string().uuid(),
  priority: z.number().int().min(0).max(1000).default(0),
});

const updateSchema = z.object({
  id: z.string().uuid(),
  merchant_pattern: z.string().min(1).max(200).optional(),
  category_id: z.string().uuid().optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  is_active: z.boolean().optional(),
});

const deleteSchema = z.object({
  id: z.string().uuid(),
});

/**
 * GET /api/transaction-rules
 * List all transaction rules for the authenticated user.
 */
export async function GET() {
  try {
    const supabase = createServerSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
    }

    await requireMFA(supabase);

    const { data: rules, error } = await supabase
      .from('transaction_rules')
      .select(`
        id, entity_id, merchant_pattern, category_id, priority, is_active, created_at,
        budget_categories!transaction_rules_category_id_fkey(name),
        entities!transaction_rules_entity_id_fkey(name)
      `)
      .order('priority', { ascending: false })
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('Failed to fetch transaction rules', { error_message: error.message });
      return NextResponse.json({ error: 'Failed to fetch rules.' }, { status: 500 });
    }

    return NextResponse.json({ rules: rules ?? [] });
  } catch (error) {
    logger.error('Transaction rules GET error', { error_message: String(error) });
    const clientError = toClientError(error);
    return NextResponse.json({ error: clientError.error }, { status: clientError.status });
  }
}

/**
 * POST /api/transaction-rules
 * Create a new auto-categorization rule.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = createServerSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
    }

    await requireMFA(supabase);

    const body = await request.json();
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid request body');
    }

    const { entity_id, merchant_pattern, category_id, priority } = parsed.data;

    // Verify entity ownership
    const { data: entity } = await supabase
      .from('entities')
      .select('id')
      .eq('id', entity_id)
      .eq('is_active', true)
      .single();

    if (!entity) {
      return NextResponse.json({ error: 'Invalid entity.' }, { status: 400 });
    }

    // Verify category ownership
    const { data: category } = await supabase
      .from('budget_categories')
      .select('id')
      .eq('id', category_id)
      .eq('is_active', true)
      .single();

    if (!category) {
      return NextResponse.json({ error: 'Invalid category.' }, { status: 400 });
    }

    const { data: rule, error } = await supabase
      .from('transaction_rules')
      .insert({
        user_id: user.id,
        entity_id,
        merchant_pattern,
        category_id,
        priority,
      })
      .select('id')
      .single();

    if (error) {
      logger.error('Failed to create transaction rule', { error_message: error.message });
      return NextResponse.json({ error: 'Failed to create rule.' }, { status: 500 });
    }

    const ip = getClientIP(request.headers) ?? 'unknown';
    await writeAuditLog(supabase, {
      userId: user.id,
      action: 'BUDGET_MODIFIED',
      entityType: 'transaction_rule',
      entityId: rule?.id,
      details: { merchant_pattern, category_id, priority, action: 'created' },
      ipAddress: ip,
    });

    return NextResponse.json({ success: true, rule_id: rule?.id });
  } catch (error) {
    logger.error('Transaction rules POST error', { error_message: String(error) });
    const clientError = toClientError(error);
    return NextResponse.json({ error: clientError.error }, { status: clientError.status });
  }
}

/**
 * PATCH /api/transaction-rules
 * Update an existing transaction rule.
 */
export async function PATCH(request: NextRequest) {
  try {
    const supabase = createServerSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
    }

    await requireMFA(supabase);

    const body = await request.json();
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid request body');
    }

    const { id, ...updates } = parsed.data;

    // RLS ensures user can only update their own rules
    const { error } = await supabase
      .from('transaction_rules')
      .update(updates)
      .eq('id', id);

    if (error) {
      logger.error('Failed to update transaction rule', { error_message: error.message });
      return NextResponse.json({ error: 'Failed to update rule.' }, { status: 500 });
    }

    const ip = getClientIP(request.headers) ?? 'unknown';
    await writeAuditLog(supabase, {
      userId: user.id,
      action: 'BUDGET_MODIFIED',
      entityType: 'transaction_rule',
      entityId: id,
      details: { ...updates, action: 'updated' },
      ipAddress: ip,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('Transaction rules PATCH error', { error_message: String(error) });
    const clientError = toClientError(error);
    return NextResponse.json({ error: clientError.error }, { status: clientError.status });
  }
}

/**
 * DELETE /api/transaction-rules
 * Delete a transaction rule.
 */
export async function DELETE(request: NextRequest) {
  try {
    const supabase = createServerSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
    }

    await requireMFA(supabase);

    const body = await request.json();
    const parsed = deleteSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid request body');
    }

    // RLS ensures user can only delete their own rules
    const { error } = await supabase
      .from('transaction_rules')
      .delete()
      .eq('id', parsed.data.id);

    if (error) {
      logger.error('Failed to delete transaction rule', { error_message: error.message });
      return NextResponse.json({ error: 'Failed to delete rule.' }, { status: 500 });
    }

    const ip = getClientIP(request.headers) ?? 'unknown';
    await writeAuditLog(supabase, {
      userId: user.id,
      action: 'BUDGET_MODIFIED',
      entityType: 'transaction_rule',
      entityId: parsed.data.id,
      details: { action: 'deleted' },
      ipAddress: ip,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('Transaction rules DELETE error', { error_message: String(error) });
    const clientError = toClientError(error);
    return NextResponse.json({ error: clientError.error }, { status: clientError.status });
  }
}
