-- ============================================================================
-- Budget Intelligence V1 — Initial Schema
-- Run against Supabase PostgreSQL.
-- ============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- PRIVATE SCHEMA — NOT exposed via PostgREST
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM anon, authenticated;
GRANT USAGE ON SCHEMA private TO service_role;

-- ============================================================================
-- PUBLIC TABLES
-- ============================================================================

-- Profiles (extends Supabase auth.users)
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  full_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Entities (business/personal separation)
CREATE TABLE public.entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('personal', 'llc', 'corp')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_entities_user_id ON public.entities(user_id);

-- Plaid Items (one per Plaid Link connection)
CREATE TABLE public.plaid_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_id UUID NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  plaid_item_id TEXT NOT NULL UNIQUE,
  institution_name TEXT,
  status TEXT NOT NULL DEFAULT 'connected'
    CHECK (status IN ('connected', 'degraded', 'disconnected', 'reauth_required')),
  transactions_cursor TEXT,
  last_successful_sync TIMESTAMPTZ,
  last_error_code TEXT,
  error_count INTEGER NOT NULL DEFAULT 0,
  consent_expiration TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_plaid_items_user_id ON public.plaid_items(user_id);
CREATE INDEX idx_plaid_items_entity_id ON public.plaid_items(entity_id);
CREATE INDEX idx_plaid_items_status ON public.plaid_items(status);

-- Accounts (bank, credit, investment)
CREATE TABLE public.accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_id UUID NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  plaid_item_id UUID NOT NULL REFERENCES public.plaid_items(id) ON DELETE CASCADE,
  plaid_account_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  official_name TEXT,
  type TEXT NOT NULL CHECK (type IN ('depository', 'credit', 'investment', 'loan', 'other')),
  subtype TEXT,
  current_balance NUMERIC(14, 2),
  available_balance NUMERIC(14, 2),
  currency TEXT NOT NULL DEFAULT 'USD',
  mask TEXT, -- Last 4 digits ONLY
  is_active BOOLEAN NOT NULL DEFAULT true,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_accounts_user_id ON public.accounts(user_id);
CREATE INDEX idx_accounts_entity_id ON public.accounts(entity_id);
CREATE INDEX idx_accounts_plaid_item_id ON public.accounts(plaid_item_id);

-- Budget Categories
CREATE TABLE public.budget_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_id UUID NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  parent_category_id UUID REFERENCES public.budget_categories(id) ON DELETE SET NULL,
  monthly_budget_amount NUMERIC(14, 2),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_budget_categories_user_entity ON public.budget_categories(user_id, entity_id);

-- Transactions
CREATE TABLE public.transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_id UUID NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  plaid_transaction_id TEXT NOT NULL,
  amount NUMERIC(14, 2) NOT NULL,
  date DATE NOT NULL,
  merchant_name TEXT,
  plaid_category JSONB,
  user_category_id UUID REFERENCES public.budget_categories(id) ON DELETE SET NULL,
  is_recurring BOOLEAN NOT NULL DEFAULT false,
  recurring_pattern_id UUID,
  notes TEXT,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_transactions_plaid_id ON public.transactions(plaid_transaction_id);
CREATE INDEX idx_transactions_user_date ON public.transactions(user_id, date);
CREATE INDEX idx_transactions_entity_date ON public.transactions(entity_id, date);
CREATE INDEX idx_transactions_account_date ON public.transactions(account_id, date);
CREATE INDEX idx_transactions_user_merchant ON public.transactions(user_id, merchant_name);
CREATE INDEX idx_transactions_user_category_date ON public.transactions(user_id, user_category_id, date);

-- Transaction Rules (auto-categorization)
CREATE TABLE public.transaction_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_id UUID NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  merchant_pattern TEXT NOT NULL,
  category_id UUID NOT NULL REFERENCES public.budget_categories(id) ON DELETE CASCADE,
  priority INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_transaction_rules_user_entity ON public.transaction_rules(user_id, entity_id);

-- Recurring Patterns
CREATE TABLE public.recurring_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_id UUID NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  merchant_pattern TEXT NOT NULL,
  estimated_amount NUMERIC(14, 2) NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('weekly', 'biweekly', 'monthly', 'annual')),
  confidence_score NUMERIC(3, 2) NOT NULL DEFAULT 0.0,
  next_expected_date DATE,
  last_seen_date DATE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add FK from transactions to recurring_patterns now that both tables exist
ALTER TABLE public.transactions
  ADD CONSTRAINT fk_transactions_recurring_pattern
  FOREIGN KEY (recurring_pattern_id) REFERENCES public.recurring_patterns(id) ON DELETE SET NULL;

CREATE INDEX idx_recurring_patterns_user_entity ON public.recurring_patterns(user_id, entity_id);

-- Holdings (investment positions)
CREATE TABLE public.holdings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_id UUID NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  plaid_holding_id TEXT,
  security_name TEXT NOT NULL,
  ticker TEXT,
  quantity NUMERIC(14, 6) NOT NULL DEFAULT 0,
  price NUMERIC(14, 4) NOT NULL DEFAULT 0,
  value NUMERIC(14, 2) NOT NULL DEFAULT 0,
  cost_basis NUMERIC(14, 2),
  deleted_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_holdings_user_entity ON public.holdings(user_id, entity_id);
CREATE INDEX idx_holdings_account ON public.holdings(account_id);

-- Financial Snapshots (pre-computed daily summaries)
CREATE TABLE public.financial_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, snapshot_date)
);

CREATE INDEX idx_financial_snapshots_user_date ON public.financial_snapshots(user_id, snapshot_date);

-- Plaid Webhook Events (ingestion pipeline)
CREATE TABLE public.plaid_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plaid_item_id UUID NOT NULL REFERENCES public.plaid_items(id) ON DELETE CASCADE,
  webhook_type TEXT NOT NULL,
  webhook_code TEXT NOT NULL,
  plaid_webhook_id TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  processed_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_webhook_events_plaid_id ON public.plaid_webhook_events(plaid_webhook_id);
CREATE INDEX idx_webhook_events_status ON public.plaid_webhook_events(status) WHERE status = 'pending';

-- Audit Log (IMMUTABLE — no UPDATE or DELETE)
CREATE TABLE public.audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details JSONB,
  ip_address INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_log_user_id ON public.audit_log(user_id);
CREATE INDEX idx_audit_log_action ON public.audit_log(action);
CREATE INDEX idx_audit_log_created_at ON public.audit_log(created_at);

-- AI Conversations
CREATE TABLE public.ai_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT,
  summary TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  last_message_at TIMESTAMPTZ,
  purge_after TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ai_conversations_user ON public.ai_conversations(user_id);

-- AI Messages
CREATE TABLE public.ai_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.ai_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  function_calls JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ai_messages_conversation ON public.ai_messages(conversation_id);

-- ============================================================================
-- PRIVATE TABLE — Plaid tokens (encrypted, not exposed via PostgREST)
-- ============================================================================

CREATE TABLE private.plaid_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plaid_item_id UUID NOT NULL REFERENCES public.plaid_items(id) ON DELETE CASCADE,
  access_token_encrypted TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rotated_at TIMESTAMPTZ
);

GRANT ALL ON private.plaid_tokens TO service_role;

-- ============================================================================
-- ROW LEVEL SECURITY — Enabled and FORCED on every table
-- ============================================================================

-- profiles
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY "users_own_profile" ON public.profiles
  FOR ALL USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- entities
ALTER TABLE public.entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entities FORCE ROW LEVEL SECURITY;
CREATE POLICY "users_own_entities" ON public.entities
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- plaid_items
ALTER TABLE public.plaid_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plaid_items FORCE ROW LEVEL SECURITY;
CREATE POLICY "users_own_plaid_items" ON public.plaid_items
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- accounts
ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY "users_own_accounts" ON public.accounts
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- budget_categories
ALTER TABLE public.budget_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.budget_categories FORCE ROW LEVEL SECURITY;
CREATE POLICY "users_own_budget_categories" ON public.budget_categories
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- transactions
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions FORCE ROW LEVEL SECURITY;
CREATE POLICY "users_own_transactions" ON public.transactions
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- transaction_rules
ALTER TABLE public.transaction_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transaction_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY "users_own_transaction_rules" ON public.transaction_rules
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- recurring_patterns
ALTER TABLE public.recurring_patterns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recurring_patterns FORCE ROW LEVEL SECURITY;
CREATE POLICY "users_own_recurring_patterns" ON public.recurring_patterns
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- holdings
ALTER TABLE public.holdings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.holdings FORCE ROW LEVEL SECURITY;
CREATE POLICY "users_own_holdings" ON public.holdings
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- financial_snapshots
ALTER TABLE public.financial_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financial_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY "users_own_financial_snapshots" ON public.financial_snapshots
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- plaid_webhook_events
ALTER TABLE public.plaid_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plaid_webhook_events FORCE ROW LEVEL SECURITY;
CREATE POLICY "users_own_webhook_events" ON public.plaid_webhook_events
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- audit_log — IMMUTABLE: INSERT + SELECT only. No UPDATE or DELETE.
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY "users_insert_own_logs" ON public.audit_log
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users_read_own_logs" ON public.audit_log
  FOR SELECT USING (auth.uid() = user_id);
-- NO update or delete policy = immutable

-- ai_conversations
ALTER TABLE public.ai_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY "users_own_ai_conversations" ON public.ai_conversations
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ai_messages (secured via conversation ownership)
ALTER TABLE public.ai_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY "users_own_ai_messages" ON public.ai_messages
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.ai_conversations c
      WHERE c.id = ai_messages.conversation_id
      AND c.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.ai_conversations c
      WHERE c.id = ai_messages.conversation_id
      AND c.user_id = auth.uid()
    )
  );

-- ============================================================================
-- AUTO-CREATE PROFILE ON USER SIGNUP
-- ============================================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (NEW.id, NEW.email, NEW.raw_user_meta_data->>'full_name');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================================
-- UPDATED_AT TRIGGER
-- ============================================================================

CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.entities
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.plaid_items
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.budget_categories
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.transaction_rules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.recurring_patterns
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.holdings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================================
-- RLS VERIFICATION TESTS (run after deployment)
-- ============================================================================

-- Test 1: As anon role, all tables should return 0 rows:
--   SET ROLE anon;
--   SELECT * FROM transactions;       -- expect: 0 rows
--   SELECT * FROM accounts;           -- expect: 0 rows
--   SELECT * FROM plaid_items;        -- expect: 0 rows
--   SELECT * FROM audit_log;          -- expect: 0 rows
--   RESET ROLE;

-- Test 2: As authenticated user, can only see own data:
--   SET ROLE authenticated;
--   SET request.jwt.claims = '{"sub": "your-user-uuid"}';
--   SELECT count(*) FROM transactions; -- expect: your transaction count
--   INSERT INTO transactions (user_id, ...) VALUES ('fake-uuid', ...); -- expect: FAIL (RLS violation)
--   RESET ROLE;

-- Test 3: Audit log immutability:
--   SET ROLE authenticated;
--   SET request.jwt.claims = '{"sub": "your-user-uuid"}';
--   UPDATE audit_log SET action = 'TAMPERED' WHERE user_id = 'your-user-uuid'; -- expect: FAIL
--   DELETE FROM audit_log WHERE user_id = 'your-user-uuid'; -- expect: FAIL
--   RESET ROLE;

-- Test 4: Private schema inaccessible via PostgREST:
--   SET ROLE anon;
--   SELECT * FROM private.plaid_tokens; -- expect: permission denied
--   SET ROLE authenticated;
--   SELECT * FROM private.plaid_tokens; -- expect: permission denied
--   RESET ROLE;

-- Test 5: Service role CAN access private schema:
--   SET ROLE service_role;
--   SELECT count(*) FROM private.plaid_tokens; -- expect: success
--   RESET ROLE;
