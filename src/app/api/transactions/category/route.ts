import { createServerSupabaseClient } from '@/lib/supabase/server';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

const schema = z.object({
  transaction_id: z.string().uuid(),
  category_id: z.string().uuid().nullable(),
});

export async function PATCH(request: NextRequest) {
  const supabase = createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { transaction_id, category_id } = parsed.data;

  // RLS ensures user can only update their own transactions
  const { error } = await supabase
    .from('transactions')
    .update({ user_category_id: category_id })
    .eq('id', transaction_id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Audit log
  await supabase.from('audit_log').insert({
    user_id: user.id,
    action: 'TRANSACTION_CATEGORY_OVERRIDE',
    entity_type: 'transaction',
    entity_id: transaction_id,
    details: { category_id },
  });

  return NextResponse.json({ success: true });
}
