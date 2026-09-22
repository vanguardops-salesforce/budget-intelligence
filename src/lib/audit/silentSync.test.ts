import { describe, it, expect } from 'vitest';
import { checkSilentSyncFailure } from './checks';
import type { AuditAccount, AuditPlaidItem, AuditTransaction, Finding } from './types';

const NOW = new Date('2026-09-22T09:13:00Z');
const SYNCED_TODAY = '2026-09-22T03:20:55Z';

function item(over: Partial<AuditPlaidItem> = {}): AuditPlaidItem {
  return {
    id: 'item-1',
    institution_name: 'Capital One',
    status: 'degraded',
    last_successful_sync: SYNCED_TODAY,
    error_count: 0,
    last_error_code: null,
    ...over,
  };
}

/** Defaults to the broken case: balances stuck six weeks before the claimed sync. */
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

/** An account whose balance was refreshed by the same run that claimed success. */
function freshAccount(over: Partial<AuditAccount> = {}): AuditAccount {
  return account({ updated_at: '2026-09-22T03:20:57Z', ...over });
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

const rowsOf = (f: Finding) => f.detail.rows as Array<Record<string, unknown>>;

describe('checkSilentSyncFailure', () => {
  describe('the Capital One case — stale balances prove the sync wrote nothing', () => {
    it('reports critical when balances lag the claimed sync', () => {
      const findings = checkSilentSyncFailure([item()], [account()], [txn('2026-08-08')], NOW);

      expect(findings).toHaveLength(1);
      expect(findings[0].checkKey).toBe('silent_sync_failure');
      expect(findings[0].severity).toBe('critical');
      expect(findings[0].title).toBe('Sync reports success but is ingesting nothing');
      expect(findings[0].detail.confirmedFailures).toBe(1);

      const row = rowsOf(findings[0])[0];
      expect(row.institution).toBe('Capital One');
      expect(row.daysSinceNewestTransaction).toBe(45);
      expect(row.newestTransaction).toBe('2026-08-08');
      expect(row.balancesStale).toBe(true);
      expect(row.balanceLagHours).toBe(1032);
    });
  });

  describe('the quiet-account case — balances fresh, Plaid simply had nothing', () => {
    it('downgrades to warn when the run did refresh balances', () => {
      // Citibank 54417f43: savings account, synced today, newest txn 2026-09-09.
      const citi = item({ id: 'citi', institution_name: 'Citibank Online', status: 'connected' });
      const findings = checkSilentSyncFailure(
        [citi],
        [freshAccount({ plaid_item_id: 'citi', name: 'Citi® Accelerate Savings' })],
        [txn('2026-09-09')],
        NOW
      );

      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('warn');
      expect(findings[0].title).toBe('No new transactions since last successful sync');
      expect(findings[0].detail.confirmedFailures).toBe(0);
      expect(findings[0].detail.quietAccounts).toBe(1);
      expect(rowsOf(findings[0])[0].balancesStale).toBe(false);
    });

    it('escalates the whole finding to critical if any one item is broken', () => {
      const broken = item();
      const quiet = item({ id: 'citi', institution_name: 'Citibank Online' });
      const findings = checkSilentSyncFailure(
        [quiet, broken],
        [freshAccount({ id: 'acct-2', plaid_item_id: 'citi' }), account()],
        [txn('2026-08-08'), txn('2026-09-09', { account_id: 'acct-2' })],
        NOW
      );

      expect(findings[0].severity).toBe('critical');
      expect(findings[0].itemCount).toBe(2);
      expect(findings[0].detail.confirmedFailures).toBe(1);
      expect(findings[0].detail.quietAccounts).toBe(1);
      // Proven failures sort first.
      expect(rowsOf(findings[0]).map((r) => r.balancesStale)).toEqual([true, false]);
    });
  });

  describe('threshold behaviour', () => {
    it('stays silent when transactions are within the 5-day threshold', () => {
      expect(checkSilentSyncFailure([item()], [account()], [txn('2026-09-18')], NOW)).toEqual([]);
    });

    it('treats exactly 5 days old as healthy and 6 days as reportable', () => {
      expect(checkSilentSyncFailure([item()], [account()], [txn('2026-09-17')], NOW)).toEqual([]);
      expect(checkSilentSyncFailure([item()], [account()], [txn('2026-09-16')], NOW)).toHaveLength(1);
    });

    it('reports an item that claims success but has never ingested a transaction', () => {
      const findings = checkSilentSyncFailure([item()], [account()], [], NOW);
      expect(findings).toHaveLength(1);
      const row = rowsOf(findings[0])[0];
      expect(row.newestTransaction).toBeNull();
      expect(row.daysSinceNewestTransaction).toBeNull();
    });

    it('does not flag a never-ingested account whose balances are fresh as critical', () => {
      // Navy Federal 7ac74dfa "Business Savings": no transactions ever, but live.
      const findings = checkSilentSyncFailure([item()], [freshAccount()], [], NOW);
      expect(findings[0].severity).toBe('warn');
    });
  });

  describe('exclusions', () => {
    it('ignores items whose sync is already stale (Check E owns those)', () => {
      // Amex 18dedaa2: last success 2026-08-14, reported by Check E instead.
      const stale = item({ id: 'item-2', last_successful_sync: '2026-08-14T03:42:07Z' });
      expect(
        checkSilentSyncFailure([stale], [account({ plaid_item_id: 'item-2' })], [], NOW)
      ).toEqual([]);
    });

    it('ignores items that never synced at all', () => {
      expect(
        checkSilentSyncFailure([item({ last_successful_sync: null })], [account()], [], NOW)
      ).toEqual([]);
    });

    it('ignores items with no accounts rows to measure', () => {
      expect(checkSilentSyncFailure([item()], [], [txn('2026-01-01')], NOW)).toEqual([]);
    });

    it('ignores accounts belonging to a different item', () => {
      expect(
        checkSilentSyncFailure([item()], [account({ plaid_item_id: 'other' })], [], NOW)
      ).toEqual([]);
    });
  });

  describe('multi-account items', () => {
    it('uses the newest transaction across all accounts on the item', () => {
      const accounts = [account(), account({ id: 'acct-2', name: 'Savings' })];
      const txns = [txn('2026-08-08'), txn('2026-09-20', { account_id: 'acct-2' })];
      expect(checkSilentSyncFailure([item()], accounts, txns, NOW)).toEqual([]);
    });

    it('uses the newest balance across all accounts when grading severity', () => {
      // One account lagging is fine so long as the run touched another.
      const accounts = [account(), freshAccount({ id: 'acct-2', name: 'Savings' })];
      const findings = checkSilentSyncFailure([item()], accounts, [txn('2026-08-08')], NOW);
      expect(findings[0].severity).toBe('warn');
      expect(rowsOf(findings[0])[0].balancesStale).toBe(false);
    });
  });

  it('orders rows: proven failures, then never-ingested, then oldest first', () => {
    const items = [
      item({ id: 'a', institution_name: 'QuietRecent' }),
      item({ id: 'b', institution_name: 'QuietNever' }),
      item({ id: 'c', institution_name: 'Broken' }),
    ];
    const accounts = [
      freshAccount({ id: 'acct-a', plaid_item_id: 'a' }),
      freshAccount({ id: 'acct-b', plaid_item_id: 'b' }),
      account({ id: 'acct-c', plaid_item_id: 'c' }),
    ];
    const txns = [
      txn('2026-09-10', { account_id: 'acct-a' }),
      txn('2026-02-01', { account_id: 'acct-c' }),
    ];

    const rows = rowsOf(checkSilentSyncFailure(items, accounts, txns, NOW)[0]);
    expect(rows.map((r) => r.institution)).toEqual(['Broken', 'QuietNever', 'QuietRecent']);
  });
});
