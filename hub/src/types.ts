export interface DiscordConfig {
  token_env: string;
  allowed_user_ids: string[];
  guild_id: string;
}

export interface ModelsConfig {
  default: string;
  coding: string;
  complex: string;
  ollama_base_url: string;
}

export interface ScheduleConfig {
  timezone: string;
  email_triage_cron: string;
  daily_summary_cron: string;
}

export interface EmailAccount {
  name: string;
  host: string;
  port: number;
  username: string;
  password_env: string;
  ssl: boolean;
  folders: string[];
}

export interface EmailCategorizationConfig {
  enabled: boolean;
  source_folder: string;
  categories: string[];
  default_category: string;
  batch_size: number;
  model?: string;
}

export interface EmailConfig {
  accounts: EmailAccount[];
  categorization?: EmailCategorizationConfig;
}

export interface HostedScoringConfig {
  enabled: boolean;
  provider: 'google' | 'anthropic';
  model: string;
  api_key_env: string;
  max_candidates?: number;
  confirm_clips?: boolean;
}

export interface SubtitleConfig {
  font?: string;           // default "Impact"
  font_size?: number;      // default 72
  primary_color?: string;  // default "&H00FFFFFF" (white)
  outline_color?: string;  // default "&H00000000" (black)
  outline_width?: number;  // default 4
  alignment?: number;      // default 2 (bottom-center)
  margin_v?: number;       // default 80
  uppercase?: boolean;     // default true
}

export interface ShortsConfig {
  workspace_dir: string;
  max_clips: number;
  peak_threshold: number;
  output_channel: string;
  scoring_model: string;
  screening_model?: string;
  window_size: number;
  window_overlap: number;
  min_clip_duration?: number;  // default 15
  max_clip_duration?: number;  // default 58
  transcription: {
    model: string;
    language: string;
  };
  hosted_scoring?: HostedScoringConfig;
  subtitles?: SubtitleConfig;
}

export interface WebSearchConfig {
  provider: 'brave';
  api_key_env: string;
}

export interface WeatherConfig {
  default_location?: string;
}

export interface FetchUrlConfig {
  max_body_bytes?: number;   // default 2MB
  max_text_chars?: number;   // default 15000
  timeout_ms?: number;       // default 15000
  max_redirects?: number;    // default 5
}

export interface ToolsConfig {
  web_search?: WebSearchConfig;
  weather?: WeatherConfig;
  fetch_url?: FetchUrlConfig;
}

export interface Config {
  discord: DiscordConfig;
  models: ModelsConfig;
  schedule: ScheduleConfig;
  email: EmailConfig;
  shorts?: ShortsConfig;
  tools?: ToolsConfig;
}
