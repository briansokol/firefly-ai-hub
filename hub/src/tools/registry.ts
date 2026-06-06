import type { ChatCompletionTool, ChatCompletionFunctionTool } from 'openai/resources/chat/completions.js';
import type { Config } from '../types.js';
import { createWebSearchTool } from './web-search.js';
import { createWeatherTool } from './weather.js';
import { createDateTimeTool } from './datetime.js';
import { createSystemInfoTool } from './system-info.js';
import { createFetchUrlTool } from './fetch-url.js';

export interface ToolDefinition {
  name: string;
  spec: ChatCompletionFunctionTool;
  handler: (args: Record<string, unknown>) => Promise<string>;
}

export interface ToolRegistryOptions {
  config: Config;
}

function addTool(registry: Map<string, ToolDefinition>, tool: ToolDefinition): void {
  registry.set(tool.name, tool);
}

export function getToolRegistry(opts: ToolRegistryOptions): Map<string, ToolDefinition> {
  const { config } = opts;
  const registry = new Map<string, ToolDefinition>();

  addTool(registry, createDateTimeTool());
  addTool(registry, createSystemInfoTool());
  addTool(registry, createWeatherTool(config));

  if (config.tools?.web_search) {
    addTool(registry, createWebSearchTool(config));
  }

  addTool(registry, createFetchUrlTool(config));

  return registry;
}

export function getToolSpecs(registry: Map<string, ToolDefinition>): ChatCompletionTool[] {
  return Array.from(registry.values()).map((t) => t.spec);
}
