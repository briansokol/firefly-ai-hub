// hub/src/temporal/workflow-types.ts
// Workflow type signatures — safe to import from non-workflow code.
// Do NOT import @temporalio/workflow here.

export type ChatWorkflow = (
  model: string,
  systemPrompt: string,
  userMessage: string,
) => Promise<string>;

export type EmailTriageWorkflow = (accountName: string) => Promise<void>;

export type DailySummaryWorkflow = () => Promise<void>;

export type RgbPreset = 'work' | 'night' | 'gaming' | 'off';
export type RgbWorkflow = (preset: RgbPreset) => Promise<void>;

export type ShortsAnalysisWorkflow = (
  source: string,
  shortsConfig: import('../types.js').ShortsConfig,
) => Promise<void>;
