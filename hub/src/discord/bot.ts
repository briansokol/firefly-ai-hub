import path from 'node:path';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { Client as TemporalClient } from '@temporalio/client';
import type { Config } from '../types.js';
import { getDiscordToken } from '../config.js';
import { isAllowed, stripMention, resolveRoute, parseRgbCommand, parseShortsCommand, parseShortsEditCommand, parseCategorizeCommand } from './router.js';
import type { ChatWorkflow } from '../temporal/workflow-types.js';
import { RgbStateManager } from '../rgb.js';
import { setRgb } from '../rgb-client.js';

const SYSTEM_PROMPT = 'You are a helpful AI assistant running on a private home server.';
const MAX_MSG_LENGTH = 2000;

function splitMessage(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > MAX_MSG_LENGTH) {
    chunks.push(remaining.slice(0, MAX_MSG_LENGTH));
    remaining = remaining.slice(MAX_MSG_LENGTH);
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export function createDiscordBot(config: Config, temporalClient: TemporalClient, rgbManager: RgbStateManager): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });

  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!isAllowed(message.author.id, config)) return;

    const isDM = message.channel.isDMBased();
    if (!isDM && !message.mentions.has(client.user!)) return;

    const rawContent = isDM ? message.content : stripMention(message.content);
    if (!rawContent) return;

    const rgbPreset = parseRgbCommand(rawContent);
    if (rgbPreset !== null) {
      setRgb(rgbPreset).then(
        () => { message.reply(`RGB set to **${rgbPreset}**`).catch(() => {}); },
        (err) => { message.reply(`RGB error: ${err.message}`).catch(() => {}); },
      );
      return;
    }

    const shortsCmd = parseShortsCommand(rawContent);
    if (shortsCmd !== null) {
      if (!config.shorts) {
        await message.reply('⚠️ Shorts processing is not configured.');
        return;
      }
      await temporalClient.workflow.start('shortsAnalysisWorkflow', {
        workflowId: `shorts-${message.id}`,
        taskQueue: 'firefly-ai-hub',
        args: [shortsCmd.source, config.shorts],
      });
      await message.reply("⏳ Processing started — I'll post results when done.");
      return;
    }

    const categorizeCmd = parseCategorizeCommand(rawContent);
    if (categorizeCmd !== null) {
      if (!config.email.categorization?.enabled) {
        await message.reply('⚠️ Email categorization is not configured.');
        return;
      }
      await temporalClient.workflow.start('emailCategorizationWorkflow', {
        workflowId: `email-categorize-${message.id}`,
        taskQueue: 'firefly-ai-hub',
        args: [categorizeCmd.accountName],
      });
      await message.reply(`📬 Categorizing emails for **${categorizeCmd.accountName}**...`);
      return;
    }

    const shortsEditCmd = parseShortsEditCommand(rawContent);
    if (shortsEditCmd !== null) {
      if (!config.shorts) {
        await message.reply('⚠️ Shorts processing is not configured.');
        return;
      }
      // Resolve workspace name to full path (accept either a name or absolute path)
      const workspacePath = shortsEditCmd.workspaceName.startsWith('/')
        ? shortsEditCmd.workspaceName
        : path.join(config.shorts.workspace_dir, shortsEditCmd.workspaceName);
      await temporalClient.workflow.start('shortsEditWorkflow', {
        workflowId: `shorts-edit-${message.id}`,
        taskQueue: 'firefly-ai-hub',
        args: [workspacePath],
      });
      await message.reply(`⏳ Re-processing clips from checkpoint in \`${shortsEditCmd.workspaceName}\`...`);
      return;
    }

    const channelName = isDM
      ? 'general'
      : ('name' in message.channel ? message.channel.name : 'general');

    const route = resolveRoute(channelName, rawContent, config);

    rgbManager.startProcessing();
    try {
      const reply = await temporalClient.workflow.execute<ChatWorkflow>(
        'chatWorkflow',
        {
          args: [route.model, SYSTEM_PROMPT, route.content],
          taskQueue: 'firefly-ai-hub',
          workflowId: `chat-${message.id}`,
        },
      );
      for (const chunk of splitMessage(reply)) {
        await message.reply(chunk);
      }
    } catch {
      await message.reply('⚠️ Model unavailable, try again in a moment.');
    } finally {
      rgbManager.endProcessing();
    }
  });

  return client;
}

export async function startDiscordBot(client: Client, config: Config): Promise<void> {
  const token = getDiscordToken(config);
  await client.login(token);
  return new Promise((resolve) => {
    client.once('ready', () => {
      console.log(`Discord bot ready: ${client.user?.tag}`);
      resolve();
    });
  });
}
