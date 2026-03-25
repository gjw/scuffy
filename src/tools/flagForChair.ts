import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const parameters = z.object({
  subject: z.string().describe("Short subject line (e.g. 'Chose REST over GraphQL for issues API')."),
  detail: z.string().describe("What you decided, why, and what alternative Chair might prefer. Include the bead ID if relevant."),
});

/**
 * Non-blocking flag to the human overseer. Sends a message via agent mail
 * and returns immediately — does NOT stop your work. Use this when you
 * encounter ambiguity, make a judgment call, or want Chair to review a
 * decision asynchronously.
 */
export const flagForChairTool: Tool<typeof parameters> = {
  name: "flagForChair",
  description:
    "Send a non-blocking flag to the human overseer (Chair). Use when you encounter " +
    "ambiguity, make a judgment call, or want Chair to review a decision. This does NOT " +
    "stop your work — send the flag and continue. Chair reviews asynchronously.",
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx: ToolContext): Promise<ToolResult> {
    const message = `[FLAG] ${params.subject}\n\n${params.detail}`;

    // Send via agent mail (no-op if not connected)
    await ctx.notifyHuman(message);

    // Log it
    ctx.log({
      type: "escalation",
      timestamp: new Date().toISOString(),
      reason: "flag",
      message: `${params.subject}: ${params.detail}`,
    });

    return {
      content: `Flag sent to Chair: "${params.subject}". Continue working.`,
    };
  },
};
