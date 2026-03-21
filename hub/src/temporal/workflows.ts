import { proxyActivities } from '@temporalio/workflow';
import type { Activities } from './activities.js';

const {
  callOllama,
  getLastUid,
  fetchEmails,
  triageWithOllama,
  postEmailResult,
  updateLastUid,
  generateDailySummary,
  postDailySummary,
  setRgbPreset,
} = proxyActivities<Activities>({
  startToCloseTimeout: '5 minutes',
  retry: {
    maximumAttempts: 3,
    initialInterval: '2s',
    backoffCoefficient: 2,
  },
});

export async function chatWorkflow(
  model: string,
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  return callOllama(model, systemPrompt, userMessage);
}

export async function emailTriageWorkflow(accountName: string): Promise<void> {
  const sinceUid = await getLastUid(accountName);
  const { emails } = await fetchEmails(accountName, sinceUid);
  if (emails.length === 0) return;

  for (const email of emails) {
    const result = await triageWithOllama(email);
    await postEmailResult(
      accountName,
      email.subject,
      result.summary,
      result.urgent,
      result.actionItems,
    );
    await updateLastUid(accountName, email.uid);
  }
}

export async function dailySummaryWorkflow(): Promise<void> {
  const summary = await generateDailySummary();
  await postDailySummary(summary);
}

export async function rgbWorkflow(preset: import('./workflow-types.js').RgbPreset): Promise<void> {
  await setRgbPreset(preset);
}

export { shortsAnalysisWorkflow, shortsEditWorkflow } from '../shorts/workflow.js';
