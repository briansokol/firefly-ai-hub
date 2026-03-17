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

export interface EmailConfig {
  accounts: EmailAccount[];
}

export interface ShortsConfig {
  workspace_dir: string;
  max_clips: number;
  peak_threshold: number;
  output_channel: string;
  scoring_model: string;
  window_size: number;
  window_overlap: number;
  transcription: {
    model: string;
    language: string;
  };
}

export interface Config {
  discord: DiscordConfig;
  models: ModelsConfig;
  schedule: ScheduleConfig;
  email: EmailConfig;
  shorts?: ShortsConfig;
}
