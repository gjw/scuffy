import { describe, expect, it, beforeEach } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { ToolRegistry } from "./registry.js";
import { thinkTool } from "./think.js";
import { listDirTool } from "./listDir.js";
import type { Tool, ToolContext } from "./types.js";

function makeCtx(workingDir: string): ToolContext {
  return {
    sessionId: "test-session",
    workingDir,
    fileReadTimestamps: new Map(),
    log: () => {
      /* noop */
    },
  };
}

function makeDummyTool(name: string): Tool {
  return {
    name,
    description: `Dummy tool: ${name}`,
    parameters: z.object({ value: z.string() }),
    execute(params: { value: string }) {
      return Promise.resolve({ content: params.value });
    },
  };
}

describe("ToolRegistry", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it("registers and retrieves a tool", () => {
    const tool = makeDummyTool("foo");
    registry.register(tool);
    expect(registry.get("foo")).toBe(tool);
    expect(registry.has("foo")).toBe(true);
  });

  it("returns undefined for unknown tools", () => {
    expect(registry.get("nonexistent")).toBeUndefined();
    expect(registry.has("nonexistent")).toBe(false);
  });

  it("throws on duplicate registration", () => {
    registry.register(makeDummyTool("dup"));
    expect(() => {
      registry.register(makeDummyTool("dup"));
    }).toThrow("Tool already registered: dup");
  });

  it("getAll returns all registered tools", () => {
    registry.register(makeDummyTool("a"));
    registry.register(makeDummyTool("b"));
    const all = registry.getAll();
    expect(all).toHaveLength(2);
    expect(all.map((t) => t.name).sort()).toEqual(["a", "b"]);
  });

  it("converts to Anthropic tool format", () => {
    registry.register(thinkTool);
    const anthropicTools = registry.toAnthropicTools();

    expect(anthropicTools).toHaveLength(1);
    const tool = anthropicTools[0];
    if (!tool) throw new Error("expected tool");
    expect(tool.name).toBe("think");
    expect(tool.description).toBeDefined();
    expect(tool.input_schema.type).toBe("object");
    expect(tool.input_schema.properties).toBeDefined();
    expect(tool.input_schema.required).toContain("thought");
    // Must not include $schema
    expect("$schema" in tool.input_schema).toBe(false);
  });
});

describe("think tool", () => {
  it("returns the thought as content", async () => {
    const ctx = makeCtx("/tmp");
    const result = await thinkTool.execute({ thought: "step 1: check input" }, ctx);
    expect(result.content).toBe("step 1: check input");
    expect(result.isError).toBeUndefined();
  });
});

describe("listDir tool", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "scuffy-test-"));
    await writeFile(path.join(tmpDir, "file.txt"), "hello");
    await mkdir(path.join(tmpDir, "subdir"));
  });

  it("lists files and directories", async () => {
    const ctx = makeCtx(tmpDir);
    const result = await listDirTool.execute({}, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("file.txt");
    expect(result.content).toContain("subdir/");
  });

  it("defaults to workingDir when no path given", async () => {
    const ctx = makeCtx(tmpDir);
    const result = await listDirTool.execute({}, ctx);
    expect(result.content).toContain("file.txt");
  });

  it("lists a subdirectory", async () => {
    await writeFile(path.join(tmpDir, "subdir", "nested.ts"), "code");
    const ctx = makeCtx(tmpDir);
    const result = await listDirTool.execute({ path: "subdir" }, ctx);
    expect(result.content).toBe("nested.ts");
  });

  it("rejects paths outside workingDir", async () => {
    const ctx = makeCtx(tmpDir);
    const result = await listDirTool.execute({ path: "../../" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside the working directory");
  });

  it("returns error for nonexistent path", async () => {
    const ctx = makeCtx(tmpDir);
    const result = await listDirTool.execute({ path: "nope" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Error listing directory");
  });

  it("handles empty directory", async () => {
    await mkdir(path.join(tmpDir, "empty"));
    const ctx = makeCtx(tmpDir);
    const result = await listDirTool.execute({ path: "empty" }, ctx);
    expect(result.content).toBe("(empty directory)");
  });
});
