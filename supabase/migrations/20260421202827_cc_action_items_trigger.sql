-- ============================================================================
-- Credit card payment action-item generator
-- ----------------------------------------------------------------------------
-- Scans public.card_statements for statements with a positive statement balance
-- whose next_payment_due_date falls within the next 5 days. Inserts a
-- priority-1 action_item per statement. Idempotent: a matching active
-- credit_card action with the same due_date and label prefix is not duplicated.
--
-- NOTE: this migration file is for PR accuracy only. The function has already
-- been applied manually in Supabase; do not re-run this migration against the
-- live DB.
--
-- Schema notes:
--   public.action_items uses (user_id, label, detail, due_date, priority
--     (INTEGER, 1=highest), category, status, is_active). status CHECK
--     allows: overdue | in_progress | on_track | done | snoozed.
--   public.card_statements has no user_id; join accounts by plaid_account_id
--     to resolve it. entity_id stays on card_statements and is joined to
--     public.entities purely for the display name.
-- ============================================================================

create or replace function public.generate_cc_payment_action_items()
returns void as $$
declare
  cs record;
begin
  for cs in
    select
      cs.*,
      a.user_id,
      e.name as entity_name
    from public.card_statements cs
    join public.accounts a on a.plaid_account_id = cs.plaid_account_id
    left join public.entities e on e.id = cs.entity_id
    where cs.next_payment_due_date between current_date and current_date + interval '5 days'
      and cs.last_statement_balance > 0
      and a.is_active = true
  loop
    insert into public.action_items (
      user_id, label, detail, due_date, priority, category, status, is_active
    )
    select
      cs.user_id,
      'Pay ' || cs.card_name || ' — $' || cs.last_statement_balance::text,
      'Pay STATEMENT BALANCE of $' || cs.last_statement_balance::text ||
        ' on ' || cs.card_name || ' (' || coalesce(cs.entity_name, 'Personal') ||
        ') by ' || cs.next_payment_due_date::text || ' to avoid interest. Do NOT pay less than this amount.',
      cs.next_payment_due_date,
      1,  -- 1 = highest priority
      'credit_card',
      case
        when cs.next_payment_due_date < current_date then 'overdue'
        else 'on_track'
      end,
      true
    where not exists (
      select 1 from public.action_items ai
      where ai.category = 'credit_card'
        and ai.due_date = cs.next_payment_due_date
        and ai.label like 'Pay ' || cs.card_name || '%'
        and ai.is_active = true
    );
  end loop;
end;
$$ language plpgsql;
