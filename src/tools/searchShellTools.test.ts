import { describe, expect, it, beforeEach } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { bashTool } from "./bash.js";
import type { ToolContext } from "./types.js";

function makeCtx(workingDir: string): ToolContext {
  return {
    sessionId: "test-session",
    workingDir,
    fileReadTimestamps: new Map(),
    getClaimedBeadId: () => null,
    setClaimedBeadId: () => {},
    notifyHuman: async () => {},
    recordOutcome: async () => {},
    log: () => {
      /* noop */
    },
  };
}

describe("glob", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "scuffy-glob-"));
    await writeFile(path.join(tmpDir, "foo.ts"), "code");
    await writeFile(path.join(tmpDir, "bar.ts"), "code");
    await writeFile(path.join(tmpDir, "readme.md"), "docs");
    await mkdir(path.join(tmpDir, "sub"));
    await writeFile(path.join(tmpDir, "sub", "nested.ts"), "code");
  });

  it("matches files with pattern", async () => {
    const ctx = makeCtx(tmpDir);
    const result = await globTool.execute({ pattern: "*.ts" }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("bar.ts");
    expect(result.content).toContain("foo.ts");
    expect(result.content).not.toContain("readme.md");
  });

  it("matches recursively with **", async () => {
    const ctx = makeCtx(tmpDir);
    const result = await globTool.execute({ pattern: "**/*.ts" }, ctx);
    expect(result.content).toContain("foo.ts");
    expect(result.content).toContain(path.join("sub", "nested.ts"));
  });

  it("respects path parameter", async () => {
    const ctx = makeCtx(tmpDir);
    const result = await globTool.execute({ pattern: "*.ts", path: "sub" }, ctx);
    expect(result.content).toContain(path.join("sub", "nested.ts"));
    expect(result.content).not.toContain("foo.ts");
  });

  it("returns message for no matches", async () => {
    const ctx = makeCtx(tmpDir);
    const result = await globTool.execute({ pattern: "*.xyz" }, ctx);
    expect(result.content).toBe("No files matched the pattern.");
  });
});

describe("grep", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "scuffy-grep-"));
    await writeFile(path.join(tmpDir, "hello.ts"), 'const msg = "hello world";\n');
    await writeFile(path.join(tmpDir, "goodbye.ts"), 'const msg = "goodbye world";\n');
    await writeFile(path.join(tmpDir, "readme.md"), "# Hello\n\nThis is a readme.\n");
  });

  it("finds files containing pattern", async () => {
    const ctx = makeCtx(tmpDir);
    const result = await grepTool.execute({ pattern: "hello" }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("hello.ts");
  });

  it("content mode shows matching lines with line numbers", async () => {
    const ctx = makeCtx(tmpDir);
    const result = await grepTool.execute({ pattern: "hello", output_mode: "content" }, ctx);
    expect(result.content).toContain("hello world");
    // ripgrep includes line numbers with -n
    expect(result.content).toMatch(/\d+/);
  });

  it("glob filter restricts file types", async () => {
    const ctx = makeCtx(tmpDir);
    const result = await grepTool.execute({ pattern: "Hello", glob: "*.md" }, ctx);
    expect(result.content).toContain("readme.md");
    expect(result.content).not.toContain("hello.ts");
  });

  it("returns informative message for no matches", async () => {
    const ctx = makeCtx(tmpDir);
    const result = await grepTool.execute({ pattern: "zzz_nonexistent_zzz" }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("No matches found.");
  });
});

describe("bash", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "scuffy-bash-"));
  });

  it("captures stdout", async () => {
    const ctx = makeCtx(tmpDir);
    const result = await bashTool.execute({ command: "echo hello" }, ctx);
    expect(result.content).toContain("hello");
    expect(result.content).toContain("[exit code: 0]");
  });

  it("captures non-zero exit code", async () => {
    const ctx = makeCtx(tmpDir);
    const result = await bashTool.execute({ command: "exit 42" }, ctx);
    expect(result.content).toContain("[exit code: 42]");
    expect(result.isError).toBe(true);
  });

  it("captures stderr", async () => {
    const ctx = makeCtx(tmpDir);
    const result = await bashTool.execute({ command: "echo oops >&2" }, ctx);
    expect(result.content).toContain("[stderr]");
    expect(result.content).toContain("oops");
  });

  it("times out long-running commands", async () => {
    const ctx = makeCtx(tmpDir);
    const result = await bashTool.execute({ command: "sleep 60", timeout: 500 }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("timed out");
  }, 10_000);

  it("runs in workingDir", async () => {
    const ctx = makeCtx(tmpDir);
    const result = await bashTool.execute({ command: "pwd" }, ctx);
    expect(result.content).toContain(tmpDir);
  });
});
