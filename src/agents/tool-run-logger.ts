import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractToolResultText } from "./pi-embedded-subscribe.tools.js";

const LOG_DIR = path.join(os.homedir(), ".openclaw", "logs");
const LOG_FILE = path.join(LOG_DIR, "tool-runs.jsonl");
const MAX_INPUT_LEN = 200;
const MAX_OUTPUT_LEN = 300;

let dirEnsured = false;

function ensureDir(): void {
  if (dirEnsured) {
    return;
  }
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    dirEnsured = true;
  } catch {
    // best-effort
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) {
    return text;
  }
  return text.slice(0, maxLen) + "…";
}

/** Extract a brief, human-readable summary from tool args. */
export function briefArgs(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") {
    return typeof args === "string" ? truncate(args, MAX_INPUT_LEN) : "";
  }
  const record = args as Record<string, unknown>;

  switch (toolName) {
    case "exec":
    case "bash": {
      const cmd = typeof record.command === "string" ? record.command : "";
      return truncate(cmd, MAX_INPUT_LEN);
    }
    case "read": {
      const filePath =
        typeof record.file_path === "string"
          ? record.file_path
          : typeof record.path === "string"
            ? record.path
            : "";
      return truncate(filePath, MAX_INPUT_LEN);
    }
    case "write":
    case "edit": {
      const filePath =
        typeof record.file_path === "string"
          ? record.file_path
          : typeof record.path === "string"
            ? record.path
            : "";
      return truncate(filePath, MAX_INPUT_LEN);
    }
    case "web_fetch": {
      const url = typeof record.url === "string" ? record.url : "";
      return truncate(url, MAX_INPUT_LEN);
    }
    case "web_search": {
      const query = typeof record.query === "string" ? record.query : "";
      return truncate(query, MAX_INPUT_LEN);
    }
    case "message": {
      const target = typeof record.target === "string" ? record.target : "";
      const text = typeof record.text === "string" ? record.text : "";
      const preview = target ? `→${target}: ${text}` : text;
      return truncate(preview, MAX_INPUT_LEN);
    }
    default: {
      try {
        return truncate(JSON.stringify(record), MAX_INPUT_LEN);
      } catch {
        return "";
      }
    }
  }
}

/** Extract a brief summary from the tool result. */
export function briefResult(result: unknown): string {
  const text = extractToolResultText(result);
  if (text) {
    return truncate(text.replace(/\n/g, " "), MAX_OUTPUT_LEN);
  }
  if (!result || typeof result !== "object") {
    return typeof result === "string" ? truncate(result, MAX_OUTPUT_LEN) : "";
  }
  try {
    return truncate(JSON.stringify(result), MAX_OUTPUT_LEN);
  } catch {
    return "";
  }
}

function appendLine(line: string): void {
  try {
    ensureDir();
    fs.appendFileSync(LOG_FILE, line + "\n", "utf8");
  } catch {
    // never block on logging failures
  }
}

/**
 * Log a completed tool run. All data is passed directly — no in-memory state
 * needed between start and end (avoids issues with bundler chunk duplication).
 */
export function logToolRun(params: {
  runId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  sanitizedResult: unknown;
  isError: boolean;
  meta: string | undefined;
  durationMs: number | undefined;
}): void {
  const record = {
    ts: new Date().toISOString(),
    runId: params.runId,
    tool: params.toolName,
    toolCallId: params.toolCallId,
    ...(params.meta ? { meta: params.meta } : {}),
    ...(params.durationMs != null ? { durationMs: params.durationMs } : {}),
    isError: params.isError,
    input: briefArgs(params.toolName, params.args),
    output: briefResult(params.sanitizedResult),
  };

  try {
    appendLine(JSON.stringify(record));
  } catch {
    // never block
  }
}
