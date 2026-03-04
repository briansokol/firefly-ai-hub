import { Client, ScheduleOverlapPolicy } from '@temporalio/client';
import type { Config } from '../types.js';

async function ensureSchedule(
  client: Client,
  scheduleId: string,
  spec: { cronExpression: string; timezone: string },
  workflowType: string,
  args: unknown[],
): Promise<void> {
  try {
    await client.schedule.getHandle(scheduleId).describe();
    return; // already exists
  } catch {
    // does not exist — fall through to create
  }

  await client.schedule.create({
    scheduleId,
    spec: {
      cronExpressions: [spec.cronExpression],
      timezone: spec.timezone,
    },
    action: {
      type: 'startWorkflow',
      workflowType,
      args,
      taskQueue: 'ai-hub',
    },
    policies: {
      overlap: ScheduleOverlapPolicy.SKIP,
      catchupWindow: '1 day',
    },
  });

  console.log(`Registered Temporal schedule: ${scheduleId}`);
}

export async function registerSchedules(config: Config, client: Client): Promise<void> {
  for (const account of config.email.accounts) {
    await ensureSchedule(
      client,
      `email-triage-${account.name}`,
      { cronExpression: config.schedule.email_triage_cron, timezone: config.schedule.timezone },
      'emailTriageWorkflow',
      [account.name],
    );
  }

  await ensureSchedule(
    client,
    'daily-summary',
    { cronExpression: config.schedule.daily_summary_cron, timezone: config.schedule.timezone },
    'dailySummaryWorkflow',
    [],
  );
}
