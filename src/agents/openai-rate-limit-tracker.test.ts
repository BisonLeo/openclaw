import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeDelayMs,
  describeDelay,
  parseResetDurationMs,
  updateFromHeaders,
  updateFromWsRateLimits,
  waitIfNeeded,
  type RateLimitInfo,
  __testing,
} from "./openai-rate-limit-tracker.js";

afterEach(() => {
  __testing.clearState();
  vi.useRealTimers();
});

// ─── parseResetDurationMs ────────────────────────────────────────────────────

describe("parseResetDurationMs", () => {
  it("parses '0s'", () => {
    expect(parseResetDurationMs("0s")).toBe(0);
  });

  it("parses milliseconds", () => {
    expect(parseResetDurationMs("120ms")).toBe(120);
  });

  it("parses seconds", () => {
    expect(parseResetDurationMs("30s")).toBe(30_000);
  });

  it("parses fractional seconds", () => {
    expect(parseResetDurationMs("1.5s")).toBe(1_500);
  });

  it("parses minutes and seconds", () => {
    expect(parseResetDurationMs("4m30s")).toBe(270_000);
  });

  it("parses minutes only", () => {
    expect(parseResetDurationMs("6m0s")).toBe(360_000);
  });

  it("handles whitespace", () => {
    expect(parseResetDurationMs("  30s  ")).toBe(30_000);
  });

  it("returns 0 for empty/invalid input", () => {
    expect(parseResetDurationMs("")).toBe(0);
    expect(parseResetDurationMs("abc")).toBe(0);
  });
});

// ─── computeDelayMs ─────────────────────────────────────────────────────────

describe("computeDelayMs", () => {
  it("returns 0 when budget is healthy", () => {
    const info: RateLimitInfo = {
      remainingRequests: 100,
      remainingTokens: 50_000,
      resetRequestsMs: 60_000,
      resetTokensMs: 60_000,
      updatedAt: Date.now(),
    };
    expect(computeDelayMs(info)).toBe(0);
  });

  it("returns reset wait when requests exhausted", () => {
    const info: RateLimitInfo = {
      remainingRequests: 0,
      remainingTokens: 50_000,
      resetRequestsMs: 10_000,
      resetTokensMs: 0,
      updatedAt: Date.now(),
    };
    const delay = computeDelayMs(info);
    // Should be ~10_050ms (reset + 50ms buffer), capped at 60s
    expect(delay).toBeGreaterThan(9_000);
    expect(delay).toBeLessThanOrEqual(60_000);
  });

  it("returns reset wait when tokens exhausted", () => {
    const info: RateLimitInfo = {
      remainingRequests: 100,
      remainingTokens: 0,
      resetRequestsMs: 0,
      resetTokensMs: 5_000,
      updatedAt: Date.now(),
    };
    const delay = computeDelayMs(info);
    expect(delay).toBeGreaterThan(4_000);
    expect(delay).toBeLessThanOrEqual(60_000);
  });

  it("caps at 60s even for long reset windows", () => {
    const info: RateLimitInfo = {
      remainingRequests: 0,
      remainingTokens: 50_000,
      resetRequestsMs: 120_000,
      resetTokensMs: 0,
      updatedAt: Date.now(),
    };
    expect(computeDelayMs(info)).toBe(60_000);
  });

  it("returns proactive delay when requests are low", () => {
    const info: RateLimitInfo = {
      remainingRequests: 2,
      remainingTokens: 50_000,
      resetRequestsMs: 30_000,
      resetTokensMs: 0,
      updatedAt: Date.now(),
    };
    const delay = computeDelayMs(info);
    // Should spread: 30_000 / 2 = 15_000, but capped at 3_000
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(3_000);
  });

  it("returns proactive delay when tokens are low", () => {
    const info: RateLimitInfo = {
      remainingRequests: 100,
      remainingTokens: 500,
      resetRequestsMs: 0,
      resetTokensMs: 30_000,
      updatedAt: Date.now(),
    };
    const delay = computeDelayMs(info);
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(3_000);
  });

  it("returns 0 for stale data (>5 minutes old)", () => {
    const info: RateLimitInfo = {
      remainingRequests: 0,
      remainingTokens: 0,
      resetRequestsMs: 60_000,
      resetTokensMs: 60_000,
      updatedAt: Date.now() - 6 * 60 * 1_000, // 6 minutes ago
    };
    expect(computeDelayMs(info)).toBe(0);
  });

  it("returns 0 when remaining is Infinity (never tracked)", () => {
    const info: RateLimitInfo = {
      remainingRequests: Infinity,
      remainingTokens: Infinity,
      resetRequestsMs: 0,
      resetTokensMs: 0,
      updatedAt: Date.now(),
    };
    expect(computeDelayMs(info)).toBe(0);
  });
});

// ─── describeDelay ──────────────────────────────────────────────────────────

describe("describeDelay", () => {
  it("describes exhausted requests", () => {
    const info: RateLimitInfo = {
      remainingRequests: 0,
      remainingTokens: 1000,
      resetRequestsMs: 30_000,
      resetTokensMs: 0,
      updatedAt: Date.now(),
    };
    const desc = describeDelay(info, 30_050);
    expect(desc).toContain("0 requests remaining");
    expect(desc).toContain("30.1s");
  });

  it("describes low budget", () => {
    const info: RateLimitInfo = {
      remainingRequests: 3,
      remainingTokens: 500,
      resetRequestsMs: 30_000,
      resetTokensMs: 30_000,
      updatedAt: Date.now(),
    };
    const desc = describeDelay(info, 2_000);
    expect(desc).toContain("low budget");
    expect(desc).toContain("3 requests");
    expect(desc).toContain("500 tokens");
  });
});

// ─── updateFromHeaders ──────────────────────────────────────────────────────

describe("updateFromHeaders", () => {
  it("updates state from response headers", () => {
    const headers = new Headers({
      "x-ratelimit-remaining-requests": "499",
      "x-ratelimit-remaining-tokens": "199000",
      "x-ratelimit-reset-requests": "120ms",
      "x-ratelimit-reset-tokens": "0s",
    });

    updateFromHeaders("https://api.openai.com", "sk-test1234abcd", headers);

    const state = __testing.getState("https://api.openai.com", "sk-test1234abcd");
    expect(state).toBeDefined();
    expect(state!.remainingRequests).toBe(499);
    expect(state!.remainingTokens).toBe(199_000);
    expect(state!.resetRequestsMs).toBe(120);
    expect(state!.resetTokensMs).toBe(0);
  });

  it("no-ops when no rate limit headers present", () => {
    const headers = new Headers({ "content-type": "application/json" });
    updateFromHeaders("https://api.openai.com", "sk-test1234abcd", headers);
    expect(__testing.getState("https://api.openai.com", "sk-test1234abcd")).toBeUndefined();
  });

  it("preserves previous values for missing headers", () => {
    // First update with both
    updateFromHeaders(
      "https://api.openai.com",
      "sk-test1234abcd",
      new Headers({
        "x-ratelimit-remaining-requests": "100",
        "x-ratelimit-remaining-tokens": "50000",
        "x-ratelimit-reset-requests": "30s",
        "x-ratelimit-reset-tokens": "1m0s",
      }),
    );
    // Second update with only requests
    updateFromHeaders(
      "https://api.openai.com",
      "sk-test1234abcd",
      new Headers({
        "x-ratelimit-remaining-requests": "99",
        "x-ratelimit-reset-requests": "29s",
      }),
    );

    const state = __testing.getState("https://api.openai.com", "sk-test1234abcd");
    expect(state!.remainingRequests).toBe(99);
    expect(state!.remainingTokens).toBe(50_000); // preserved
    expect(state!.resetRequestsMs).toBe(29_000);
    expect(state!.resetTokensMs).toBe(60_000); // preserved
  });
});

// ─── updateFromWsRateLimits ─────────────────────────────────────────────────

describe("updateFromWsRateLimits", () => {
  it("updates state from WebSocket event", () => {
    updateFromWsRateLimits("https://api.openai.com", "sk-test1234abcd", [
      { name: "requests", remaining: 498, reset_seconds: 60 },
      { name: "tokens", remaining: 180_000, reset_seconds: 30 },
    ]);

    const state = __testing.getState("https://api.openai.com", "sk-test1234abcd");
    expect(state).toBeDefined();
    expect(state!.remainingRequests).toBe(498);
    expect(state!.remainingTokens).toBe(180_000);
    expect(state!.resetRequestsMs).toBe(60_000);
    expect(state!.resetTokensMs).toBe(30_000);
  });

  it("preserves values for unmentioned limit types", () => {
    // First: set both
    updateFromWsRateLimits("https://api.openai.com", "sk-test1234abcd", [
      { name: "requests", remaining: 100, reset_seconds: 60 },
      { name: "tokens", remaining: 50_000, reset_seconds: 30 },
    ]);
    // Second: only requests
    updateFromWsRateLimits("https://api.openai.com", "sk-test1234abcd", [
      { name: "requests", remaining: 99, reset_seconds: 59 },
    ]);

    const state = __testing.getState("https://api.openai.com", "sk-test1234abcd");
    expect(state!.remainingRequests).toBe(99);
    expect(state!.remainingTokens).toBe(50_000); // preserved
  });
});

// ─── waitIfNeeded ───────────────────────────────────────────────────────────

describe("waitIfNeeded", () => {
  it("resolves immediately when no state exists", async () => {
    const onWait = vi.fn();
    await waitIfNeeded("https://api.openai.com", "sk-nostate00000", onWait);
    expect(onWait).not.toHaveBeenCalled();
  });

  it("resolves immediately when budget is healthy", async () => {
    __testing.setState("https://api.openai.com", "sk-healthy0000", {
      remainingRequests: 100,
      remainingTokens: 50_000,
      resetRequestsMs: 60_000,
      resetTokensMs: 60_000,
      updatedAt: Date.now(),
    });

    const onWait = vi.fn();
    await waitIfNeeded("https://api.openai.com", "sk-healthy0000", onWait);
    expect(onWait).not.toHaveBeenCalled();
  });

  it("calls onWait and waits when budget is exhausted", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    __testing.setState("https://api.openai.com", "sk-exhaust0000", {
      remainingRequests: 0,
      remainingTokens: 50_000,
      resetRequestsMs: 500,
      resetTokensMs: 0,
      updatedAt: Date.now(),
    });

    const onWait = vi.fn();

    await waitIfNeeded("https://api.openai.com", "sk-exhaust0000", onWait);

    expect(onWait).toHaveBeenCalledOnce();
    const [delayMs, reason] = onWait.mock.calls[0];
    expect(delayMs).toBeGreaterThan(0);
    expect(reason).toContain("0 requests remaining");
  });

  it("respects AbortSignal", async () => {
    __testing.setState("https://api.openai.com", "sk-abort000000", {
      remainingRequests: 0,
      remainingTokens: 50_000,
      resetRequestsMs: 60_000,
      resetTokensMs: 0,
      updatedAt: Date.now(),
    });

    const controller = new AbortController();
    const onWait = vi.fn();

    // Abort immediately
    controller.abort();
    await waitIfNeeded("https://api.openai.com", "sk-abort000000", onWait, controller.signal);

    // Should have called onWait (it's called before the delay) and not thrown
    expect(onWait).toHaveBeenCalledOnce();
  });
});
