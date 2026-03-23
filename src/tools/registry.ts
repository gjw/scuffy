import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "./types.js";

/**
 * Tool registry — stores tools, looks them up by name, and converts
 * Zod schemas to Anthropic API tool definitions.
 *
 * Invariant 4: Adding or removing a tool must not require changes to
 * the agent loop, middleware, or any other tool. The registry is the
 * only coupling point.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  /** Register a tool. Throws if a tool with the same name already exists. */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  /** Look up a tool by name. Returns undefined if not found. */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** Check whether a tool is registered. */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Return all registered tools. */
  getAll(): Tool[] {
    return [...this.tools.values()];
  }

  /** Convert all registered tools to Anthropic API tool definitions. */
  toAnthropicTools(): Anthropic.Tool[] {
    return this.getAll().map((tool) => {
      const jsonSchema = z.toJSONSchema(tool.parameters);

      // Strip $schema — Anthropic's input_schema doesn't use it
      const { $schema: _, ...inputSchema } = jsonSchema as Record<string, unknown>;

      return {
        name: tool.name,
        description: tool.description,
        input_schema: inputSchema as Anthropic.Tool.InputSchema,
      };
    });
  }
}
