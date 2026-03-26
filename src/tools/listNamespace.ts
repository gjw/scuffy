/**
 * listNamespace tool — directory-level code overview.
 *
 * Like `ls` for code: shows all .ts files in a directory with export counts
 * and primary export types. Helps the agent understand project structure
 * without reading individual files.
 */

import { stat } from "node:fs/promises";
import { glob } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolvePath } from "./readFile.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

// Re-use the project cache from describeModule
import { Project, Node, type SourceFile } from "ts-morph";
import { statSync } from "node:fs";

// ---------------------------------------------------------------------------
// Project cache (shared pattern with describeModule)
// ---------------------------------------------------------------------------

interface CachedProject {
  project: Project;
  tsconfigMtime: number | null;
}

const projectCache = new Map<string, CachedProject>();

function getOrCreateProject(workingDir: string): {
  project: Project;
  hasTsConfig: boolean;
} {
  const tsconfigPath = path.join(workingDir, "tsconfig.json");
  let tsconfigMtime: number | null = null;
  try {
    tsconfigMtime = statSync(tsconfigPath).mtimeMs;
  } catch {
    // No tsconfig
  }

  const cached = projectCache.get(workingDir);
  if (cached !== undefined && cached.tsconfigMtime === tsconfigMtime) {
    return { project: cached.project, hasTsConfig: tsconfigMtime !== null };
  }

  const project =
    tsconfigMtime !== null
      ? new Project({ tsConfigFilePath: tsconfigPath })
      : new Project({
          compilerOptions: { strict: true },
          skipAddingFilesFromTsConfig: true,
        });

  projectCache.set(workingDir, { project, tsconfigMtime });
  return { project, hasTsConfig: tsconfigMtime !== null };
}

// ---------------------------------------------------------------------------
// File analysis
// ---------------------------------------------------------------------------

interface FileInfo {
  relativePath: string;
  lines: number;
  functions: number;
  classes: number;
  interfaces: number;
  types: number;
  constants: number;
  enums: number;
  totalExports: number;
}

function analyzeFile(sf: SourceFile, workingDir: string): FileInfo {
  const exported = sf.getExportedDeclarations();
  let functions = 0;
  let classes = 0;
  let interfaces = 0;
  let types = 0;
  let constants = 0;
  let enums = 0;

  for (const [, decls] of exported) {
    for (const decl of decls) {
      if (Node.isFunctionDeclaration(decl)) functions++;
      else if (Node.isClassDeclaration(decl)) classes++;
      else if (Node.isInterfaceDeclaration(decl)) interfaces++;
      else if (Node.isTypeAliasDeclaration(decl)) types++;
      else if (Node.isVariableDeclaration(decl)) constants++;
      else if (Node.isEnumDeclaration(decl)) enums++;
    }
  }

  const totalExports = functions + classes + interfaces + types + constants + enums;

  return {
    relativePath: path.relative(workingDir, sf.getFilePath()),
    lines: sf.getEndLineNumber(),
    functions,
    classes,
    interfaces,
    types,
    constants,
    enums,
    totalExports,
  };
}

function formatFileInfo(f: FileInfo): string {
  const parts: string[] = [];
  if (f.functions > 0) parts.push(`${String(f.functions)} fn`);
  if (f.classes > 0) parts.push(`${String(f.classes)} class`);
  if (f.interfaces > 0) parts.push(`${String(f.interfaces)} iface`);
  if (f.types > 0) parts.push(`${String(f.types)} type`);
  if (f.constants > 0) parts.push(`${String(f.constants)} const`);
  if (f.enums > 0) parts.push(`${String(f.enums)} enum`);

  const summary = parts.length > 0 ? parts.join(", ") : "no exports";
  return `  ${f.relativePath} (${String(f.lines)} lines) — ${summary}`;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const parameters = z.object({
  directory: z
    .string()
    .describe(
      "Directory path relative to working directory. Lists all .ts files within.",
    ),
  recursive: z
    .boolean()
    .optional()
    .describe("Include subdirectories. Defaults to false (immediate children only)."),
});

const MAX_FILES = 100;

export const listNamespaceTool: Tool<typeof parameters> = {
  name: "listNamespace",
  description:
    "List all TypeScript files in a directory with export counts. Like ls for code: " +
    "shows file names, line counts, and what each file exports (functions, types, " +
    "interfaces, etc). Use to understand project structure before diving into files.",
  parameters,
  async execute(
    params: z.infer<typeof parameters>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const resolved = resolvePath(params.directory, ctx.workingDir);
    if ("error" in resolved) return { content: resolved.error, isError: true };
    const absDir = resolved.resolved;

    // Verify it's a directory
    try {
      const s = await stat(absDir);
      if (!s.isDirectory()) {
        return {
          content: `Error: ${params.directory} is not a directory.`,
          isError: true,
        };
      }
    } catch {
      return {
        content: `Error: directory not found: ${params.directory}`,
        isError: true,
      };
    }

    // Find .ts files
    const pattern = params.recursive ? "**/*.ts" : "*.ts";
    const files: string[] = [];
    for await (const match of glob(pattern, { cwd: absDir })) {
      // Skip declaration files and test files in the summary
      if (match.endsWith(".d.ts")) continue;
      files.push(match);
    }

    files.sort();

    if (files.length === 0) {
      return { content: `${params.directory}/ — no .ts files found.` };
    }

    const { project } = getOrCreateProject(ctx.workingDir);
    const infos: FileInfo[] = [];
    const capped = files.slice(0, MAX_FILES);

    for (const file of capped) {
      const absFile = path.join(absDir, file);
      try {
        let sf = project.getSourceFile(absFile);
        if (!sf) sf = project.addSourceFileAtPath(absFile);
        else sf.refreshFromFileSystemSync();
        infos.push(analyzeFile(sf, ctx.workingDir));
      } catch {
        // Can't analyze — include with basic info
        infos.push({
          relativePath: path.relative(ctx.workingDir, absFile),
          lines: 0,
          functions: 0,
          classes: 0,
          interfaces: 0,
          types: 0,
          constants: 0,
          enums: 0,
          totalExports: 0,
        });
      }
    }

    // Summary stats
    const totalFiles = files.length;
    const totalExports = infos.reduce((sum, f) => sum + f.totalExports, 0);
    const totalLines = infos.reduce((sum, f) => sum + f.lines, 0);

    const out: string[] = [];
    out.push(
      `${params.directory}/ — ${String(totalFiles)} files, ${String(totalExports)} exports, ${String(totalLines)} total lines`,
    );
    out.push("");

    for (const info of infos) {
      out.push(formatFileInfo(info));
    }

    if (files.length > MAX_FILES) {
      out.push(
        `\n... and ${String(files.length - MAX_FILES)} more files.`,
      );
    }

    out.push(
      "\nUse describeModule on individual files to see export signatures.",
    );

    return { content: out.join("\n") };
  },
};
