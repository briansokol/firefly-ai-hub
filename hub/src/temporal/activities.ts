import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type OpenAI from 'openai';
import type { Client as DiscordClient } from 'discord.js';
import type { Config } from '../types.js';
import type { StateStore } from '../email/state.js';
import type { FetchedEmail } from '../email/imap.js';
import { chat, chatWithHistory } from '../ollama.js';
import type { ConversationStore } from '../discord/conversation.js';
import { getToolRegistry, getToolSpecs } from '../tools/registry.js';
import type { MemoryStore } from '../memory/store.js';
import { extractExplicitMemory } from '../memory/explicit-trigger.js';
import { fetchNewEmails, fetchOldestFromFolder, moveEmails } from '../email/imap.js';
import { buildTriagePrompt, parseTriageResponse } from '../email/triage.js';
import { buildCategorizePrompt, parseCategorizeResponse } from '../email/categorize.js';
import type { CategorizeResult } from '../email/categorize.js';
import type { CategorizationEntry } from '../email/state.js';
import { getEmailPassword } from '../config.js';
import type { RgbPreset } from './workflow-types.js';
import { setRgb } from '../rgb-client.js';
import type { VideoMeta, AudioPeak, TranscriptWord, Candidate, ConfirmedCandidate, AudioEvent, ProsodyBucket, ClipResult, ShortsCheckpoint } from '../shorts/types.js';
import { getVideoInfo } from '../shorts/ffprobe.js';
import { extractAndAnalyzeAudio as analyzeAudio, extractAudioToWav, detectPeaks as detectAudioPeaks } from '../shorts/audio-analysis.js';
import { transcribeAudio as runTranscription } from '../shorts/transcription.js';
import { identifyCandidates as scoreCandidates } from '../shorts/candidates.js';
import { suggestTitles as generateTitles } from '../shorts/titles.js';
import { cleanupWorkspace as doCleanup } from '../shorts/cleanup.js';
import { classifyAudioEvents as runClassifyAudio } from '../shorts/audio-classify.js';
import { analyzeProsody as runAnalyzeProsody } from '../shorts/prosody.js';
import { confirmCandidatesWithHostedAI as runHostedScoring } from '../shorts/hosted-scoring.js';
import { computeClipBounds, processClip } from '../shorts/clip-processing.js';
import type { SubtitleConfig } from '../types.js';
import { getHostedScoringApiKey } from '../config.js';

/** Convert a video title into a filesystem-safe folder name. */
function slugifyTitle(title: string): string {
  const beforePipe = title.split('|')[0].trim();
  return beforePipe
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')  // strip special characters
    .replace(/\s+/g, '-')           // spaces to dashes
    .replace(/-+/g, '-')            // collapse consecutive dashes
    .replace(/^-|-$/g, '')          // trim leading/trailing dashes
    || 'untitled';
}

export interface ActivityDeps {
  ollamaClient: OpenAI;
  discordClient: DiscordClient;
  config: Config;
  stateStore: StateStore;
  conversationStore: ConversationStore;
  memoryStore: MemoryStore;
}

export function createActivities(deps: ActivityDeps) {
  const { ollamaClient, discordClient, config, stateStore, conversationStore, memoryStore } = deps;

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

    async chatWithConversation(
      model: string,
      systemPrompt: string,
      conversationId: string,
      userMessage: string,
    ): Promise<string> {
      const history = conversationStore.getHistory(conversationId);

      // Extract userId from conversationId (dm:{userId} or guild:{channelId})
      // For guild channels, use a generic userId since memories are per-user
      const userId = conversationId.startsWith('dm:')
        ? conversationId.slice(3)
        : conversationId;

      // Deterministic explicit-only memory save — runs before recall so the
      // freshly-saved fact shows up in this same turn's memory context.
      const explicit = extractExplicitMemory(userMessage);
      if (explicit) {
        memoryStore.addMemory(userId, 'fact', explicit.content);
      }

      const toolRegistry = getToolRegistry({ config, memoryStore, userId });
      const toolSpecs = getToolSpecs(toolRegistry);

      // Inject relevant memories into the system prompt
      let enrichedPrompt = systemPrompt;
      const relevantMemories = memoryStore.searchMemories(userId, userMessage, 5);
      const recentMemories = memoryStore.getRecentMemories(userId, 5);
      // Deduplicate by ID
      const seenIds = new Set(relevantMemories.map((m) => m.id));
      const allMemories = [
        ...relevantMemories,
        ...recentMemories.filter((m) => !seenIds.has(m.id)),
      ];
      if (allMemories.length > 0) {
        const memoryLines = allMemories
          .map((m) => `- ${m.content} (${m.category}, ${m.created_at})`)
          .join('\n');
        enrichedPrompt += `\n\n## What you remember about this user:\n${memoryLines}`;
      }

      // Build message array: system prompt + history + new user message
      const messages: import('openai/resources/chat/completions.js').ChatCompletionMessageParam[] = [
        { role: 'system', content: enrichedPrompt },
        ...history.map((m): import('openai/resources/chat/completions.js').ChatCompletionMessageParam => {
          if (m.role === 'tool' && m.tool_call_id) {
            return { role: 'tool', content: m.content, tool_call_id: m.tool_call_id };
          }
          if (m.role === 'assistant' && m.tool_calls) {
            return {
              role: 'assistant',
              content: m.content,
              tool_calls: JSON.parse(m.tool_calls),
            };
          }
          if (m.role === 'assistant') {
            return { role: 'assistant', content: m.content };
          }
          if (m.role === 'system') {
            return { role: 'system', content: m.content };
          }
          return { role: 'user', content: m.content };
        }),
        { role: 'user', content: userMessage },
      ];

      // Persist user message
      conversationStore.addMessage(conversationId, {
        role: 'user',
        content: userMessage,
      });

      // Tool-calling loop: send to LLM, execute tools if requested, repeat
      const MAX_TOOL_ITERATIONS = 5;
      let response = await chatWithHistory(ollamaClient, model, messages, toolSpecs);

      for (let i = 0; i < MAX_TOOL_ITERATIONS && response.tool_calls?.length; i++) {
        // Append assistant message with tool calls
        messages.push({
          role: 'assistant',
          content: response.content ?? '',
          tool_calls: response.tool_calls,
        });

        // Persist the assistant tool-call message
        conversationStore.addMessage(conversationId, {
          role: 'assistant',
          content: response.content ?? '',
          tool_calls: JSON.stringify(response.tool_calls),
        });

        // Execute each tool call
        for (const toolCall of response.tool_calls) {
          if (toolCall.type !== 'function') continue;
          const tool = toolRegistry.get(toolCall.function.name);
          let result: string;
          if (tool) {
            try {
              const args = JSON.parse(toolCall.function.arguments || '{}') as Record<string, unknown>;
              result = await tool.handler(args);
            } catch (err) {
              result = `Tool error: ${err instanceof Error ? err.message : 'unknown error'}`;
            }
          } else {
            result = `Unknown tool: ${toolCall.function.name}`;
          }

          messages.push({
            role: 'tool',
            content: result,
            tool_call_id: toolCall.id,
          });

          // Persist tool result
          conversationStore.addMessage(conversationId, {
            role: 'tool',
            content: result,
            tool_call_id: toolCall.id,
          });
        }

        // Send tool results back to the LLM
        response = await chatWithHistory(ollamaClient, model, messages, toolSpecs);
      }

      // Persist final assistant reply
      conversationStore.addMessage(conversationId, {
        role: 'assistant',
        content: response.content ?? '(no response)',
        tool_calls: response.tool_calls ? JSON.stringify(response.tool_calls) : null,
      });

      // Summarize if history is getting long
      await conversationStore.summarizeAndTruncate(conversationId, ollamaClient, model);

      let text = response.content ?? '(no response)';
      // Strip Qwen 3 <think>...</think> blocks
      text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

      return text;
    },

    async listMemories(userId: string): Promise<string> {
      const memories = memoryStore.getAllMemories(userId);
      if (memories.length === 0) return 'No memories stored.';
      return memories
        .map((m) => `**#${m.id}** [${m.category}] ${m.content} _(${m.created_at})_`)
        .join('\n');
    },

    async forgetMemory(userId: string, keyword: string): Promise<string> {
      // Try to parse as numeric ID first
      const id = parseInt(keyword, 10);
      if (!isNaN(id)) {
        memoryStore.deactivateMemory(id);
        return `Forgot memory #${id}.`;
      }
      // Otherwise search by keyword and deactivate matches
      const matches = memoryStore.searchMemories(userId, keyword, 5);
      if (matches.length === 0) return `No memories found matching "${keyword}".`;
      for (const m of matches) {
        memoryStore.deactivateMemory(m.id);
      }
      return `Forgot ${matches.length} memory/memories matching "${keyword}".`;
    },

    async getLastUid(accountName: string): Promise<number> {
      return stateStore.getLastUid(accountName);
    },

    async fetchEmails(
      accountName: string,
      sinceUid: number,
      limit?: number,
    ): Promise<{ emails: FetchedEmail[]; maxUid: number }> {
      const account = config.email.accounts.find((a) => a.name === accountName);
      if (!account) throw new Error(`Unknown email account: ${accountName}`);
      const password = getEmailPassword(account);
      const emails = await fetchNewEmails(account, password, sinceUid, limit);
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
      await setRgb(preset);
    },

    // ── Email Categorization activities ─────────────────────────────────────

    async fetchOldestEmails(
      accountName: string,
      folder: string,
      limit: number,
    ): Promise<FetchedEmail[]> {
      const account = config.email.accounts.find((a) => a.name === accountName);
      if (!account) throw new Error(`Unknown email account: ${accountName}`);
      const password = getEmailPassword(account);
      return fetchOldestFromFolder(account, password, folder, limit);
    },

    async categorizeWithOllama(email: FetchedEmail): Promise<CategorizeResult> {
      const catConfig = config.email.categorization;
      const model = catConfig?.model || config.models.default;
      const categories = catConfig?.categories ?? ['Alerts', 'Bills', 'Development', 'Newsletters', 'Orders', 'Other', 'Shipping', 'VIP'];
      const defaultCategory = catConfig?.default_category ?? 'Other';

      const { system, user } = buildCategorizePrompt(email);
      const raw = await chat(ollamaClient, model, system, user);
      return parseCategorizeResponse(raw, categories, defaultCategory);
    },

    async moveEmailsToFolders(
      accountName: string,
      sourceFolder: string,
      moves: Array<{ uid: number; destFolder: string }>,
    ): Promise<Array<{ uid: number; success: boolean }>> {
      const account = config.email.accounts.find((a) => a.name === accountName);
      if (!account) throw new Error(`Unknown email account: ${accountName}`);
      const password = getEmailPassword(account);
      return moveEmails(account, password, sourceFolder, moves);
    },

    async recordCategorizationResults(
      accountName: string,
      results: Array<{ uid: number; subject: string; from: string; category: string; reason: string; needsResponse: boolean }>,
    ): Promise<void> {
      for (const r of results) {
        stateStore.logCategorization({
          account: accountName,
          uid: r.uid,
          subject: r.subject,
          sender: r.from,
          category: r.category,
          reason: r.reason,
          needsResponse: r.needsResponse,
        });
      }

      // Post to #email only for emails that need a response
      const needsResponse = results.filter((r) => r.needsResponse);
      if (needsResponse.length > 0) {
        const emailChannel = getTextChannel('email');
        if (emailChannel) {
          const lines = needsResponse.map((r) =>
            `• **${r.subject}** from ${r.from} → ${r.category}\n  _${r.reason}_`
          ).join('\n');
          await emailChannel.send(`📬 **${accountName}** — ${needsResponse.length} email(s) may need a response:\n${lines}`);
        }
      }
    },

    async getCategorizationSummary(accountName: string): Promise<string> {
      const counts = stateStore.getTodaySummary(accountName);
      if (counts.length === 0) return '';
      const total = counts.reduce((sum, c) => sum + c.count, 0);
      const breakdown = counts.map((c) => `${c.count} ${c.category}`).join(', ');
      return `Categorized ${total} emails: ${breakdown}`;
    },

    // ── Shorts Phase 1 activities ──────────────────────────────────────────

    async reportProgress(message: string, channelName: string): Promise<void> {
      const channel = getTextChannel(channelName);
      if (channel) await channel.send(message);
    },

    async resolveVideo(source: string, workspaceDir: string): Promise<VideoMeta> {
      let videoPath: string;
      let title: string;

      if (source.startsWith('http')) {
        // Get title from yt-dlp metadata first (needed for workspace name)
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

        const folderName = slugifyTitle(title);
        const workspacePath = path.join(workspaceDir, folderName);
        fs.mkdirSync(workspacePath, { recursive: true });
        console.log(`[resolveVideo] workspace: ${workspacePath}`);

        videoPath = path.join(workspacePath, 'source.mp4');

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

        console.log('[resolveVideo] running ffprobe for duration');
        const { duration } = await getVideoInfo(videoPath);
        console.log(`[resolveVideo] done — title="${title}" duration=${duration.toFixed(1)}s`);
        return { title, duration, videoPath, workspacePath };
      } else {
        console.log(`[resolveVideo] local file: ${source}`);
        videoPath = source;
        const info = await getVideoInfo(videoPath);
        title = info.title;

        const folderName = slugifyTitle(title);
        const workspacePath = path.join(workspaceDir, folderName);
        fs.mkdirSync(workspacePath, { recursive: true });
        console.log(`[resolveVideo] workspace: ${workspacePath}`);

        console.log(`[resolveVideo] done — title="${title}" duration=${info.duration.toFixed(1)}s`);
        return { title, duration: info.duration, videoPath, workspacePath };
      }
    },

    async extractAndAnalyzeAudio(
      videoPath: string,
      workspacePath: string,
      peakThreshold: number,
    ): Promise<AudioPeak[]> {
      return analyzeAudio(videoPath, workspacePath, peakThreshold);
    },

    async extractAudio(
      videoPath: string,
      audioPath: string,
    ): Promise<void> {
      return extractAudioToWav(videoPath, audioPath);
    },

    async detectPeaks(
      audioPath: string,
      peakThreshold: number,
    ): Promise<AudioPeak[]> {
      return detectAudioPeaks(audioPath, peakThreshold);
    },

    async transcribeAudio(
      videoPath: string,
      workspacePath: string,
      transcriptionModel: string,
      language: string,
    ): Promise<TranscriptWord[]> {
      return runTranscription(videoPath, workspacePath, transcriptionModel, language);
    },

    async classifyAudioEvents(
      audioPath: string,
      workspacePath: string,
    ): Promise<AudioEvent[]> {
      return runClassifyAudio(audioPath, workspacePath);
    },

    async analyzeProsody(
      audioPath: string,
      workspacePath: string,
    ): Promise<ProsodyBucket[]> {
      return runAnalyzeProsody(audioPath, workspacePath);
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
      audioEvents?: AudioEvent[],
      prosody?: ProsodyBucket[],
    ): Promise<Candidate[]> {
      const model = scoringModel || config.models.default;
      return scoreCandidates(peaks, transcript, workspacePath, maxClips, ollamaClient, model, windowSize, windowOverlap, videoTitle, screeningModel, audioEvents, prosody);
    },

    async suggestTitles(
      transcript: TranscriptWord[],
      scoringModel: string,
    ): Promise<string[]> {
      const model = scoringModel || config.models.default;
      return generateTitles(transcript, ollamaClient, model);
    },

    async confirmCandidatesWithHostedAI(
      candidates: Candidate[],
      transcript: TranscriptWord[],
      videoPath: string,
      workspacePath: string,
      videoTitle: string,
      peaks: AudioPeak[],
      audioEvents?: AudioEvent[],
      prosody?: ProsodyBucket[],
    ): Promise<ConfirmedCandidate[]> {
      // Log incoming candidate timestamps for debugging NaN issues
      console.log(`[confirmCandidatesWithHostedAI] incoming candidates: ${candidates.map((c, i) => `${i}:ts=${c.timestamp}`).join(', ')}`);

      const shortsConfig = config.shorts;
      if (!shortsConfig?.hosted_scoring?.enabled) {
        // Return all candidates as confirmed with default crop
        return candidates.map(c => ({
          ...c,
          confirmed: true,
          actionPosition: 'center' as const,
          cropOffset: 0.5,
        }));
      }

      const apiKey = getHostedScoringApiKey(shortsConfig);
      const results = await runHostedScoring({
        candidates,
        transcript,
        videoPath,
        workspacePath,
        videoTitle,
        peaks,
        audioEvents,
        prosody,
        config: shortsConfig.hosted_scoring,
        apiKey,
      });

      // Log outgoing timestamps to trace NaN propagation
      console.log(`[confirmCandidatesWithHostedAI] results: ${results.map((c, i) => `${i}:ts=${c.timestamp},confirmed=${c.confirmed}`).join(', ')}`);

      return results;
    },

    async notifyDiscord(
      videoMeta: VideoMeta,
      titles: string[],
      candidates: ConfirmedCandidate[],
      channelName: string,
    ): Promise<void> {
      const channel = getTextChannel(channelName);
      if (!channel) return;

      // Filter to confirmed candidates only (if hosted scoring ran)
      const confirmed = candidates.filter(c => c.confirmed);

      const titleLines = titles.map((t, i) => `${i + 1}. ${t}`).join('\n');
      const candidateLines = confirmed
        .map((c, i) => {
          const cat = c.category ? ` [${c.category}]` : '';
          const scoreDisplay = c.hostedScore != null
            ? `(local: ${c.score.toFixed(1)}, hosted: ${c.hostedScore.toFixed(1)})`
            : `(score: ${c.score.toFixed(1)})`;
          const cropInfo = c.actionPosition ? ` | action: ${c.actionPosition}` : '';
          const reasoning = c.hostedReasoning ? `\n   > ${c.hostedReasoning}` : '';
          return `${i + 1}. 🎬 \`${formatTimestamp(c.timestamp)}\` — "${c.quote}" ${scoreDisplay}${cat}${cropInfo}${reasoning}`;
        })
        .join('\n');

      const filteredNote = confirmed.length < candidates.length
        ? `\n_${candidates.length - confirmed.length} candidate(s) filtered out by hosted AI_`
        : '';

      const msg =
        `✅ Analysis complete for: **${videoMeta.title}**\n\n` +
        `**Suggested Episode Titles:**\n${titleLines}\n\n` +
        `**Shorts Candidates (${confirmed.length}):**\n${candidateLines}${filteredNote}`;

      await channel.send(msg);

      const srtPath = path.join(videoMeta.workspacePath, 'transcript.srt');
      if (fs.existsSync(srtPath)) {
        await channel.send({ files: [{ attachment: srtPath, name: 'transcript.srt' }] });
      }
    },

    async cleanupWorkspace(workspacePath: string): Promise<void> {
      return doCleanup(workspacePath);
    },

    // ── Shorts Phase 2 activities (editing) ──────────────────────────────────

    async saveCheckpoint(
      videoMeta: VideoMeta,
      transcript: TranscriptWord[],
      confirmedCandidates: ConfirmedCandidate[],
      titles: string[],
    ): Promise<void> {
      const checkpoint: ShortsCheckpoint = {
        version: 1,
        createdAt: new Date().toISOString(),
        videoMeta,
        transcript,
        confirmedCandidates,
        titles,
        shortsConfig: config.shorts!,
      };
      const checkpointPath = path.join(videoMeta.workspacePath, 'checkpoint.json');
      fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2), 'utf8');
      console.log(`[saveCheckpoint] Written to ${checkpointPath}`);
    },

    async loadCheckpoint(workspacePath: string): Promise<ShortsCheckpoint> {
      const checkpointPath = workspacePath.endsWith('checkpoint.json')
        ? workspacePath
        : path.join(workspacePath, 'checkpoint.json');
      const raw = fs.readFileSync(checkpointPath, 'utf8');
      return JSON.parse(raw) as ShortsCheckpoint;
    },

    async generateAndProcessClip(
      videoPath: string,
      workspacePath: string,
      candidate: ConfirmedCandidate,
      candidateIndex: number,
      transcript: TranscriptWord[],
      subtitleConfig: SubtitleConfig | undefined,
      videoDuration: number,
      windowSize: number,
      minDuration: number,
      maxDuration: number,
    ): Promise<ClipResult> {
      // Validate numeric inputs — Temporal JSON serialization can silently
      // turn undefined/NaN values into null, which becomes NaN in arithmetic
      const ts = candidate.timestamp;
      if (ts == null || Number.isNaN(ts)) {
        throw new Error(
          `[generateAndProcessClip] candidate ${candidateIndex} has invalid timestamp: ${ts} ` +
          `(candidate keys: ${Object.keys(candidate).join(', ')}, ` +
          `candidate: ${JSON.stringify(candidate).slice(0, 300)})`,
        );
      }
      if (!Number.isFinite(videoDuration)) {
        throw new Error(
          `[generateAndProcessClip] invalid videoDuration: ${videoDuration}`,
        );
      }
      if (!Number.isFinite(windowSize)) {
        throw new Error(
          `[generateAndProcessClip] invalid windowSize: ${windowSize}`,
        );
      }

      const { start, end } = computeClipBounds(
        ts,
        windowSize,
        minDuration,
        maxDuration,
        videoDuration,
        transcript,
      );
      return processClip({
        videoPath,
        workspacePath,
        candidate,
        candidateIndex,
        clipStart: start,
        clipEnd: end,
        transcript,
        subtitleConfig,
      });
    },

    async notifyDiscordWithClips(
      videoMeta: VideoMeta,
      titles: string[],
      candidates: ConfirmedCandidate[],
      clipResults: ClipResult[],
      channelName: string,
    ): Promise<void> {
      const channel = getTextChannel(channelName);
      if (!channel) return;

      const confirmed = candidates.filter(c => c.confirmed);

      const titleLines = titles.map((t, i) => `${i + 1}. ${t}`).join('\n');

      const filteredNote = confirmed.length < candidates.length
        ? `_${candidates.length - confirmed.length} candidate(s) filtered out by hosted AI_`
        : '';

      const sections: string[] = [
        `✅ Shorts ready for: **${videoMeta.title}**\n\n**Suggested Episode Titles:**\n${titleLines}\n\n**Processed Clips (${clipResults.length}):**`,
        ...confirmed.map((c, i) => {
          const cat = c.category ? ` [${c.category}]` : '';
          const scoreDisplay = c.hostedScore != null
            ? `(local: ${c.score.toFixed(1)}, hosted: ${c.hostedScore.toFixed(1)})`
            : `(score: ${c.score.toFixed(1)})`;
          const cropInfo = c.actionPosition ? ` | action: ${c.actionPosition}` : '';
          const clip = clipResults.find(r => r.candidateIndex === i);
          const clipInfo = clip
            ? ` | ${clip.duration.toFixed(0)}s (${formatTimestamp(clip.startTime)}→${formatTimestamp(clip.endTime)})`
            : '';
          const reasoning = c.hostedReasoning ? `\n   > ${c.hostedReasoning}` : '';
          return `${i + 1}. 🎬 \`${formatTimestamp(c.timestamp)}\` — "${c.quote}" ${scoreDisplay}${cat}${cropInfo}${clipInfo}${reasoning}`;
        }),
        ...(filteredNote ? [filteredNote] : []),
      ];

      const messages = splitDiscordMessages(sections);
      for (const msg of messages) {
        await channel.send(msg);
      }

      // Upload clips to Discord (if under 25MB) or post NAS path
      const MAX_DISCORD_SIZE = 25 * 1024 * 1024;
      for (const clip of clipResults) {
        if (!fs.existsSync(clip.outputPath)) continue;
        const stats = fs.statSync(clip.outputPath);
        if (stats.size <= MAX_DISCORD_SIZE) {
          await channel.send({
            files: [{
              attachment: clip.outputPath,
              name: `clip_${clip.candidateIndex + 1}.mp4`,
            }],
          });
        } else {
          await channel.send(`📁 Clip ${clip.candidateIndex + 1} too large for Discord (${(stats.size / 1024 / 1024).toFixed(1)}MB): \`${clip.outputPath}\``);
        }
      }

      // Post workspace name for easy re-editing
      const workspaceName = path.basename(videoMeta.workspacePath);
      await channel.send(`💾 Workspace: \`${workspaceName}\`\nRe-edit with: \`!shorts-edit ${workspaceName}\``);
    },
  };
}

function splitDiscordMessages(sections: string[], limit = 2000): string[] {
  const messages: string[] = [];
  let current = '';
  for (const section of sections) {
    const addition = current ? '\n' + section : section;
    if (current && (current + addition).length > limit) {
      messages.push(current);
      current = section.length > limit ? section.slice(0, limit - 3) + '...' : section;
    } else {
      current = current ? current + addition : section;
    }
  }
  if (current) messages.push(current);
  return messages;
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
