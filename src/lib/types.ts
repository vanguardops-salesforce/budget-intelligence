/**
 * Core domain types for Budget Intelligence.
 * These map to database tables but are used throughout the app.
 */

// --- Entities ---

export type EntityType = 'personal' | 'llc' | 'corp';

export interface Entity {
  id: string;
  user_id: string;
  name: string;
  type: EntityType;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// --- Plaid ---

export type PlaidItemStatus = 'connected' | 'degraded' | 'disconnected' | 'reauth_required';

export interface PlaidItem {
  id: string;
  user_id: string;
  entity_id: string;
  plaid_item_id: string;
  institution_name: string | null;
  status: PlaidItemStatus;
  transactions_cursor: string | null;
  last_successful_sync: string | null;
  last_error_code: string | null;
  error_count: number;
  consent_expiration: string | null;
  created_at: string;
  updated_at: string;
}

export type AccountType = 'depository' | 'credit' | 'investment' | 'loan' | 'other';

export interface Account {
  id: string;
  user_id: string;
  entity_id: string;
  plaid_item_id: string;
  plaid_account_id: string;
  name: string;
  official_name: string | null;
  type: AccountType;
  subtype: string | null;
  current_balance: number | null;
  available_balance: number | null;
  currency: string;
  mask: string | null; // Last 4 digits only
  is_active: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

// --- Transactions ---

export interface Transaction {
  id: string;
  user_id: string;
  entity_id: string;
  account_id: string;
  plaid_transaction_id: string;
  amount: number;
  date: string;
  merchant_name: string | null;
  plaid_category: string[] | null;
  user_category_id: string | null;
  is_recurring: boolean;
  recurring_pattern_id: string | null;
  notes: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

// --- Budget ---

export interface BudgetCategory {
  id: string;
  user_id: string;
  entity_id: string;
  name: string;
  parent_category_id: string | null;
  monthly_budget_amount: number | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface TransactionRule {
  id: string;
  user_id: string;
  entity_id: string;
  merchant_pattern: string;
  category_id: string;
  priority: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// --- Recurring Patterns ---

export type RecurrenceFrequency = 'weekly' | 'biweekly' | 'monthly' | 'annual';

export interface RecurringPattern {
  id: string;
  user_id: string;
  entity_id: string;
  merchant_pattern: string;
  estimated_amount: number;
  frequency: RecurrenceFrequency;
  confidence_score: number;
  next_expected_date: string;
  last_seen_date: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// --- Holdings ---

export interface Holding {
  id: string;
  user_id: string;
  entity_id: string;
  account_id: string;
  plaid_holding_id: string | null;
  security_name: string;
  ticker: string | null;
  quantity: number;
  price: number;
  value: number;
  cost_basis: number | null;
  deleted_at: string | null;
  updated_at: string;
  created_at: string;
}

// --- Financial State (AI context) ---

export interface FinancialState {
  snapshot_date: string;
  net_worth: { total: number; assets: number; liabilities: number };
  entities: Array<{
    name: string;
    type: string;
    cash_balance: number;
    mtd_income: number;
    mtd_spending: number;
    budget_variance: number;
    runway_days: number;
  }>;
  portfolio: {
    total_value: number;
    allocation: Array<{ category: string; percentage: number; value: number }>;
  };
  cash_flow_forecast: { next_30_days: number; next_60_days: number; next_90_days: number };
  top_spending_categories: Array<{ category: string; amount: number; budget: number | null }>;
  alerts: string[];
}

// --- Audit ---

export type AuditAction =
  | 'AUTH_LOGIN'
  | 'AUTH_FAILED_LOGIN'
  | 'AUTH_MFA_ENROLLED'
  | 'AUTH_MFA_VERIFIED'
  | 'PLAID_ITEM_LINKED'
  | 'PLAID_ITEM_REAUTH'
  | 'PLAID_ITEM_ERROR'
  | 'PLAID_SYNC_COMPLETED'
  | 'PLAID_SYNC_FAILED'
  | 'WEBHOOK_RECEIVED'
  | 'WEBHOOK_VERIFICATION_FAILED'
  | 'WEBHOOK_PROCESSED'
  | 'AI_SESSION_STARTED'
  | 'AI_FUNCTION_CALLED'
  | 'FINANCIAL_STATE_ACCESSED'
  | 'TRANSACTION_CATEGORY_OVERRIDE'
  | 'BUDGET_MODIFIED'
  | 'RATE_LIMIT_EXCEEDED';

export interface AuditLogEntry {
  id: string;
  user_id: string;
  action: AuditAction;
  entity_type: string | null;
  entity_id: string | null;
  details: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: string;
}

// --- Webhook Events ---

export type WebhookEventStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface PlaidWebhookEvent {
  id: string;
  user_id: string;
  plaid_item_id: string;
  webhook_type: string;
  webhook_code: string;
  plaid_webhook_id: string;
  payload: Record<string, unknown>;
  status: WebhookEventStatus;
  processed_at: string | null;
  error_message: string | null;
  created_at: string;
}

// --- AI ---

export interface AIConversation {
  id: string;
  user_id: string;
  title: string | null;
  summary: string | null;
  message_count: number;
  last_message_at: string | null;
  purge_after: string | null;
  created_at: string;
}

export type AIMessageRole = 'user' | 'assistant' | 'system';

export interface AIMessage {
  id: string;
  conversation_id: string;
  role: AIMessageRole;
  content: string;
  function_calls: Record<string, unknown>[] | null;
  created_at: string;
}
