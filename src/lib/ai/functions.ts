/**
 * AI function-calling schema definitions and implementations.
 * These are the 5 tools the AI coach can invoke to query user data.
 */

import type OpenAI from 'openai';
import type { SupabaseClient } from '@supabase/supabase-js';
import { computeFinancialState } from './financial-intelligence';
import { fetchFundamentals } from '../market/fmp';
import { logger } from '../logger';

// ---------------------------------------------------------------------------
// OpenAI Function Schemas
// ---------------------------------------------------------------------------

export const AI_FUNCTIONS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_financial_state',
      description:
        'Get the user\'s current financial snapshot: net worth, cash balances, MTD income/spending, budget variance, portfolio allocation, cash flow forecast, and alerts. Call this before answering any financial question.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_transactions',
      description:
        'Query the user\'s transactions with optional filters. Use when the user asks about specific spending, merchants, categories, or date ranges.',
      parameters: {
        type: 'object',
        properties: {
          entity_name: {
            type: 'string',
            description: 'Filter by entity name (e.g., "Personal", "My LLC"). Omit for all entities.',
          },
          date_from: {
            type: 'string',
            description: 'Start date in YYYY-MM-DD format. Defaults to start of current month.',
          },
          date_to: {
            type: 'string',
            description: 'End date in YYYY-MM-DD format. Defaults to today.',
          },
          merchant: {
            type: 'string',
            description: 'Filter by merchant name (partial match, case-insensitive).',
          },
          category: {
            type: 'string',
            description: 'Filter by budget category name (partial match, case-insensitive).',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of transactions to return. Default 25, max 50.',
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
        'Get budget category status showing monthly limits, actual spending, and variance for each category. Use when discussing budget adherence.',
      parameters: {
        type: 'object',
        properties: {
          entity_name: {
            type: 'string',
            description: 'Filter by entity name. Omit for all entities.',
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
        'Get detailed investment holdings: security name, ticker, quantity, current value, cost basis, and gain/loss. Use when discussing portfolio or investments.',
      parameters: {
        type: 'object',
        properties: {
          entity_name: {
            type: 'string',
            description: 'Filter by entity name. Omit for all entities.',
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
        'Fetch educational market fundamentals for a specific ticker (P/E ratio, market cap, sector, description). ONLY call when the user explicitly asks about a specific stock or ticker. Never use to imply buy/sell signals.',
      parameters: {
        type: 'object',
        properties: {
          ticker: {
            type: 'string',
            description: 'Stock ticker symbol (e.g., "AAPL", "MSFT"). Must be uppercase, 1-10 characters.',
          },
        },
        required: ['ticker'],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Function Implementations
// ---------------------------------------------------------------------------

export type FunctionName =
  | 'get_financial_state'
  | 'get_transactions'
  | 'get_budget_status'
  | 'get_holdings_detail'
  | 'get_market_fundamentals';

/**
 * Execute an AI function call and return the result as a string for the model.
 * IMPORTANT: Returns summarized data only — never raw financial payloads.
 */
export async function executeFunction(
  name: FunctionName,
  args: Record<string, unknown>,
  supabase: SupabaseClient,
  userId: string
): Promise<string> {
  switch (name) {
    case 'get_financial_state':
      return executeGetFinancialState(supabase, userId);
    case 'get_transactions':
      return executeGetTransactions(supabase, userId, args);
    case 'get_budget_status':
      return executeGetBudgetStatus(supabase, userId, args);
    case 'get_holdings_detail':
      return executeGetHoldingsDetail(supabase, userId, args);
    case 'get_market_fundamentals':
      return executeGetMarketFundamentals(args);
    default:
      return JSON.stringify({ error: 'Unknown function' });
  }
}

async function executeGetFinancialState(
  supabase: SupabaseClient,
  userId: string
): Promise<string> {
  const state = await computeFinancialState(supabase, userId);
  return JSON.stringify(state);
}

async function executeGetTransactions(
  supabase: SupabaseClient,
  userId: string,
  args: Record<string, unknown>
): Promise<string> {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    .toISOString()
    .split('T')[0];
  const today = now.toISOString().split('T')[0];

  const dateFrom = (args.date_from as string) || monthStart;
  const dateTo = (args.date_to as string) || today;
  const limit = Math.min(Number(args.limit) || 25, 50);

  let query = supabase
    .from('transactions')
    .select(`
      date, amount, merchant_name,
      budget_categories!transactions_user_category_id_fkey(name)
    `)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .gte('date', dateFrom)
    .lte('date', dateTo)
    .order('date', { ascending: false })
    .limit(limit);

  // Entity filter
  if (args.entity_name) {
    const entityId = await resolveEntityId(supabase, userId, args.entity_name as string);
    if (entityId) query = query.eq('entity_id', entityId);
  }

  // Merchant filter
  if (args.merchant) {
    query = query.ilike('merchant_name', `%${args.merchant}%`);
  }

  const { data, error } = await query;

  if (error) {
    logger.error('get_transactions function error', { error_message: error.message });
    return JSON.stringify({ error: 'Failed to fetch transactions' });
  }

  // Category filter (post-query since it's a join)
  let results = (data ?? []).map((tx) => {
    const cat = tx.budget_categories as unknown as { name: string } | null;
    return {
      date: tx.date,
      amount: tx.amount,
      merchant: tx.merchant_name ?? 'Unknown',
      category: cat?.name ?? 'Uncategorized',
    };
  });

  if (args.category) {
    const catFilter = (args.category as string).toLowerCase();
    results = results.filter((r) =>
      r.category.toLowerCase().includes(catFilter)
    );
  }

  return JSON.stringify({
    period: `${dateFrom} to ${dateTo}`,
    count: results.length,
    transactions: results,
  });
}

async function executeGetBudgetStatus(
  supabase: SupabaseClient,
  userId: string,
  args: Record<string, unknown>
): Promise<string> {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    .toISOString()
    .split('T')[0];
  const today = now.toISOString().split('T')[0];

  // Get budget categories
  let budgetQuery = supabase
    .from('budget_categories')
    .select('id, entity_id, name, monthly_budget_amount')
    .eq('user_id', userId)
    .eq('is_active', true);

  if (args.entity_name) {
    const entityId = await resolveEntityId(supabase, userId, args.entity_name as string);
    if (entityId) budgetQuery = budgetQuery.eq('entity_id', entityId);
  }

  const [budgetRes, txRes] = await Promise.all([
    budgetQuery,
    supabase
      .from('transactions')
      .select('user_category_id, amount')
      .eq('user_id', userId)
      .is('deleted_at', null)
      .gte('date', monthStart)
      .lte('date', today)
      .gt('amount', 0), // Spending only
  ]);

  const categories = budgetRes.data ?? [];
  const transactions = txRes.data ?? [];

  // Sum spending per category
  const spending = new Map<string, number>();
  for (const tx of transactions) {
    const catId = tx.user_category_id || 'uncategorized';
    spending.set(catId, (spending.get(catId) || 0) + Number(tx.amount));
  }

  const status = categories.map((cat) => {
    const spent = Math.round((spending.get(cat.id) || 0) * 100) / 100;
    const budget = Number(cat.monthly_budget_amount) || 0;
    return {
      category: cat.name,
      budget_limit: budget,
      spent_mtd: spent,
      remaining: budget > 0 ? Math.round((budget - spent) * 100) / 100 : null,
      percent_used: budget > 0 ? Math.round((spent / budget) * 100) : null,
    };
  });

  return JSON.stringify({
    month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
    categories: status,
  });
}

async function executeGetHoldingsDetail(
  supabase: SupabaseClient,
  userId: string,
  args: Record<string, unknown>
): Promise<string> {
  let query = supabase
    .from('holdings')
    .select('security_name, ticker, quantity, price, value, cost_basis, entity_id')
    .eq('user_id', userId)
    .is('deleted_at', null);

  if (args.entity_name) {
    const entityId = await resolveEntityId(supabase, userId, args.entity_name as string);
    if (entityId) query = query.eq('entity_id', entityId);
  }

  const { data, error } = await query;

  if (error) {
    logger.error('get_holdings_detail function error', { error_message: error.message });
    return JSON.stringify({ error: 'Failed to fetch holdings' });
  }

  const holdings = (data ?? []).map((h) => {
    const gainLoss = h.cost_basis
      ? Math.round((Number(h.value) - Number(h.cost_basis)) * 100) / 100
      : null;
    return {
      security: h.security_name,
      ticker: h.ticker,
      quantity: h.quantity,
      price: h.price,
      value: h.value,
      cost_basis: h.cost_basis,
      gain_loss: gainLoss,
      gain_loss_pct:
        h.cost_basis && Number(h.cost_basis) > 0
          ? Math.round(((Number(h.value) - Number(h.cost_basis)) / Number(h.cost_basis)) * 10000) / 100
          : null,
    };
  });

  const totalValue = holdings.reduce((s, h) => s + Number(h.value), 0);

  return JSON.stringify({
    total_value: Math.round(totalValue * 100) / 100,
    holding_count: holdings.length,
    holdings,
  });
}

async function executeGetMarketFundamentals(
  args: Record<string, unknown>
): Promise<string> {
  const ticker = (args.ticker as string || '').toUpperCase().replace(/[^A-Z0-9.]/g, '');
  if (!ticker || ticker.length > 10) {
    return JSON.stringify({ error: 'Invalid ticker symbol' });
  }

  try {
    const data = await fetchFundamentals(ticker);
    return JSON.stringify(data);
  } catch (err) {
    logger.error('get_market_fundamentals error', { error_message: String(err) });
    return JSON.stringify({ error: 'Failed to fetch market data' });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveEntityId(
  supabase: SupabaseClient,
  userId: string,
  entityName: string
): Promise<string | null> {
  const { data } = await supabase
    .from('entities')
    .select('id')
    .eq('user_id', userId)
    .ilike('name', `%${entityName}%`)
    .eq('is_active', true)
    .limit(1)
    .single();

  return data?.id ?? null;
}
