import OpenAI from "openai";
import type {
  ContentBlock,
  LLMMessage,
  LLMProvider,
  LLMResponse,
  LLMToolDef,
  TextBlock,
  ToolUseBlock,
} from "./types.js";

type ChatMessage = OpenAI.ChatCompletionMessageParam;

/** Translate our messages to OpenAI chat messages. */
function toOpenAIMessages(system: string, messages: LLMMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [{ role: "system" as const, content: system }];

  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        result.push({ role: "user" as const, content: msg.content });
      } else {
        // Content blocks: split tool_results into separate tool messages, text into user messages
        const textParts = msg.content.filter((b): b is TextBlock => b.type === "text");
        if (textParts.length > 0) {
          result.push({ role: "user" as const, content: textParts.map((t) => t.text).join("\n") });
        }
        for (const block of msg.content) {
          if (block.type === "tool_result") {
            result.push({
              role: "tool" as const,
              tool_call_id: block.tool_use_id,
              content: block.content,
            });
          }
        }
      }
    } else {
      // Assistant messages: may contain text and tool_use blocks
      if (typeof msg.content === "string") {
        result.push({ role: "assistant" as const, content: msg.content });
      } else {
        const textParts = msg.content.filter((b): b is TextBlock => b.type === "text");
        const toolUseParts = msg.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
        const textContent = textParts.map((t) => t.text).join("\n") || null;

        if (toolUseParts.length > 0) {
          result.push({
            role: "assistant" as const,
            content: textContent,
            tool_calls: toolUseParts.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.input),
              },
            })),
          });
        } else {
          result.push({ role: "assistant" as const, content: textContent ?? "" });
        }
      }
    }
  }

  return result;
}

/** Translate our tool defs to OpenAI function tools. */
function toOpenAITools(tools: LLMToolDef[]): OpenAI.ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

/** Translate OpenAI response to our LLMResponse. */
function fromOpenAIResponse(choice: OpenAI.ChatCompletion.Choice): LLMResponse {
  const content: ContentBlock[] = [];

  if (choice.message.content) {
    content.push({ type: "text", text: choice.message.content });
  }

  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      if (tc.type === "function") {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments) as unknown,
        });
      }
    }
  }

  let stopReason: LLMResponse["stopReason"] = "end_turn";
  if (choice.finish_reason === "tool_calls") stopReason = "tool_use";
  else if (choice.finish_reason === "length") stopReason = "max_tokens";

  return {
    content,
    stopReason,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
}

export class OpenAIProvider implements LLMProvider {
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async createCompletion(params: {
    model: string;
    maxTokens: number;
    system: string;
    messages: LLMMessage[];
    tools?: LLMToolDef[];
  }): Promise<LLMResponse> {
    const createParams: OpenAI.ChatCompletionCreateParamsNonStreaming = {
      model: params.model,
      max_completion_tokens: params.maxTokens,
      messages: toOpenAIMessages(params.system, params.messages),
    };
    if (params.tools && params.tools.length > 0) {
      createParams.tools = toOpenAITools(params.tools);
    }

    const response = await this.client.chat.completions.create(createParams);
    const choice = response.choices[0];
    if (!choice) {
      throw new Error("OpenAI returned no choices");
    }

    const result = fromOpenAIResponse(choice);
    // OpenAI reports usage at the response level
    if (response.usage) {
      result.usage.inputTokens = response.usage.prompt_tokens;
      result.usage.outputTokens = response.usage.completion_tokens;
      const details = response.usage.prompt_tokens_details as
        | { cached_tokens?: number }
        | undefined;
      result.usage.cacheReadTokens = details?.cached_tokens ?? 0;
    }
    return result;
  }
}
