import type { Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { runExtraParamsCase } from "./extra-params.test-support.js";

type ContentBlock = { type: string; text: string; cache_control?: { type: string } };
type Message = { role: string; content: string | ContentBlock[] };

function makeAnthropicModel(): Model<"openai-completions"> {
  return {
    api: "anthropic-messages",
    provider: "api-proxy-claude",
    id: "claude-sonnet-4-6",
  } as unknown as Model<"openai-completions">;
}

function runPayload(payload: { messages: Message[] }) {
  return runExtraParamsCase({
    cfg: undefined,
    model: makeAnthropicModel(),
    payload: payload as unknown as Record<string, unknown>,
  });
}

describe("Anthropic cache prefix stability wrapper", () => {
  it("adds cache_control to second-to-last user message (array content)", () => {
    const payload = {
      messages: [
        { role: "user", content: [{ type: "text", text: "msg1" }] },
        { role: "assistant", content: [{ type: "text", text: "reply1" }] },
        { role: "user", content: [{ type: "text", text: "msg2" }] },
        { role: "assistant", content: [{ type: "text", text: "reply2" }] },
        {
          role: "user",
          content: [{ type: "text", text: "msg3", cache_control: { type: "ephemeral" } }],
        },
      ],
    };

    runPayload(payload);

    // Second-to-last user message (index 2) should get cache_control
    const secondLastUser = payload.messages[2].content as ContentBlock[];
    expect(secondLastUser[0].cache_control).toEqual({ type: "ephemeral" });

    // First user message (index 0) should NOT get cache_control (only 2nd-to-last)
    const firstUser = payload.messages[0].content as ContentBlock[];
    expect(firstUser[0].cache_control).toBeUndefined();

    // Last user message (index 4) should keep its existing cache_control
    const lastUser = payload.messages[4].content as ContentBlock[];
    expect(lastUser[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("converts string content to block array on second-to-last user message", () => {
    const payload = {
      messages: [
        { role: "user", content: "msg1" },
        { role: "assistant", content: [{ type: "text", text: "reply" }] },
        {
          role: "user",
          content: [{ type: "text", text: "msg2", cache_control: { type: "ephemeral" } }],
        },
      ],
    };

    runPayload(payload);

    const firstUser = payload.messages[0].content as ContentBlock[];
    expect(firstUser).toEqual([
      { type: "text", text: "msg1", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("does not add cache_control when only one user message exists", () => {
    const payload = {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "only msg", cache_control: { type: "ephemeral" } }],
        },
      ],
    };

    runPayload(payload);

    const content = payload.messages[0].content as ContentBlock[];
    expect(content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("does not duplicate cache_control if already present", () => {
    const payload = {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "msg1", cache_control: { type: "ephemeral" } }],
        },
        { role: "assistant", content: [{ type: "text", text: "reply" }] },
        {
          role: "user",
          content: [{ type: "text", text: "msg2", cache_control: { type: "ephemeral" } }],
        },
      ],
    };

    runPayload(payload);

    const firstUser = payload.messages[0].content as ContentBlock[];
    expect(firstUser[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("skips non-anthropic-messages API models", () => {
    const payload = {
      messages: [
        { role: "user", content: [{ type: "text", text: "msg1" }] },
        { role: "assistant", content: [{ type: "text", text: "reply" }] },
        { role: "user", content: [{ type: "text", text: "msg2" }] },
      ],
    };

    runExtraParamsCase({
      cfg: undefined,
      model: {
        api: "openai-completions",
        provider: "openai",
        id: "gpt-5.4",
      } as unknown as Model<"openai-completions">,
      payload: payload as unknown as Record<string, unknown>,
    });

    const firstUser = payload.messages[0].content as ContentBlock[];
    expect(firstUser[0].cache_control).toBeUndefined();
  });

  it("stays within 4-block limit (system=1 + wrapper=1 + pi-ai=1 = 3)", () => {
    const payload = {
      messages: [
        { role: "user", content: [{ type: "text", text: "msg1" }] },
        { role: "assistant", content: [{ type: "text", text: "reply1" }] },
        { role: "user", content: [{ type: "text", text: "msg2" }] },
        { role: "assistant", content: [{ type: "text", text: "reply2" }] },
        { role: "user", content: [{ type: "text", text: "msg3" }] },
        { role: "assistant", content: [{ type: "text", text: "reply3" }] },
        { role: "user", content: [{ type: "text", text: "msg4" }] },
        { role: "assistant", content: [{ type: "text", text: "reply4" }] },
        {
          role: "user",
          content: [{ type: "text", text: "msg5", cache_control: { type: "ephemeral" } }],
        },
      ],
    };

    runPayload(payload);

    // Count messages with cache_control (excluding system which is separate)
    let ccCount = 0;
    for (const msg of payload.messages) {
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const block of content as ContentBlock[]) {
          if (block.cache_control) {
            ccCount += 1;
          }
        }
      }
    }
    // Only 2 messages should have cache_control: second-to-last user + last user
    expect(ccCount).toBe(2);
  });

  it("consecutive turns: second-to-last breakpoint aligns with previous last", () => {
    // Turn N: pi-ai marks msg[2] as last user msg
    const turnN = {
      messages: [
        { role: "user", content: [{ type: "text", text: "msg1" }] },
        { role: "assistant", content: [{ type: "text", text: "reply1" }] },
        {
          role: "user",
          content: [{ type: "text", text: "msg2", cache_control: { type: "ephemeral" } }],
        },
      ],
    };
    runPayload(turnN);

    // Turn N+1: pi-ai marks msg[4] as last user msg, wrapper marks msg[2]
    const turnN1 = {
      messages: [
        { role: "user", content: [{ type: "text", text: "msg1" }] },
        { role: "assistant", content: [{ type: "text", text: "reply1" }] },
        { role: "user", content: [{ type: "text", text: "msg2" }] },
        { role: "assistant", content: [{ type: "text", text: "reply2" }] },
        {
          role: "user",
          content: [{ type: "text", text: "msg3", cache_control: { type: "ephemeral" } }],
        },
      ],
    };
    runPayload(turnN1);

    // msg[2] has cache_control in both turns → breakpoint content matches
    const bpTurnN = JSON.stringify(turnN.messages[2].content as ContentBlock[]);
    const bpTurnN1 = JSON.stringify(turnN1.messages[2].content as ContentBlock[]);
    expect(bpTurnN).toBe(bpTurnN1);
  });
});
