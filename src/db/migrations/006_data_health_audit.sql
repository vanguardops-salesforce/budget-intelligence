-- ============================================================================
-- Phase 1: Data Health self-audit storage
-- Two tables capture the output of the nightly automated integrity audit.
-- The audit feature is READ-ONLY against financial data; it only ever writes
-- to these tables and to public.action_items.
-- ============================================================================

-- One row per audit execution (cron or manual).
CREATE TABLE public.audit_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  triggered_by TEXT NOT NULL CHECK (triggered_by IN ('cron', 'manual')),
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_runs_user_run_at ON public.audit_runs(user_id, run_at DESC);

-- One row per issue found within a run.
CREATE TABLE public.audit_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES public.audit_runs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  check_key TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warn', 'critical')),
  title TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  item_count INT NOT NULL DEFAULT 0,
  total_amount NUMERIC NOT NULL DEFAULT 0,
  period TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX idx_audit_findings_lookup
  ON public.audit_findings(user_id, check_key, period, resolved_at);

CREATE INDEX idx_audit_findings_run ON public.audit_findings(run_id);

-- RLS: a user may only see their own audit history. All writes happen through
-- the service-role client (which bypasses RLS), but we still scope read access
-- and own-row writes to the owner, mirroring the income_sources convention.
ALTER TABLE public.audit_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY "users_own_audit_runs" ON public.audit_runs
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

ALTER TABLE public.audit_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_findings FORCE ROW LEVEL SECURITY;
CREATE POLICY "users_own_audit_findings" ON public.audit_findings
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
