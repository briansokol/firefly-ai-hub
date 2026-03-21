import fs from 'node:fs';
import type { TranscriptWord } from './types.js';
import type { SubtitleConfig } from '../types.js';

const DEFAULTS: Required<SubtitleConfig> = {
  font: 'Impact',
  font_size: 72,
  primary_color: '&H00FFFFFF',
  outline_color: '&H00000000',
  outline_width: 4,
  alignment: 2,
  margin_v: 650,
  uppercase: true,
};

export function resolveSubtitleConfig(config?: SubtitleConfig): Required<SubtitleConfig> {
  return { ...DEFAULTS, ...config };
}

interface Phrase {
  text: string;
  start: number; // clip-relative seconds
  end: number;
}

/**
 * Group transcript words into short display phrases.
 * Breaks on speech pauses (>300ms gap) or at 4 words, minimum 2 words per phrase.
 */
function groupIntoPhrases(words: { word: string; start: number; end: number }[]): Phrase[] {
  if (words.length === 0) return [];

  const phrases: Phrase[] = [];
  let current: typeof words = [words[0]];

  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end;
    const atWordLimit = current.length >= 4;
    const hasPause = gap > 0.3;

    if ((hasPause && current.length >= 2) || atWordLimit) {
      phrases.push({
        text: current.map(w => w.word).join(' '),
        start: current[0].start,
        end: current[current.length - 1].end,
      });
      current = [words[i]];
    } else {
      current.push(words[i]);
    }
  }

  // Flush remaining words
  if (current.length > 0) {
    // If only 1 word left, merge with previous phrase if possible
    if (current.length === 1 && phrases.length > 0) {
      const prev = phrases[phrases.length - 1];
      prev.text += ' ' + current[0].word;
      prev.end = current[0].end;
    } else {
      phrases.push({
        text: current.map(w => w.word).join(' '),
        start: current[0].start,
        end: current[current.length - 1].end,
      });
    }
  }

  return phrases;
}

/** Escape characters that are special in ASS dialogue text. */
function escapeAss(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}

/** Format seconds as ASS timestamp: H:MM:SS.CC */
function formatAssTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const wholeSec = Math.floor(s);
  const centisec = Math.round((s - wholeSec) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(wholeSec).padStart(2, '0')}.${String(centisec).padStart(2, '0')}`;
}

/**
 * Generate ASS subtitle content for a clip.
 * Words are filtered to the clip range and timestamps adjusted to be clip-relative.
 */
export function generateSubtitleContent(
  words: TranscriptWord[],
  clipStart: number,
  clipEnd: number,
  config?: SubtitleConfig,
): string {
  const resolved = resolveSubtitleConfig(config);

  // Filter words that overlap the clip range and adjust to clip-relative timestamps
  const clipWords = words
    .filter(w => w.end > clipStart && w.start < clipEnd)
    .map(w => ({
      word: w.word,
      start: Math.max(0, w.start - clipStart),
      end: Math.min(clipEnd - clipStart, w.end - clipStart),
    }));

  const phrases = groupIntoPhrases(clipWords);

  // ASS header
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${resolved.font},${resolved.font_size},${resolved.primary_color},&H000000FF,${resolved.outline_color},&H80000000,-1,0,0,0,100,100,0,0,1,${resolved.outline_width},0,${resolved.alignment},10,10,${resolved.margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  // Dialogue lines
  const dialogueLines = phrases.map(p => {
    const text = resolved.uppercase ? p.text.toUpperCase() : p.text;
    return `Dialogue: 0,${formatAssTime(p.start)},${formatAssTime(p.end)},Default,,0,0,0,,${escapeAss(text)}`;
  });

  return header + '\n' + dialogueLines.join('\n') + '\n';
}

export function writeSubtitleFile(assContent: string, outputPath: string): void {
  fs.writeFileSync(outputPath, assContent, 'utf8');
}
