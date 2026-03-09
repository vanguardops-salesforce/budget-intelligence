import { type SupabaseClient } from '@supabase/supabase-js';
import type { RecurrenceFrequency } from '../types';
import { logger } from '../logger';

interface TransactionRow {
  id: string;
  entity_id: string;
  merchant_name: string | null;
  amount: number;
  date: string;
}

interface DetectedPattern {
  entity_id: string;
  merchant_pattern: string;
  estimated_amount: number;
  frequency: RecurrenceFrequency;
  confidence_score: number;
  next_expected_date: string;
  last_seen_date: string;
}

/**
 * Analyze transaction history to detect recurring patterns.
 * Groups transactions by merchant, analyzes interval regularity and amount consistency,
 * and upserts detected patterns into the recurring_patterns table.
 *
 * Should be called after transaction syncs or as part of daily snapshot cron.
 */
export async function detectRecurringPatterns(
  supabase: SupabaseClient,
  userId: string
): Promise<{ detected: number; updated: number; deactivated: number }> {
  // Fetch last 6 months of transactions for pattern analysis
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const cutoff = sixMonthsAgo.toISOString().split('T')[0];

  const { data: transactions, error } = await supabase
    .from('transactions')
    .select('id, entity_id, merchant_name, amount, date')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .gte('date', cutoff)
    .order('date', { ascending: true });

  if (error) {
    logger.error('Failed to fetch transactions for pattern detection', {
      user_id: userId,
      error_message: error.message,
    });
    return { detected: 0, updated: 0, deactivated: 0 };
  }

  if (!transactions || transactions.length < 3) {
    return { detected: 0, updated: 0, deactivated: 0 };
  }

  // Group by merchant + entity
  const groups = groupByMerchantEntity(transactions);

  // Analyze each group for recurring patterns
  const detectedPatterns: DetectedPattern[] = [];

  for (const [key, txs] of groups.entries()) {
    if (txs.length < 2) continue;

    const pattern = analyzeGroup(key, txs);
    if (pattern && pattern.confidence_score >= 0.5) {
      detectedPatterns.push(pattern);
    }
  }

  // Upsert patterns and deactivate stale ones
  const stats = await upsertPatterns(supabase, userId, detectedPatterns);

  // Link transactions to their detected patterns
  await linkTransactionsToPatterns(supabase, userId, detectedPatterns);

  logger.info('Recurring pattern detection completed', {
    user_id: userId,
    total_groups: groups.size,
    ...stats,
  });

  return stats;
}

/**
 * Group transactions by normalized merchant name + entity.
 */
function groupByMerchantEntity(
  transactions: TransactionRow[]
): Map<string, TransactionRow[]> {
  const groups = new Map<string, TransactionRow[]>();

  for (const tx of transactions) {
    if (!tx.merchant_name) continue;
    const normalized = normalizeMerchant(tx.merchant_name);
    const key = `${tx.entity_id}::${normalized}`;
    const group = groups.get(key) ?? [];
    group.push(tx);
    groups.set(key, group);
  }

  return groups;
}

/**
 * Normalize merchant names for grouping.
 * Strips numbers, extra whitespace, and common suffixes.
 */
function normalizeMerchant(name: string): string {
  return name
    .toLowerCase()
    .replace(/[#*]\d+/g, '') // Remove reference numbers
    .replace(/\d{4,}/g, '') // Remove long number sequences
    .replace(/\s+(inc|llc|ltd|corp|co)\b\.?/gi, '') // Remove company suffixes
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Analyze a group of transactions from the same merchant to detect recurrence.
 */
function analyzeGroup(
  key: string,
  txs: TransactionRow[]
): DetectedPattern | null {
  const [entityId, merchantPattern] = key.split('::');

  // Sort by date ascending
  const sorted = [...txs].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  );

  if (sorted.length < 2) return null;

  // Compute intervals between consecutive transactions (in days)
  const intervals: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const d1 = new Date(sorted[i - 1].date);
    const d2 = new Date(sorted[i].date);
    intervals.push(Math.round((d2.getTime() - d1.getTime()) / 86_400_000));
  }

  // Detect frequency from median interval
  const medianInterval = median(intervals);
  const frequency = classifyFrequency(medianInterval);
  if (!frequency) return null;

  // Check interval consistency (coefficient of variation)
  const intervalStdDev = stddev(intervals);
  const intervalCV = medianInterval > 0 ? intervalStdDev / medianInterval : 1;

  // Check amount consistency
  const amounts = sorted.map((t) => Number(t.amount));
  const medianAmount = median(amounts);
  const amountStdDev = stddev(amounts);
  const amountCV = Math.abs(medianAmount) > 0 ? amountStdDev / Math.abs(medianAmount) : 1;

  // Confidence score: weighted combination of interval and amount consistency
  // Low CV = high consistency = high confidence
  const intervalConfidence = Math.max(0, 1 - intervalCV);
  const amountConfidence = Math.max(0, 1 - amountCV);
  const recencyBonus = sorted.length >= 3 ? 0.1 : 0;
  const confidence = Math.min(
    0.99,
    intervalConfidence * 0.5 + amountConfidence * 0.4 + recencyBonus
  );

  // Predict next expected date
  const lastDate = new Date(sorted[sorted.length - 1].date);
  const expectedInterval = frequencyToDays(frequency);
  const nextExpected = new Date(lastDate.getTime() + expectedInterval * 86_400_000);

  return {
    entity_id: entityId,
    merchant_pattern: merchantPattern,
    estimated_amount: round2(medianAmount),
    frequency,
    confidence_score: round2(confidence),
    next_expected_date: nextExpected.toISOString().split('T')[0],
    last_seen_date: sorted[sorted.length - 1].date,
  };
}

/**
 * Classify an interval in days to a frequency bucket.
 */
function classifyFrequency(days: number): RecurrenceFrequency | null {
  if (days >= 5 && days <= 9) return 'weekly';
  if (days >= 12 && days <= 18) return 'biweekly';
  if (days >= 25 && days <= 38) return 'monthly';
  if (days >= 340 && days <= 395) return 'annual';
  return null; // Not a recognized frequency
}

function frequencyToDays(freq: RecurrenceFrequency): number {
  const map: Record<RecurrenceFrequency, number> = {
    weekly: 7,
    biweekly: 14,
    monthly: 30,
    annual: 365,
  };
  return map[freq];
}

/**
 * Upsert detected patterns and deactivate stale ones.
 */
async function upsertPatterns(
  supabase: SupabaseClient,
  userId: string,
  patterns: DetectedPattern[]
): Promise<{ detected: number; updated: number; deactivated: number }> {
  let detected = 0;
  let updated = 0;

  for (const pattern of patterns) {
    // Check if pattern already exists for this user/entity/merchant
    const { data: existing } = await supabase
      .from('recurring_patterns')
      .select('id')
      .eq('user_id', userId)
      .eq('entity_id', pattern.entity_id)
      .eq('merchant_pattern', pattern.merchant_pattern)
      .maybeSingle();

    if (existing) {
      // Update existing pattern
      await supabase
        .from('recurring_patterns')
        .update({
          estimated_amount: pattern.estimated_amount,
          frequency: pattern.frequency,
          confidence_score: pattern.confidence_score,
          next_expected_date: pattern.next_expected_date,
          last_seen_date: pattern.last_seen_date,
          is_active: true,
        })
        .eq('id', existing.id);
      updated++;
    } else {
      // Insert new pattern
      await supabase.from('recurring_patterns').insert({
        user_id: userId,
        entity_id: pattern.entity_id,
        merchant_pattern: pattern.merchant_pattern,
        estimated_amount: pattern.estimated_amount,
        frequency: pattern.frequency,
        confidence_score: pattern.confidence_score,
        next_expected_date: pattern.next_expected_date,
        last_seen_date: pattern.last_seen_date,
        is_active: true,
      });
      detected++;
    }
  }

  // Deactivate patterns not seen in last 90 days
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
  const cutoff = ninetyDaysAgo.toISOString().split('T')[0];

  const { count } = await supabase
    .from('recurring_patterns')
    .update({ is_active: false })
    .eq('user_id', userId)
    .eq('is_active', true)
    .lt('last_seen_date', cutoff)
    .select('id', { count: 'exact', head: true });

  return { detected, updated, deactivated: count ?? 0 };
}

/**
 * Mark transactions as recurring and link to their pattern.
 */
async function linkTransactionsToPatterns(
  supabase: SupabaseClient,
  userId: string,
  patterns: DetectedPattern[]
): Promise<void> {
  for (const pattern of patterns) {
    // Find the pattern record
    const { data: patternRecord } = await supabase
      .from('recurring_patterns')
      .select('id')
      .eq('user_id', userId)
      .eq('entity_id', pattern.entity_id)
      .eq('merchant_pattern', pattern.merchant_pattern)
      .maybeSingle();

    if (!patternRecord) continue;

    // Update matching transactions — use ILIKE for case-insensitive merchant match
    await supabase
      .from('transactions')
      .update({
        is_recurring: true,
        recurring_pattern_id: patternRecord.id,
      })
      .eq('user_id', userId)
      .eq('entity_id', pattern.entity_id)
      .ilike('merchant_name', `%${pattern.merchant_pattern}%`);
  }
}

// --- Statistical helpers ---

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  const variance =
    values.reduce((s, v) => s + (v - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
