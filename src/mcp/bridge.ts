import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import type { Tool, ToolResult } from "../tools/types.js";

/**
 * Bridge MCP tools from a connected server into Scuffy Tool objects.
 * Tool names are prefixed with the server name to avoid collisions.
 * If whitelist is provided, only tools with matching names are bridged.
 */
export async function bridgeMcpTools(
  serverName: string,
  client: Client,
  whitelist?: string[],
): Promise<Tool[]> {
  const { tools: mcpTools } = await client.listTools();
  const allowSet = whitelist ? new Set(whitelist) : null;
  const bridged: Tool[] = [];

  for (const mcpTool of mcpTools) {
    // Skip tools not in whitelist (if whitelist is specified)
    if (allowSet && !allowSet.has(mcpTool.name)) continue;
    const toolName = `mcp_${serverName}_${mcpTool.name}`;
    const description = mcpTool.description ?? `MCP tool from ${serverName}`;

    // Convert JSON Schema inputSchema to Zod via z.fromJSONSchema
    // Fall back to z.object({}).passthrough() if conversion fails
    let parameters: z.ZodType;
    try {
      // Cast needed: MCP inputSchema type doesn't exactly match Zod's JSONSchema type
      parameters = z.fromJSONSchema(mcpTool.inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
    } catch {
      parameters = z.looseObject({});
    }

    // Capture mcpTool.name for the closure (not the prefixed name)
    const mcpToolName = mcpTool.name;

    const tool: Tool = {
      name: toolName,
      description,
      parameters,
      async execute(params: unknown): Promise<ToolResult> {
        try {
          const result = await client.callTool({
            name: mcpToolName,
            arguments: params as Record<string, unknown>,
          });

          // Convert MCP content array to a single string
          const parts: string[] = [];
          if (Array.isArray(result.content)) {
            for (const item of result.content) {
              if (typeof item === "object" && item !== null && "type" in item) {
                const typed = item as { type: string; text?: string; data?: string; mimeType?: string };
                if (typed.type === "text" && typed.text) {
                  parts.push(typed.text);
                } else if (typed.type === "image" && typed.data) {
                  parts.push(`[image: ${typed.mimeType ?? "unknown"}]`);
                } else if (typed.type === "resource") {
                  parts.push("[embedded resource]");
                }
              }
            }
          }

          return {
            content: parts.length > 0 ? parts.join("\n") : "(no content)",
            isError: result.isError === true,
          };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: `MCP tool error (${mcpToolName}): ${msg}`, isError: true };
        }
      },
    };

    bridged.push(tool);
  }

  return bridged;
}
