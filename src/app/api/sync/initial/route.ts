export const dynamic = "force-dynamic";

import { NextResponse } from 'next/server';
import { getSecrets } from '@/lib/env';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { syncTransactionsForItem } from '@/lib/plaid/sync';
import { logger } from '@/lib/logger';

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  const secrets = getSecrets();

  if (authHeader !== `Bearer ${secrets.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const supabase = createServiceRoleClient();

  const { data: items, error } = await supabase
    .from('plaid_items')
    .select('id, user_id, entity_id, institution_name')
    .eq('status', 'connected');

  if (error || !items) {
    return NextResponse.json({ error: 'Failed to fetch items' }, { status: 500 });
  }

  const results = [];
  for (const item of items) {
    try {
      const result = await syncTransactionsForItem(
        supabase, item.id, item.user_id, item.entity_id
      );
      results.push({ institution: item.institution_name, ...result });
    } catch (err) {
      results.push({ institution: item.institution_name, error: String(err) });
    }
  }

  return NextResponse.json({ status: 'ok', results });
}
