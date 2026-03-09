-- ============================================================================
-- Migration 002: Transaction Rules Auto-Apply
-- Adds a trigger to automatically categorize new transactions based on
-- user-defined merchant pattern rules (e.g., "WHOLEFDS" → Groceries).
-- ============================================================================

-- Function: apply matching transaction rules on INSERT or UPDATE
CREATE OR REPLACE FUNCTION public.apply_transaction_rules()
RETURNS TRIGGER AS $$
DECLARE
  matched_category_id UUID;
BEGIN
  -- Skip if the transaction already has a user-assigned category
  IF NEW.user_category_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Skip if there is no merchant name to match against
  IF NEW.merchant_name IS NULL OR NEW.merchant_name = '' THEN
    RETURN NEW;
  END IF;

  -- Find the highest-priority active rule whose merchant_pattern matches
  -- Uses case-insensitive LIKE matching (pattern is stored as a substring)
  SELECT tr.category_id INTO matched_category_id
  FROM public.transaction_rules tr
  WHERE tr.user_id = NEW.user_id
    AND tr.entity_id = NEW.entity_id
    AND tr.is_active = true
    AND LOWER(NEW.merchant_name) LIKE '%' || LOWER(tr.merchant_pattern) || '%'
  ORDER BY tr.priority DESC, tr.created_at ASC
  LIMIT 1;

  IF matched_category_id IS NOT NULL THEN
    NEW.user_category_id = matched_category_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Apply on both INSERT and UPDATE of transactions
CREATE TRIGGER trg_apply_transaction_rules
  BEFORE INSERT OR UPDATE ON public.transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.apply_transaction_rules();
