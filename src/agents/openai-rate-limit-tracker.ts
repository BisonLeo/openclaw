/**
 * OpenAI Rate Limit Tracker
 *
 * Tracks per-key rate limit state from:
 *  - HTTP response headers (x-ratelimit-remaining-requests, etc.)
 *  - WebSocket rate_limits.updated events
 *
 * Provides waitIfNeeded() which delays the next request when the remaining
 * budget is exhausted or dangerously low, and informs the caller via a
 * callback so the user can see how long the wait will be.
 *
 * @see https://developers.openai.com/api/docs/guides/rate-limits
 */

import { setTimeout as nodeDelay } from "node:timers/promises";

export type RateLimitInfo = {
  remainingRequests: number;
  remainingTokens: number;
  /** ms until the requests bucket resets (as recorded at updatedAt) */
  resetRequestsMs: number;
  /** ms until the tokens bucket resets (as recorded at updatedAt) */
  resetTokensMs: number;
  /** Date.now() when this snapshot was recorded */
  updatedAt: number;
};

// Start proactively throttling when this few requests remain.
const LOW_REQUESTS_THRESHOLD = 5;
// Start proactively throttling when this few tokens remain.
const LOW_TOKENS_THRESHOLD = 2_000;
// Maximum proactive delay when budget is low but not exhausted (ms).
const MAX_PROACTIVE_DELAY_MS = 3_000;
// Hard cap on how long we will wait even when remaining == 0 (ms).
const MAX_WAIT_MS = 60_000;
// Ignore tracker state older than this (quotas have likely reset).
const STALENESS_MS = 5 * 60 * 1_000;

/** Per-(baseUrl, key-prefix) state. */
const rateLimitState = new Map<string, RateLimitInfo>();

function stateKey(baseUrl: string, apiKey: string): string {
  // Truncate key to first 8 chars so we don't hold full secrets in memory.
  return `${baseUrl}::${apiKey.slice(0, 8)}`;
}

/**
 * Parse an OpenAI rate-limit reset header value such as:
 *   "0s", "120ms", "30s", "4m30s", "1m0s", "6m0s"
 * Returns milliseconds.
 */
export function parseResetDurationMs(value: string): number {
  const s = value.trim();
  if (s.endsWith("ms")) {
    return Math.max(0, parseInt(s, 10) || 0);
  }
  let ms = 0;
  const minuteMatch = s.match(/(\d+)m/);
  const secondMatch = s.match(/(\d+(?:\.\d+)?)s/);
  if (minuteMatch?.[1]) {
    ms += parseInt(minuteMatch[1], 10) * 60_000;
  }
  if (secondMatch?.[1]) {
    ms += Math.round(parseFloat(secondMatch[1]) * 1_000);
  }
  return Math.max(0, ms);
}

/**
 * Update tracker from x-ratelimit-* response headers.
 * No-ops if none of the relevant headers are present.
 */
export function updateFromHeaders(baseUrl: string, apiKey: string, headers: Headers): void {
  const remainingRequests = headers.get("x-ratelimit-remaining-requests");
  const remainingTokens = headers.get("x-ratelimit-remaining-tokens");
  const resetRequests = headers.get("x-ratelimit-reset-requests");
  const resetTokens = headers.get("x-ratelimit-reset-tokens");

  if (remainingRequests === null && remainingTokens === null) {
    return;
  }

  const key = stateKey(baseUrl, apiKey);
  const current = rateLimitState.get(key);

  rateLimitState.set(key, {
    remainingRequests:
      remainingRequests !== null
        ? Math.max(0, parseInt(remainingRequests, 10) || 0)
        : (current?.remainingRequests ?? Infinity),
    remainingTokens:
      remainingTokens !== null
        ? Math.max(0, parseInt(remainingTokens, 10) || 0)
        : (current?.remainingTokens ?? Infinity),
    resetRequestsMs:
      resetRequests !== null
        ? parseResetDurationMs(resetRequests)
        : (current?.resetRequestsMs ?? 0),
    resetTokensMs:
      resetTokens !== null ? parseResetDurationMs(resetTokens) : (current?.resetTokensMs ?? 0),
    updatedAt: Date.now(),
  });
}

/**
 * Update tracker from a WebSocket rate_limits.updated event payload.
 */
export function updateFromWsRateLimits(
  baseUrl: string,
  apiKey: string,
  rateLimits: ReadonlyArray<{ name: string; remaining: number; reset_seconds: number }>,
): void {
  const key = stateKey(baseUrl, apiKey);
  const current = rateLimitState.get(key) ?? {
    remainingRequests: Infinity,
    remainingTokens: Infinity,
    resetRequestsMs: 0,
    resetTokensMs: 0,
    updatedAt: Date.now(),
  };

  const next: RateLimitInfo = { ...current, updatedAt: Date.now() };
  for (const limit of rateLimits) {
    if (limit.name === "requests") {
      next.remainingRequests = Math.max(0, limit.remaining);
      next.resetRequestsMs = Math.round(limit.reset_seconds * 1_000);
    } else if (limit.name === "tokens") {
      next.remainingTokens = Math.max(0, limit.remaining);
      next.resetTokensMs = Math.round(limit.reset_seconds * 1_000);
    }
  }
  rateLimitState.set(key, next);
}

/**
 * Compute how many ms to wait before the next request.
 *
 * Returns 0 when no wait is needed.  When the remaining budget is completely
 * exhausted, returns the full time until reset (capped at MAX_WAIT_MS).
 * When the budget is low but not zero, returns a smaller proactive delay that
 * spreads the remaining requests over the reset window.
 */
export function computeDelayMs(info: RateLimitInfo): number {
  const elapsed = Date.now() - info.updatedAt;

  // Stale data — quotas have likely reset, don't throttle.
  if (elapsed > STALENESS_MS) {
    return 0;
  }

  // Exhausted: requests
  if (info.remainingRequests === 0 && info.resetRequestsMs > 0) {
    const waitMs = Math.max(0, info.resetRequestsMs - elapsed) + 50;
    return Math.min(waitMs, MAX_WAIT_MS);
  }

  // Exhausted: tokens
  if (info.remainingTokens === 0 && info.resetTokensMs > 0) {
    const waitMs = Math.max(0, info.resetTokensMs - elapsed) + 50;
    return Math.min(waitMs, MAX_WAIT_MS);
  }

  // Proactive throttle when budget is low
  let proactiveMs = 0;

  if (
    isFinite(info.remainingRequests) &&
    info.remainingRequests > 0 &&
    info.remainingRequests < LOW_REQUESTS_THRESHOLD &&
    info.resetRequestsMs > 0
  ) {
    const windowRemaining = Math.max(0, info.resetRequestsMs - elapsed);
    const spread = windowRemaining / info.remainingRequests;
    proactiveMs = Math.max(proactiveMs, Math.min(spread, MAX_PROACTIVE_DELAY_MS));
  }

  if (
    isFinite(info.remainingTokens) &&
    info.remainingTokens > 0 &&
    info.remainingTokens < LOW_TOKENS_THRESHOLD &&
    info.resetTokensMs > 0
  ) {
    const windowRemaining = Math.max(0, info.resetTokensMs - elapsed);
    // Rough heuristic: treat each 100 tokens as one "slot".
    const slots = Math.max(1, Math.round(info.remainingTokens / 100));
    const spread = windowRemaining / slots;
    proactiveMs = Math.max(proactiveMs, Math.min(spread, MAX_PROACTIVE_DELAY_MS));
  }

  return Math.round(proactiveMs);
}

/**
 * Build a human-readable reason string for the delay.
 */
export function describeDelay(info: RateLimitInfo, delayMs: number): string {
  const secs = (delayMs / 1_000).toFixed(1);
  if (info.remainingRequests === 0) {
    return `0 requests remaining, waiting ${secs}s for rate limit reset`;
  }
  if (info.remainingTokens === 0) {
    return `0 tokens remaining, waiting ${secs}s for rate limit reset`;
  }
  return `low budget (${info.remainingRequests} requests / ${info.remainingTokens} tokens remaining), adding ${secs}s proactive delay`;
}

/**
 * Wait if the rate limit budget requires it.
 *
 * @param baseUrl  Base URL key (e.g. "https://api.openai.com")
 * @param apiKey   The API key in use
 * @param onWait   Optional callback invoked before waiting, receives delay ms and reason
 * @param signal   Optional AbortSignal — aborted waits are treated as zero-delay
 */
export async function waitIfNeeded(
  baseUrl: string,
  apiKey: string,
  onWait?: (delayMs: number, reason: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const key = stateKey(baseUrl, apiKey);
  const info = rateLimitState.get(key);
  if (!info) {
    return;
  }

  const delayMs = computeDelayMs(info);
  if (delayMs <= 0) {
    return;
  }

  onWait?.(delayMs, describeDelay(info, delayMs));

  try {
    await nodeDelay(delayMs, undefined, signal ? { signal } : undefined);
  } catch {
    // Aborted or timer cancelled — proceed without waiting.
  }
}

/** Exposed for unit testing only. */
export const __testing = {
  clearState(): void {
    rateLimitState.clear();
  },
  getState(baseUrl: string, apiKey: string): RateLimitInfo | undefined {
    return rateLimitState.get(stateKey(baseUrl, apiKey));
  },
  setState(baseUrl: string, apiKey: string, info: RateLimitInfo): void {
    rateLimitState.set(stateKey(baseUrl, apiKey), info);
  },
};
