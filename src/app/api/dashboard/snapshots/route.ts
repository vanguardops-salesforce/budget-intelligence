import { createServerSupabaseClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { requireMFA } from '@/lib/supabase/auth-config';
import { toClientError } from '@/lib/errors';
import { logger } from '@/lib/logger';

/**
 * Returns the last 90 days of financial snapshots for trend charts.
 * Each snapshot contains net_worth, assets, liabilities from the JSONB data.
 */
export async function GET() {
  try {
    const supabase = createServerSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
    }

    await requireMFA(supabase);

    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const cutoff = ninetyDaysAgo.toISOString().split('T')[0];

    const { data: snapshots, error } = await supabase
      .from('financial_snapshots')
      .select('snapshot_date, data')
      .gte('snapshot_date', cutoff)
      .order('snapshot_date', { ascending: true });

    if (error) {
      logger.error('Failed to fetch snapshots', { error_message: error.message });
      return NextResponse.json({ error: 'Failed to fetch snapshots.' }, { status: 500 });
    }

    // Extract only the fields needed for charts to keep payload small
    const points = (snapshots ?? []).map((s: { snapshot_date: string; data: unknown }) => {
      const data = s.data as {
        net_worth?: { total?: number; assets?: number; liabilities?: number };
        cash_flow_forecast?: { next_30_days?: number; next_60_days?: number; next_90_days?: number };
      };
      return {
        date: s.snapshot_date,
        net_worth: data.net_worth?.total ?? 0,
        assets: data.net_worth?.assets ?? 0,
        liabilities: data.net_worth?.liabilities ?? 0,
        forecast_30d: data.cash_flow_forecast?.next_30_days ?? 0,
      };
    });

    return NextResponse.json({ points });
  } catch (error) {
    logger.error('Snapshots API error', { error_message: String(error) });
    const clientError = toClientError(error);
    return NextResponse.json({ error: clientError.error }, { status: clientError.status });
  }
}
