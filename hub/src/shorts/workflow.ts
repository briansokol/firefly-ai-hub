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

// Hosted AI scoring — video uploads + API calls can be slow
const { confirmCandidatesWithHostedAI } = proxyActivities<Activities>({
  startToCloseTimeout: '30 minutes',
  retry: { maximumAttempts: 3, initialInterval: '5s', backoffCoefficient: 2 },
});

// Clip processing — FFmpeg encoding per clip
const { generateAndProcessClip, saveCheckpoint, loadCheckpoint } =
  proxyActivities<Activities>({
    startToCloseTimeout: '15 minutes',
    retry: { maximumAttempts: 2, initialInterval: '5s', backoffCoefficient: 2 },
  });

// Fast activities — Discord posts and cleanup
const { reportProgress, notifyDiscordWithClips, cleanupWorkspace } =
  proxyActivities<Activities>({
    startToCloseTimeout: '5 minutes',
    retry: { maximumAttempts: 2, initialInterval: '1s', backoffCoefficient: 2 },
  });

export async function shortsAnalysisWorkflow(
  source: string,
  shortsConfig: ShortsConfig,
): Promise<void> {
  const channel = shortsConfig.output_channel;

  await reportProgress('⏳ Downloading video...', channel);
  const videoMeta = await resolveVideo(source, shortsConfig.workspace_dir);

  // Report workspace name so user can reference it for !shorts-edit later
  const workspaceName = videoMeta.workspacePath.split('/').pop() ?? videoMeta.workspacePath;
  await reportProgress(`📂 Workspace: \`${workspaceName}\``, channel);

  // Step 1: Extract audio (must complete before analysis steps can start)
  await reportProgress(
    '⏳ Extracting audio and starting transcription...',
    channel,
  );
  const audioPath = `${videoMeta.workspacePath}/audio.wav`;
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

  // Step 4: Confirm candidates with hosted AI (re-score + visual confirmation + crop)
  await reportProgress('⏳ Confirming candidates with hosted AI...', channel);
  const confirmedCandidates = await confirmCandidatesWithHostedAI(
    candidates,
    transcript,
    videoMeta.videoPath,
    videoMeta.workspacePath,
    videoMeta.title,
    peaks,
    audioEvents,
    prosody,
  );

  // Step 5: Save checkpoint for re-editing
  const confirmed = confirmedCandidates.filter(c => c.confirmed);
  await saveCheckpoint(videoMeta, transcript, confirmed, titles);

  // Step 6: Process clips (parallel fan-out)
  await reportProgress(`⏳ Processing ${confirmed.length} clips...`, channel);
  const windowSize = shortsConfig.window_size ?? 30;
  const minDuration = shortsConfig.min_clip_duration ?? 15;
  const maxDuration = shortsConfig.max_clip_duration ?? 58;

  const clipResults = await Promise.all(
    confirmed.map((candidate, i) =>
      generateAndProcessClip(
        videoMeta.videoPath,
        videoMeta.workspacePath,
        candidate,
        i,
        transcript,
        shortsConfig.subtitles,
        videoMeta.duration,
        windowSize,
        minDuration,
        maxDuration,
      ),
    ),
  );

  // Step 7: Notify Discord with clips
  await notifyDiscordWithClips(videoMeta, titles, confirmedCandidates, clipResults, channel);

  // Step 8: Clean up intermediates (keep source video + clips on NAS)
  await cleanupWorkspace(videoMeta.workspacePath);
}

/**
 * Resume from a checkpoint to re-process clips without re-running detection.
 * Use via: !shorts-edit <workspace-path>
 */
export async function shortsEditWorkflow(
  workspacePath: string,
): Promise<void> {
  const checkpoint = await loadCheckpoint(workspacePath);
  const { videoMeta, transcript, confirmedCandidates, titles, shortsConfig } = checkpoint;
  const channel = shortsConfig.output_channel;

  await reportProgress(`⏳ Re-processing ${confirmedCandidates.length} clips from checkpoint...`, channel);

  const windowSize = shortsConfig.window_size ?? 30;
  const minDuration = shortsConfig.min_clip_duration ?? 15;
  const maxDuration = shortsConfig.max_clip_duration ?? 58;

  const clipResults = await Promise.all(
    confirmedCandidates.map((candidate, i) =>
      generateAndProcessClip(
        videoMeta.videoPath,
        videoMeta.workspacePath,
        candidate,
        i,
        transcript,
        shortsConfig.subtitles,
        videoMeta.duration,
        windowSize,
        minDuration,
        maxDuration,
      ),
    ),
  );

  // Re-save checkpoint with current config (captures any subtitle setting changes)
  await saveCheckpoint(videoMeta, transcript, confirmedCandidates, titles);

  await notifyDiscordWithClips(videoMeta, titles, confirmedCandidates, clipResults, channel);
  await cleanupWorkspace(videoMeta.workspacePath);
}
