-- ============================================================================
-- Migration 004: Custom Budget Month Cycle
--
-- A budget month runs from the 11th of one calendar month through the 10th
-- of the next, and is labeled by the calendar month it STARTS in:
--   "May 2026"  = May 11, 2026  -> June 10, 2026
--   "June 2026" = June 11, 2026 -> July 10, 2026
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_budget_month(d DATE)
RETURNS DATE
LANGUAGE SQL IMMUTABLE AS $$
  SELECT CASE
    WHEN EXTRACT(DAY FROM d) >= 11
      THEN DATE_TRUNC('month', d)::DATE
    ELSE DATE_TRUNC('month', d - INTERVAL '1 month')::DATE
  END
$$;

CREATE OR REPLACE FUNCTION public.get_budget_month_range(budget_month DATE)
RETURNS TABLE(start_date DATE, end_date DATE)
LANGUAGE SQL IMMUTABLE AS $$
  SELECT
    (budget_month + INTERVAL '10 days')::DATE AS start_date,
    (budget_month + INTERVAL '1 month' + INTERVAL '9 days')::DATE AS end_date
$$;

GRANT EXECUTE ON FUNCTION public.get_budget_month(DATE) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_budget_month_range(DATE) TO anon, authenticated, service_role;
