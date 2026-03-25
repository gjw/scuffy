import type { ConnectedServer } from "./client.js";

/**
 * Create a recordOutcome callback that sends session outcomes to CASS via MCP.
 * Returns a no-op if no CASS server is connected.
 */
export function createRecordOutcome(
  mcpServers: ConnectedServer[],
): (status: "success" | "failure" | "partial", rules: string) => Promise<void> {
  const cassServer = mcpServers.find((s) => s.name === "cass");
  if (!cassServer) {
    return async () => {};
  }

  return async (status: "success" | "failure" | "partial", rules: string) => {
    try {
      await cassServer.client.callTool({
        name: "cm_outcome",
        arguments: { status, rules },
      });
    } catch {
      // Don't let CASS failures break the agent
    }
  };
}
