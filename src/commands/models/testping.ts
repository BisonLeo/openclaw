import { resolveApiKeyForProvider } from "../../agents/model-auth.js";
import { withProgressTotals } from "../../cli/progress.js";
import type { OpenClawConfig } from "../../config/config.js";
import { makeProxyFetch, resolveProxyFetchFromEnv } from "../../infra/net/proxy-fetch.js";
import { type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { getTerminalTableWidth, renderTable } from "../../terminal/table.js";
import { colorize, theme } from "../../terminal/theme.js";
import { resolveConfiguredEntries } from "./list.configured.js";
import { isRich } from "./list.format.js";
import type { AuthProbeStatus } from "./list.probe.js";
import { loadModelsConfig } from "./load-config.js";
import { ensureFlagCompatibility, formatMs, modelKey } from "./shared.js";

const PING_PROMPT = "just say hi";

type TestpingResult = {
  model: string;
  status: AuthProbeStatus;
  latencyMs?: number;
  response?: string;
  error?: string;
};

/**
 * Build the request URL, headers, and body for a direct ping based on the
 * provider's configured API type.
 */
function buildPingRequest(params: {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  api: string;
}): { url: string; headers: Record<string, string>; body: string } {
  const { baseUrl, apiKey, modelId, api } = params;
  const base = baseUrl.replace(/\/+$/, "");

  if (api === "openai-responses") {
    return {
      url: `${base}/responses`,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        input: PING_PROMPT,
        max_output_tokens: 64,
      }),
    };
  }

  if (api === "anthropic-messages") {
    return {
      url: `${base}/v1/messages`,
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: PING_PROMPT }],
        max_tokens: 64,
      }),
    };
  }

  // Default: openai-completions / openai-chat
  return {
    url: `${base}/chat/completions`,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "user", content: PING_PROMPT }],
      max_tokens: 64,
    }),
  };
}

/**
 * Extract the assistant text from a raw API response body based on the API
 * format.
 */
function extractResponseText(json: unknown, api: string): string | undefined {
  if (!json || typeof json !== "object") {
    return undefined;
  }
  const obj = json as Record<string, unknown>;

  // openai-responses: output[].content[].text
  if (api === "openai-responses" && Array.isArray(obj.output)) {
    const texts: string[] = [];
    for (const item of obj.output) {
      if (
        item &&
        typeof item === "object" &&
        Array.isArray((item as Record<string, unknown>).content)
      ) {
        for (const block of (item as Record<string, unknown>).content as unknown[]) {
          if (
            block &&
            typeof block === "object" &&
            typeof (block as Record<string, unknown>).text === "string"
          ) {
            texts.push((block as Record<string, string>).text);
          }
        }
      }
    }
    return texts.join(" ").trim() || undefined;
  }

  // anthropic-messages: content[].text
  if (api === "anthropic-messages" && Array.isArray(obj.content)) {
    const texts: string[] = [];
    for (const block of obj.content) {
      if (
        block &&
        typeof block === "object" &&
        typeof (block as Record<string, unknown>).text === "string"
      ) {
        texts.push((block as Record<string, string>).text);
      }
    }
    return texts.join(" ").trim() || undefined;
  }

  // openai-chat: choices[].message.content
  if (Array.isArray(obj.choices)) {
    const texts: string[] = [];
    for (const choice of obj.choices) {
      const content = (choice as Record<string, unknown>)?.message;
      if (
        content &&
        typeof content === "object" &&
        typeof (content as Record<string, unknown>).content === "string"
      ) {
        texts.push((content as Record<string, string>).content);
      }
    }
    return texts.join(" ").trim() || undefined;
  }

  return undefined;
}

function extractErrorMessage(json: unknown): string | undefined {
  if (!json || typeof json !== "object") {
    return undefined;
  }
  const obj = json as Record<string, unknown>;
  if (obj.error && typeof obj.error === "object") {
    const msg = (obj.error as Record<string, unknown>).message;
    if (typeof msg === "string") {
      return msg;
    }
  }
  if (typeof obj.message === "string") {
    return obj.message;
  }
  return undefined;
}

async function pingModel(params: {
  cfg: OpenClawConfig;
  provider: string;
  modelId: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  timeoutMs: number;
  headers?: Record<string, string>;
  fetchImpl: typeof fetch;
}): Promise<TestpingResult> {
  const { provider, modelId, baseUrl, api, apiKey, timeoutMs, fetchImpl } = params;
  const key = modelKey(provider, modelId);
  const start = Date.now();
  const elapsed = () => Date.now() - start;

  try {
    const req = buildPingRequest({ baseUrl, apiKey, modelId, api });
    // Merge provider-level headers (e.g. custom auth headers)
    const headers = { ...req.headers, ...params.headers };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetchImpl(req.url, {
        method: "POST",
        headers,
        body: req.body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const body = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      // non-JSON response
    }

    if (!res.ok) {
      const errMsg = (json ? extractErrorMessage(json) : null) ?? `${res.status} ${res.statusText}`;
      return {
        model: key,
        status:
          res.status === 401 || res.status === 403
            ? ("auth" as const)
            : res.status === 429
              ? ("rate_limit" as const)
              : ("unknown" as const),
        latencyMs: elapsed(),
        error: errMsg,
      };
    }

    const text = json ? extractResponseText(json, api) : body.slice(0, 200);
    return {
      model: key,
      status: "ok",
      latencyMs: elapsed(),
      response: text || "[empty response]",
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { model: key, status: "timeout", latencyMs: elapsed(), error: "timeout" };
    }
    return {
      model: key,
      status: "unknown",
      latencyMs: elapsed(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Convert a glob pattern (with `*` wildcards) to a RegExp.
 * Supports patterns like `openai/*`, `api-proxy-*\/*`, `*\/gpt-5.4*`.
 */
function globToRegExp(pattern: string): RegExp {
  // Strip trailing slash if present (e.g. "api-proxy-*/")
  const cleaned = pattern.replace(/\/+$/, "");
  const escaped = cleaned.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

export async function modelsTestpingCommand(
  filters: string[],
  opts: {
    timeout?: string;
    concurrency?: string;
    json?: boolean;
    plain?: boolean;
  },
  runtime: RuntimeEnv,
) {
  ensureFlagCompatibility(opts);

  const timeoutMs = opts.timeout ? Number(opts.timeout) : 15_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("--timeout must be a positive number (ms).");
  }
  const concurrency = opts.concurrency ? Number(opts.concurrency) : 4;
  if (!Number.isFinite(concurrency) || concurrency <= 0) {
    throw new Error("--concurrency must be > 0.");
  }

  const filterPatterns = filters.length > 0 ? filters.map(globToRegExp) : null;

  const cfg = await loadModelsConfig({ commandName: "models testping", runtime });

  const { entries } = resolveConfiguredEntries(cfg);
  const targets = entries
    .filter((e) => {
      if (!filterPatterns) {
        return true;
      }
      const key = modelKey(e.ref.provider, e.ref.model);
      return filterPatterns.some((re) => re.test(key));
    })
    .toSorted((a, b) => {
      const p = a.ref.provider.localeCompare(b.ref.provider);
      return p !== 0 ? p : a.ref.model.localeCompare(b.ref.model);
    });

  if (targets.length === 0) {
    runtime.log(
      filterPatterns
        ? `No configured models matching: ${filters.join(", ")}`
        : "No configured models found.",
    );
    return;
  }

  // Resolve API keys per provider (once per provider, not per model)
  const providerKeys = new Map<string, string>();
  for (const target of targets) {
    if (!providerKeys.has(target.ref.provider)) {
      try {
        const resolved = await resolveApiKeyForProvider({
          provider: target.ref.provider,
          cfg,
        });
        providerKeys.set(target.ref.provider, resolved.apiKey || "");
      } catch {
        providerKeys.set(target.ref.provider, "");
      }
    }
  }

  // Resolve proxy-aware fetch per provider (provider config proxy > env proxy > direct)
  const providerFetchMap = new Map<string, typeof fetch>();
  for (const target of targets) {
    if (!providerFetchMap.has(target.ref.provider)) {
      const providerCfg = cfg.models?.providers?.[target.ref.provider];
      const providerProxy = (providerCfg as Record<string, unknown> | undefined)?.proxy as
        | string
        | undefined;
      const channelProxy = cfg.channels?.discord?.proxy;
      const proxyUrl = providerProxy || channelProxy;
      const fetchImpl = proxyUrl
        ? makeProxyFetch(proxyUrl)
        : (resolveProxyFetchFromEnv() ?? globalThis.fetch);
      providerFetchMap.set(target.ref.provider, fetchImpl);
    }
  }

  const results: TestpingResult[] = [];

  await withProgressTotals(
    { label: "Pinging models...", total: targets.length },
    async (update) => {
      let completed = 0;
      let cursor = 0;
      const resultSlots: Array<TestpingResult | undefined> = Array.from({
        length: targets.length,
      });

      const worker = async () => {
        while (true) {
          const index = cursor;
          cursor += 1;
          if (index >= targets.length) {
            return;
          }
          const target = targets[index];
          const providerCfg = cfg.models?.providers?.[target.ref.provider];
          const apiKey = providerKeys.get(target.ref.provider) ?? "";
          update({
            completed,
            total: targets.length,
            label: `Pinging ${target.key}`,
          });

          if (!apiKey) {
            resultSlots[index] = {
              model: target.key,
              status: "auth",
              latencyMs: 0,
              error: "No API key resolved",
            };
          } else {
            resultSlots[index] = await pingModel({
              cfg,
              provider: target.ref.provider,
              modelId: target.ref.model,
              baseUrl: providerCfg?.baseUrl ?? "",
              api: providerCfg?.api ?? "openai-completions",
              apiKey,
              timeoutMs,
              headers: providerCfg?.headers as Record<string, string> | undefined,
              fetchImpl: providerFetchMap.get(target.ref.provider) ?? globalThis.fetch,
            });
          }
          completed += 1;
          update({ completed, total: targets.length });
        }
      };

      const workerCount = Math.max(1, Math.min(targets.length, concurrency));
      await Promise.all(Array.from({ length: workerCount }, () => worker()));

      for (const slot of resultSlots) {
        if (slot) {
          results.push(slot);
        }
      }
    },
  );

  // Sort: ok results by latency ascending, then non-ok grouped
  results.sort((a, b) => {
    if (a.status === "ok" && b.status !== "ok") {
      return -1;
    }
    if (a.status !== "ok" && b.status === "ok") {
      return 1;
    }
    if (a.status === "ok" && b.status === "ok") {
      return (a.latencyMs ?? 0) - (b.latencyMs ?? 0);
    }
    return a.model.localeCompare(b.model);
  });

  if (opts.json) {
    writeRuntimeJson(runtime, { count: results.length, results });
    return;
  }

  if (opts.plain) {
    for (const r of results) {
      const latency = r.latencyMs != null ? `${r.latencyMs}ms` : "-";
      const text = r.response ?? r.error ?? "";
      runtime.log(`${r.model} ${r.status} ${latency} ${text}`);
    }
    return;
  }

  const rich = isRich(opts);
  const statusColor = (status: string) => {
    if (status === "ok") {
      return theme.success;
    }
    if (status === "rate_limit" || status === "timeout" || status === "billing") {
      return theme.warn;
    }
    if (status === "auth" || status === "format") {
      return theme.error;
    }
    return theme.muted;
  };

  const truncateResponse = (text: string, max: number) =>
    text.length > max ? `${text.slice(0, max - 1)}…` : text;

  const tableWidth = getTerminalTableWidth();
  const rows = results.map((r) => {
    const responseText = r.response ?? r.error ?? "";
    return {
      Model: colorize(rich, theme.accent, r.model),
      Status: colorize(rich, statusColor(r.status), r.status),
      Latency: colorize(
        rich,
        r.status === "ok" ? theme.success : theme.muted,
        formatMs(r.latencyMs),
      ),
      Response: colorize(
        rich,
        r.error ? theme.error : theme.muted,
        truncateResponse(responseText, 60),
      ),
    };
  });

  runtime.log(
    renderTable({
      width: tableWidth,
      columns: [
        { key: "Model", header: "Model", minWidth: 30 },
        { key: "Status", header: "Status", minWidth: 10 },
        { key: "Latency", header: "Latency", minWidth: 10 },
        { key: "Response", header: "Response", minWidth: 20 },
      ],
      rows,
    }).trimEnd(),
  );
  runtime.log(
    colorize(
      rich,
      theme.muted,
      `\n${results.length} model${results.length === 1 ? "" : "s"} pinged (timeout: ${formatMs(timeoutMs)})`,
    ),
  );
}
