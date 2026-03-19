export const dynamic = "force-dynamic";

import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';

export async function PATCH(request: Request) {
  try {
    const supabase = createServerSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
    }

    const body = await request.json();
    const { category_id, monthly_budget_amount } = body;

    if (!category_id || monthly_budget_amount === undefined) {
      return NextResponse.json({ error: 'Missing fields.' }, { status: 400 });
    }

    const { error } = await supabase
      .from('budget_categories')
      .update({ monthly_budget_amount: Number(monthly_budget_amount) })
      .eq('id', category_id);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
