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

export interface FeatureVector {
  speechRate: number;      // words per second
  volumeDelta: number;     // current LUFS minus 10s rolling average
  silenceToLoud: boolean;  // gap >1.5s followed by loudness spike
  speechDensity: number;   // words per second in a tight window (rapid speech)
}

/** Summary of audio features for a time window, for injection into LLM prompts. */
export interface AudioFeatureSummary {
  avgSpeechRate: number;
  peakSpeechRate: number;
  avgVolumeDelta: number;
  peakVolumeDelta: number;
  hasSilenceToLoud: boolean;
  avgSpeechDensity: number;
}
