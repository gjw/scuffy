import type { LLMCallContext, Middleware } from "../agent/middleware.js";
import type { Session } from "../agent/types.js";

/**
 * Time awareness middleware — injects current timestamp and session
 * elapsed time into the system prompt before each LLM call.
 * Must run before the LLM call (Invariant 5).
 */
export function createTimeAwarenessMiddleware(session: Session): Middleware {
  return {
    name: "timeAwareness",

    beforeLLMCall(ctx: LLMCallContext): LLMCallContext {
      const now = new Date();
      const elapsed = now.getTime() - session.startedAt.getTime();
      const elapsedMinutes = Math.floor(elapsed / 60_000);

      const timeLine = `Current time: ${now.toISOString()}. Session started ${String(elapsedMinutes)}m ago.`;

      const systemPrompt = ctx.systemPrompt ? `${ctx.systemPrompt}\n\n${timeLine}` : timeLine;

      return { ...ctx, systemPrompt };
    },
  };
}
