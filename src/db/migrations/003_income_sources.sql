-- ============================================================================
-- Income Sources — tracks known income merchant patterns for tithing calc
-- ============================================================================

CREATE TABLE public.income_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_id UUID NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  merchant_patterns TEXT[] NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_income_sources_user_entity ON public.income_sources(user_id, entity_id);

ALTER TABLE public.income_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.income_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY "users_own_income_sources" ON public.income_sources
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.income_sources
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
