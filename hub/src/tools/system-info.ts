import os from 'node:os';
import type { ToolDefinition } from './registry.js';

export function createSystemInfoTool(): ToolDefinition {
  return {
    name: 'system_status',
    spec: {
      type: 'function',
      function: {
        name: 'system_status',
        description:
          'Get the current status of the home server: CPU usage, memory, disk, and uptime. ' +
          'Use this when the user asks about the server status or system health.',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    },
    handler: async () => {
      const cpus = os.cpus();
      const loadAvg = os.loadavg();
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const uptimeSec = os.uptime();

      const days = Math.floor(uptimeSec / 86400);
      const hours = Math.floor((uptimeSec % 86400) / 3600);
      const minutes = Math.floor((uptimeSec % 3600) / 60);

      const formatBytes = (b: number) => `${(b / 1024 / 1024 / 1024).toFixed(1)} GB`;

      return [
        `Host: ${os.hostname()}`,
        `Platform: ${os.platform()} ${os.arch()}`,
        `CPUs: ${cpus.length}x ${cpus[0]?.model ?? 'unknown'}`,
        `Load average: ${loadAvg.map((l) => l.toFixed(2)).join(', ')} (1m, 5m, 15m)`,
        `Memory: ${formatBytes(usedMem)} used / ${formatBytes(totalMem)} total (${((usedMem / totalMem) * 100).toFixed(0)}%)`,
        `Uptime: ${days}d ${hours}h ${minutes}m`,
      ].join('\n');
    },
  };
}
