import { createServerSupabaseClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export async function GET() {
  const supabase = createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  const today = now.toISOString().split('T')[0];

  // Run all queries in parallel
  const [accountsRes, txRes, holdingsRes, plaidItemsRes] = await Promise.all([
    supabase
      .from('accounts')
      .select('id, name, type, current_balance, available_balance, mask, is_active')
      .eq('is_active', true)
      .is('deleted_at', null),
    supabase
      .from('transactions')
      .select('amount, date, plaid_category')
      .is('deleted_at', null)
      .gte('date', monthStart)
      .lte('date', today),
    supabase
      .from('holdings')
      .select('value, cost_basis')
      .is('deleted_at', null),
    supabase
      .from('plaid_items')
      .select('id, institution_name, status, last_successful_sync, error_count'),
  ]);

  const accounts = accountsRes.data ?? [];
  const transactions = txRes.data ?? [];
  const holdings = holdingsRes.data ?? [];
  const plaidItems = plaidItemsRes.data ?? [];

  // Calculate summary metrics
  const totalCash = accounts
    .filter((a) => a.type === 'depository')
    .reduce((sum, a) => sum + (Number(a.current_balance) || 0), 0);

  const totalCredit = accounts
    .filter((a) => a.type === 'credit')
    .reduce((sum, a) => sum + (Number(a.current_balance) || 0), 0);

  const totalInvestments = holdings.reduce((sum, h) => sum + (Number(h.value) || 0), 0);

  const totalLoans = accounts
    .filter((a) => a.type === 'loan')
    .reduce((sum, a) => sum + (Number(a.current_balance) || 0), 0);

  const totalAssets = totalCash + totalInvestments;
  const totalLiabilities = totalCredit + totalLoans;
  const netWorth = totalAssets - totalLiabilities;

  // MTD spending (positive amounts = money out in Plaid)
  const mtdSpending = transactions
    .filter((t) => Number(t.amount) > 0)
    .reduce((sum, t) => sum + Number(t.amount), 0);

  const mtdIncome = transactions
    .filter((t) => Number(t.amount) < 0)
    .reduce((sum, t) => sum + Math.abs(Number(t.amount)), 0);

  // Connection health
  const connectedCount = plaidItems.filter((i) => i.status === 'connected').length;
  const totalConnections = plaidItems.length;

  return NextResponse.json({
    netWorth,
    totalCash,
    totalCredit,
    totalInvestments,
    totalLoans,
    totalAssets,
    totalLiabilities,
    mtdSpending,
    mtdIncome,
    connectedCount,
    totalConnections,
  });
}
