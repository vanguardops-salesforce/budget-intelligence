export const dynamic = "force-dynamic";

import { createServerSupabaseClient } from '@/lib/supabase/server';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireMFA } from '@/lib/supabase/auth-config';
import { toClientError } from '@/lib/errors';
import { writeAuditLog, getClientIP } from '@/lib/audit';
import { logger } from '@/lib/logger';

const schema = z.object({
  transaction_id: z.string().uuid(),
  category_id: z.string().uuid().nullable(),
});

export async function PATCH(request: NextRequest) {
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
      return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
    }

    const { transaction_id, category_id } = parsed.data;

    // RLS ensures user can only update their own transactions
    const { error } = await supabase
      .from('transactions')
      .update({ user_category_id: category_id })
      .eq('id', transaction_id);

    if (error) {
      logger.error('Transaction category update failed', { error_message: error.message });
      return NextResponse.json({ error: 'Failed to update category.' }, { status: 500 });
    }

    const ip = getClientIP(request.headers) ?? 'unknown';
    await writeAuditLog(supabase, {
      userId: user.id,
      action: 'TRANSACTION_CATEGORY_OVERRIDE',
      entityType: 'transaction',
      entityId: transaction_id,
      details: { category_id },
      ipAddress: ip,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('Transaction category error', { error_message: String(error) });
    const clientError = toClientError(error);
    return NextResponse.json({ error: clientError.error }, { status: clientError.status });
  }
}
