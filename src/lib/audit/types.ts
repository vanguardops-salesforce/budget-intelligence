/**
 * Types for the Data Health self-audit.
 *
 * A "check" is a pure function over already-fetched data that returns zero or
 * more Findings. The runner performs all database IO, invokes the checks, then
 * persists an audit_run + audit_findings and reconciles action_items.
 */

export type Severity = 'info' | 'warn' | 'critical';

export type CheckKey =
  | 'unclassified_deposits'
  | 'tithe_gaps'
  | 'stale_balances'
  | 'duplicate_transactions'
  | 'plaid_item_health'
  | 'tithe_idempotency';

/** A single issue surfaced by a check. */
export interface Finding {
  checkKey: CheckKey;
  severity: Severity;
  title: string;
  /** Offending rows / amounts — rendered in the panel's expandable detail. */
  detail: Record<string, unknown>;
  itemCount: number;
  totalAmount: number;
  /** Budget-month label where relevant, else null. */
  period: string | null;
}

export type TriggeredBy = 'cron' | 'manual';

export interface AuditSummary {
  counts: Record<Severity, number>;
  totalFindings: number;
  /** Sync state when invoked from the cron, so a failed sync is visible. */
  syncState?: {
    ok: boolean;
    itemsProcessed?: number;
    itemsErrored?: number;
    note?: string;
  };
}

// ── Minimal row shapes the checks operate on (a subset of the DB columns) ──

export type AccountType = 'depository' | 'credit' | 'investment' | 'loan' | 'other';

export interface AuditAccount {
  id: string;
  name: string;
  type: AccountType;
  subtype: string | null;
  current_balance: number | null;
  updated_at: string;
  is_active: boolean;
  entity_id: string;
  plaid_item_id: string | null;
}

export interface AuditPlaidItem {
  id: string;
  institution_name: string | null;
  status: string;
  last_successful_sync: string | null;
  error_count: number;
  last_error_code: string | null;
}

export interface AuditTransaction {
  id: string;
  account_id: string;
  entity_id: string;
  amount: number;
  date: string;
  merchant_name: string | null;
}

export interface AuditIncomeSource {
  id: string;
  name: string;
  entity_id: string;
  merchant_patterns: unknown;
}

export interface AuditTitheRow {
  id: string;
  entity_id: string;
  income_date: string | null;
  tithe_owed: number;
  tithe_paid: number;
  income_transaction_id: string | null;
}

export interface AuditEntity {
  id: string;
  name: string;
}
