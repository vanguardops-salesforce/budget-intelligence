/**
 * Financial Modeling Prep (FMP) API client.
 * Used for educational market data queries only.
 * Free tier: 250 req/day — we cache aggressively.
 */

import { getSecrets } from '../env';
import { logger } from '../logger';

const FMP_BASE = 'https://financialmodelingprep.com/api/v3';

export interface FundamentalsData {
  ticker: string;
  company_name: string;
  sector: string;
  industry: string;
  description: string;
  market_cap: number | null;
  pe_ratio: number | null;
  eps: number | null;
  dividend_yield: number | null;
  fifty_two_week_high: number | null;
  fifty_two_week_low: number | null;
  price: number | null;
  beta: number | null;
  disclaimer: string;
}

// In-memory cache: ticker -> { data, fetchedAt }
const cache = new Map<string, { data: FundamentalsData; fetchedAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Daily request counter (resets on cold start, which is acceptable for single-user)
let dailyRequests = 0;
let dailyResetDate = new Date().toISOString().split('T')[0];
const DAILY_LIMIT = 200; // Conservative buffer under 250

function checkDailyLimit() {
  const today = new Date().toISOString().split('T')[0];
  if (today !== dailyResetDate) {
    dailyRequests = 0;
    dailyResetDate = today;
  }
  if (dailyRequests >= DAILY_LIMIT) {
    throw new Error('FMP daily request limit reached. Try again tomorrow.');
  }
}

/**
 * Fetch fundamental data for a ticker. Returns educational context only.
 */
export async function fetchFundamentals(ticker: string): Promise<FundamentalsData> {
  const normalizedTicker = ticker.toUpperCase().replace(/[^A-Z0-9.]/g, '');

  // Check cache
  const cached = cache.get(normalizedTicker);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  checkDailyLimit();

  const secrets = getSecrets();
  const url = `${FMP_BASE}/profile/${encodeURIComponent(normalizedTicker)}?apikey=${secrets.FMP_API_KEY}`;

  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    logger.error('FMP API error', {
      status: response.status,
      ticker: normalizedTicker,
    });
    throw new Error(`FMP API returned ${response.status}`);
  }

  dailyRequests++;

  const profiles = (await response.json()) as Array<Record<string, unknown>>;

  if (!profiles || profiles.length === 0) {
    throw new Error(`No data found for ticker ${normalizedTicker}`);
  }

  const p = profiles[0];

  const data: FundamentalsData = {
    ticker: normalizedTicker,
    company_name: String(p.companyName ?? ''),
    sector: String(p.sector ?? ''),
    industry: String(p.industry ?? ''),
    description: truncate(String(p.description ?? ''), 300),
    market_cap: toNum(p.mktCap),
    pe_ratio: toNum(p.pe ?? p.peRatio),
    eps: toNum(p.eps),
    dividend_yield: toNum(p.lastDiv),
    fifty_two_week_high: toNum(p.range ? String(p.range).split('-')[1] : null),
    fifty_two_week_low: toNum(p.range ? String(p.range).split('-')[0] : null),
    price: toNum(p.price),
    beta: toNum(p.beta),
    disclaimer:
      'This data is for educational purposes only. It does not constitute investment advice or a recommendation to buy or sell any security.',
  };

  cache.set(normalizedTicker, { data, fetchedAt: Date.now() });

  logger.info('FMP fundamentals fetched', {
    ticker: normalizedTicker,
    daily_requests: dailyRequests,
  });

  return data;
}

function toNum(val: unknown): number | null {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  return isNaN(n) ? null : n;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}
