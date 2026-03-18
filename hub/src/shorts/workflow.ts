import { proxyActivities } from '@temporalio/workflow';
import type { Activities } from '../temporal/activities.js';
import type { ShortsConfig } from '../types.js';

// Heavy activities — download and transcription can take 60+ minutes
const { resolveVideo, transcribeAudio, extractAudio } =
  proxyActivities<Activities>({
    startToCloseTimeout: '60 minutes',
    retry: { maximumAttempts: 2, initialInterval: '5s', backoffCoefficient: 2 },
  });

// Medium activities — analysis steps that depend on audio.wav existing
const {
  detectPeaks, classifyAudioEvents, analyzeProsody,
  identifyCandidates, suggestTitles,
} = proxyActivities<Activities>({
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

  // Step 1: Extract audio (must complete before analysis steps can start)
  await reportProgress(
    '⏳ Extracting audio and starting transcription...',
    channel,
  );
  const audioPath = `${videoMeta.workspacePath}/audio.wav`;
  // Transcription reads the video directly, so it can run in parallel with extraction
  const [, transcript] = await Promise.all([
    extractAudio(videoMeta.videoPath, audioPath),
    transcribeAudio(
      videoMeta.videoPath,
      videoMeta.workspacePath,
      shortsConfig.transcription.model,
      shortsConfig.transcription.language,
    ),
  ]);

  // Step 2: Now audio.wav exists — run all analysis in parallel
  await reportProgress(
    '⏳ Analyzing audio features (peaks, events, prosody)...',
    channel,
  );
  const [peaks, audioEvents, prosody] = await Promise.all([
    detectPeaks(audioPath, shortsConfig.peak_threshold),
    classifyAudioEvents(audioPath, videoMeta.workspacePath),
    analyzeProsody(audioPath, videoMeta.workspacePath),
  ]);

  // Step 3: Score candidates using all signals
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
      videoMeta.title,
      shortsConfig.screening_model,
      audioEvents,
      prosody,
    ),
    suggestTitles(transcript, shortsConfig.scoring_model),
  ]);

  await notifyDiscord(videoMeta, titles, candidates, channel);
  await cleanupWorkspace(videoMeta.workspacePath);
}
