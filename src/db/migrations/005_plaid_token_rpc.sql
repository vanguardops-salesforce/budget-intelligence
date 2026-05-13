-- ============================================================================
-- Phase 2: RPC functions for private schema access
-- Service role only — used by cron jobs and webhook processing.
-- ============================================================================

-- Get encrypted access token for a plaid item
CREATE OR REPLACE FUNCTION get_plaid_token(p_plaid_item_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = private, public
AS $$
DECLARE
  v_token TEXT;
BEGIN
  SELECT access_token_encrypted INTO v_token
  FROM private.plaid_tokens
  WHERE plaid_item_id = p_plaid_item_id
  LIMIT 1;

  RETURN v_token;
END;
$$;

-- Only service_role can call this function
REVOKE ALL ON FUNCTION get_plaid_token(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION get_plaid_token(UUID) FROM anon;
REVOKE ALL ON FUNCTION get_plaid_token(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION get_plaid_token(UUID) TO service_role;

-- Store encrypted access token for a plaid item
CREATE OR REPLACE FUNCTION store_plaid_token(
  p_plaid_item_id UUID,
  p_encrypted_token TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = private, public
AS $$
BEGIN
  INSERT INTO private.plaid_tokens (plaid_item_id, access_token_encrypted)
  VALUES (p_plaid_item_id, p_encrypted_token)
  ON CONFLICT (plaid_item_id)
  DO UPDATE SET
    access_token_encrypted = EXCLUDED.access_token_encrypted,
    rotated_at = NOW();
END;
$$;

-- Add unique constraint on plaid_item_id for the upsert
ALTER TABLE private.plaid_tokens
  ADD CONSTRAINT uq_plaid_tokens_plaid_item_id UNIQUE (plaid_item_id);

-- Only service_role can call this function
REVOKE ALL ON FUNCTION store_plaid_token(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION store_plaid_token(UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION store_plaid_token(UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION store_plaid_token(UUID, TEXT) TO service_role;
