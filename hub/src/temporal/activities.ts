import type OpenAI from 'openai';
import type { Client as DiscordClient } from 'discord.js';
import type { Config } from '../types.js';
import type { StateStore } from '../email/state.js';
import type { FetchedEmail } from '../email/imap.js';
import { chat } from '../ollama.js';
import { fetchNewEmails } from '../email/imap.js';
import { buildTriagePrompt, parseTriageResponse } from '../email/triage.js';
import { getEmailPassword } from '../config.js';

export interface ActivityDeps {
  ollamaClient: OpenAI;
  discordClient: DiscordClient;
  config: Config;
  stateStore: StateStore;
}

export function createActivities(deps: ActivityDeps) {
  const { ollamaClient, discordClient, config, stateStore } = deps;

  function getTextChannel(name: string) {
    const guild = discordClient.guilds.cache.get(config.discord.guild_id);
    const channel = guild?.channels.cache.find((c) => c.name === name);
    return channel?.isTextBased() ? channel : null;
  }

  return {
    async callOllama(
      model: string,
      systemPrompt: string,
      userMessage: string,
    ): Promise<string> {
      return chat(ollamaClient, model, systemPrompt, userMessage);
    },

    async getLastUid(accountName: string): Promise<number> {
      return stateStore.getLastUid(accountName);
    },

    async fetchEmails(
      accountName: string,
      sinceUid: number,
    ): Promise<{ emails: FetchedEmail[]; maxUid: number }> {
      const account = config.email.accounts.find((a) => a.name === accountName);
      if (!account) throw new Error(`Unknown email account: ${accountName}`);
      const password = getEmailPassword(account);
      const emails = await fetchNewEmails(account, password, sinceUid);
      const maxUid = emails.length > 0 ? Math.max(...emails.map((e) => e.uid)) : sinceUid;
      return { emails, maxUid };
    },

    async triageWithOllama(email: FetchedEmail): Promise<{ summary: string; actionItems: string[]; urgent: boolean }> {
      const { system, user } = buildTriagePrompt(email);
      const raw = await chat(ollamaClient, config.models.default, system, user);
      return parseTriageResponse(raw);
    },

    async postEmailResult(
      accountName: string,
      subject: string,
      summary: string,
      urgent: boolean,
      actionItems: string[],
    ): Promise<void> {
      const emailChannel = getTextChannel('email');
      if (emailChannel) {
        await emailChannel.send(`📧 **${accountName}** | **${subject}**\n${summary}`);
      }
      if (urgent && actionItems.length > 0) {
        const alertsChannel = getTextChannel('alerts');
        if (alertsChannel) {
          const items = actionItems.map((item) => `• ${item}`).join('\n');
          await alertsChannel.send(`⚠️ **Action required** — ${subject}\n${items}`);
        }
      }
    },

    async updateLastUid(accountName: string, uid: number): Promise<void> {
      stateStore.setLastUid(accountName, uid);
    },

    async generateDailySummary(): Promise<string> {
      const today = new Date().toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      });
      const system =
        'You are a friendly personal assistant. Write warm, concise daily summaries.';
      const user = `Write a brief daily summary for ${today}. 2-3 sentences.`;
      return chat(ollamaClient, config.models.default, system, user);
    },

    async postDailySummary(summary: string): Promise<void> {
      const channel = getTextChannel('daily-summary');
      if (channel) {
        await channel.send(`📅 **Daily Summary**\n${summary}`);
      }
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
