import type { ToolDefinition } from './registry.js';

export function createDateTimeTool(): ToolDefinition {
  return {
    name: 'get_current_time',
    spec: {
      type: 'function',
      function: {
        name: 'get_current_time',
        description:
          'Get the current date and time. Use this when the user asks what time or date it is, ' +
          'or when you need to know the current time for any reason.',
        parameters: {
          type: 'object',
          properties: {
            timezone: {
              type: 'string',
              description:
                'IANA timezone name (e.g., "America/New_York", "Europe/London"). ' +
                'Defaults to the server\'s local timezone if not specified.',
            },
          },
          required: [],
        },
      },
    },
    handler: async (args) => {
      const tz = (args.timezone as string) || Intl.DateTimeFormat().resolvedOptions().timeZone;
      try {
        const now = new Date();
        const formatted = now.toLocaleString('en-US', {
          timeZone: tz,
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          timeZoneName: 'short',
        });
        return `Current time: ${formatted}`;
      } catch {
        return `Invalid timezone: "${tz}". Use an IANA timezone name like "America/New_York".`;
      }
    },
  };
}
