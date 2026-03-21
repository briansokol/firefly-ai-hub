export interface VideoMeta {
  title: string;
  duration: number;
  videoPath: string;
  workspacePath: string;
}

export interface AudioPeak {
  timestamp: number;
  rms: number;
}

export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
}

export type ClipCategory = 'humor' | 'action' | 'dramatic' | 'story';

export interface Candidate {
  timestamp: number;
  quote: string;
  score: number;
  reasoning?: string;
  category?: ClipCategory;
}

export type ActionPosition = 'left' | 'center-left' | 'center' | 'center-right' | 'right';

export interface ConfirmedCandidate extends Candidate {
  hostedScore?: number;
  hostedReasoning?: string;
  confirmed: boolean;
  actionPosition?: ActionPosition;
  facecamPosition?: string | null;
  cropOffset?: number;
}

export interface FeatureVector {
  speechRate: number;      // words per second
  volumeDelta: number;     // current LUFS minus 10s rolling average
  silenceToLoud: boolean;  // gap >1.5s followed by loudness spike
  speechDensity: number;   // words per second in a tight window (rapid speech)
  laughConfidence: number; // 0-1, from YAMNet audio classification
  reactionType?: string;   // e.g. 'laughter', 'cheering', 'screaming'
  pitchRise: number;       // Hz above speaker baseline (excitement marker)
  energy: number;          // RMS energy relative to file mean (>1 = louder)
}

/** A single audio event detected by YAMNet. */
export interface AudioEvent {
  timestamp: number;
  event: string;         // normalized category: 'laughter', 'cheering', 'screaming', 'reaction'
  class: string;         // raw YAMNet class name
  confidence: number;    // 0-1
}

/** Per-second prosody data from parselmouth pitch analysis. */
export interface ProsodyBucket {
  timestamp: number;
  mean_pitch: number;      // Hz (0 if no voicing)
  pitch_variance: number;  // variance of F0 within bucket
  pitch_rise: number;      // max pitch minus speaker baseline
  energy: number;          // RMS energy relative to file mean
}

export interface ClipResult {
  candidateIndex: number;
  timestamp: number;
  startTime: number;
  endTime: number;
  outputPath: string;
  subtitlePath: string;
  duration: number;
}

export interface ShortsCheckpoint {
  version: 1;
  createdAt: string;
  videoMeta: VideoMeta;
  transcript: TranscriptWord[];
  confirmedCandidates: ConfirmedCandidate[];
  titles: string[];
  shortsConfig: import('../types.js').ShortsConfig;
}

/** Summary of audio features for a time window, for injection into LLM prompts. */
export interface AudioFeatureSummary {
  avgSpeechRate: number;
  peakSpeechRate: number;
  avgVolumeDelta: number;
  peakVolumeDelta: number;
  hasSilenceToLoud: boolean;
  avgSpeechDensity: number;
  peakLaughConfidence: number;
  dominantReaction?: string;
  avgPitchRise: number;
  peakPitchRise: number;
  avgEnergy: number;
}
