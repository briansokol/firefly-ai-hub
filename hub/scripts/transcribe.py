#!/usr/bin/env python3
"""faster-whisper CLI wrapper — outputs word-level transcript JSON to a file."""
import argparse
import json
import sys


def _srt_time(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f'{h:02d}:{m:02d}:{s:02d},{ms:03d}'


def main() -> None:
    parser = argparse.ArgumentParser(description='Transcribe audio with faster-whisper')
    parser.add_argument('--input', required=True, help='Path to input audio/video file')
    parser.add_argument('--model', default='large-v3', help='Whisper model name')
    parser.add_argument('--language', default='en', help='Language code')
    parser.add_argument('--output', required=True, help='Path to write transcript JSON')
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel  # type: ignore[import]
    except ImportError:
        print('ERROR: faster-whisper is not installed. Run: pip install faster-whisper', file=sys.stderr)
        sys.exit(1)

    print(f'Loading model: {args.model}', file=sys.stderr)
    model = WhisperModel(args.model, device='auto', compute_type='auto')

    print(f'Transcribing: {args.input}', file=sys.stderr)
    segments_gen, info = model.transcribe(
        args.input,
        language=args.language,
        word_timestamps=True,
    )
    print(f'Detected language: {info.language} (probability: {info.language_probability:.2f})', file=sys.stderr)

    # Collect into a list so we can iterate twice (words + SRT)
    segments = list(segments_gen)

    words = []
    for segment in segments:
        if segment.words:
            for word in segment.words:
                words.append({
                    'word': word.word,
                    'start': round(word.start, 3),
                    'end': round(word.end, 3),
                })

    with open(args.output, 'w') as f:
        json.dump(words, f, indent=2)

    srt_path = args.output.rsplit('.', 1)[0] + '.srt'
    with open(srt_path, 'w') as f:
        for i, segment in enumerate(segments, 1):
            text = segment.text.strip()
            if not text:
                continue
            f.write(f'{i}\n')
            f.write(f'{_srt_time(segment.start)} --> {_srt_time(segment.end)}\n')
            f.write(f'{text}\n\n')

    print(f'Transcribed {len(words)} words → {args.output}', file=sys.stderr)
    print(f'SRT written → {srt_path}', file=sys.stderr)


if __name__ == '__main__':
    main()
