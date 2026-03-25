import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SessionLogger } from "./session.js";
import { createLoggingMiddleware } from "./loggingMiddleware.js";
import { createTimeAwarenessMiddleware } from "./timeAwarenessMiddleware.js";
import type { LogEvent } from "./types.js";
import type { Session } from "../agent/types.js";
import type { AgentConfig } from "../config.js";

function makeConfig(): AgentConfig {
  return {
    provider: "anthropic",
    model: "test-model",
    maxTokens: 1024,
    maxIterations: 10,
    tokenBudget: 800_000,
    mcpServers: [],
    systemPrompt: "You are a test agent.",
    workingDir: "/tmp",
    anthropicApiKey: "test-key",
  };
}

function makeSession(): Session {
  return {
    id: "test-session",
    startedAt: new Date(),
    messages: [],
    fileReadTimestamps: new Map(),
    logFile: "/tmp/test.jsonl",
  };
}

/** Parse JSONL file into array of events. */
async function readLogEvents(logFile: string): Promise<LogEvent[]> {
  const content = await readFile(logFile, "utf-8");
  return content
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as LogEvent);
}

describe("SessionLogger", () => {
  let tmpDir: string;
  let logFile: string;
  let logger: SessionLogger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "scuffy-log-"));
    logFile = path.join(tmpDir, "test.jsonl");
    logger = new SessionLogger(logFile);
  });

  afterEach(() => {
    logger.close();
  });

  it("writes JSONL events to file", async () => {
    logger.log({
      type: "session_start",
      sessionId: "s1",
      timestamp: new Date().toISOString(),
      instruction: "hello",
    });
    logger.log({
      type: "llm_request",
      timestamp: new Date().toISOString(),
      messageCount: 1,
      model: "test",
    });

    const events = await readLogEvents(logFile);
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("session_start");
    expect(events[1]?.type).toBe("llm_request");
  });

  it("each line is valid JSON", async () => {
    logger.log({
      type: "session_start",
      sessionId: "s1",
      timestamp: new Date().toISOString(),
      instruction: "test",
    });

    const content = await readFile(logFile, "utf-8");
    const lines = content.trim().split("\n");
    for (const line of lines) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
  });

  it("ignores writes after close", async () => {
    logger.log({
      type: "session_start",
      sessionId: "s1",
      timestamp: new Date().toISOString(),
      instruction: "first",
    });
    logger.close();
    logger.log({
      type: "llm_request",
      timestamp: new Date().toISOString(),
      messageCount: 1,
      model: "test",
    });

    const events = await readLogEvents(logFile);
    expect(events).toHaveLength(1);
  });
});

describe("LoggingMiddleware", () => {
  let tmpDir: string;
  let logFile: string;
  let logger: SessionLogger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "scuffy-mw-"));
    logFile = path.join(tmpDir, "test.jsonl");
    logger = new SessionLogger(logFile);
  });

  afterEach(() => {
    logger.close();
  });

  it("logs llm_request in beforeLLMCall", async () => {
    const mw = createLoggingMiddleware(logger);
    const config = makeConfig();
    mw.beforeLLMCall?.({
      messages: [{ role: "user", content: "hello" }],
      systemPrompt: "",
      config,
    });

    const events = await readLogEvents(logFile);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("llm_request");
    if (events[0]?.type === "llm_request") {
      expect(events[0].messageCount).toBe(1);
      expect(events[0].model).toBe("test-model");
    }
  });

  it("logs llm_response in afterLLMResponse", async () => {
    const mw = createLoggingMiddleware(logger);
    const config = makeConfig();

    // Call beforeLLMCall first to set timing
    mw.beforeLLMCall?.({ messages: [], systemPrompt: "", config });

    const mockResponse: import("../providers/types.js").LLMResponse = {
      content: [{ type: "text", text: "Hello!" }],
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2 },
    };

    mw.afterLLMResponse?.(mockResponse);

    const events = await readLogEvents(logFile);
    expect(events).toHaveLength(2);
    expect(events[1]?.type).toBe("llm_response");
    if (events[1]?.type === "llm_response") {
      expect(events[1].tokensIn).toBe(10);
      expect(events[1].tokensOut).toBe(5);
      expect(events[1].content).toBe("Hello!");
    }
  });

  it("logs tool_call and tool_result", async () => {
    const mw = createLoggingMiddleware(logger);

    mw.beforeToolCall?.({ id: "call_1", name: "think", input: { thought: "hmm" } });
    mw.afterToolResult?.(
      { id: "call_1", name: "think", input: { thought: "hmm" } },
      { content: "hmm" },
    );

    const events = await readLogEvents(logFile);
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("tool_call");
    expect(events[1]?.type).toBe("tool_result");
    if (events[0]?.type === "tool_call") {
      expect(events[0].tool).toBe("think");
      expect(events[0].callId).toBe("call_1");
    }
    if (events[1]?.type === "tool_result") {
      expect(events[1].callId).toBe("call_1");
      expect(events[1].output).toBe("hmm");
      expect(events[1].isError).toBe(false);
    }
  });
});

describe("TimeAwarenessMiddleware", () => {
  it("injects time into system prompt", () => {
    const session = makeSession();
    const mw = createTimeAwarenessMiddleware(session);
    const config = makeConfig();

    const result = mw.beforeLLMCall?.({
      messages: [],
      systemPrompt: "You are helpful.",
      config,
    });

    expect(result?.systemPrompt).toContain("You are helpful.");
    expect(result?.systemPrompt).toContain("Current time:");
    expect(result?.systemPrompt).toContain("Session started");
  });

  it("works with empty system prompt", () => {
    const session = makeSession();
    const mw = createTimeAwarenessMiddleware(session);
    const config = makeConfig();

    const result = mw.beforeLLMCall?.({
      messages: [],
      systemPrompt: "",
      config,
    });

    expect(result?.systemPrompt).toContain("Current time:");
  });
});
