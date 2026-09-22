import { describe, it, expect } from 'vitest';
import { checkSilentSyncFailure } from './checks';
import type { AuditAccount, AuditPlaidItem, AuditTransaction } from './types';

const NOW = new Date('2026-09-22T09:13:00Z');

function item(over: Partial<AuditPlaidItem> = {}): AuditPlaidItem {
  return {
    id: 'item-1',
    institution_name: 'Capital One',
    status: 'degraded',
    last_successful_sync: '2026-09-22T03:20:55Z',
    error_count: 0,
    last_error_code: null,
    ...over,
  };
}

function account(over: Partial<AuditAccount> = {}): AuditAccount {
  return {
    id: 'acct-1',
    name: 'Venture X',
    type: 'credit',
    subtype: 'credit card',
    current_balance: 100,
    updated_at: '2026-08-10T03:42:10Z',
    is_active: true,
    entity_id: 'ent-1',
    plaid_item_id: 'item-1',
    ...over,
  };
}

function txn(date: string, over: Partial<AuditTransaction> = {}): AuditTransaction {
  return {
    id: `t-${date}-${over.account_id ?? 'acct-1'}`,
    account_id: 'acct-1',
    entity_id: 'ent-1',
    amount: 10,
    date,
    merchant_name: 'Merchant',
    ...over,
  };
}

describe('checkSilentSyncFailure', () => {
  it('flags the Capital One case: synced today, newest transaction 2026-08-08', () => {
    const findings = checkSilentSyncFailure([item()], [account()], [txn('2026-08-08')], NOW);

    expect(findings).toHaveLength(1);
    expect(findings[0].checkKey).toBe('silent_sync_failure');
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].itemCount).toBe(1);

    const rows = findings[0].detail.rows as Array<Record<string, unknown>>;
    expect(rows[0].institution).toBe('Capital One');
    expect(rows[0].daysSinceNewestTransaction).toBe(45);
    expect(rows[0].newestTransaction).toBe('2026-08-08');
  });

  it('stays silent when transactions are within the 5-day threshold', () => {
    expect(
      checkSilentSyncFailure([item()], [account()], [txn('2026-09-18')], NOW)
    ).toEqual([]);
  });

  it('treats exactly 5 days old as healthy and 6 days as a failure', () => {
    expect(checkSilentSyncFailure([item()], [account()], [txn('2026-09-17')], NOW)).toEqual([]);
    expect(checkSilentSyncFailure([item()], [account()], [txn('2026-09-16')], NOW)).toHaveLength(1);
  });

  it('flags an item that claims success but has never ingested a transaction', () => {
    const findings = checkSilentSyncFailure([item()], [account()], [], NOW);
    expect(findings).toHaveLength(1);
    const rows = findings[0].detail.rows as Array<Record<string, unknown>>;
    expect(rows[0].newestTransaction).toBeNull();
    expect(rows[0].daysSinceNewestTransaction).toBeNull();
  });

  it('ignores items whose sync is already stale (Check E owns those)', () => {
    // Amex 18dedaa2: last success 2026-08-14, so Check E reports it, not this one.
    const stale = item({ id: 'item-2', last_successful_sync: '2026-08-14T03:42:07Z' });
    expect(checkSilentSyncFailure([stale], [account({ plaid_item_id: 'item-2' })], [], NOW)).toEqual([]);
  });

  it('ignores items that never synced at all', () => {
    expect(
      checkSilentSyncFailure([item({ last_successful_sync: null })], [account()], [], NOW)
    ).toEqual([]);
  });

  it('ignores items with no accounts rows to measure', () => {
    expect(checkSilentSyncFailure([item()], [], [txn('2026-01-01')], NOW)).toEqual([]);
  });

  it('uses the newest transaction across all accounts on the item', () => {
    const accounts = [account(), account({ id: 'acct-2', name: 'Savings' })];
    const txns = [txn('2026-08-08'), txn('2026-09-20', { account_id: 'acct-2' })];
    expect(checkSilentSyncFailure([item()], accounts, txns, NOW)).toEqual([]);
  });

  it('reports never-ingested items first, then oldest data first', () => {
    const items = [
      item({ id: 'a', institution_name: 'Recent-ish' }),
      item({ id: 'b', institution_name: 'Never' }),
      item({ id: 'c', institution_name: 'Ancient' }),
    ];
    const accounts = [
      account({ id: 'acct-a', plaid_item_id: 'a' }),
      account({ id: 'acct-b', plaid_item_id: 'b' }),
      account({ id: 'acct-c', plaid_item_id: 'c' }),
    ];
    const txns = [
      txn('2026-09-10', { account_id: 'acct-a' }),
      txn('2026-02-01', { account_id: 'acct-c' }),
    ];

    const rows = checkSilentSyncFailure(items, accounts, txns, NOW)[0].detail.rows as Array<
      Record<string, unknown>
    >;
    expect(rows.map((r) => r.institution)).toEqual(['Never', 'Ancient', 'Recent-ish']);
  });
});
