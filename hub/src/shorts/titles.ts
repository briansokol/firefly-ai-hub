import type OpenAI from 'openai';
import type { TranscriptWord } from './types.js';

const FALLBACK_TITLES = [
  'Gaming Highlights',
  'Best Moments',
  'Epic Plays',
  'Clutch Gaming',
  'Top Clips',
];

export async function suggestTitles(
  transcript: TranscriptWord[],
  ollamaClient: OpenAI,
  model: string,
): Promise<string[]> {
  console.log(`[titles] generating title suggestions with model ${model}`);
  const text = transcript.map((w) => w.word).join(' ').trim();
  if (!text) {
    console.warn('[titles] transcript is empty, using fallback titles');
    return FALLBACK_TITLES;
  }

  // Truncate to avoid hitting context limits
  const truncated = text.length > 4000 ? `${text.slice(0, 4000)}...` : text;

  const prompt =
    'You are helping title a gaming video. Based on this transcript, suggest exactly 5 short, ' +
    'punchy episode titles. Each title should be 3–5 words. ' +
    'Reply as a JSON array of strings only.\n\n' +
    `Transcript:\n${truncated}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await ollamaClient.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
      });
      const content = response.choices[0]?.message?.content ?? '[]';
      const arrayMatch = content.match(/\[[\s\S]*?\]/);
      if (arrayMatch) {
        const titles = JSON.parse(arrayMatch[0]) as unknown[];
        const strings = titles.filter((t): t is string => typeof t === 'string');
        if (strings.length > 0) {
          console.log(`[titles] generated ${strings.length} titles`);
          return strings.slice(0, 5);
        }
      } else {
        console.warn(`[titles] could not parse JSON array from response: ${content.slice(0, 200)}`);
      }
    } catch (e) {
      console.error(`[titles] Ollama error on attempt ${attempt + 1}: ${e}`);
      if (attempt === 1) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  console.warn('[titles] Ollama failed, using fallback titles');
  return FALLBACK_TITLES;
}
