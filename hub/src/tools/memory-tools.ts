import type { MemoryStore } from '../memory/store.js';
import type { ToolDefinition } from './registry.js';

export function createRememberTool(memoryStore: MemoryStore, userId: string): ToolDefinition {
  return {
    name: 'remember',
    spec: {
      type: 'function',
      function: {
        name: 'remember',
        description:
          'Save a fact, preference, or important detail about the user for future conversations. ' +
          'Use this when the user explicitly asks you to remember something, or when they share ' +
          'important personal details like preferences, names, dates, or ongoing projects.',
        parameters: {
          type: 'object',
          properties: {
            fact: {
              type: 'string',
              description: 'The fact or detail to remember (e.g., "User\'s favorite color is blue").',
            },
            category: {
              type: 'string',
              enum: ['preference', 'fact', 'project', 'relationship'],
              description: 'Category of the memory.',
            },
          },
          required: ['fact', 'category'],
        },
      },
    },
    handler: async (args) => {
      const fact = args.fact as string;
      const category = (args.category as string) || 'fact';
      if (!fact) return 'No fact provided to remember.';
      memoryStore.addMemory(userId, category, fact);
      return `Remembered: "${fact}"`;
    },
  };
}

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
