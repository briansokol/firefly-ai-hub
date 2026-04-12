import type { MemoryStore } from '../memory/store.js';
import type { ToolDefinition } from './registry.js';

export function createRecallTool(memoryStore: MemoryStore, userId: string): ToolDefinition {
  return {
    name: 'recall',
    spec: {
      type: 'function',
      function: {
        name: 'recall',
        description:
          'Search your memory for previously saved facts about the user. ' +
          'Use this when you need to recall something the user told you before, ' +
          'or when answering questions about their preferences or past conversations.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'What to search for in memory (e.g., "favorite color", "birthday").',
            },
          },
          required: ['query'],
        },
      },
    },
    handler: async (args) => {
      const query = args.query as string;
      if (!query) return 'No query provided.';
      const results = memoryStore.searchMemories(userId, query, 10);
      if (results.length === 0) return 'No memories found for that query.';
      return results
        .map((m) => `[${m.category}] ${m.content} (saved ${m.created_at})`)
        .join('\n');
    },
  };
}
