import type { AgentConfig } from "../config.js";
import type { Session, ContextInjection } from "./types.js";

/**
 * Context assembly — builds the system prompt and user messages
 * for each LLM call.
 */

/** Build the system prompt with time awareness. */
export function buildSystemPrompt(config: AgentConfig, session: Session): string {
  const now = new Date();
  const elapsed = now.getTime() - session.startedAt.getTime();
  const elapsedMinutes = Math.floor(elapsed / 60_000);

  const timeLine = `Current time: ${now.toISOString()}. Session started ${String(elapsedMinutes)}m ago.`;

  if (config.systemPrompt) {
    return `${config.systemPrompt}\n\n${timeLine}`;
  }
  return timeLine;
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
