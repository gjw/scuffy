import { z } from "zod";
import type { Tool, ToolResult } from "./types.js";

const parameters = z.object({
  thought: z
    .string()
    .describe("Your internal reasoning. Use this to work through problems step by step."),
});

/**
 * No-op scratchpad tool. The model calls this to "think out loud" —
 * the thought is captured in the tool call log but has no side effects.
 */
export const thinkTool: Tool<typeof parameters> = {
  name: "think",
  description:
    "Use this tool to think through a problem step by step. " +
    "Your thought is recorded but has no side effects.",
  parameters,
  execute(params): Promise<ToolResult> {
    return Promise.resolve({ content: params.thought });
  },
};
