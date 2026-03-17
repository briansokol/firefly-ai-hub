import { proxyActivities } from '@temporalio/workflow';
import type { Activities } from '../temporal/activities.js';
import type { ShortsConfig } from '../types.js';

// Heavy activities — download and transcription can take 60+ minutes
const { resolveVideo, transcribeAudio, extractAndAnalyzeAudio } =
  proxyActivities<Activities>({
    startToCloseTimeout: '60 minutes',
    retry: { maximumAttempts: 2, initialInterval: '5s', backoffCoefficient: 2 },
  });

// Medium activities — Ollama scoring, bounded by model response time
const { identifyCandidates, suggestTitles } = proxyActivities<Activities>({
  startToCloseTimeout: '20 minutes',
  retry: { maximumAttempts: 2, initialInterval: '2s', backoffCoefficient: 2 },
});

// Fast activities — Discord posts and cleanup
const { reportProgress, notifyDiscord, cleanupWorkspace } =
  proxyActivities<Activities>({
    startToCloseTimeout: '2 minutes',
    retry: { maximumAttempts: 2, initialInterval: '1s', backoffCoefficient: 2 },
  });

export async function shortsAnalysisWorkflow(
  source: string,
  shortsConfig: ShortsConfig,
): Promise<void> {
  const channel = shortsConfig.output_channel;

  await reportProgress('⏳ Downloading video...', channel);
  const videoMeta = await resolveVideo(source, shortsConfig.workspace_dir);

  await reportProgress(
    '⏳ Transcribing and analyzing audio (this may take a while)...',
    channel,
  );
  const [peaks, transcript] = await Promise.all([
    extractAndAnalyzeAudio(
      videoMeta.videoPath,
      videoMeta.workspacePath,
      shortsConfig.peak_threshold,
    ),
    transcribeAudio(
      videoMeta.videoPath,
      videoMeta.workspacePath,
      shortsConfig.transcription.model,
      shortsConfig.transcription.language,
    ),
  ]);

  await reportProgress('⏳ Scoring candidate moments and generating titles...', channel);
  const [candidates, titles] = await Promise.all([
    identifyCandidates(
      peaks,
      transcript,
      videoMeta.workspacePath,
      shortsConfig.max_clips,
      shortsConfig.scoring_model,
      shortsConfig.window_size,
      shortsConfig.window_overlap,
    ),
    suggestTitles(transcript, shortsConfig.scoring_model),
  ]);

  await notifyDiscord(videoMeta, titles, candidates, channel);
  await cleanupWorkspace(videoMeta.workspacePath);
}
