import { describe, it, expect } from 'vitest';
import { applyActivityToBalance, balanceAgeDays, estimateAccountBalance } from './balance';
import type { AuditAccount, AuditTransaction } from './types';

describe('applyActivityToBalance — sign convention', () => {
  it('depository: positive net (money out) reduces cash', () => {
    expect(applyActivityToBalance('depository', 1000, 200)).toBe(800);
  });

  it('depository: negative net (deposit) increases cash', () => {
    expect(applyActivityToBalance('depository', 1000, -500)).toBe(1500);
  });

  it('credit: positive net (charge) increases balance owed', () => {
    expect(applyActivityToBalance('credit', 3000, 250)).toBe(3250);
  });

  it('credit: negative net (payment) reduces balance owed', () => {
    expect(applyActivityToBalance('credit', 3000, -1000)).toBe(2000);
  });

  it('other types are returned unchanged', () => {
    expect(applyActivityToBalance('investment', 5000, 999)).toBe(5000);
    expect(applyActivityToBalance('loan', 5000, -999)).toBe(5000);
  });
});

describe('balanceAgeDays', () => {
  it('counts whole days between snapshot and now', () => {
    const now = new Date('2026-05-29T00:00:00Z');
    expect(balanceAgeDays('2026-05-26T00:00:00Z', now)).toBe(3);
  });
});

describe('estimateAccountBalance', () => {
  const account: AuditAccount = {
    id: 'acct-1',
    name: 'Checking',
    type: 'depository',
    subtype: 'checking',
    current_balance: 1000,
    updated_at: '2026-05-01T00:00:00Z',
    is_active: true,
    entity_id: 'e1',
    plaid_item_id: 'p1',
  };

  const txns: AuditTransaction[] = [
    // Before the snapshot day — excluded.
    { id: 't0', account_id: 'acct-1', entity_id: 'e1', amount: -100, date: '2026-04-30', merchant_name: 'Old' },
    // On the snapshot day — included; money out.
    { id: 't1', account_id: 'acct-1', entity_id: 'e1', amount: 50, date: '2026-05-01', merchant_name: 'Coffee' },
    // After the snapshot — included; deposit.
    { id: 't2', account_id: 'acct-1', entity_id: 'e1', amount: -200, date: '2026-05-10', merchant_name: 'Paycheck' },
    // Different account — excluded.
    { id: 't3', account_id: 'acct-2', entity_id: 'e1', amount: 999, date: '2026-05-12', merchant_name: 'Other' },
  ];

  it('applies only on/after the snapshot day for the matching account', () => {
    // net included = 50 + (-200) = -150 ; depository -> 1000 - (-150) = 1150
    expect(estimateAccountBalance(account, txns)).toBe(1150);
  });
});
