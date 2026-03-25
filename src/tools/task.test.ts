import { describe, expect, it, vi, beforeEach } from "vitest";
import { mkdtemp, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { AgentConfig } from "../config.js";
import type { LLMProvider } from "../providers/types.js";
import type { ToolContext } from "./types.js";
import { ToolRegistry } from "./registry.js";
import { thinkTool } from "./think.js";
import { createTaskTool } from "./task.js";

const mockProvider: LLMProvider = {
  createCompletion: vi.fn(),
};

// Mock runAgentLoop to avoid real API calls
vi.mock("../agent/loop.js", () => ({
  runAgentLoop: vi.fn(),
}));

// Mock SessionLogger to avoid file I/O
vi.mock("../logging/session.js", () => ({
  SessionLogger: class MockSessionLogger {
    log = vi.fn();
    close = vi.fn();
  },
}));

// Mock middleware factories
vi.mock("../logging/loggingMiddleware.js", () => ({
  createLoggingMiddleware: vi.fn().mockReturnValue({ name: "logging" }),
}));
vi.mock("../logging/timeAwarenessMiddleware.js", () => ({
  createTimeAwarenessMiddleware: vi.fn().mockReturnValue({ name: "timeAwareness" }),
}));

function makeCtx(): ToolContext {
  return {
    sessionId: "parent-session",
    workingDir: "/tmp",
    fileReadTimestamps: new Map(),
    notifyHuman: async () => {},
    recordOutcome: async () => {},
    log: () => {
      /* noop */
    },
  };
}

function makeConfig(workingDir: string): AgentConfig {
  return {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    maxTokens: 4096,
    maxIterations: 10,
    tokenBudget: 800_000,
    mcpServers: [],
    systemPrompt: "",
    workingDir,
    anthropicApiKey: "test-key",
  };
}

describe("task tool", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "scuffy-task-"));
    await mkdir(path.join(tmpDir, ".scuffy", "sessions"), { recursive: true });
  });

  it("has correct name and description", () => {
    const registry = new ToolRegistry();
    registry.register(thinkTool);
    const tool = createTaskTool(registry, makeConfig(tmpDir), mockProvider);
    expect(tool.name).toBe("task");
    expect(tool.description).toContain("subagent");
  });

  it("spawns a subagent and returns its response", async () => {
    const { runAgentLoop } = await import("../agent/loop.js");
    const mockLoop = vi.mocked(runAgentLoop);
    mockLoop.mockResolvedValueOnce({
      response: "The file contains 42 lines.",
      tokensUsed: { in: 100, out: 50, cacheRead: 0, cacheWrite: 0 },
      toolCallCount: 1,
      durationMs: 500,
    });

    const registry = new ToolRegistry();
    registry.register(thinkTool);
    const tool = createTaskTool(registry, makeConfig(tmpDir), mockProvider);

    const result = await tool.execute(
      { name: "read-counter", prompt: "Count lines in foo.txt" },
      makeCtx(),
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("The file contains 42 lines.");
    expect(result.metadata).toBeDefined();
    expect(result.metadata?.name).toBe("read-counter");
    expect(result.metadata?.toolCallCount).toBe(1);

    // Verify runAgentLoop was called with correct args
    expect(mockLoop).toHaveBeenCalledOnce();
    const callArgs = mockLoop.mock.calls[0];
    if (!callArgs) throw new Error("expected call args");
    const [instruction, session, reg, mw, cfg] = callArgs;
    expect(instruction).toBe("Count lines in foo.txt");
    expect(session.messages).toEqual([]); // fresh session
    expect(session.id).toBeTruthy();
    expect(reg).toBe(registry); // same registry
    expect(mw).toHaveLength(2); // logging + time awareness
    expect(cfg.anthropicApiKey).toBe("test-key");
  });

  it("returns error when subagent throws", async () => {
    const { runAgentLoop } = await import("../agent/loop.js");
    const mockLoop = vi.mocked(runAgentLoop);
    mockLoop.mockRejectedValueOnce(new Error("API rate limit"));

    const registry = new ToolRegistry();
    const tool = createTaskTool(registry, makeConfig(tmpDir), mockProvider);

    const result = await tool.execute({ name: "failing-task", prompt: "do something" }, makeCtx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("failing-task");
    expect(result.content).toContain("API rate limit");
  });

  it("creates unique session IDs per invocation", async () => {
    const { runAgentLoop } = await import("../agent/loop.js");
    const mockLoop = vi.mocked(runAgentLoop);
    mockLoop.mockResolvedValue({
      response: "done",
      tokensUsed: { in: 10, out: 10, cacheRead: 0, cacheWrite: 0 },
      toolCallCount: 0,
      durationMs: 100,
    });

    const registry = new ToolRegistry();
    const tool = createTaskTool(registry, makeConfig(tmpDir), mockProvider);

    await tool.execute({ name: "a", prompt: "task a" }, makeCtx());
    await tool.execute({ name: "b", prompt: "task b" }, makeCtx());

    const sessionA = mockLoop.mock.calls[0]?.[1];
    const sessionB = mockLoop.mock.calls[1]?.[1];
    if (!sessionA || !sessionB) throw new Error("expected sessions");
    expect(sessionA.id).not.toBe(sessionB.id);
  });

  it("subagent log file uses sub- prefix", async () => {
    const { runAgentLoop } = await import("../agent/loop.js");
    const mockLoop = vi.mocked(runAgentLoop);
    mockLoop.mockResolvedValue({
      response: "done",
      tokensUsed: { in: 10, out: 10, cacheRead: 0, cacheWrite: 0 },
      toolCallCount: 0,
      durationMs: 100,
    });

    const registry = new ToolRegistry();
    const tool = createTaskTool(registry, makeConfig(tmpDir), mockProvider);

    await tool.execute({ name: "test", prompt: "do it" }, makeCtx());

    const session = mockLoop.mock.calls[0]?.[1];
    if (!session) throw new Error("expected session");
    expect(path.basename(session.logFile)).toMatch(/^sub-/);
  });
});
