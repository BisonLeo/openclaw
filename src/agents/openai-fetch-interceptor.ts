/**
 * OpenAI HTTP Fetch Interceptor
 *
 * Patches globalThis.fetch to:
 *  1. Apply pre-request rate-limit throttling for api.openai.com requests.
 *  2. Capture x-ratelimit-* response headers to update the tracker.
 *
 * Call installOpenAIFetchInterceptor() once — it is idempotent.
 *
 * This is necessary because the pi-ai SDK creates the OpenAI client internally
 * and does not expose response headers or accept a custom fetch function.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { updateFromHeaders, waitIfNeeded } from "./openai-rate-limit-tracker.js";

const log = createSubsystemLogger("agent/openai-throttle");

let installed = false;

function isOpenAIPublicApiUrl(url: string): boolean {
  try {
    return new URL(url).hostname === "api.openai.com";
  } catch {
    return url.includes("api.openai.com");
  }
}

function extractRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

/**
 * Best-effort extraction of the Bearer token from request headers.
 * Handles HeadersInit as Record, Headers instance, or array of tuples.
 */
function extractBearerToken(init?: RequestInit): string {
  if (!init?.headers) {
    return "unknown";
  }

  if (init.headers instanceof Headers) {
    const auth = init.headers.get("authorization");
    return auth?.startsWith("Bearer ") ? auth.slice(7) : "unknown";
  }

  if (Array.isArray(init.headers)) {
    for (const [k, v] of init.headers) {
      if (k.toLowerCase() === "authorization" && v.startsWith("Bearer ")) {
        return v.slice(7);
      }
    }
    return "unknown";
  }

  // Record<string, string>
  const record = init.headers;
  const auth = record["Authorization"] ?? record["authorization"];
  return typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "unknown";
}

const OPENAI_BASE_URL = "https://api.openai.com";

/**
 * Install the fetch interceptor. Idempotent — safe to call multiple times.
 */
export function installOpenAIFetchInterceptor(): void {
  if (installed || typeof globalThis.fetch !== "function") {
    return;
  }
  installed = true;
  log.info("[openai-throttle] fetch interceptor installed");

  const originalFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async function openAIThrottledFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = extractRequestUrl(input);

    if (!isOpenAIPublicApiUrl(url)) {
      return originalFetch(input, init);
    }

    const apiKey = extractBearerToken(init);

    // Pre-request: wait if budget is exhausted or very low.
    await waitIfNeeded(OPENAI_BASE_URL, apiKey, (delayMs, reason) => {
      log.info(`[openai-throttle] waiting ${delayMs}ms before request — ${reason}`);
    });

    log.info(
      `[openai-throttle] request → ${url.replace(/\?.*$/, "")} method=${init?.method ?? "GET"}`,
    );

    const response = await originalFetch(input, init);

    // Post-response: update tracker from rate limit headers.
    updateFromHeaders(OPENAI_BASE_URL, apiKey, response.headers);

    const remainingReq = response.headers.get("x-ratelimit-remaining-requests");
    const remainingTok = response.headers.get("x-ratelimit-remaining-tokens");
    if (remainingReq !== null || remainingTok !== null) {
      log.info(
        `[openai-throttle] response ← status=${response.status} remaining-requests=${remainingReq ?? "n/a"} remaining-tokens=${remainingTok ?? "n/a"}`,
      );
    } else {
      log.info(`[openai-throttle] response ← status=${response.status} (no rate limit headers)`);
    }

    return response;
  } as typeof globalThis.fetch;
}

/** Exposed for unit testing only. */
export const __testing = {
  resetInstalled(): void {
    installed = false;
  },
};
