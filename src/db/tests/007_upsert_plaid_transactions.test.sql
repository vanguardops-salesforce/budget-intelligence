-- ============================================================================
-- Database test for migration 007: public.upsert_plaid_transactions(jsonb)
--
-- LOCAL ONLY. Never run this against production: it seeds rows (all inside a
-- transaction that is rolled back at the end, but still).
--
-- Run against a local Supabase Postgres with migrations 001-007 applied:
--
--   psql "$LOCAL_DB_URL" -v ON_ERROR_STOP=1 -f src/db/tests/007_upsert_plaid_transactions.test.sql
--
-- Every check is an ASSERT inside a DO block, so any failure aborts the run
-- with a non-zero exit and names the failed check. The final line prints
-- 'ALL 007 CHECKS PASSED' only if every check passed.
--
-- Checks:
--   a. on conflict, amount/date/merchant_name/plaid_category/account_id change
--      and EVERY user-owned field (entity_id, is_recurring, user_id,
--      user_category_id, recurring_pattern_id, notes, deleted_at) does not;
--   b. a new plaid_transaction_id is a full insert, keeping the computed
--      is_recurring and the item entity_id from the payload;
--   c. the return value equals inserted + updated;
--   d. anon and authenticated cannot execute the function; service_role can.
-- ============================================================================

BEGIN;

-- ── Fixtures ───────────────────────────────────────────────────────────────
-- Fixed UUIDs so failures are easy to read.
--   user            11111111-...
--   default entity  aaaaaaaa-...   (the plaid_item's entity)
--   other entity    22222222-...   (a per-transaction reassignment)

INSERT INTO auth.users (id, email)
VALUES ('11111111-1111-1111-1111-111111111111', 'db-test@example.invalid');

INSERT INTO public.entities (id, user_id, name, type) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'Personal', 'personal'),
  ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Business', 'llc');

INSERT INTO public.plaid_items (id, user_id, entity_id, plaid_item_id, status)
VALUES ('c0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'plaid-item-test', 'connected');

INSERT INTO public.accounts (id, user_id, entity_id, plaid_item_id, plaid_account_id, name, type)
VALUES
  ('a0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'c0000000-0000-0000-0000-000000000001',
   'plaid-acct-old', 'Venture X', 'credit'),
  ('a0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'c0000000-0000-0000-0000-000000000001',
   'plaid-acct-new', 'Venture X (reissued id)', 'credit');

INSERT INTO public.budget_categories (id, user_id, entity_id, name)
VALUES ('b0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222', 'Software');

INSERT INTO public.recurring_patterns (id, user_id, entity_id, merchant_pattern, estimated_amount, frequency)
VALUES ('f0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222', 'Old Merchant', 15.99, 'monthly');

-- The existing row, carrying every kind of user-owned state the sync must not
-- touch: a non-default entity, a recurring flag set by the app's own detection
-- (Plaid's rule would compute false for this merchant), a category, a pattern
-- link, a note, and a soft-delete marker.
INSERT INTO public.transactions (
  id, user_id, entity_id, account_id, plaid_transaction_id,
  amount, date, merchant_name, plaid_category,
  user_category_id, is_recurring, recurring_pattern_id, notes, deleted_at,
  created_at, updated_at
) VALUES (
  'e0000000-0000-0000-0000-000000000001',
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',            -- reassigned entity
  'a0000000-0000-0000-0000-000000000001',
  'txn-existing',
  15.99, DATE '2026-10-01', 'Old Merchant Name', '["Service"]'::jsonb,
  'b0000000-0000-0000-0000-000000000001',
  true,                                               -- app-detected subscription
  'f0000000-0000-0000-0000-000000000001',
  'keep this note',
  TIMESTAMPTZ '2026-10-15 00:00:00+00',
  TIMESTAMPTZ '2026-10-01 00:00:00+00',
  TIMESTAMPTZ '2026-10-01 00:00:00+00'
);

-- ── d. Privileges ──────────────────────────────────────────────────────────
DO $$
BEGIN
  ASSERT NOT has_function_privilege('anon', 'public.upsert_plaid_transactions(jsonb)', 'EXECUTE'),
    'd: anon must NOT be able to execute upsert_plaid_transactions';
  ASSERT NOT has_function_privilege('authenticated', 'public.upsert_plaid_transactions(jsonb)', 'EXECUTE'),
    'd: authenticated must NOT be able to execute upsert_plaid_transactions';
  ASSERT has_function_privilege('service_role', 'public.upsert_plaid_transactions(jsonb)', 'EXECUTE'),
    'd: service_role must be able to execute upsert_plaid_transactions';
  -- Same posture as get_plaid_token (migration 005).
  ASSERT NOT has_function_privilege('anon', 'public.get_plaid_token(uuid)', 'EXECUTE'),
    'd: sanity — get_plaid_token is also closed to anon';
  RAISE NOTICE 'PASS d: privilege checks (has_function_privilege)';
END $$;

-- Belt and braces for (d): actually attempt the call as anon and authenticated.
-- has_function_privilege is what PostgREST relies on, but the real call is the
-- proof. Each attempt must fail with insufficient_privilege.
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    BEGIN
      EXECUTE format('SET LOCAL ROLE %I', r);
      PERFORM public.upsert_plaid_transactions('[]'::jsonb);
      RESET ROLE;
      RAISE EXCEPTION 'd: % was able to execute upsert_plaid_transactions', r;
    EXCEPTION WHEN insufficient_privilege THEN
      RESET ROLE;
      RAISE NOTICE 'PASS d: % denied (insufficient_privilege)', r;
    END;
  END LOOP;
END $$;

-- ── a/b/c run as the real caller ───────────────────────────────────────────
-- The sync calls this with the service-role key, so run as service_role. The
-- function is SECURITY INVOKER, so this also proves service_role's own grants
-- on public.transactions are enough.
SET LOCAL ROLE service_role;

CREATE TEMP TABLE result (written integer) ON COMMIT DROP;

-- One modified row (existing plaid_transaction_id, new Plaid-side values and a
-- different account — the reissued-id case) plus one brand-new row.
INSERT INTO result
SELECT public.upsert_plaid_transactions($json$[
  {
    "user_id":              "11111111-1111-1111-1111-111111111111",
    "entity_id":            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    "account_id":           "a0000000-0000-0000-0000-000000000002",
    "plaid_transaction_id": "txn-existing",
    "amount":               17.49,
    "date":                 "2026-10-02",
    "merchant_name":        "New Merchant Name",
    "plaid_category":       ["Service", "Subscription"],
    "is_recurring":         false
  },
  {
    "user_id":              "11111111-1111-1111-1111-111111111111",
    "entity_id":            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    "account_id":           "a0000000-0000-0000-0000-000000000001",
    "plaid_transaction_id": "txn-new",
    "amount":               1850.00,
    "date":                 "2026-10-03",
    "merchant_name":        "Mortgage Co",
    "plaid_category":       ["Payment", "Loan"],
    "is_recurring":         true
  }
]$json$::jsonb);

RESET ROLE;

-- ── c. Return value ────────────────────────────────────────────────────────
DO $$
DECLARE
  v integer;
BEGIN
  SELECT written INTO v FROM result;
  ASSERT v = 2, format('c: expected 2 (1 updated + 1 inserted), got %s', v);
  RAISE NOTICE 'PASS c: returned % (1 updated + 1 inserted)', v;
END $$;

-- ── a. Conflict updates Plaid-owned columns only ───────────────────────────
DO $$
DECLARE
  t public.transactions%ROWTYPE;
BEGIN
  SELECT * INTO t FROM public.transactions WHERE plaid_transaction_id = 'txn-existing';

  -- Plaid-owned: must change.
  ASSERT t.amount = 17.49,                        format('a: amount not updated (%s)', t.amount);
  ASSERT t.date = DATE '2026-10-02',              format('a: date not updated (%s)', t.date);
  ASSERT t.merchant_name = 'New Merchant Name',   format('a: merchant_name not updated (%s)', t.merchant_name);
  ASSERT t.plaid_category = '["Service", "Subscription"]'::jsonb,
                                                  format('a: plaid_category not updated (%s)', t.plaid_category);
  ASSERT t.account_id = 'a0000000-0000-0000-0000-000000000002',
                                                  format('a: account_id not updated (%s)', t.account_id);
  ASSERT t.updated_at > TIMESTAMPTZ '2026-10-01 00:00:00+00',
                                                  'a: updated_at not bumped';

  -- User-owned: must NOT change, even though the payload carried different
  -- entity_id and is_recurring values.
  ASSERT t.entity_id = '22222222-2222-2222-2222-222222222222',
                                                  format('a: entity_id was overwritten (%s)', t.entity_id);
  ASSERT t.is_recurring = true,                   'a: is_recurring was overwritten';
  ASSERT t.user_id = '11111111-1111-1111-1111-111111111111',
                                                  'a: user_id changed';
  ASSERT t.user_category_id = 'b0000000-0000-0000-0000-000000000001',
                                                  'a: user_category_id changed';
  ASSERT t.recurring_pattern_id = 'f0000000-0000-0000-0000-000000000001',
                                                  'a: recurring_pattern_id changed';
  ASSERT t.notes = 'keep this note',              'a: notes changed';
  ASSERT t.deleted_at = TIMESTAMPTZ '2026-10-15 00:00:00+00',
                                                  'a: deleted_at changed';
  ASSERT t.id = 'e0000000-0000-0000-0000-000000000001',
                                                  'a: row was replaced rather than updated';
  ASSERT t.created_at = TIMESTAMPTZ '2026-10-01 00:00:00+00',
                                                  'a: created_at changed';

  RAISE NOTICE 'PASS a: Plaid-owned columns updated, all user-owned columns preserved';
END $$;

-- ── b. New id is a full insert ─────────────────────────────────────────────
DO $$
DECLARE
  t public.transactions%ROWTYPE;
BEGIN
  SELECT * INTO t FROM public.transactions WHERE plaid_transaction_id = 'txn-new';

  ASSERT FOUND,                                   'b: new row was not inserted';
  ASSERT t.entity_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
                                                  format('b: entity_id should be the item entity (%s)', t.entity_id);
  ASSERT t.is_recurring = true,                   'b: computed is_recurring not stored';
  ASSERT t.user_id = '11111111-1111-1111-1111-111111111111', 'b: user_id wrong';
  ASSERT t.account_id = 'a0000000-0000-0000-0000-000000000001', 'b: account_id wrong';
  ASSERT t.amount = 1850.00,                      'b: amount wrong';
  ASSERT t.date = DATE '2026-10-03',              'b: date wrong';
  ASSERT t.merchant_name = 'Mortgage Co',         'b: merchant_name wrong';
  ASSERT t.plaid_category = '["Payment", "Loan"]'::jsonb, 'b: plaid_category wrong';
  ASSERT t.user_category_id IS NULL,              'b: user_category_id should default to NULL';
  ASSERT t.recurring_pattern_id IS NULL,          'b: recurring_pattern_id should default to NULL';
  ASSERT t.notes IS NULL,                         'b: notes should default to NULL';
  ASSERT t.deleted_at IS NULL,                    'b: deleted_at should default to NULL';

  RAISE NOTICE 'PASS b: new plaid_transaction_id fully inserted with item entity_id and computed is_recurring';
END $$;

-- ── c (edge). Empty and replay behaviour ───────────────────────────────────
DO $$
DECLARE
  v integer;
BEGIN
  SET LOCAL ROLE service_role;

  v := public.upsert_plaid_transactions('[]'::jsonb);
  ASSERT v = 0, format('c: empty array should return 0, got %s', v);

  -- Replaying the same row is an update, counted once, and still preserves
  -- user-owned fields — the cursor-reset replay in scripts/manual/02 §C.
  v := public.upsert_plaid_transactions($json$[{
    "user_id": "11111111-1111-1111-1111-111111111111",
    "entity_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    "account_id": "a0000000-0000-0000-0000-000000000002",
    "plaid_transaction_id": "txn-existing",
    "amount": 17.49, "date": "2026-10-02",
    "merchant_name": "New Merchant Name",
    "plaid_category": ["Service", "Subscription"],
    "is_recurring": false
  }]$json$::jsonb);
  ASSERT v = 1, format('c: single replayed row should return 1, got %s', v);

  RESET ROLE;

  ASSERT (SELECT entity_id FROM public.transactions WHERE plaid_transaction_id = 'txn-existing')
           = '22222222-2222-2222-2222-222222222222',
         'c: replay overwrote entity_id';
  ASSERT (SELECT is_recurring FROM public.transactions WHERE plaid_transaction_id = 'txn-existing'),
         'c: replay overwrote is_recurring';
  ASSERT (SELECT count(*) FROM public.transactions WHERE plaid_transaction_id = 'txn-existing') = 1,
         'c: replay created a duplicate row';

  RAISE NOTICE 'PASS c: empty array returns 0; replay counts 1, no duplicate, user fields preserved';
END $$;

SELECT 'ALL 007 CHECKS PASSED' AS result;

ROLLBACK;
