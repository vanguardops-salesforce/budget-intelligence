-- ============================================================================
-- Credit card payment action-item generator
-- ----------------------------------------------------------------------------
-- Scans public.card_statements for statements with a positive statement balance
-- whose next_payment_due_date falls within the next 5 days. Inserts a
-- high-priority action item for each one. Idempotent: a matching row with the
-- same (entity_id, due_date, title prefix) is not duplicated.
--
-- NOTE: this migration assumes public.action_items has the columns
-- (title, description, due_date, priority, category, entity_id, status). The
-- live schema was not inspected at authoring time — if additional NOT NULL
-- columns exist (e.g. user_id), they must be added to the INSERT below before
-- this migration will succeed.
-- ============================================================================

create or replace function public.generate_cc_payment_action_items()
returns void as $$
declare cs record;
begin
  for cs in
    select cs.*, e.name as entity_name
    from public.card_statements cs
    left join public.entities e on e.id = cs.entity_id
    where cs.next_payment_due_date between current_date and current_date + interval '5 days'
      and cs.last_statement_balance > 0
  loop
    insert into public.action_items (title, description, due_date, priority, category, entity_id, status)
    select
      'Pay ' || cs.card_name || ' — $' || cs.last_statement_balance::text,
      'Pay STATEMENT BALANCE of $' || cs.last_statement_balance::text ||
        ' on ' || cs.card_name || ' (' || coalesce(cs.entity_name, 'Personal') ||
        ') by ' || cs.next_payment_due_date::text || ' to avoid interest.',
      cs.next_payment_due_date, 'high', 'credit_card', cs.entity_id, 'pending'
    where not exists (
      select 1 from public.action_items
      where category = 'credit_card'
        and entity_id = cs.entity_id
        and due_date = cs.next_payment_due_date
        and title like 'Pay ' || cs.card_name || '%'
    );
  end loop;
end;
$$ language plpgsql;

grant execute on function public.generate_cc_payment_action_items() to service_role;
