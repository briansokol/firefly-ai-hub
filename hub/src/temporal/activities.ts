import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type OpenAI from 'openai';
import type { Client as DiscordClient } from 'discord.js';
import type { Config } from '../types.js';
import type { StateStore } from '../email/state.js';
import type { FetchedEmail } from '../email/imap.js';
import { chat } from '../ollama.js';
import { fetchNewEmails } from '../email/imap.js';
import { buildTriagePrompt, parseTriageResponse } from '../email/triage.js';
import { getEmailPassword } from '../config.js';
import type { RgbPreset } from './workflow-types.js';
import type { VideoMeta, AudioPeak, TranscriptWord, Candidate } from '../shorts/types.js';
import { getVideoInfo } from '../shorts/ffprobe.js';
import { extractAndAnalyzeAudio as analyzeAudio } from '../shorts/audio-analysis.js';
import { transcribeAudio as runTranscription } from '../shorts/transcription.js';
import { identifyCandidates as scoreCandidates } from '../shorts/candidates.js';
import { suggestTitles as generateTitles } from '../shorts/titles.js';
import { cleanupWorkspace as doCleanup } from '../shorts/cleanup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RGB_SET = path.resolve(__dirname, '../../../rgb/rgb-set');

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

    async setRgbPreset(preset: RgbPreset): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        execFile(RGB_SET, [preset], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },

    // ── Shorts Phase 1 activities ──────────────────────────────────────────

    async reportProgress(message: string, channelName: string): Promise<void> {
      const channel = getTextChannel(channelName);
      if (channel) await channel.send(message);
    },

    async resolveVideo(source: string, workspaceDir: string): Promise<VideoMeta> {
      const timestamp = Date.now();
      const workspacePath = path.join(workspaceDir, `shorts-${timestamp}`);
      fs.mkdirSync(workspacePath, { recursive: true });
      console.log(`[resolveVideo] workspace: ${workspacePath}`);

      let videoPath: string;
      let title: string;

      if (source.startsWith('http')) {
        videoPath = path.join(workspacePath, 'source.mp4');

        // Get title from yt-dlp metadata (separate from download for reliability)
        console.log('[resolveVideo] fetching video metadata via yt-dlp --dump-json');
        title = await new Promise<string>((resolve) => {
          execFile(
            'yt-dlp',
            ['--dump-json', '--no-playlist', source],
            (err, stdout, stderr) => {
              if (err) {
                console.error(`[resolveVideo] yt-dlp --dump-json failed: ${err.message}\n${stderr}`);
                resolve('Untitled');
                return;
              }
              try {
                const data = JSON.parse(stdout.split('\n')[0]) as { title?: string };
                resolve(data.title ?? 'Untitled');
              } catch (e) {
                console.error(`[resolveVideo] failed to parse yt-dlp JSON: ${e}`);
                resolve('Untitled');
              }
            },
          );
        });
        console.log(`[resolveVideo] title: "${title}"`);

        console.log(`[resolveVideo] starting yt-dlp download → ${videoPath}`);
        await new Promise<void>((resolve, reject) => {
          const proc = spawn('yt-dlp', [
            '-o', videoPath,
            '--no-playlist',
            '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
            '--merge-output-format', 'mp4',
            source,
          ]);
          let stderr = '';
          proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
          proc.stdout.on('data', (chunk: Buffer) => {
            // yt-dlp progress lines go to stdout — stream them to logs
            process.stdout.write(`[yt-dlp] ${chunk.toString()}`);
          });
          proc.on('close', (code) => {
            if (code === 0) {
              console.log('[resolveVideo] yt-dlp download complete');
              resolve();
            } else {
              console.error(`[resolveVideo] yt-dlp failed (code ${code}):\n${stderr.slice(-500)}`);
              reject(new Error(`yt-dlp failed with code ${code}`));
            }
          });
        });
      } else {
        console.log(`[resolveVideo] local file: ${source}`);
        videoPath = source;
        const info = await getVideoInfo(videoPath);
        title = info.title;
      }

      console.log('[resolveVideo] running ffprobe for duration');
      const { duration } = await getVideoInfo(videoPath);
      console.log(`[resolveVideo] done — title="${title}" duration=${duration.toFixed(1)}s`);
      return { title, duration, videoPath, workspacePath };
    },

    async extractAndAnalyzeAudio(
      videoPath: string,
      workspacePath: string,
      peakThreshold: number,
    ): Promise<AudioPeak[]> {
      return analyzeAudio(videoPath, workspacePath, peakThreshold);
    },

    async transcribeAudio(
      videoPath: string,
      workspacePath: string,
      transcriptionModel: string,
      language: string,
    ): Promise<TranscriptWord[]> {
      return runTranscription(videoPath, workspacePath, transcriptionModel, language);
    },

    async identifyCandidates(
      peaks: AudioPeak[],
      transcript: TranscriptWord[],
      workspacePath: string,
      maxClips: number,
      scoringModel: string,
      windowSize?: number,
      windowOverlap?: number,
      videoTitle?: string,
      screeningModel?: string,
    ): Promise<Candidate[]> {
      const model = scoringModel || config.models.default;
      return scoreCandidates(peaks, transcript, workspacePath, maxClips, ollamaClient, model, windowSize, windowOverlap, videoTitle, screeningModel);
    },

    async suggestTitles(
      transcript: TranscriptWord[],
      scoringModel: string,
    ): Promise<string[]> {
      const model = scoringModel || config.models.default;
      return generateTitles(transcript, ollamaClient, model);
    },

    async notifyDiscord(
      videoMeta: VideoMeta,
      titles: string[],
      candidates: Candidate[],
      channelName: string,
    ): Promise<void> {
      const channel = getTextChannel(channelName);
      if (!channel) return;

      const titleLines = titles.map((t, i) => `${i + 1}. ${t}`).join('\n');
      const candidateLines = candidates
        .map((c, i) => {
          const cat = c.category ? ` [${c.category}]` : '';
          return `${i + 1}. 🎬 \`${formatTimestamp(c.timestamp)}\` — "${c.quote}" (score: ${c.score.toFixed(1)})${cat}`;
        })
        .join('\n');

      const msg =
        `✅ Analysis complete for: **${videoMeta.title}**\n\n` +
        `**Suggested Episode Titles:**\n${titleLines}\n\n` +
        `**Shorts Candidates (${candidates.length}):**\n${candidateLines}`;

      await channel.send(msg);

      const srtPath = path.join(videoMeta.workspacePath, 'transcript.srt');
      if (fs.existsSync(srtPath)) {
        await channel.send({ files: [{ attachment: srtPath, name: 'transcript.srt' }] });
      }
    },

    async cleanupWorkspace(workspacePath: string): Promise<void> {
      return doCleanup(workspacePath);
    },
  };
}

function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

export type Activities = ReturnType<typeof createActivities>;
