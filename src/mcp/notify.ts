import type { ConnectedServer } from "./client.js";

/**
 * Create a notifyHuman callback that sends messages via agent mail MCP server.
 * Returns a no-op if no mail server is connected.
 */
export function createNotifyHuman(
  mcpServers: ConnectedServer[],
  projectKey: string,
  agentName: string,
): (message: string) => Promise<void> {
  const mailServer = mcpServers.find((s) => s.name === "mail");
  if (!mailServer) {
    return async () => {};
  }

  return async (message: string) => {
    try {
      await mailServer.client.callTool({
        name: "send_message",
        arguments: {
          project_key: projectKey,
          sender_name: agentName,
          to: ["HumanOverseer"],
          subject: "Agent notification",
          body_md: message,
          importance: "high",
        },
      });
    } catch {
      // Don't let mail failures break the agent
    }
  };
}
