#!/usr/bin/env python3
"""Extract speech prosody features (pitch contours) using parselmouth (Praat wrapper)."""
import argparse
import json
import sys

import numpy as np


def analyze_prosody(audio_path: str, bucket_size: float = 1.0) -> list[dict]:
    """Analyze pitch and energy per time bucket.

    Returns per-second metrics:
      - mean_pitch: average F0 in Hz (0 if no voicing detected)
      - pitch_variance: variance of F0 within the bucket
      - pitch_rise: max pitch minus speaker baseline (positive = excitement)
      - energy: RMS energy relative to file-wide mean (>1 = louder than average)
    """
    try:
        import parselmouth  # type: ignore[import]
        from parselmouth.praat import call  # type: ignore[import]
    except ImportError:
        print(
            'ERROR: parselmouth is not installed.\n'
            'Run: pip install parselmouth',
            file=sys.stderr,
        )
        sys.exit(1)

    print(f'Loading audio: {audio_path}', file=sys.stderr)
    sound = parselmouth.Sound(audio_path)
    duration = sound.get_total_duration()
    print(f'Duration: {duration:.1f}s', file=sys.stderr)

    # Extract pitch contour (F0)
    print('Extracting pitch contour...', file=sys.stderr)
    pitch = call(sound, 'To Pitch', 0.0, 75.0, 600.0)  # time_step=auto, floor=75Hz, ceiling=600Hz

    # Extract intensity (energy)
    print('Extracting intensity...', file=sys.stderr)
    intensity = call(sound, 'To Intensity', 100.0, 0.0)  # min_pitch=100Hz, time_step=auto

    # Compute speaker baseline pitch (median of voiced frames)
    all_pitches: list[float] = []
    t = 0.0
    while t < duration:
        f0 = call(pitch, 'Get value at time', t, 'Hertz', 'Linear')
        if f0 is not None and not np.isnan(f0) and f0 > 0:
            all_pitches.append(float(f0))
        t += 0.01  # 10ms steps for baseline calculation

    baseline_pitch = float(np.median(all_pitches)) if all_pitches else 0.0

    # Compute file-wide mean intensity for normalization
    mean_intensity = call(intensity, 'Get mean', 0.0, 0.0, 'energy')
    if mean_intensity is None or np.isnan(mean_intensity) or mean_intensity <= 0:
        mean_intensity = 1.0

    print(f'Baseline pitch: {baseline_pitch:.1f} Hz, mean intensity: {mean_intensity:.1f} dB', file=sys.stderr)

    # Compute per-bucket metrics
    results: list[dict] = []
    n_buckets = int(np.ceil(duration / bucket_size))

    for i in range(n_buckets):
        bucket_start = i * bucket_size
        bucket_end = min((i + 1) * bucket_size, duration)

        # Collect pitch values within this bucket
        bucket_pitches: list[float] = []
        t = bucket_start
        while t < bucket_end:
            f0 = call(pitch, 'Get value at time', t, 'Hertz', 'Linear')
            if f0 is not None and not np.isnan(f0) and f0 > 0:
                bucket_pitches.append(float(f0))
            t += 0.01

        # Compute pitch metrics
        if bucket_pitches:
            mean_f0 = float(np.mean(bucket_pitches))
            pitch_var = float(np.var(bucket_pitches))
            max_f0 = float(np.max(bucket_pitches))
            pitch_rise = max_f0 - baseline_pitch if baseline_pitch > 0 else 0.0
        else:
            mean_f0 = 0.0
            pitch_var = 0.0
            pitch_rise = 0.0

        # Compute energy for this bucket
        bucket_intensity = call(intensity, 'Get mean', bucket_start, bucket_end, 'energy')
        if bucket_intensity is None or np.isnan(bucket_intensity):
            bucket_intensity = 0.0
        energy_ratio = float(bucket_intensity) / mean_intensity if mean_intensity > 0 else 0.0

        results.append({
            'timestamp': round(bucket_start, 2),
            'mean_pitch': round(mean_f0, 1),
            'pitch_variance': round(pitch_var, 1),
            'pitch_rise': round(pitch_rise, 1),
            'energy': round(energy_ratio, 3),
        })

    print(f'Analyzed {len(results)} time buckets', file=sys.stderr)
    return results


def main() -> None:
    parser = argparse.ArgumentParser(description='Extract speech prosody features')
    parser.add_argument('--input', required=True, help='Path to input WAV file')
    parser.add_argument('--output', required=True, help='Path to write prosody JSON')
    parser.add_argument(
        '--bucket-size',
        type=float,
        default=1.0,
        help='Time bucket size in seconds (default: 1.0)',
    )
    args = parser.parse_args()

    results = analyze_prosody(args.input, args.bucket_size)

    with open(args.output, 'w') as f:
        json.dump(results, f, indent=2)

    print(f'Prosody data written to {args.output}', file=sys.stderr)


if __name__ == '__main__':
    main()
