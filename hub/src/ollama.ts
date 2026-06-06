import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessage,
  ChatCompletionTool,
} from 'openai/resources/chat/completions.js';
import type { Config } from './types.js';

export function createOllamaClient(config: Config): OpenAI {
  return new OpenAI({
    baseURL: config.models.ollama_base_url,
    apiKey: 'ollama',
  });
}

/** Single-turn chat (used by email triage, categorization, etc.) */
export async function chat(
  client: OpenAI,
  model: string,
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
  });
  return response.choices[0]?.message?.content ?? '(no response)';
}

/** Embed a single text via the OpenAI-compatible /v1/embeddings endpoint. */
export async function embed(
  client: OpenAI,
  model: string,
  input: string,
): Promise<number[]> {
  const response = await client.embeddings.create({ model, input });
  return response.data[0]?.embedding ?? [];
}

/** Multi-turn chat with full message history and optional tool definitions. */
export async function chatWithHistory(
  client: OpenAI,
  model: string,
  messages: ChatCompletionMessageParam[],
  tools?: ChatCompletionTool[],
): Promise<ChatCompletionMessage> {
  const response = await client.chat.completions.create({
    model,
    messages,
    ...(tools && tools.length > 0 ? { tools } : {}),
  });
  return (
    response.choices[0]?.message ?? {
      role: 'assistant' as const,
      content: '(no response)',
      refusal: null,
    }
  );
}
