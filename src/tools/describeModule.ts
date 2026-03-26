/**
 * describeModule tool — structured TypeScript introspection via ts-morph.
 *
 * Replaces bulk readFile calls by returning API surface information:
 * exports, types, signatures, imports, test structure, references, call graphs.
 *
 * Three-tier fallback:
 *   Tier 1: ts-morph with tsconfig → full type resolution
 *   Tier 2: ts-morph without tsconfig → syntax-level analysis
 *   Tier 3: regex scan → export names only (emergency fallback)
 */

import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Project, Node, type SourceFile, type Type } from "ts-morph";
import { z } from "zod";
import { resolvePath } from "./readFile.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_EXPORTS_SHOWN = 50;
const MAX_REFS_SHOWN = 30;
const MAX_CALLS_SHOWN = 30;
const TYPE_TEXT_MAX = 120;
const DECL_TEXT_MAX = 3000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "...";
}

/** Get type text safely — complex types can produce huge output. */
function safeTypeText(type: Type, enclosing: Node, maxLen: number): string {
  try {
    return truncate(type.getText(enclosing), maxLen);
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Project cache — singleton per workingDir, invalidated on tsconfig change
// ---------------------------------------------------------------------------

interface CachedProject {
  project: Project;
  tsconfigMtime: number | null;
}

const projectCache = new Map<string, CachedProject>();

function getOrCreateProject(workingDir: string): { project: Project; hasTsConfig: boolean } {
  const tsconfigPath = path.join(workingDir, "tsconfig.json");
  let tsconfigMtime: number | null = null;
  try {
    tsconfigMtime = statSync(tsconfigPath).mtimeMs;
  } catch {
    // No tsconfig — Tier 2
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

/** Refresh the target file from disk (handles edits since last call). */
function ensureSourceFile(project: Project, absolutePath: string): SourceFile {
  const existing = project.getSourceFile(absolutePath);
  if (existing) {
    existing.refreshFromFileSystemSync();
    return existing;
  }
  return project.addSourceFileAtPath(absolutePath);
}

/** Load all .ts files for cross-file analysis (references/callGraph). */
function ensureAllFilesLoaded(
  project: Project,
  workingDir: string,
  hasTsConfig: boolean,
): void {
  if (hasTsConfig) return;
  project.addSourceFilesAtPaths([
    path.join(workingDir, "**/*.ts"),
    path.join(workingDir, "**/*.tsx"),
    "!" + path.join(workingDir, "**/node_modules/**"),
    "!" + path.join(workingDir, "**/dist/**"),
  ]);
}

// ---------------------------------------------------------------------------
// Export summary (default mode)
// ---------------------------------------------------------------------------

interface ExportEntry {
  name: string;
  kind: string;
  signature: string;
  line: number;
}

function summarizeExports(sf: SourceFile): ExportEntry[] {
  const entries: ExportEntry[] = [];

  for (const [name, decls] of sf.getExportedDeclarations()) {
    for (const decl of decls) {
      try {
        entries.push(summarizeOne(name, decl, sf));
      } catch {
        entries.push({
          name,
          kind: "unknown",
          signature: name,
          line: decl.getStartLineNumber(),
        });
      }
    }
  }

  entries.sort((a, b) => a.line - b.line);
  return entries;
}

function summarizeOne(name: string, decl: Node, sf: SourceFile): ExportEntry {
  const line = decl.getStartLineNumber();

  if (Node.isFunctionDeclaration(decl)) {
    const params = decl
      .getParameters()
      .map((p) => `${p.getName()}: ${safeTypeText(p.getType(), sf, 60)}`);
    const ret = safeTypeText(decl.getReturnType(), sf, 60);
    return {
      name,
      kind: "function",
      signature: `function ${name}(${params.join(", ")}): ${ret}`,
      line,
    };
  }

  if (Node.isClassDeclaration(decl)) {
    const methods = decl.getMethods().map((m) => m.getName());
    return {
      name,
      kind: "class",
      signature: `class ${name} { ${truncate(methods.join(", "), TYPE_TEXT_MAX)} }`,
      line,
    };
  }

  if (Node.isInterfaceDeclaration(decl)) {
    const members = decl.getMembers().map((m) => {
      if (Node.isMethodSignature(m)) return m.getName() + "()";
      if (Node.isPropertySignature(m)) return m.getName();
      return "\u2026";
    });
    return {
      name,
      kind: "interface",
      signature: `interface ${name} { ${truncate(members.join(", "), TYPE_TEXT_MAX)} }`,
      line,
    };
  }

  if (Node.isTypeAliasDeclaration(decl)) {
    const typeText = safeTypeText(decl.getType(), sf, TYPE_TEXT_MAX);
    return { name, kind: "type", signature: `type ${name} = ${typeText}`, line };
  }

  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    if (init && init.getText().length <= 100) {
      return {
        name,
        kind: "const",
        signature: `const ${name} = ${init.getText()}`,
        line,
      };
    }
    const typeText = safeTypeText(decl.getType(), sf, TYPE_TEXT_MAX);
    return { name, kind: "const", signature: `const ${name}: ${typeText}`, line };
  }

  if (Node.isEnumDeclaration(decl)) {
    const members = decl.getMembers().map((m) => m.getName());
    return {
      name,
      kind: "enum",
      signature: `enum ${name} { ${truncate(members.join(", "), TYPE_TEXT_MAX)} }`,
      line,
    };
  }

  return { name, kind: "export", signature: name, line };
}

// ---------------------------------------------------------------------------
// Symbol detail
// ---------------------------------------------------------------------------

function getJsDocText(decl: Node): string | null {
  try {
    if (Node.isFunctionDeclaration(decl)) return formatDocs(decl.getJsDocs());
    if (Node.isClassDeclaration(decl)) return formatDocs(decl.getJsDocs());
    if (Node.isInterfaceDeclaration(decl)) return formatDocs(decl.getJsDocs());
    if (Node.isTypeAliasDeclaration(decl)) return formatDocs(decl.getJsDocs());
    if (Node.isEnumDeclaration(decl)) return formatDocs(decl.getJsDocs());
    if (Node.isVariableDeclaration(decl)) {
      const statement = decl.getParent().getParent();
      if (Node.isVariableStatement(statement)) {
        return formatDocs(statement.getJsDocs());
      }
    }
  } catch {
    // Some nodes don't support getJsDocs
  }
  return null;
}

function formatDocs(docs: Array<{ getText(): string }>): string | null {
  if (docs.length === 0) return null;
  return docs.map((d) => d.getText()).join("\n");
}

function getDeclarationText(decl: Node, sf: SourceFile): string {
  if (Node.isFunctionDeclaration(decl)) {
    const params = decl
      .getParameters()
      .map((p) => `${p.getName()}: ${safeTypeText(p.getType(), sf, 80)}`);
    const ret = safeTypeText(decl.getReturnType(), sf, 80);
    const name = decl.getName() ?? "default";
    const asyncPrefix = decl.isAsync() ? "async " : "";
    return `${asyncPrefix}function ${name}(${params.join(", ")}): ${ret}`;
  }

  if (Node.isClassDeclaration(decl)) {
    const lines: string[] = [];
    const name = decl.getName() ?? "default";
    const heritage = decl
      .getHeritageClauses()
      .map((h) => h.getText())
      .join(" ");
    lines.push(`class ${name}${heritage ? " " + heritage : ""} {`);

    for (const prop of decl.getProperties()) {
      const pType = safeTypeText(prop.getType(), sf, 80);
      const staticPrefix = prop.isStatic() ? "static " : "";
      lines.push(`  ${staticPrefix}${prop.getName()}: ${pType};`);
    }

    for (const method of decl.getMethods()) {
      const mParams = method
        .getParameters()
        .map((p) => `${p.getName()}: ${safeTypeText(p.getType(), sf, 60)}`);
      const mRet = safeTypeText(method.getReturnType(), sf, 60);
      const staticPrefix = method.isStatic() ? "static " : "";
      const asyncPrefix = method.isAsync() ? "async " : "";
      lines.push(
        `  ${staticPrefix}${asyncPrefix}${method.getName()}(${mParams.join(", ")}): ${mRet};`,
      );
    }

    lines.push("}");
    return lines.join("\n");
  }

  // Interfaces, types, enums, variables: full declaration text
  if (Node.isVariableDeclaration(decl)) {
    const statement = decl.getParent().getParent();
    if (Node.isVariableStatement(statement)) {
      return truncate(statement.getText(), DECL_TEXT_MAX);
    }
  }

  return truncate(decl.getText(), DECL_TEXT_MAX);
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

interface ImportEntry {
  from: string;
  names: string[];
}

function listImports(sf: SourceFile): ImportEntry[] {
  return sf.getImportDeclarations().map((imp) => {
    const from = imp.getModuleSpecifierValue();
    const names: string[] = [];

    const defaultImport = imp.getDefaultImport();
    if (defaultImport) names.push(defaultImport.getText());

    const nsImport = imp.getNamespaceImport();
    if (nsImport) names.push(`* as ${nsImport.getText()}`);

    for (const named of imp.getNamedImports()) {
      const alias = named.getAliasNode();
      names.push(alias ? `${named.getName()} as ${alias.getText()}` : named.getName());
    }

    return { from, names };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

interface TestBlock {
  type: "describe" | "it" | "test";
  name: string;
  line: number;
  children: TestBlock[];
}

function extractTestBlocks(sf: SourceFile): TestBlock[] {
  return visitForTests(sf);
}

function visitForTests(parent: Node): TestBlock[] {
  const blocks: TestBlock[] = [];

  parent.forEachChild((child) => {
    if (!Node.isExpressionStatement(child)) return;
    const expr = child.getExpression();
    if (!Node.isCallExpression(expr)) return;

    const calleeName = expr.getExpression().getText();
    if (calleeName !== "describe" && calleeName !== "it" && calleeName !== "test")
      return;

    const args = expr.getArguments();
    const firstArg = args[0];
    let testName = "unnamed";
    if (firstArg) {
      testName = Node.isStringLiteral(firstArg)
        ? firstArg.getLiteralValue()
        : truncate(firstArg.getText(), 60);
    }

    const block: TestBlock = {
      type: calleeName,
      name: testName,
      line: child.getStartLineNumber(),
      children: [],
    };

    if (calleeName === "describe") {
      const callback = args[1];
      if (
        callback &&
        (Node.isArrowFunction(callback) ||
          Node.isFunctionExpression(callback))
      ) {
        const body = callback.getBody();
        if (Node.isBlock(body)) {
          block.children = visitForTests(body);
        }
      }
    }

    blocks.push(block);
  });

  return blocks;
}

function renderTestTree(blocks: TestBlock[], out: string[], depth: number): void {
  const indent = "  ".repeat(depth);
  for (const b of blocks) {
    out.push(`${indent}${b.type} "${b.name}" (L${String(b.line)})`);
    if (b.children.length > 0) renderTestTree(b.children, out, depth + 1);
  }
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

interface RefEntry {
  file: string;
  line: number;
  text: string;
}

function getNameNode(decl: Node): Node | undefined {
  if (Node.isFunctionDeclaration(decl)) return decl.getNameNode();
  if (Node.isClassDeclaration(decl)) return decl.getNameNode();
  if (Node.isInterfaceDeclaration(decl)) return decl.getNameNode();
  if (Node.isTypeAliasDeclaration(decl)) return decl.getNameNode();
  if (Node.isEnumDeclaration(decl)) return decl.getNameNode();
  if (Node.isVariableDeclaration(decl)) return decl.getNameNode();
  return undefined;
}

function findSymbolReferences(
  sf: SourceFile,
  symbolName: string,
  workingDir: string,
): RefEntry[] {
  const decls = sf.getExportedDeclarations().get(symbolName);
  if (!decls || decls.length === 0) return [];

  const decl = decls[0];
  if (!decl) return [];

  const nameNode = getNameNode(decl);
  if (!nameNode || !Node.isIdentifier(nameNode)) return [];

  const refs: RefEntry[] = [];
  try {
    const refNodes = nameNode.findReferencesAsNodes();
    for (const refNode of refNodes) {
      // Skip the definition itself
      if (
        refNode.getSourceFile().getFilePath() === sf.getFilePath() &&
        refNode.getStartLineNumber() === nameNode.getStartLineNumber()
      ) {
        continue;
      }

      const refFile = path.relative(
        workingDir,
        refNode.getSourceFile().getFilePath(),
      );
      const lineNum = refNode.getStartLineNumber();
      const fullText = refNode.getSourceFile().getFullText();
      const lineText = (fullText.split("\n")[lineNum - 1] ?? "").trim();

      refs.push({
        file: refFile,
        line: lineNum,
        text: truncate(lineText, TYPE_TEXT_MAX),
      });

      if (refs.length >= MAX_REFS_SHOWN) break;
    }
  } catch {
    // findReferences can fail on some node types — return what we have
  }

  return refs;
}

// ---------------------------------------------------------------------------
// Call graph
// ---------------------------------------------------------------------------

function buildCallGraph(
  sf: SourceFile,
  symbolName: string,
  workingDir: string,
): { calls: RefEntry[]; calledBy: RefEntry[] } {
  const decls = sf.getExportedDeclarations().get(symbolName);
  if (!decls || decls.length === 0) return { calls: [], calledBy: [] };

  const decl = decls[0];
  if (!decl) return { calls: [], calledBy: [] };

  // --- What this function calls ---
  const calls: RefEntry[] = [];
  let body: Node | undefined;

  if (Node.isFunctionDeclaration(decl)) {
    body = decl.getBody();
  } else if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    if (
      init &&
      (Node.isArrowFunction(init) || Node.isFunctionExpression(init))
    ) {
      body = init.getBody();
    }
  }

  if (body) {
    const seen = new Set<string>();
    body.forEachDescendant((node) => {
      if (!Node.isCallExpression(node) || calls.length >= MAX_CALLS_SHOWN) return;

      const callExpr = node.getExpression();
      const callText = callExpr.getText();
      if (seen.has(callText)) return;
      seen.add(callText);

      try {
        const sym = callExpr.getSymbol();
        if (sym) {
          const symDecls = sym.getDeclarations();
          const target = symDecls[0];
          if (target) {
            calls.push({
              file: path.relative(workingDir, target.getSourceFile().getFilePath()),
              line: target.getStartLineNumber(),
              text: truncate(callText, 80),
            });
            return;
          }
        }
      } catch {
        // Can't resolve — fall through
      }

      calls.push({
        file: path.relative(workingDir, sf.getFilePath()),
        line: node.getStartLineNumber(),
        text: truncate(callText, 80) + " (unresolved)",
      });
    });
  }

  // --- What calls this function ---
  const calledBy: RefEntry[] = [];
  const nameNode = getNameNode(decl);

  if (nameNode && Node.isIdentifier(nameNode)) {
    try {
      const refNodes = nameNode.findReferencesAsNodes();
      for (const refNode of refNodes) {
        if (calledBy.length >= MAX_CALLS_SHOWN) break;

        // Skip definition
        if (
          refNode.getSourceFile().getFilePath() === sf.getFilePath() &&
          refNode.getStartLineNumber() === nameNode.getStartLineNumber()
        ) {
          continue;
        }

        // Check if this reference is in a call-expression position
        if (!isCallSite(refNode)) continue;

        const refFile = path.relative(
          workingDir,
          refNode.getSourceFile().getFilePath(),
        );
        const lineNum = refNode.getStartLineNumber();
        const fullText = refNode.getSourceFile().getFullText();
        const lineText = (fullText.split("\n")[lineNum - 1] ?? "").trim();

        calledBy.push({
          file: refFile,
          line: lineNum,
          text: truncate(lineText, TYPE_TEXT_MAX),
        });
      }
    } catch {
      // findReferences can fail
    }
  }

  return { calls, calledBy };
}

/** Check whether a reference node is in a call-expression callee position. */
function isCallSite(refNode: Node): boolean {
  const parent = refNode.getParent();
  if (!parent) return false;

  // Direct call: myFunc(...)
  if (Node.isCallExpression(parent)) {
    const callee = parent.getExpression();
    return (
      callee.getStart() === refNode.getStart() &&
      callee.getEnd() === refNode.getEnd()
    );
  }

  // Method-style: obj.myFunc(...)
  if (Node.isPropertyAccessExpression(parent)) {
    const grandparent = parent.getParent();
    if (grandparent && Node.isCallExpression(grandparent)) {
      const callee = grandparent.getExpression();
      return (
        callee.getStart() === parent.getStart() &&
        callee.getEnd() === parent.getEnd()
      );
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Regex fallback (Tier 3 — emergency)
// ---------------------------------------------------------------------------

function regexFallback(source: string, filePath: string): string {
  const lines = source.split("\n");
  const exports: Array<{ name: string; kind: string; line: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    const m = line.match(
      /^export\s+(?:default\s+)?(?:abstract\s+)?(function|class|interface|type|const|let|var|enum)\s+(\w+)/,
    );
    if (m) {
      exports.push({ name: m[2] ?? "unknown", kind: m[1] ?? "unknown", line: i + 1 });
      continue;
    }

    const braceMatch = line.match(/^export\s*\{([^}]+)\}/);
    if (braceMatch) {
      const names = (braceMatch[1] ?? "").split(",");
      for (const raw of names) {
        const name = raw.trim().split(/\s+as\s+/)[0]?.trim();
        if (name) exports.push({ name, kind: "re-export", line: i + 1 });
      }
    }
  }

  const header = `${filePath} (${String(lines.length)} lines) [regex fallback]`;
  if (exports.length === 0) return header + "\n\nNo exports detected.";

  const body = exports
    .map((e) => `  L${String(e.line)} ${e.kind} ${e.name}`)
    .join("\n");
  return header + "\n\nExports:\n" + body;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const parameters = z.object({
  path: z.string().describe("File path relative to working directory."),
  symbol: z
    .string()
    .optional()
    .describe(
      "Zoom into one export: full definition, JSDoc, type details, line range.",
    ),
  imports: z
    .boolean()
    .optional()
    .describe("Show what this module imports and from where."),
  tests: z
    .boolean()
    .optional()
    .describe(
      "For test files: list describe/it/test blocks without reading implementation.",
    ),
  references: z
    .boolean()
    .optional()
    .describe(
      "Find all references to the named symbol across the project. Requires symbol.",
    ),
  callGraph: z
    .boolean()
    .optional()
    .describe(
      "Show what the named function calls and what calls it. Requires symbol.",
    ),
});

export const describeModuleTool: Tool<typeof parameters> = {
  name: "describeModule",
  description:
    "Structured TypeScript introspection. Returns exports, types, and signatures " +
    "WITHOUT reading implementation code. Use BEFORE readFile to understand a " +
    "module's API surface — saves 10-50x context. Modes: default (all exports), " +
    "symbol (one export detail + JSDoc), imports (dependency map), tests (test " +
    "structure), references (who uses a symbol), callGraph (what calls what).",
  parameters,
  async execute(
    params: z.infer<typeof parameters>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const resolved = resolvePath(params.path, ctx.workingDir);
    if ("error" in resolved) return { content: resolved.error, isError: true };
    const absPath = resolved.resolved;

    if (params.references && !params.symbol) {
      return {
        content: "Error: references mode requires the symbol param.",
        isError: true,
      };
    }
    if (params.callGraph && !params.symbol) {
      return {
        content: "Error: callGraph mode requires the symbol param.",
        isError: true,
      };
    }

    // --- Try ts-morph (Tier 1 / Tier 2) ---
    try {
      const { project, hasTsConfig } = getOrCreateProject(ctx.workingDir);
      const sf = ensureSourceFile(project, absPath);
      const totalLines = sf.getEndLineNumber();
      const out: string[] = [];

      let header = `${params.path} (${String(totalLines)} lines)`;
      if (!hasTsConfig) header += " [no tsconfig \u2014 types may be unresolved]";
      out.push(header);

      const isDefaultMode =
        !params.symbol &&
        !params.imports &&
        !params.tests &&
        !params.references &&
        !params.callGraph;

      // ── Default: all exports ──
      if (isDefaultMode) {
        const exports = summarizeExports(sf);
        if (exports.length === 0) {
          out.push("\nNo exports found.");
        } else {
          const shown = exports.slice(0, MAX_EXPORTS_SHOWN);
          out.push("\nExports:");
          for (const e of shown) {
            out.push(`  L${String(e.line)} ${e.signature}`);
          }
          if (exports.length > MAX_EXPORTS_SHOWN) {
            out.push(
              `\n... and ${String(exports.length - MAX_EXPORTS_SHOWN)} more exports.`,
            );
          }
        }
        out.push(
          "\nUse describeModule with symbol param for full definitions.",
        );
        out.push("Use readFile with offset/limit to read implementations.");
      }

      // ── Symbol detail ──
      if (params.symbol) {
        const decls = sf.getExportedDeclarations().get(params.symbol);
        if (!decls || decls.length === 0) {
          out.push(`\nSymbol "${params.symbol}" not found in exports.`);
          const allExports = summarizeExports(sf);
          if (allExports.length > 0) {
            out.push(
              "Available: " + allExports.map((e) => e.name).join(", "),
            );
          }
        } else {
          const decl = decls[0];
          if (decl) {
            const jsdoc = getJsDocText(decl);
            if (jsdoc) out.push("\n" + jsdoc);

            out.push("\n" + getDeclarationText(decl, sf));

            const startLine = decl.getStartLineNumber();
            const endLine = decl.getEndLineNumber();
            out.push(
              `\nLines ${String(startLine)}-${String(endLine)}.`,
            );
            if (
              Node.isFunctionDeclaration(decl) ||
              Node.isVariableDeclaration(decl)
            ) {
              out.push(
                `Use readFile offset=${String(startLine)} limit=${String(endLine - startLine + 1)} to see implementation.`,
              );
            }
          }
        }
      }

      // ── Imports ──
      if (params.imports) {
        const imports = listImports(sf);
        if (imports.length === 0) {
          out.push("\nNo imports.");
        } else {
          out.push("\nImports:");
          for (const imp of imports) {
            out.push(`  from "${imp.from}" \u2192 ${imp.names.join(", ")}`);
          }
        }
      }

      // ── Tests ──
      if (params.tests) {
        const blocks = extractTestBlocks(sf);
        if (blocks.length === 0) {
          out.push("\nNo test blocks found.");
        } else {
          out.push("\nTests:");
          renderTestTree(blocks, out, 1);
        }
      }

      // ── References ──
      if (params.references && params.symbol) {
        ensureAllFilesLoaded(project, ctx.workingDir, hasTsConfig);
        const refs = findSymbolReferences(sf, params.symbol, ctx.workingDir);
        if (refs.length === 0) {
          out.push(`\nNo references to "${params.symbol}" found.`);
        } else {
          out.push(
            `\nReferences to "${params.symbol}" (${String(refs.length)}):`,
          );
          for (const r of refs) {
            out.push(`  ${r.file}:${String(r.line)} \u2014 ${r.text}`);
          }
          if (refs.length >= MAX_REFS_SHOWN) {
            out.push("  ... (capped at " + String(MAX_REFS_SHOWN) + ")");
          }
        }
      }

      // ── Call graph ──
      if (params.callGraph && params.symbol) {
        ensureAllFilesLoaded(project, ctx.workingDir, hasTsConfig);
        const graph = buildCallGraph(sf, params.symbol, ctx.workingDir);

        out.push(`\nCall graph for "${params.symbol}":`);
        out.push("  Calls:");
        if (graph.calls.length === 0) {
          out.push("    (none or unresolvable)");
        } else {
          for (const c of graph.calls) {
            out.push(
              `    ${c.text} \u2192 ${c.file}:${String(c.line)}`,
            );
          }
        }
        out.push("  Called by:");
        if (graph.calledBy.length === 0) {
          out.push("    (none found)");
        } else {
          for (const c of graph.calledBy) {
            out.push(
              `    ${c.file}:${String(c.line)} \u2014 ${c.text}`,
            );
          }
        }
      }

      return { content: out.join("\n") };
    } catch {
      // --- Tier 3: regex fallback ---
      try {
        const source = await readFile(absPath, "utf-8");
        return { content: regexFallback(source, params.path) };
      } catch (readErr: unknown) {
        const msg =
          readErr instanceof Error ? readErr.message : String(readErr);
        return { content: `Error: could not read file: ${msg}`, isError: true };
      }
    }
  },
};
