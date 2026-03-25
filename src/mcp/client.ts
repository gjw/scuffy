import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig } from "../config.js";

export interface ConnectedServer {
  name: string;
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
}

/**
 * Connect to configured MCP servers. Returns connected clients.
 * Logs warnings for servers that fail to connect but does not throw.
 */
export async function connectMcpServers(
  configs: McpServerConfig[],
): Promise<ConnectedServer[]> {
  const connected: ConnectedServer[] = [];

  for (const config of configs) {
    try {
      const client = new Client(
        { name: `scuffy-mcp-${config.name}`, version: "1.0.0" },
        { capabilities: {} },
      );

      let transport: StdioClientTransport | StreamableHTTPClientTransport;

      if (config.transport === "stdio") {
        if (!config.command) {
          console.error(`MCP server "${config.name}": stdio transport requires "command"`);
          continue;
        }
        const stdioOpts: { command: string; args: string[]; env?: Record<string, string> } = {
          command: config.command,
          args: config.args ?? [],
        };
        if (config.env) {
          stdioOpts.env = { ...process.env, ...config.env } as Record<string, string>;
        }
        transport = new StdioClientTransport(stdioOpts);
      } else {
        if (!config.url) {
          console.error(`MCP server "${config.name}": http transport requires "url"`);
          continue;
        }
        transport = new StreamableHTTPClientTransport(new URL(config.url));
      }

      // MCP SDK transport types don't satisfy exactOptionalPropertyTypes
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
      await client.connect(transport as any);
      connected.push({ name: config.name, client, transport });
      console.log(`MCP server "${config.name}" connected (${config.transport})`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`MCP server "${config.name}" failed to connect: ${msg}`);
    }
  }

  return connected;
}

/** Disconnect all connected MCP servers. */
export async function disconnectAll(servers: ConnectedServer[]): Promise<void> {
  for (const server of servers) {
    try {
      await server.transport.close();
    } catch {
      // Ignore close errors during shutdown
    }
  }
}
