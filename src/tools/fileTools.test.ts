import { describe, expect, it, beforeEach } from "vitest";
import { mkdtemp, writeFile, readFile, utimes } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readFileTool } from "./readFile.js";
import { editFileTool } from "./editFile.js";
import { writeFileTool } from "./writeFile.js";
import type { ToolContext } from "./types.js";

function makeCtx(workingDir: string): ToolContext {
  return {
    sessionId: "test-session",
    workingDir,
    fileReadTimestamps: new Map(),
    notifyHuman: async () => {},
    recordOutcome: async () => {},
    log: () => {
      /* noop */
    },
  };
}

describe("readFile", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "scuffy-read-"));
    await writeFile(path.join(tmpDir, "hello.txt"), "line one\nline two\nline three\n");
  });

  it("reads file with line numbers", async () => {
    const ctx = makeCtx(tmpDir);
    const result = await readFileTool.execute({ path: "hello.txt" }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("hello.txt (4 lines)");
    expect(result.content).toContain("1\tline one");
    expect(result.content).toContain("2\tline two");
    expect(result.content).toContain("3\tline three");
  });

  it("supports offset/limit pagination", async () => {
    const ctx = makeCtx(tmpDir);
    const result = await readFileTool.execute({ path: "hello.txt", offset: 2, limit: 1 }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("2\tline two");
    expect(result.content).not.toContain("1\tline one");
    expect(result.content).not.toContain("3\tline three");
  });

  it("records read timestamp", async () => {
    const ctx = makeCtx(tmpDir);
    await readFileTool.execute({ path: "hello.txt" }, ctx);
    const resolved = path.resolve(tmpDir, "hello.txt");
    expect(ctx.fileReadTimestamps.has(resolved)).toBe(true);
  });

  it("rejects path outside workingDir", async () => {
    const ctx = makeCtx(tmpDir);
    const result = await readFileTool.execute({ path: "../../etc/passwd" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside the working directory");
  });

  it("returns error for nonexistent file", async () => {
    const ctx = makeCtx(tmpDir);
    const result = await readFileTool.execute({ path: "nope.txt" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Error reading file");
  });
});

describe("editFile", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "scuffy-edit-"));
    await writeFile(path.join(tmpDir, "code.ts"), 'const x = "hello";\nconst y = "world";\n');
  });

  it("rejects edit on unread file (Invariant 1)", async () => {
    const ctx = makeCtx(tmpDir);
    const result = await editFileTool.execute(
      { path: "code.ts", old_string: "hello", new_string: "goodbye" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("has not been read");
  });

  it("rejects edit on stale file", async () => {
    const ctx = makeCtx(tmpDir);
    // Read the file first
    await readFileTool.execute({ path: "code.ts" }, ctx);

    // Simulate external modification by setting mtime to the future
    const future = new Date(Date.now() + 10_000);
    await utimes(path.join(tmpDir, "code.ts"), future, future);

    const result = await editFileTool.execute(
      { path: "code.ts", old_string: "hello", new_string: "goodbye" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("modified since last read");
  });

  it("rejects when old_string not found", async () => {
    const ctx = makeCtx(tmpDir);
    await readFileTool.execute({ path: "code.ts" }, ctx);
    const result = await editFileTool.execute(
      { path: "code.ts", old_string: "nonexistent", new_string: "replacement" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  it("rejects multiple matches without replace_all (Invariant 2)", async () => {
    const ctx = makeCtx(tmpDir);
    await writeFile(path.join(tmpDir, "dup.ts"), "foo\nfoo\nbar\n");
    await readFileTool.execute({ path: "dup.ts" }, ctx);
    const result = await editFileTool.execute(
      { path: "dup.ts", old_string: "foo", new_string: "baz" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("matches 2 times");
  });

  it("succeeds with replace_all on multiple matches", async () => {
    const ctx = makeCtx(tmpDir);
    await writeFile(path.join(tmpDir, "dup.ts"), "foo\nfoo\nbar\n");
    await readFileTool.execute({ path: "dup.ts" }, ctx);
    const result = await editFileTool.execute(
      { path: "dup.ts", old_string: "foo", new_string: "baz", replace_all: true },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("2 occurrences");
    const content = await readFile(path.join(tmpDir, "dup.ts"), "utf-8");
    expect(content).toBe("baz\nbaz\nbar\n");
  });

  it("performs single match replacement", async () => {
    const ctx = makeCtx(tmpDir);
    await readFileTool.execute({ path: "code.ts" }, ctx);
    const result = await editFileTool.execute(
      { path: "code.ts", old_string: '"hello"', new_string: '"goodbye"' },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("1 occurrence");
    const content = await readFile(path.join(tmpDir, "code.ts"), "utf-8");
    expect(content).toContain('"goodbye"');
    expect(content).toContain('"world"');
  });

  it("rejects old_string === new_string", async () => {
    const ctx = makeCtx(tmpDir);
    await readFileTool.execute({ path: "code.ts" }, ctx);
    const result = await editFileTool.execute(
      { path: "code.ts", old_string: "hello", new_string: "hello" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("identical");
  });
});

describe("writeFile", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "scuffy-write-"));
  });

  it("creates a new file", async () => {
    const ctx = makeCtx(tmpDir);
    const result = await writeFileTool.execute({ path: "new.txt", content: "hello world" }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Wrote new.txt");
    const content = await readFile(path.join(tmpDir, "new.txt"), "utf-8");
    expect(content).toBe("hello world");
  });

  it("creates parent directories", async () => {
    const ctx = makeCtx(tmpDir);
    const result = await writeFileTool.execute(
      { path: "deep/nested/file.ts", content: "export {}" },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    const content = await readFile(path.join(tmpDir, "deep", "nested", "file.ts"), "utf-8");
    expect(content).toBe("export {}");
  });

  it("overwrites existing file", async () => {
    await writeFile(path.join(tmpDir, "existing.txt"), "old content");
    const ctx = makeCtx(tmpDir);
    const result = await writeFileTool.execute(
      { path: "existing.txt", content: "new content" },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    const content = await readFile(path.join(tmpDir, "existing.txt"), "utf-8");
    expect(content).toBe("new content");
  });

  it("rejects path outside workingDir", async () => {
    const ctx = makeCtx(tmpDir);
    const result = await writeFileTool.execute({ path: "../../escape.txt", content: "bad" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside the working directory");
  });

  it("sets read timestamp so editFile works on new files", async () => {
    const ctx = makeCtx(tmpDir);
    await writeFileTool.execute({ path: "new.ts", content: 'const x = "old";' }, ctx);

    // Should be able to edit without reading first
    const result = await editFileTool.execute(
      { path: "new.ts", old_string: '"old"', new_string: '"new"' },
      ctx,
    );
    expect(result.isError).toBeUndefined();
  });
});
