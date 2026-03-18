import OpenAI from 'openai';
import type { Config } from './types.js';

export function createOllamaClient(config: Config): OpenAI {
  return new OpenAI({
    baseURL: config.models.ollama_base_url,
    apiKey: 'ollama',
  });
}

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
