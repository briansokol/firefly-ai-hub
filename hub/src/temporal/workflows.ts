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
  categorizeWithOllama,
  moveEmailsToFolders,
  recordCategorizationResults,
  getCategorizationSummary,
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

export async function emailCategorizationWorkflow(accountName: string): Promise<void> {
  const stateKey = `${accountName}:categorize`;
  const sinceUid = await getLastUid(stateKey);
  const batchSize = 10;
  const { emails } = await fetchEmails(accountName, sinceUid, batchSize);
  if (emails.length === 0) return;

  const sourceFolder = 'Screening';
  const categorized: Array<{
    uid: number; subject: string; from: string;
    category: string; reason: string; needsResponse: boolean;
  }> = [];
  const moves: Array<{ uid: number; destFolder: string }> = [];

  for (const email of emails) {
    const result = await categorizeWithOllama(email);
    categorized.push({
      uid: email.uid,
      subject: email.subject,
      from: email.from,
      category: result.category,
      reason: result.reason,
      needsResponse: result.needsResponse,
    });
    moves.push({ uid: email.uid, destFolder: `${sourceFolder}/${result.category}` });
  }

  // Batch move all categorized emails
  await moveEmailsToFolders(accountName, sourceFolder, moves);

  // Record results and notify Discord if any need responses
  await recordCategorizationResults(accountName, categorized);

  // Update UID to the highest processed
  const maxUid = Math.max(...emails.map((e) => e.uid));
  await updateLastUid(stateKey, maxUid);
}

export async function dailySummaryWorkflow(): Promise<void> {
  const summary = await generateDailySummary();

  // Append email categorization stats if available
  const emailSummary = await getCategorizationSummary('fastmail');
  const fullSummary = emailSummary
    ? `${summary}\n\n📬 **Email:** ${emailSummary}`
    : summary;

  await postDailySummary(fullSummary);
}

export async function rgbWorkflow(preset: import('./workflow-types.js').RgbPreset): Promise<void> {
  await setRgbPreset(preset);
}

export { shortsAnalysisWorkflow, shortsEditWorkflow } from '../shorts/workflow.js';
