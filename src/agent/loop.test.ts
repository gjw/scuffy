import { describe, expect, it, vi } from "vitest";
import type { LLMProvider, LLMResponse, ToolResultBlock } from "../providers/types.js";
import { runAgentLoop } from "./loop.js";
import type { Session } from "./types.js";
import type { Middleware } from "./middleware.js";
import { ToolRegistry } from "../tools/registry.js";
import { thinkTool } from "../tools/think.js";
import type { AgentConfig } from "../config.js";

/** Create a minimal test session. */
function makeSession(): Session {
  return {
    id: "test-session",
    startedAt: new Date(),
    messages: [],
    fileReadTimestamps: new Map(),
    claimedBeadId: null,
    logFile: "/tmp/test.jsonl",
  };
}

/** Create a minimal test config. */
function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    provider: "anthropic",
    model: "test-model",
    maxTokens: 1024,
    maxIterations: 10,
    tokenBudget: 800_000,
    mcpServers: [],
    agentName: "TestAgent",
    systemPrompt: "You are a test agent.",
    workingDir: "/tmp",
    anthropicApiKey: "test-key",
    ...overrides,
  };
}

/** Build a mock LLMResponse with text content. */
function makeTextResponse(text: string): LLMResponse {
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
}

function makeToolUseResponse(
  toolCalls: Array<{ id: string; name: string; input: unknown }>,
): LLMResponse {
  return {
    content: toolCalls.map((tc) => ({
      type: "tool_use" as const,
      id: tc.id,
      name: tc.name,
      input: tc.input,
    })),
    stopReason: "tool_use",
    usage: { inputTokens: 15, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
}

/** Create a mock LLMProvider with canned responses. */
function makeMockProvider(responses: LLMResponse[]): LLMProvider {
  let callIndex = 0;
  return {
    createCompletion: vi.fn(() => {
      const response = responses[callIndex];
      if (!response) throw new Error(`No mock response for call index ${String(callIndex)}`);
      callIndex++;
      return Promise.resolve(response);
    }),
  };
}

describe("runAgentLoop", () => {
  it("returns text response when LLM responds immediately", async () => {
    const provider = makeMockProvider([makeTextResponse("Hello!")]);
    const registry = new ToolRegistry();
    const session = makeSession();
    const config = makeConfig();

    const result = await runAgentLoop("Say hello", session, registry, [], config, { provider });

    expect(result.response).toBe("Hello!");
    expect(result.toolCallCount).toBe(0);
    expect(result.tokensUsed.in).toBe(10);
    expect(result.tokensUsed.out).toBe(5);
  });

  it("executes a tool call and returns final response", async () => {
    const provider = makeMockProvider([
      makeToolUseResponse([
        { id: "call_1", name: "think", input: { thought: "Let me consider..." } },
      ]),
      makeTextResponse("Done thinking."),
    ]);
    const registry = new ToolRegistry();
    registry.register(thinkTool);
    const session = makeSession();
    const config = makeConfig();

    const result = await runAgentLoop("Think about this", session, registry, [], config, {
      provider,
    });

    expect(result.response).toBe("Done thinking.");
    expect(result.toolCallCount).toBe(1);
    expect(result.tokensUsed.in).toBe(25);
    expect(result.tokensUsed.out).toBe(15);
  });

  it("handles multiple parallel tool calls", async () => {
    const provider = makeMockProvider([
      makeToolUseResponse([
        { id: "call_1", name: "think", input: { thought: "First thought" } },
        { id: "call_2", name: "think", input: { thought: "Second thought" } },
      ]),
      makeTextResponse("Both done."),
    ]);
    const registry = new ToolRegistry();
    registry.register(thinkTool);
    const session = makeSession();
    const config = makeConfig();

    const result = await runAgentLoop("Think twice", session, registry, [], config, { provider });

    expect(result.response).toBe("Both done.");
    expect(result.toolCallCount).toBe(2);
  });

  it("returns error for unknown tool", async () => {
    const provider = makeMockProvider([
      makeToolUseResponse([{ id: "call_1", name: "nonexistent", input: {} }]),
      makeTextResponse("I see the error."),
    ]);
    const registry = new ToolRegistry();
    registry.register(thinkTool);
    const session = makeSession();
    const config = makeConfig();

    const result = await runAgentLoop("Try bad tool", session, registry, [], config, { provider });

    expect(result.response).toBe("I see the error.");
    // Verify the tool result was an error
    const toolResultMsg = session.messages[2];
    expect(toolResultMsg).toBeDefined();
    expect(toolResultMsg?.role).toBe("user");
    const content = toolResultMsg?.content;
    expect(Array.isArray(content)).toBe(true);
    if (Array.isArray(content)) {
      const toolResult = content[0] as ToolResultBlock;
      expect(toolResult.is_error).toBe(true);
      expect(typeof toolResult.content).toBe("string");
      expect(toolResult.content).toContain("unknown tool");
    }
  });

  it("returns error for invalid tool parameters", async () => {
    const provider = makeMockProvider([
      makeToolUseResponse([{ id: "call_1", name: "think", input: { wrong_param: 123 } }]),
      makeTextResponse("Got the error."),
    ]);
    const registry = new ToolRegistry();
    registry.register(thinkTool);
    const session = makeSession();
    const config = makeConfig();

    const result = await runAgentLoop("Bad params", session, registry, [], config, { provider });

    expect(result.response).toBe("Got the error.");
    const toolResultMsg = session.messages[2];
    if (Array.isArray(toolResultMsg?.content)) {
      const toolResult = toolResultMsg.content[0] as ToolResultBlock;
      expect(toolResult.is_error).toBe(true);
      expect(toolResult.content).toContain("invalid parameters");
    }
  });

  it("respects maxIterations safety cap", async () => {
    // Return tool_use every time so loop never ends naturally
    const infiniteToolCalls = Array.from({ length: 5 }, () =>
      makeToolUseResponse([{ id: "call_loop", name: "think", input: { thought: "looping" } }]),
    );
    const provider = makeMockProvider(infiniteToolCalls);
    const registry = new ToolRegistry();
    registry.register(thinkTool);
    const session = makeSession();
    const config = makeConfig({ maxIterations: 3 });

    const result = await runAgentLoop("Loop forever", session, registry, [], config, { provider });

    expect(result.response).toContain("maximum iterations");
    expect(result.toolCallCount).toBe(3);
  });

  it("runs middleware hooks in order", async () => {
    const callOrder: string[] = [];

    const mw1: Middleware = {
      name: "mw1",
      beforeLLMCall(ctx) {
        callOrder.push("mw1:beforeLLM");
        return ctx;
      },
      afterLLMResponse(response) {
        callOrder.push("mw1:afterLLM");
        return response;
      },
      beforeToolCall(call) {
        callOrder.push("mw1:beforeTool");
        return call;
      },
      afterToolResult(_call, result) {
        callOrder.push("mw1:afterTool");
        return result;
      },
    };

    const mw2: Middleware = {
      name: "mw2",
      beforeLLMCall(ctx) {
        callOrder.push("mw2:beforeLLM");
        return ctx;
      },
      afterLLMResponse(response) {
        callOrder.push("mw2:afterLLM");
        return response;
      },
    };

    const provider = makeMockProvider([
      makeToolUseResponse([{ id: "call_1", name: "think", input: { thought: "test" } }]),
      makeTextResponse("Done."),
    ]);
    const registry = new ToolRegistry();
    registry.register(thinkTool);
    const session = makeSession();
    const config = makeConfig();

    await runAgentLoop("Test middleware", session, registry, [mw1, mw2], config, { provider });

    // First LLM call: both beforeLLM, both afterLLM, then tool hooks (mw1 only)
    expect(callOrder).toEqual([
      "mw1:beforeLLM",
      "mw2:beforeLLM",
      "mw1:afterLLM",
      "mw2:afterLLM",
      "mw1:beforeTool",
      "mw1:afterTool",
      // Second LLM call
      "mw1:beforeLLM",
      "mw2:beforeLLM",
      "mw1:afterLLM",
      "mw2:afterLLM",
    ]);
  });

  it("auto-escalates when token budget is exceeded", async () => {
    const highTokenResponse: LLMResponse = {
      content: [
        { type: "tool_use" as const, id: "call_1", name: "think", input: { thought: "big" } },
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 500_000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
    const provider = makeMockProvider([highTokenResponse, highTokenResponse]);
    const registry = new ToolRegistry();
    registry.register(thinkTool);
    const session = makeSession();
    const config = makeConfig({ tokenBudget: 900_000 });

    const result = await runAgentLoop("Do work", session, registry, [], config, { provider });

    expect(result.exitCode).toBe(1);
    expect(result.response).toContain("Token budget exceeded");
    expect(result.response).toContain("1000000 input tokens");
    expect(result.response).toContain("900000 budget");
    expect(result.tokensUsed.in).toBe(1_000_000);
  });

  it("includes context injections in user message", async () => {
    const createFn = vi.fn(() => Promise.resolve(makeTextResponse("Got it.")));
    const provider: LLMProvider = { createCompletion: createFn };
    const registry = new ToolRegistry();
    const session = makeSession();
    const config = makeConfig();

    await runAgentLoop("Do the thing", session, registry, [], config, {
      provider,
      injections: [{ type: "specification", label: "Auth spec", content: "Users must log in." }],
    });

    // The first user message should contain the context injection
    const firstMsg = session.messages[0];
    expect(firstMsg?.role).toBe("user");
    expect(typeof firstMsg?.content).toBe("string");
    const content = firstMsg?.content as string;
    expect(content).toContain('<context type="specification" label="Auth spec">');
    expect(content).toContain("Users must log in.");
    expect(content).toContain("Your instruction: Do the thing");
  });
});
