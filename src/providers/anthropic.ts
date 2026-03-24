import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlock, LLMMessage, LLMProvider, LLMResponse, LLMToolDef } from "./types.js";

/** Translate our ContentBlock[] to Anthropic message content. */
function toAnthropicContent(
  content: string | ContentBlock[],
): string | Anthropic.ContentBlockParam[] {
  if (typeof content === "string") return content;

  return content.map((block): Anthropic.ContentBlockParam => {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text };
      case "tool_use":
        return {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        };
      case "tool_result":
        return {
          type: "tool_result",
          tool_use_id: block.tool_use_id,
          content: block.content,
          is_error: block.is_error,
        };
    }
  });
}

/** Translate our messages to Anthropic message params. */
function toAnthropicMessages(messages: LLMMessage[]): Anthropic.MessageParam[] {
  return messages.map((msg) => ({
    role: msg.role,
    content: toAnthropicContent(msg.content),
  }));
}

/** Translate our tool defs to Anthropic tool format. */
function toAnthropicTools(tools: LLMToolDef[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
  }));
}

/** Translate Anthropic response to our LLMResponse. */
function fromAnthropicResponse(response: Anthropic.Message): LLMResponse {
  const content: ContentBlock[] = [];
  for (const block of response.content) {
    if (block.type === "text") {
      content.push({ type: "text" as const, text: block.text });
    } else if (block.type === "tool_use") {
      content.push({
        type: "tool_use" as const,
        id: block.id,
        name: block.name,
        input: block.input,
      });
    }
    // Skip thinking, redacted_thinking, and other block types
  }

  let stopReason: LLMResponse["stopReason"] = "end_turn";
  if (response.stop_reason === "tool_use") stopReason = "tool_use";
  else if (response.stop_reason === "max_tokens") stopReason = "max_tokens";

  return {
    content,
    stopReason,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}

export class AnthropicProvider implements LLMProvider {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async createCompletion(params: {
    model: string;
    maxTokens: number;
    system: string;
    messages: LLMMessage[];
    tools?: LLMToolDef[];
  }): Promise<LLMResponse> {
    const createParams: Anthropic.MessageCreateParamsNonStreaming = {
      model: params.model,
      max_tokens: params.maxTokens,
      system: params.system,
      messages: toAnthropicMessages(params.messages),
    };
    if (params.tools && params.tools.length > 0) {
      createParams.tools = toAnthropicTools(params.tools);
    }

    const response = await this.client.messages.create(createParams);
    return fromAnthropicResponse(response);
  }
}
