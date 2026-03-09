import { getSecrets } from '../env';
import { logger } from '../logger';

const FMP_BASE_URL = 'https://financialmodelingprep.com/api/v3';

/**
 * Simple daily request counter. Resets on cold start (acceptable for personal app).
 * FMP free tier: 250 req/day.
 */
let dailyRequests = 0;
let lastResetDate = new Date().toDateString();

function checkDailyLimit(): boolean {
  const today = new Date().toDateString();
  if (today !== lastResetDate) {
    dailyRequests = 0;
    lastResetDate = today;
  }
  return dailyRequests < 200; // Leave buffer under 250 limit
}

interface FMPQuote {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changesPercentage: number;
  dayHigh: number;
  dayLow: number;
  marketCap: number;
  volume: number;
  pe: number | null;
  eps: number | null;
}

interface FMPProfile {
  symbol: string;
  companyName: string;
  sector: string;
  industry: string;
  description: string;
  marketCap: number;
  beta: number;
  price: number;
}

/**
 * Fetch a stock quote for educational context.
 * Returns null on failure (non-critical for AI responses).
 */
export async function getQuote(symbol: string): Promise<FMPQuote | null> {
  return fetchFMP<FMPQuote[]>(`/quote/${encodeURIComponent(symbol)}`)
    .then((data) => data?.[0] ?? null);
}

/**
 * Fetch company profile for educational context.
 */
export async function getCompanyProfile(symbol: string): Promise<FMPProfile | null> {
  return fetchFMP<FMPProfile[]>(`/profile/${encodeURIComponent(symbol)}`)
    .then((data) => data?.[0] ?? null);
}

/**
 * Fetch key financial ratios for educational comparison.
 */
export async function getKeyMetrics(symbol: string): Promise<Record<string, unknown> | null> {
  return fetchFMP<Record<string, unknown>[]>(`/key-metrics-ttm/${encodeURIComponent(symbol)}`)
    .then((data) => data?.[0] ?? null);
}

async function fetchFMP<T>(path: string): Promise<T | null> {
  if (!checkDailyLimit()) {
    logger.warn('FMP daily rate limit approaching', { daily_requests: dailyRequests });
    return null;
  }

  try {
    const secrets = getSecrets();
    const url = `${FMP_BASE_URL}${path}?apikey=${secrets.FMP_API_KEY}`;

    const res = await fetch(url, {
      next: { revalidate: 300 }, // Cache for 5 minutes (Next.js extended fetch)
    } as RequestInit);

    dailyRequests++;

    if (!res.ok) {
      logger.warn('FMP request failed', { path, status: res.status });
      return null;
    }

    return (await res.json()) as T;
  } catch (error) {
    logger.error('FMP fetch error', { path, error_message: String(error) });
    return null;
  }
}
