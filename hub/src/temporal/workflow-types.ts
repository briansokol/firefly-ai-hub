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
