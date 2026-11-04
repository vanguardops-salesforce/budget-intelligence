import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { refreshAccountsForItem } from './accounts';

const ITEM_ID = 'item-1';
const USER_ID = 'user-1';
/** The plaid_item's entity. Accounts may legitimately differ from this. */
const ITEM_ENTITY_ID = 'entity-item';

interface Write {
  op: 'insert' | 'update';
  payload: Record<string, unknown> | Record<string, unknown>[];
}

interface ExistingRow {
  id: string;
  plaid_account_id: string;
  deleted_at: string | null;
}

/**
 * Minimal Supabase stub. `existing` is returned by both reads, so the map is
 * rebuilt from it plus anything inserted during the call.
 */
function makeSupabase(existing: ExistingRow[], writes: Write[]) {
  const rows = [...existing];

  const chain = () => {
    const self: Record<string, unknown> = {
      select: () => self,
      eq: () => self,
      is: () => self,
      then: undefined,
    };
    // Reads resolve to the current row set.
    (self as { eq: unknown }).eq = () => Promise.resolve({ data: rows, error: null });
    return self;
  };

  return {
    from: () => ({
      select: () => chain(),
      insert: (payload: Record<string, unknown>[]) => {
        writes.push({ op: 'insert', payload });
        for (const r of payload) {
          rows.push({
            id: `db-${r.plaid_account_id}`,
            plaid_account_id: r.plaid_account_id as string,
            deleted_at: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      },
      update: (payload: Record<string, unknown>) => {
        writes.push({ op: 'update', payload });
        return { eq: () => Promise.resolve({ data: null, error: null }) };
      },
    }),
  } as never;
}

function plaidAccount(id: string, over: Record<string, unknown> = {}) {
  return {
    account_id: id,
    name: 'Venture X',
    official_name: null,
    type: 'credit',
    subtype: 'credit card',
    mask: '9950',
    balances: { current: 100, available: 50, iso_currency_code: 'USD' },
    ...over,
  };
}

function makePlaid(accounts: unknown[]) {
  return { accountsGet: vi.fn().mockResolvedValue({ data: { accounts } }) } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('refreshAccountsForItem', () => {
  it('creates an account Plaid returns that we do not hold', async () => {
    const writes: Write[] = [];
    const supabase = makeSupabase([], writes);

    const result = await refreshAccountsForItem(
      supabase, makePlaid([plaidAccount('new-acct')]), 'token', ITEM_ID, USER_ID, ITEM_ENTITY_ID
    );

    expect(result.createdAccountIds).toEqual(['new-acct']);
    expect(result.accountMap.get('new-acct')).toBe('db-new-acct');

    const insert = writes.find((w) => w.op === 'insert');
    expect(insert).toBeDefined();
    // A brand-new account inherits the item's entity as its starting point.
    expect((insert!.payload as Record<string, unknown>[])[0]).toMatchObject({
      plaid_account_id: 'new-acct',
      entity_id: ITEM_ENTITY_ID,
      user_id: USER_ID,
    });
  });

  describe('user-owned fields must survive a refresh', () => {
    it('never rewrites entity_id on an existing account', async () => {
      // The account was reassigned to another entity via
      // /api/accounts/assign-entity. A blanket upsert would reset that on
      // every nightly sync, silently re-attributing the ledger.
      const writes: Write[] = [];
      const supabase = makeSupabase(
        [{ id: 'db-1', plaid_account_id: 'known-acct', deleted_at: null }],
        writes
      );

      await refreshAccountsForItem(
        supabase, makePlaid([plaidAccount('known-acct')]), 'token', ITEM_ID, USER_ID, ITEM_ENTITY_ID
      );

      expect(writes.some((w) => w.op === 'insert')).toBe(false);
      const update = writes.find((w) => w.op === 'update');
      expect(update).toBeDefined();
      expect(update!.payload).not.toHaveProperty('entity_id');
      expect(update!.payload).not.toHaveProperty('user_id');
    });

    it('does refresh the Plaid-owned fields', async () => {
      const writes: Write[] = [];
      const supabase = makeSupabase(
        [{ id: 'db-1', plaid_account_id: 'known-acct', deleted_at: null }],
        writes
      );

      await refreshAccountsForItem(
        supabase,
        makePlaid([plaidAccount('known-acct', { balances: { current: 42, available: 7, iso_currency_code: 'USD' } })]),
        'token', ITEM_ID, USER_ID, ITEM_ENTITY_ID
      );

      expect(writes.find((w) => w.op === 'update')!.payload).toMatchObject({
        current_balance: 42,
        available_balance: 7,
        mask: '9950',
      });
    });
  });

  describe('soft-deleted accounts', () => {
    it('reports them separately instead of putting them in the map', async () => {
      const writes: Write[] = [];
      const supabase = makeSupabase(
        [{ id: 'db-1', plaid_account_id: 'removed-acct', deleted_at: '2026-09-01T00:00:00Z' }],
        writes
      );

      const result = await refreshAccountsForItem(
        supabase, makePlaid([plaidAccount('removed-acct')]), 'token', ITEM_ID, USER_ID, ITEM_ENTITY_ID
      );

      expect(result.accountMap.has('removed-acct')).toBe(false);
      expect(result.deletedAccountIds.has('removed-acct')).toBe(true);
      // Must not try to insert over the row — plaid_account_id is UNIQUE, so
      // that would fail on the index.
      expect(writes.some((w) => w.op === 'insert')).toBe(false);
    });
  });

  it('normalizes an unrecognised account type to "other"', async () => {
    const writes: Write[] = [];
    const supabase = makeSupabase([], writes);

    await refreshAccountsForItem(
      supabase,
      makePlaid([plaidAccount('new-acct', { type: 'brokerage' })]),
      'token', ITEM_ID, USER_ID, ITEM_ENTITY_ID
    );

    // accounts_type_check only permits depository/credit/investment/loan/other.
    expect((writes[0].payload as Record<string, unknown>[])[0].type).toBe('other');
  });

  it('handles an item with no accounts without writing anything', async () => {
    const writes: Write[] = [];
    const result = await refreshAccountsForItem(
      makeSupabase([], writes), makePlaid([]), 'token', ITEM_ID, USER_ID, ITEM_ENTITY_ID
    );

    expect(writes).toHaveLength(0);
    expect(result.accountMap.size).toBe(0);
    expect(result.createdAccountIds).toEqual([]);
  });
});
