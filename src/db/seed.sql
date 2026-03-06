-- ============================================================================
-- Budget Intelligence V1 — Seed Data
-- Run AFTER creating your user in Supabase Auth.
-- Replace 'YOUR_USER_UUID' with your actual auth.users UUID.
-- ============================================================================

-- Step 1: Insert your profile (normally done by trigger, but just in case)
-- INSERT INTO public.profiles (id, email, full_name)
-- VALUES ('YOUR_USER_UUID', 'you@example.com', 'Your Name')
-- ON CONFLICT (id) DO NOTHING;

-- Step 2: Create 3 entities
INSERT INTO public.entities (id, user_id, name, type, is_active)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'YOUR_USER_UUID', 'Personal', 'personal', true),
  ('22222222-2222-2222-2222-222222222222', 'YOUR_USER_UUID', 'Veteran Digital LLC', 'llc', true),
  ('33333333-3333-3333-3333-333333333333', 'YOUR_USER_UUID', 'Veteran Capital Group LLC', 'llc', true);

-- Step 3: Create default budget categories for Personal entity
INSERT INTO public.budget_categories (user_id, entity_id, name, monthly_budget_amount)
VALUES
  ('YOUR_USER_UUID', '11111111-1111-1111-1111-111111111111', 'Housing', 2500.00),
  ('YOUR_USER_UUID', '11111111-1111-1111-1111-111111111111', 'Food & Dining', 800.00),
  ('YOUR_USER_UUID', '11111111-1111-1111-1111-111111111111', 'Transportation', 400.00),
  ('YOUR_USER_UUID', '11111111-1111-1111-1111-111111111111', 'Utilities', 300.00),
  ('YOUR_USER_UUID', '11111111-1111-1111-1111-111111111111', 'Entertainment', 200.00),
  ('YOUR_USER_UUID', '11111111-1111-1111-1111-111111111111', 'Healthcare', 250.00),
  ('YOUR_USER_UUID', '11111111-1111-1111-1111-111111111111', 'Insurance', 400.00),
  ('YOUR_USER_UUID', '11111111-1111-1111-1111-111111111111', 'Savings & Investments', 1000.00),
  ('YOUR_USER_UUID', '11111111-1111-1111-1111-111111111111', 'Subscriptions', 150.00),
  ('YOUR_USER_UUID', '11111111-1111-1111-1111-111111111111', 'Shopping', 300.00);

-- Step 4: Create default budget categories for Veteran Digital LLC
INSERT INTO public.budget_categories (user_id, entity_id, name, monthly_budget_amount)
VALUES
  ('YOUR_USER_UUID', '22222222-2222-2222-2222-222222222222', 'Software & Tools', 500.00),
  ('YOUR_USER_UUID', '22222222-2222-2222-2222-222222222222', 'Contractors', 3000.00),
  ('YOUR_USER_UUID', '22222222-2222-2222-2222-222222222222', 'Hosting & Infrastructure', 200.00),
  ('YOUR_USER_UUID', '22222222-2222-2222-2222-222222222222', 'Marketing', 500.00),
  ('YOUR_USER_UUID', '22222222-2222-2222-2222-222222222222', 'Office & Admin', 150.00);

-- Step 5: Create default budget categories for Veteran Capital Group LLC
INSERT INTO public.budget_categories (user_id, entity_id, name, monthly_budget_amount)
VALUES
  ('YOUR_USER_UUID', '33333333-3333-3333-3333-333333333333', 'Research & Data', 200.00),
  ('YOUR_USER_UUID', '33333333-3333-3333-3333-333333333333', 'Legal & Compliance', 500.00),
  ('YOUR_USER_UUID', '33333333-3333-3333-3333-333333333333', 'Platform Fees', 100.00),
  ('YOUR_USER_UUID', '33333333-3333-3333-3333-333333333333', 'Office & Admin', 100.00);
