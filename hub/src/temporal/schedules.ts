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
  } catch (err) {
    const message = err instanceof Error ? err.message.toLowerCase() : '';
    if (!message.includes('not found') && !message.includes('no rows')) {
      throw err;
    }
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
      taskQueue: 'firefly-ai-hub',
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

  // Email categorization — hourly, batch of 10
  if (config.email.categorization?.enabled) {
    for (const account of config.email.accounts) {
      await ensureSchedule(
        client,
        `email-categorize-${account.name}`,
        { cronExpression: '0 * * * *', timezone: config.schedule.timezone },
        'emailCategorizationWorkflow',
        [account.name],
      );
    }
  }

  await ensureSchedule(
    client,
    'daily-summary',
    { cronExpression: config.schedule.daily_summary_cron, timezone: config.schedule.timezone },
    'dailySummaryWorkflow',
    [],
  );

  // Memory distillation — every 15 minutes
  await ensureSchedule(
    client,
    'memory-distill',
    { cronExpression: '*/15 * * * *', timezone: config.schedule.timezone },
    'memoryDistillWorkflow',
    [],
  );

  const tz = config.schedule.timezone;
  await ensureSchedule(client, 'rgb-work',  { cronExpression: '0 8 * * 1-5', timezone: tz }, 'rgbWorkflow', ['work']);
  await ensureSchedule(client, 'rgb-night', { cronExpression: '0 21 * * *',   timezone: tz }, 'rgbWorkflow', ['night']);
  await ensureSchedule(client, 'rgb-off',   { cronExpression: '0 0 * * *',    timezone: tz }, 'rgbWorkflow', ['off']);
}
