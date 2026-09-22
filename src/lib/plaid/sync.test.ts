import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks, declared before importing the module under test ────────────────
const transactionsSync = vi.fn();
const accountsBalanceGet = vi.fn();
const refreshAccountsForItem = vi.fn();

vi.mock('./client', () => ({
  getPlaidClient: () => ({ transactionsSync, accountsBalanceGet }),
}));
vi.mock('./accounts', () => ({
  refreshAccountsForItem: (...args: unknown[]) => refreshAccountsForItem(...args),
}));
vi.mock('../crypto', () => ({ decrypt: () => 'access-token' }));
vi.mock('../audit', () => ({ writeAuditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { syncTransactionsForItem } from './sync';
import { UnknownAccountError } from './errors';

const ITEM_ID = 'ccffe6d8-3b5c-4da5-a02b-c166359b436e';
const USER_ID = 'user-1';
const ENTITY_ID = 'entity-1';

/** Records every write so assertions can check what did and did not happen. */
interface Recorded {
  table: string;
  op: 'upsert' | 'update';
  payload: unknown;
}

function makeSupabase(recorded: Recorded[]) {
  const ok = { data: null, error: null };

  const builder = (table: string) => {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      in: () => Promise.resolve(ok),
      single: () =>
        Promise.resolve({
          data: { plaid_item_id: 'plaid-item-abc', transactions_cursor: 'cursor-0' },
          error: null,
        }),
      upsert: (payload: unknown) => {
        recorded.push({ table, op: 'upsert', payload });
        return Promise.resolve(ok);
      },
      update: (payload: unknown) => {
        recorded.push({ table, op: 'update', payload });
        return { eq: () => Promise.resolve(ok), in: () => Promise.resolve(ok) };
      },
    };
    return chain;
  };

  return {
    from: (table: string) => builder(table),
    rpc: () => Promise.resolve({ data: 'encrypted-token', error: null }),
  } as never;
}

function plaidTxn(id: string, accountId: string) {
  return {
    transaction_id: id,
    account_id: accountId,
    amount: 12.34,
    date: '2026-09-20',
    name: 'Merchant',
    merchant_name: 'Merchant',
    category: null,
    personal_finance_category: null,
  };
}

function syncPage(over: Record<string, unknown> = {}) {
  return {
    data: {
      added: [],
      modified: [],
      removed: [],
      accounts: [],
      next_cursor: 'cursor-1',
      has_more: false,
      ...over,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  accountsBalanceGet.mockResolvedValue({ data: { accounts: [] } });
  refreshAccountsForItem.mockResolvedValue({
    accountMap: new Map([['known-acct', 'db-acct-uuid']]),
    deletedAccountIds: new Set<string>(),
    createdAccountIds: [],
    upserted: 1,
  });
});

describe('syncTransactionsForItem', () => {
  it('reconciles accounts with Plaid before ingesting anything', async () => {
    transactionsSync.mockResolvedValue(syncPage());

    await syncTransactionsForItem(makeSupabase([]), ITEM_ID, USER_ID, ENTITY_ID);

    expect(refreshAccountsForItem).toHaveBeenCalledOnce();
    // The refresh must precede the first /transactions/sync call.
    expect(refreshAccountsForItem.mock.invocationCallOrder[0]).toBeLessThan(
      transactionsSync.mock.invocationCallOrder[0]
    );
  });

  describe('the Capital One regression: unmapped accounts must abort the run', () => {
    it('throws UnknownAccountError instead of dropping the transactions', async () => {
      transactionsSync.mockResolvedValue(
        syncPage({ added: [plaidTxn('t1', 'reissued-acct'), plaidTxn('t2', 'reissued-acct')] })
      );

      await expect(
        syncTransactionsForItem(makeSupabase([]), ITEM_ID, USER_ID, ENTITY_ID)
      ).rejects.toThrow(UnknownAccountError);
    });

    it('does NOT advance the cursor or stamp last_successful_sync', async () => {
      const recorded: Recorded[] = [];
      transactionsSync.mockResolvedValue(syncPage({ added: [plaidTxn('t1', 'reissued-acct')] }));

      await expect(
        syncTransactionsForItem(makeSupabase(recorded), ITEM_ID, USER_ID, ENTITY_ID)
      ).rejects.toThrow(UnknownAccountError);

      // This is the invariant that was violated: previously the run reported
      // added: 254, wrote nothing, and committed the advanced cursor anyway.
      const itemWrites = recorded.filter((r) => r.table === 'plaid_items');
      expect(itemWrites).toHaveLength(0);
    });

    it('writes no transactions at all, not even the mappable ones on the page', async () => {
      const recorded: Recorded[] = [];
      transactionsSync.mockResolvedValue(
        syncPage({ added: [plaidTxn('good', 'known-acct'), plaidTxn('bad', 'reissued-acct')] })
      );

      await expect(
        syncTransactionsForItem(makeSupabase(recorded), ITEM_ID, USER_ID, ENTITY_ID)
      ).rejects.toThrow(UnknownAccountError);

      // A partial write would be re-delivered whole on retry anyway, so the
      // page is all-or-nothing.
      expect(recorded.filter((r) => r.table === 'transactions')).toHaveLength(0);
    });

    it('names the offending account ids and the number at risk', async () => {
      transactionsSync.mockResolvedValue(
        syncPage({ added: [plaidTxn('t1', 'acct-x'), plaidTxn('t2', 'acct-y')] })
      );

      await syncTransactionsForItem(makeSupabase([]), ITEM_ID, USER_ID, ENTITY_ID).catch(
        (err: UnknownAccountError) => {
          expect(err.unknownAccountIds.sort()).toEqual(['acct-x', 'acct-y']);
          expect(err.droppedCount).toBe(2);
          expect(err.plaidItemDbId).toBe(ITEM_ID);
        }
      );
      expect.assertions(3);
    });
  });

  describe('healthy runs', () => {
    it('counts rows written, not the size of Plaid’s page', async () => {
      transactionsSync.mockResolvedValue(
        syncPage({
          added: [plaidTxn('t1', 'known-acct'), plaidTxn('t2', 'known-acct')],
          modified: [plaidTxn('t3', 'known-acct')],
        })
      );

      const result = await syncTransactionsForItem(
        makeSupabase([]), ITEM_ID, USER_ID, ENTITY_ID
      );

      expect(result.added).toBe(2);
      expect(result.modified).toBe(1);
    });

    it('resets status to connected and clears the error fields', async () => {
      const recorded: Recorded[] = [];
      transactionsSync.mockResolvedValue(syncPage({ added: [plaidTxn('t1', 'known-acct')] }));

      await syncTransactionsForItem(makeSupabase(recorded), ITEM_ID, USER_ID, ENTITY_ID);

      const commit = recorded.find((r) => r.table === 'plaid_items' && r.op === 'update');
      expect(commit?.payload).toMatchObject({
        status: 'connected',
        last_error_code: null,
        error_count: 0,
        transactions_cursor: 'cursor-1',
      });
      // Sticky 'degraded' was the bug: success never cleared it.
      expect((commit?.payload as Record<string, unknown>).last_successful_sync).toBeTruthy();
    });

    it('commits the cursor on an empty page without inventing writes', async () => {
      const recorded: Recorded[] = [];
      transactionsSync.mockResolvedValue(syncPage());

      const result = await syncTransactionsForItem(
        makeSupabase(recorded), ITEM_ID, USER_ID, ENTITY_ID
      );

      expect(result.added).toBe(0);
      expect(recorded.filter((r) => r.table === 'transactions')).toHaveLength(0);
      expect(recorded.filter((r) => r.table === 'plaid_items')).toHaveLength(1);
    });

    it('reports accounts created by the pre-sync refresh', async () => {
      refreshAccountsForItem.mockResolvedValue({
        accountMap: new Map([['known-acct', 'db-acct-uuid'], ['new-acct', 'db-new-uuid']]),
        deletedAccountIds: new Set<string>(),
        createdAccountIds: ['new-acct'],
        upserted: 2,
      });
      transactionsSync.mockResolvedValue(syncPage({ added: [plaidTxn('t1', 'new-acct')] }));

      const result = await syncTransactionsForItem(
        makeSupabase([]), ITEM_ID, USER_ID, ENTITY_ID
      );

      // The self-healing path: an account that appeared after a relink is
      // created, so its transactions map instead of being dropped.
      expect(result.createdAccounts).toEqual(['new-acct']);
      expect(result.added).toBe(1);
    });

    it('skips transactions for soft-deleted accounts without failing the item', async () => {
      // A removed account is an intentional exclusion, not a mapping failure:
      // it must not abort the whole item's sync.
      refreshAccountsForItem.mockResolvedValue({
        accountMap: new Map([['known-acct', 'db-acct-uuid']]),
        deletedAccountIds: new Set(['removed-acct']),
        createdAccountIds: [],
        upserted: 1,
      });
      const recorded: Recorded[] = [];
      transactionsSync.mockResolvedValue(
        syncPage({ added: [plaidTxn('t1', 'known-acct'), plaidTxn('t2', 'removed-acct')] })
      );

      const result = await syncTransactionsForItem(
        makeSupabase(recorded), ITEM_ID, USER_ID, ENTITY_ID
      );

      expect(result.added).toBe(1);
      // The run still completes and commits.
      expect(recorded.filter((r) => r.table === 'plaid_items')).toHaveLength(1);
    });

    it('still aborts when an unmapped account appears alongside a deleted one', async () => {
      refreshAccountsForItem.mockResolvedValue({
        accountMap: new Map([['known-acct', 'db-acct-uuid']]),
        deletedAccountIds: new Set(['removed-acct']),
        createdAccountIds: [],
        upserted: 1,
      });
      transactionsSync.mockResolvedValue(
        syncPage({ added: [plaidTxn('t1', 'removed-acct'), plaidTxn('t2', 'mystery-acct')] })
      );

      await syncTransactionsForItem(makeSupabase([]), ITEM_ID, USER_ID, ENTITY_ID).catch(
        (err: UnknownAccountError) => {
          expect(err.unknownAccountIds).toEqual(['mystery-acct']);
          // The deliberately-removed account is not counted as at risk.
          expect(err.droppedCount).toBe(1);
        }
      );
      expect.assertions(2);
    });

    it('paginates until has_more is false', async () => {
      transactionsSync
        .mockResolvedValueOnce(
          syncPage({ added: [plaidTxn('t1', 'known-acct')], next_cursor: 'c1', has_more: true })
        )
        .mockResolvedValueOnce(
          syncPage({ added: [plaidTxn('t2', 'known-acct')], next_cursor: 'c2', has_more: false })
        );

      const result = await syncTransactionsForItem(
        makeSupabase([]), ITEM_ID, USER_ID, ENTITY_ID
      );

      expect(transactionsSync).toHaveBeenCalledTimes(2);
      expect(result.added).toBe(2);
      expect(result.cursor).toBe('c2');
    });
  });
});
