import type { AgentConfig } from "../config.js";
import type { ContextInjection } from "./types.js";

/**
 * Context assembly — builds the system prompt and user messages
 * for each LLM call.
 *
 * Time awareness is injected by TimeAwarenessMiddleware, not here.
 */

/** Build the base system prompt (without time injection). */
export function buildSystemPrompt(config: AgentConfig): string {
  return config.systemPrompt;
}

/** Build the first user message with optional context injections. */
export function buildUserMessage(instruction: string, injections?: ContextInjection[]): string {
  if (!injections || injections.length === 0) {
    return instruction;
  }

  const blocks = injections
    .map((inj) => `<context type="${inj.type}" label="${inj.label}">\n${inj.content}\n</context>`)
    .join("\n\n");

  return `${blocks}\n\nYour instruction: ${instruction}`;
}
