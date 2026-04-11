import type { Config } from '../types.js';
import type { ToolDefinition } from './registry.js';

interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveSearchResult[];
  };
}

export function createWebSearchTool(config: Config): ToolDefinition {
  const apiKeyEnv = config.tools?.web_search?.api_key_env;

  return {
    name: 'web_search',
    spec: {
      type: 'function',
      function: {
        name: 'web_search',
        description:
          'Search the web for current information. Use this for questions about recent events, ' +
          'facts you are unsure about, or when the user explicitly asks you to look something up.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'The search query.',
            },
          },
          required: ['query'],
        },
      },
    },
    handler: async (args) => {
      const query = args.query as string;
      if (!query) return 'Please provide a search query.';

      const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
      if (!apiKey) {
        return 'Web search is not configured (missing API key).';
      }

      try {
        const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;
        const response = await fetch(url, {
          headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' },
          signal: AbortSignal.timeout(10000),
        });

        if (!response.ok) {
          return `Search failed: HTTP ${response.status}`;
        }

        const data = (await response.json()) as BraveSearchResponse;
        const results = data.web?.results;

        if (!results?.length) {
          return `No results found for: "${query}"`;
        }

        return results
          .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.description}\n   ${r.url}`)
          .join('\n\n');
      } catch (err) {
        return `Search failed: ${err instanceof Error ? err.message : 'unknown error'}`;
      }
    },
  };
}
