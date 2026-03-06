/**
 * In-memory sliding window rate limiter.
 * For single-user personal app on Vercel — memory resets on cold start, which is acceptable.
 * For production multi-user: use Redis or Upstash.
 */

interface RateLimitEntry {
  timestamps: number[];
}

const store = new Map<string, RateLimitEntry>();

// Clean up entries older than the window to prevent memory leak
function cleanup(key: string, windowMs: number) {
  const entry = store.get(key);
  if (!entry) return;
  const now = Date.now();
  entry.timestamps = entry.timestamps.filter((ts) => now - ts < windowMs);
  if (entry.timestamps.length === 0) {
    store.delete(key);
  }
}

export interface RateLimitConfig {
  /** Unique identifier for this limiter (e.g. 'ai-chat', 'plaid-link') */
  name: string;
  /** Maximum requests allowed in the window */
  maxRequests: number;
  /** Window size in milliseconds */
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/**
 * Check and consume a rate limit token.
 * @param config - Rate limit configuration
 * @param identifier - Unique key (e.g. user ID or IP)
 */
export function checkRateLimit(config: RateLimitConfig, identifier: string): RateLimitResult {
  const key = `${config.name}:${identifier}`;
  const now = Date.now();

  cleanup(key, config.windowMs);

  let entry = store.get(key);
  if (!entry) {
    entry = { timestamps: [] };
    store.set(key, entry);
  }

  if (entry.timestamps.length >= config.maxRequests) {
    const oldestInWindow = entry.timestamps[0];
    return {
      allowed: false,
      remaining: 0,
      resetAt: oldestInWindow + config.windowMs,
    };
  }

  entry.timestamps.push(now);

  return {
    allowed: true,
    remaining: config.maxRequests - entry.timestamps.length,
    resetAt: now + config.windowMs,
  };
}

// Pre-configured rate limiters matching the spec
export const RATE_LIMITS = {
  AI_CHAT: { name: 'ai-chat', maxRequests: 10, windowMs: 60_000 },
  PLAID_LINK: { name: 'plaid-link', maxRequests: 3, windowMs: 60_000 },
  WEBHOOK: { name: 'webhook', maxRequests: 100, windowMs: 60_000 },
  FINANCIAL_STATE: { name: 'financial-state', maxRequests: 20, windowMs: 60_000 },
  TRANSACTIONS: { name: 'transactions', maxRequests: 60, windowMs: 60_000 },
} as const;
