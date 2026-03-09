import type OpenAI from 'openai';
import { type SupabaseClient } from '@supabase/supabase-js';
import { computeFinancialState } from './financial-intelligence';
import { getQuote, getCompanyProfile, getKeyMetrics } from '../market/fmp';
import { logger } from '../logger';

// Row types for Supabase query results (avoids implicit any)
interface TxRow {
  date: string;
  merchant_name: string | null;
  amount: number;
  plaid_category: string[] | null;
  is_recurring: boolean;
  user_category_id?: string | null;
}

interface BudgetCatRow {
  id: string;
  entity_id: string;
  name: string;
  monthly_budget_amount: number | null;
}

interface HoldingRow {
  security_name: string;
  ticker: string | null;
  quantity: number;
  price: number;
  value: number;
  cost_basis: number | null;
}

// ---------------------------------------------------------------------------
// Function-calling tool definitions for OpenAI
// ---------------------------------------------------------------------------

export const AI_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_financial_state',
      description:
        'Get the user\'s current financial snapshot: net worth, cash, income, spending, budget variance, portfolio allocation, cash flow forecast, and alerts. Call this before answering any financial question.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_transactions',
      description:
        'Get recent transactions, optionally filtered by entity or date range. Returns the last 50 transactions by default.',
      parameters: {
        type: 'object',
        properties: {
          entity_name: {
            type: 'string',
            description: 'Filter by entity name (e.g., "Personal", "My LLC")',
          },
          days: {
            type: 'number',
            description: 'Number of days to look back (default 30, max 90)',
          },
          category: {
            type: 'string',
            description: 'Filter by budget category name',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_budget_status',
      description:
        'Get month-to-date budget status across all categories: budgeted amount, actual spending, remaining, and percentage used.',
      parameters: {
        type: 'object',
        properties: {
          entity_name: {
            type: 'string',
            description: 'Filter by entity name',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_holdings_detail',
      description:
        'Get investment holdings with current value, cost basis, and gain/loss for educational portfolio discussion.',
      parameters: {
        type: 'object',
        properties: {
          entity_name: {
            type: 'string',
            description: 'Filter by entity name',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_market_fundamentals',
      description:
        'Get educational market data for a stock ticker: price, P/E, market cap, sector, key metrics. For educational context only.',
      parameters: {
        type: 'object',
        properties: {
          symbol: {
            type: 'string',
            description: 'Stock ticker symbol (e.g., "AAPL", "VTI")',
          },
        },
        required: ['symbol'],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Function implementations
// ---------------------------------------------------------------------------

type FunctionArgs = Record<string, unknown>;

/**
 * Execute an AI function call against user data.
 * Returns a JSON string result for the AI to interpret.
 * IMPORTANT: Results are summarized — never raw financial payloads.
 */
export async function executeFunction(
  name: string,
  args: FunctionArgs,
  supabase: SupabaseClient,
  userId: string
): Promise<string> {
  try {
    switch (name) {
      case 'get_financial_state':
        return await handleGetFinancialState(supabase, userId);

      case 'get_transactions':
        return await handleGetTransactions(supabase, userId, args);

      case 'get_budget_status':
        return await handleGetBudgetStatus(supabase, userId, args);

      case 'get_holdings_detail':
        return await handleGetHoldingsDetail(supabase, userId, args);

      case 'get_market_fundamentals':
        return await handleGetMarketFundamentals(args);

      default:
        return JSON.stringify({ error: `Unknown function: ${name}` });
    }
  } catch (error) {
    logger.error('AI function execution failed', {
      function_name: name,
      error_message: String(error),
    });
    return JSON.stringify({ error: 'Failed to retrieve data. Please try again.' });
  }
}

// --- Individual function handlers ---

async function handleGetFinancialState(
  supabase: SupabaseClient,
  userId: string
): Promise<string> {
  const state = await computeFinancialState(supabase, userId);
  return JSON.stringify(state);
}

async function handleGetTransactions(
  supabase: SupabaseClient,
  userId: string,
  args: FunctionArgs
): Promise<string> {
  const days = Math.min(Number(args.days) || 30, 90);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  let query = supabase
    .from('transactions')
    .select('date, merchant_name, amount, plaid_category, is_recurring')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .gte('date', cutoffStr)
    .order('date', { ascending: false })
    .limit(50);

  // Filter by entity name if provided
  if (args.entity_name) {
    const { data: entity } = await supabase
      .from('entities')
      .select('id')
      .eq('user_id', userId)
      .ilike('name', String(args.entity_name))
      .maybeSingle();
    if (entity) {
      query = query.eq('entity_id', entity.id);
    }
  }

  const { data: txs } = await query;

  if (!txs || txs.length === 0) {
    return JSON.stringify({ message: 'No transactions found for this period.' });
  }

  // Summarize rather than returning raw data
  const total = txs.reduce((s: number, t: TxRow) => s + Number(t.amount), 0);
  const spending = txs.filter((t: TxRow) => Number(t.amount) > 0);
  const income = txs.filter((t: TxRow) => Number(t.amount) < 0);

  // Top merchants by spending
  const merchantMap = new Map<string, number>();
  for (const t of spending) {
    const name = t.merchant_name ?? 'Unknown';
    merchantMap.set(name, (merchantMap.get(name) ?? 0) + Number(t.amount));
  }
  const topMerchants = Array.from(merchantMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, amount]) => ({ name, amount: round2(amount) }));

  return JSON.stringify({
    period_days: days,
    transaction_count: txs.length,
    total_spending: round2(spending.reduce((s: number, t: TxRow) => s + Number(t.amount), 0)),
    total_income: round2(income.reduce((s: number, t: TxRow) => s + Math.abs(Number(t.amount)), 0)),
    net: round2(-total),
    recurring_count: txs.filter((t: TxRow) => t.is_recurring).length,
    top_merchants: topMerchants,
    recent: txs.slice(0, 10).map((t: TxRow) => ({
      date: t.date,
      merchant: t.merchant_name ?? 'Unknown',
      amount: round2(Number(t.amount)),
      category: t.plaid_category?.[0] ?? null,
    })),
  });
}

async function handleGetBudgetStatus(
  supabase: SupabaseClient,
  userId: string,
  args: FunctionArgs
): Promise<string> {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    .toISOString()
    .split('T')[0];
  const today = now.toISOString().split('T')[0];

  // Get budget categories
  let categoryQuery = supabase
    .from('budget_categories')
    .select('id, entity_id, name, monthly_budget_amount')
    .eq('user_id', userId)
    .eq('is_active', true);

  if (args.entity_name) {
    const { data: entity } = await supabase
      .from('entities')
      .select('id')
      .eq('user_id', userId)
      .ilike('name', String(args.entity_name))
      .maybeSingle();
    if (entity) {
      categoryQuery = categoryQuery.eq('entity_id', entity.id);
    }
  }

  const { data: categories } = await categoryQuery;

  // Get MTD transactions
  const { data: txs } = await supabase
    .from('transactions')
    .select('user_category_id, amount')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .gte('date', monthStart)
    .lte('date', today);

  if (!categories || categories.length === 0) {
    return JSON.stringify({ message: 'No budget categories configured.' });
  }

  // Aggregate spending by category
  const spending = new Map<string, number>();
  for (const tx of txs ?? []) {
    if (Number(tx.amount) <= 0) continue;
    const catId = tx.user_category_id ?? 'uncategorized';
    spending.set(catId, (spending.get(catId) ?? 0) + Number(tx.amount));
  }

  const statuses = categories
    .filter((c: BudgetCatRow) => c.monthly_budget_amount)
    .map((c: BudgetCatRow) => {
      const budgeted = Number(c.monthly_budget_amount);
      const actual = round2(spending.get(c.id) ?? 0);
      const remaining = round2(budgeted - actual);
      const pctUsed = budgeted > 0 ? round2((actual / budgeted) * 100) : 0;

      return {
        category: c.name,
        budgeted: round2(budgeted),
        actual,
        remaining,
        pct_used: pctUsed,
        status: pctUsed > 100 ? 'over_budget' : pctUsed > 80 ? 'warning' : 'on_track',
      };
    })
    .sort((a: { pct_used: number }, b: { pct_used: number }) => b.pct_used - a.pct_used);

  const totalBudgeted = statuses.reduce((s: number, c: { budgeted: number }) => s + c.budgeted, 0);
  const totalActual = statuses.reduce((s: number, c: { actual: number }) => s + c.actual, 0);

  return JSON.stringify({
    month: monthStart,
    total_budgeted: round2(totalBudgeted),
    total_actual: round2(totalActual),
    total_remaining: round2(totalBudgeted - totalActual),
    day_of_month: now.getDate(),
    categories: statuses,
  });
}

async function handleGetHoldingsDetail(
  supabase: SupabaseClient,
  userId: string,
  args: FunctionArgs
): Promise<string> {
  let query = supabase
    .from('holdings')
    .select('security_name, ticker, quantity, price, value, cost_basis')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .order('value', { ascending: false });

  if (args.entity_name) {
    const { data: entity } = await supabase
      .from('entities')
      .select('id')
      .eq('user_id', userId)
      .ilike('name', String(args.entity_name))
      .maybeSingle();
    if (entity) {
      query = query.eq('entity_id', entity.id);
    }
  }

  const { data: holdings } = await query;

  if (!holdings || holdings.length === 0) {
    return JSON.stringify({ message: 'No investment holdings found.' });
  }

  const totalValue = holdings.reduce((s: number, h: HoldingRow) => s + Number(h.value || 0), 0);
  const totalCostBasis = holdings
    .filter((h: HoldingRow) => h.cost_basis != null)
    .reduce((s: number, h: HoldingRow) => s + Number(h.cost_basis!), 0);

  const items = holdings.slice(0, 20).map((h: HoldingRow) => {
    const value = Number(h.value || 0);
    const cost = h.cost_basis != null ? Number(h.cost_basis) : null;
    const gain = cost != null ? round2(value - cost) : null;
    const gainPct = cost != null && cost > 0 ? round2(((value - cost) / cost) * 100) : null;

    return {
      name: h.security_name,
      ticker: h.ticker,
      quantity: Number(h.quantity),
      price: round2(Number(h.price)),
      value: round2(value),
      cost_basis: cost != null ? round2(cost) : null,
      gain,
      gain_pct: gainPct,
      allocation_pct: totalValue > 0 ? round2((value / totalValue) * 100) : 0,
    };
  });

  return JSON.stringify({
    total_value: round2(totalValue),
    total_cost_basis: round2(totalCostBasis),
    total_gain: round2(totalValue - totalCostBasis),
    holding_count: holdings.length,
    holdings: items,
  });
}

async function handleGetMarketFundamentals(args: FunctionArgs): Promise<string> {
  const symbol = String(args.symbol ?? '').toUpperCase().trim();
  if (!symbol || symbol.length > 10) {
    return JSON.stringify({ error: 'Invalid symbol.' });
  }

  const [quote, profile, metrics] = await Promise.all([
    getQuote(symbol),
    getCompanyProfile(symbol),
    getKeyMetrics(symbol),
  ]);

  if (!quote && !profile) {
    return JSON.stringify({
      error: `Could not find data for "${symbol}". Verify the ticker is correct.`,
    });
  }

  return JSON.stringify({
    symbol,
    name: profile?.companyName ?? quote?.name ?? symbol,
    sector: profile?.sector ?? null,
    industry: profile?.industry ?? null,
    price: quote?.price ?? profile?.price ?? null,
    change_pct: quote?.changesPercentage ?? null,
    market_cap: quote?.marketCap ?? profile?.marketCap ?? null,
    pe_ratio: quote?.pe ?? null,
    eps: quote?.eps ?? null,
    beta: profile?.beta ?? null,
    dividend_yield: metrics ? (metrics.dividendYieldTTM as number) ?? null : null,
    debt_to_equity: metrics ? (metrics.debtToEquityTTM as number) ?? null : null,
    roe: metrics ? (metrics.roeTTM as number) ?? null : null,
    description: profile?.description
      ? profile.description.slice(0, 200) + '...'
      : null,
    note: 'This data is for educational purposes only. Not a recommendation.',
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
