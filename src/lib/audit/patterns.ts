/**
 * Merchant-pattern parsing and matching.
 *
 * income_sources.merchant_patterns is declared TEXT[] in migration 003 but is
 * actually stored as TEXT in production (a Postgres array literal string such
 * as `{%FEDEX%,"%FED EX%",%TALUTION%}`). We accept both shapes. The stored
 * entries are SQL LIKE patterns; for substring matching we strip the `%`
 * wildcards and compare case-insensitively.
 *
 * Note: a naive comma split mis-handles a quoted entry that itself contains a
 * comma. None of the live patterns do, and the real long-term fix is the
 * TEXT→TEXT[] migration (explicitly out of scope for this PR), so we match the
 * dashboard's pragmatic parser here.
 */
import type { AuditIncomeSource } from './types';

export function parseMerchantPatterns(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .map((p) => String(p).replace(/%/g, '').trim())
      .filter(Boolean);
  }
  if (typeof raw !== 'string' || raw.length === 0) return [];
  const inner = raw.startsWith('{') && raw.endsWith('}') ? raw.slice(1, -1) : raw;
  return inner
    .split(',')
    .map((p) => p.trim().replace(/^"|"$/g, '').replace(/%/g, ''))
    .filter(Boolean);
}

/** True if merchantName contains any of the given (wildcard-stripped) patterns. */
export function merchantMatchesPatterns(
  merchantName: string | null,
  patterns: string[]
): boolean {
  if (!merchantName) return false;
  const lower = merchantName.toLowerCase();
  return patterns.some((p) => p.length > 0 && lower.includes(p.toLowerCase()));
}

/** True if a deposit's merchant matches any known income source pattern. */
export function isClassifiedIncome(
  merchantName: string | null,
  sources: AuditIncomeSource[]
): boolean {
  if (!merchantName) return false;
  return sources.some((src) =>
    merchantMatchesPatterns(merchantName, parseMerchantPatterns(src.merchant_patterns))
  );
}
