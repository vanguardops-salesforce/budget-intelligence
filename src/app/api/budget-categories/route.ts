import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { requireMFA } from '@/lib/supabase/auth-config';
import { toClientError, ValidationError } from '@/lib/errors';
import { writeAuditLog, getClientIP } from '@/lib/audit';
import { logger } from '@/lib/logger';

const createSchema = z.object({
  entity_id: z.string().uuid(),
  name: z.string().min(1).max(100).trim(),
  monthly_budget_amount: z.number().min(0).max(99_999_999).nullable().default(null),
  parent_category_id: z.string().uuid().nullable().default(null),
});

const updateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100).trim().optional(),
  monthly_budget_amount: z.number().min(0).max(99_999_999).nullable().optional(),
  is_active: z.boolean().optional(),
});

const deleteSchema = z.object({
  id: z.string().uuid(),
});

/**
 * GET /api/budget-categories
 * List all budget categories for the authenticated user.
 */
export async function GET() {
  try {
    const supabase = createServerSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
    }

    await requireMFA(supabase);

    const { data: categories, error } = await supabase
      .from('budget_categories')
      .select(`
        id, entity_id, name, monthly_budget_amount, parent_category_id, is_active, created_at,
        entities!budget_categories_entity_id_fkey(name)
      `)
      .order('name');

    if (error) {
      logger.error('Failed to fetch budget categories', { error_message: error.message });
      return NextResponse.json({ error: 'Failed to fetch categories.' }, { status: 500 });
    }

    return NextResponse.json({ categories: categories ?? [] });
  } catch (error) {
    logger.error('Budget categories GET error', { error_message: String(error) });
    const clientError = toClientError(error);
    return NextResponse.json({ error: clientError.error }, { status: clientError.status });
  }
}

/**
 * POST /api/budget-categories
 * Create a new budget category.
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

    const { entity_id, name, monthly_budget_amount, parent_category_id } = parsed.data;

    // Verify entity ownership (RLS enforces user_id match)
    const { data: entity } = await supabase
      .from('entities')
      .select('id')
      .eq('id', entity_id)
      .eq('is_active', true)
      .single();

    if (!entity) {
      return NextResponse.json({ error: 'Invalid entity.' }, { status: 400 });
    }

    // Verify parent category if specified
    if (parent_category_id) {
      const { data: parent } = await supabase
        .from('budget_categories')
        .select('id')
        .eq('id', parent_category_id)
        .eq('entity_id', entity_id)
        .single();

      if (!parent) {
        return NextResponse.json({ error: 'Invalid parent category.' }, { status: 400 });
      }
    }

    const { data: category, error } = await supabase
      .from('budget_categories')
      .insert({
        user_id: user.id,
        entity_id,
        name,
        monthly_budget_amount,
        parent_category_id,
      })
      .select('id')
      .single();

    if (error) {
      logger.error('Failed to create budget category', { error_message: error.message });
      return NextResponse.json({ error: 'Failed to create category.' }, { status: 500 });
    }

    const ip = getClientIP(request.headers) ?? 'unknown';
    await writeAuditLog(supabase, {
      userId: user.id,
      action: 'BUDGET_MODIFIED',
      entityType: 'budget_category',
      entityId: category?.id,
      details: { name, monthly_budget_amount, entity_id, action: 'created' },
      ipAddress: ip,
    });

    return NextResponse.json({ success: true, category_id: category?.id });
  } catch (error) {
    logger.error('Budget categories POST error', { error_message: String(error) });
    const clientError = toClientError(error);
    return NextResponse.json({ error: clientError.error }, { status: clientError.status });
  }
}

/**
 * PATCH /api/budget-categories
 * Update a budget category (name, amount, active status).
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

    // RLS ensures user can only update their own categories
    const { error } = await supabase
      .from('budget_categories')
      .update(updates)
      .eq('id', id);

    if (error) {
      logger.error('Failed to update budget category', { error_message: error.message });
      return NextResponse.json({ error: 'Failed to update category.' }, { status: 500 });
    }

    const ip = getClientIP(request.headers) ?? 'unknown';
    await writeAuditLog(supabase, {
      userId: user.id,
      action: 'BUDGET_MODIFIED',
      entityType: 'budget_category',
      entityId: id,
      details: { ...updates, action: 'updated' },
      ipAddress: ip,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('Budget categories PATCH error', { error_message: String(error) });
    const clientError = toClientError(error);
    return NextResponse.json({ error: clientError.error }, { status: clientError.status });
  }
}

/**
 * DELETE /api/budget-categories
 * Soft-delete a budget category (sets is_active = false).
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

    // Soft-delete by deactivating
    const { error } = await supabase
      .from('budget_categories')
      .update({ is_active: false })
      .eq('id', parsed.data.id);

    if (error) {
      logger.error('Failed to delete budget category', { error_message: error.message });
      return NextResponse.json({ error: 'Failed to delete category.' }, { status: 500 });
    }

    const ip = getClientIP(request.headers) ?? 'unknown';
    await writeAuditLog(supabase, {
      userId: user.id,
      action: 'BUDGET_MODIFIED',
      entityType: 'budget_category',
      entityId: parsed.data.id,
      details: { action: 'deactivated' },
      ipAddress: ip,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('Budget categories DELETE error', { error_message: String(error) });
    const clientError = toClientError(error);
    return NextResponse.json({ error: clientError.error }, { status: clientError.status });
  }
}
