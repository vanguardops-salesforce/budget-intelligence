import { describe, it, expect } from 'vitest';
import { parseMerchantPatterns, merchantMatchesPatterns, isClassifiedIncome } from './patterns';
import type { AuditIncomeSource } from './types';

describe('parseMerchantPatterns', () => {
  it('parses a single-entry Postgres array literal, stripping wildcards', () => {
    expect(parseMerchantPatterns('{%NIKE%}')).toEqual(['NIKE']);
  });

  it('parses a multi-entry literal with quoted entries', () => {
    expect(parseMerchantPatterns('{%FEDEX%,"%FED EX%",%TALUTION%}')).toEqual([
      'FEDEX',
      'FED EX',
      'TALUTION',
    ]);
  });

  it('accepts a real array (post-migration shape)', () => {
    expect(parseMerchantPatterns(['%FOO%', 'BAR'])).toEqual(['FOO', 'BAR']);
  });

  it('returns [] for null/empty', () => {
    expect(parseMerchantPatterns(null)).toEqual([]);
    expect(parseMerchantPatterns('')).toEqual([]);
  });
});

describe('merchantMatchesPatterns', () => {
  it('matches case-insensitively as a substring', () => {
    expect(merchantMatchesPatterns('Nike Store #123', ['NIKE'])).toBe(true);
  });
  it('does not match unrelated merchants', () => {
    expect(merchantMatchesPatterns('Starbucks', ['NIKE'])).toBe(false);
  });
  it('returns false for a null merchant', () => {
    expect(merchantMatchesPatterns(null, ['NIKE'])).toBe(false);
  });
});

describe('isClassifiedIncome — deposit classification', () => {
  const sources: AuditIncomeSource[] = [
    { id: '1', name: 'FedEx', entity_id: 'vd', merchant_patterns: '{%FEDEX%,"%FED EX%",%TALUTION%}' },
    { id: '2', name: 'Leidos', entity_id: 'p', merchant_patterns: '{%LEIDOS%}' },
  ];

  it('classifies a known intermediary (Talution) as income', () => {
    expect(isClassifiedIncome('TALUTION GROUP LLC PAYMENT', sources)).toBe(true);
  });

  it('classifies a direct payer match', () => {
    expect(isClassifiedIncome('LEIDOS INC PAYROLL', sources)).toBe(true);
  });

  it('does not classify an unknown deposit', () => {
    expect(isClassifiedIncome('MOBILE CHECK DEPOSIT', sources)).toBe(false);
  });

  it('does not classify a null merchant', () => {
    expect(isClassifiedIncome(null, sources)).toBe(false);
  });
});
