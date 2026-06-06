import { proxyActivities } from '@temporalio/workflow';
import type { Activities } from './activities.js';

const {
  callOllama,
  chatWithConversation,
  getLastUid,
  fetchEmails,
  triageWithOllama,
  postEmailResult,
  updateLastUid,
  generateDailySummary,
  postDailySummaryWithThread,
  setRgbPreset,
  fetchOldestEmails,
  categorizeWithOllama,
  moveEmailsToFolders,
  recordCategorizationResults,
  getDailyEmailDigest,
} = proxyActivities<Activities>({
  startToCloseTimeout: '5 minutes',
  retry: {
    maximumAttempts: 3,
    initialInterval: '2s',
    backoffCoefficient: 2,
  },
});

// Distillation runs a heavy LLM + embeddings per user; give it a longer budget.
const { listDistillUsers, distillUserMemories } = proxyActivities<Activities>({
  startToCloseTimeout: '15 minutes',
  retry: {
    maximumAttempts: 2,
    initialInterval: '5s',
    backoffCoefficient: 2,
  },
});

export async function chatWorkflow(
  model: string,
  systemPrompt: string,
  conversationId: string,
  userMessage: string,
): Promise<string> {
  return chatWithConversation(model, systemPrompt, conversationId, userMessage);
}

export async function memoryDistillWorkflow(): Promise<void> {
  const users = await listDistillUsers();
  for (const userId of users) {
    await distillUserMemories(userId);
  }
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
  const sourceFolder = 'Screening';
  const batchSize = 10;

  // Fetch oldest messages in the folder — since we move processed emails out,
  // the oldest remaining are always unprocessed. No UID tracking needed.
  const emails = await fetchOldestEmails(accountName, sourceFolder, batchSize);
  if (emails.length === 0) return;

  const categorized: Array<{
    uid: number; subject: string; from: string;
    category: string; reason: string; summary: string; needsResponse: boolean;
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
      summary: result.summary,
      needsResponse: result.needsResponse,
    });
    moves.push({ uid: email.uid, destFolder: `${sourceFolder}/${result.category}` });
  }

  // Batch move all categorized emails
  await moveEmailsToFolders(accountName, sourceFolder, moves);

  // Record results and notify Discord if any need responses
  await recordCategorizationResults(accountName, categorized);
}

export async function dailySummaryWorkflow(): Promise<void> {
  const summary = await generateDailySummary();
  const digest = await getDailyEmailDigest('fastmail');
  await postDailySummaryWithThread(summary, digest);
}

export async function rgbWorkflow(preset: import('./workflow-types.js').RgbPreset): Promise<void> {
  await setRgbPreset(preset);
}

export { shortsAnalysisWorkflow, shortsEditWorkflow } from '../shorts/workflow.js';
