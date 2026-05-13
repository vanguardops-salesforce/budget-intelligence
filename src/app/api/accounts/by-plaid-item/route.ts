import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { requireMFA } from '@/lib/supabase/auth-config';
import { toClientError } from '@/lib/errors';
import { logger } from '@/lib/logger';

/**
 * GET /api/accounts/by-plaid-item?plaid_item_id=<uuid>
 * Fetch accounts belonging to a specific plaid item.
 * Used after linking to show accounts for entity assignment.
 * Only returns id, name, mask, and type — never full account numbers.
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = createServerSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
    }

    await requireMFA(supabase);

    const plaidItemId = request.nextUrl.searchParams.get('plaid_item_id');
    if (!plaidItemId) {
      return NextResponse.json({ error: 'plaid_item_id required.' }, { status: 400 });
    }

    // RLS ensures only the user's accounts are returned
    const { data: accounts, error } = await supabase
      .from('accounts')
      .select('id, name, mask, type, entity_id')
      .eq('plaid_item_id', plaidItemId)
      .eq('is_active', true)
      .is('deleted_at', null);

    if (error) {
      logger.error('Failed to fetch accounts by plaid item', { error_message: error.message });
      return NextResponse.json({ error: 'Failed to fetch accounts.' }, { status: 500 });
    }

    return NextResponse.json({ accounts: accounts ?? [] });
  } catch (error) {
    logger.error('Accounts by plaid item error', { error_message: String(error) });
    const clientError = toClientError(error);
    return NextResponse.json({ error: clientError.error }, { status: clientError.status });
  }
}
