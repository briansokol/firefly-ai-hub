#!/usr/bin/env python3
"""Classify audio events using YAMNet (TFLite) — detects laughter, cheering, screaming, etc."""
import argparse
import json
import os
import sys
import urllib.request

import numpy as np

# YAMNet processes audio in 960ms frames at 16kHz
YAMNET_SAMPLE_RATE = 16000
YAMNET_FRAME_SAMPLES = 15360  # 960ms at 16kHz

# TFLite model URL (from TF Hub, converted to TFLite format)
MODEL_URL = 'https://tfhub.dev/google/lite-model/yamnet/classification/tflite/1?lite-format=tflite'
MODEL_DIR = os.path.join(os.path.dirname(__file__), '.models')
MODEL_PATH = os.path.join(MODEL_DIR, 'yamnet.tflite')

# AudioSet class IDs for reaction-relevant sounds
# See: https://github.com/tensorflow/models/blob/master/research/audioset/yamnet/yamnet_class_map.csv
RELEVANT_CLASSES = {
    'Laughter': 'laughter',
    'Giggle': 'laughter',
    'Baby laughter': 'laughter',
    'Chuckle, chortle': 'laughter',
    'Cheering': 'cheering',
    'Crowd': 'cheering',
    'Applause': 'cheering',
    'Shout': 'shouting',
    'Yell': 'shouting',
    'Screaming': 'screaming',
    'Scream': 'screaming',
    'Gasp': 'reaction',
    'Sigh': 'reaction',
    'Groan': 'reaction',
    'Whoop': 'reaction',
    'Exclamation': 'reaction',
    'Excitement': 'reaction',
}

DEFAULT_CONFIDENCE_THRESHOLD = 0.35


def download_model() -> str:
    """Download YAMNet TFLite model if not already cached."""
    if os.path.exists(MODEL_PATH):
        return MODEL_PATH

    os.makedirs(MODEL_DIR, exist_ok=True)
    print(f'Downloading YAMNet TFLite model to {MODEL_PATH}...', file=sys.stderr)
    urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)
    print('Download complete.', file=sys.stderr)
    return MODEL_PATH


def load_class_names() -> list[str]:
    """Load YAMNet class names from the CSV bundled with the model."""
    # YAMNet class map — 521 classes in AudioSet order
    # We embed the relevant ones directly rather than requiring a separate CSV
    csv_url = 'https://raw.githubusercontent.com/tensorflow/models/master/research/audioset/yamnet/yamnet_class_map.csv'
    csv_path = os.path.join(MODEL_DIR, 'yamnet_class_map.csv')

    if not os.path.exists(csv_path):
        os.makedirs(MODEL_DIR, exist_ok=True)
        print(f'Downloading YAMNet class map...', file=sys.stderr)
        urllib.request.urlretrieve(csv_url, csv_path)

    class_names: list[str] = []
    with open(csv_path) as f:
        next(f)  # skip header
        for line in f:
            parts = line.strip().split(',', 2)
            if len(parts) >= 3:
                # Format: index, mid, display_name
                class_names.append(parts[2].strip('" '))
    return class_names


def read_wav(path: str) -> np.ndarray:
    """Read a WAV file and return float32 samples normalized to [-1, 1]."""
    import wave

    with wave.open(path, 'rb') as wf:
        assert wf.getsampwidth() == 2, f'Expected 16-bit audio, got {wf.getsampwidth() * 8}-bit'
        assert wf.getnchannels() == 1, f'Expected mono audio, got {wf.getnchannels()} channels'
        sample_rate = wf.getframerate()
        n_frames = wf.getnframes()
        raw = wf.readframes(n_frames)

    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0

    # Resample to 16kHz if needed
    if sample_rate != YAMNET_SAMPLE_RATE:
        duration = len(samples) / sample_rate
        target_len = int(duration * YAMNET_SAMPLE_RATE)
        indices = np.linspace(0, len(samples) - 1, target_len).astype(int)
        samples = samples[indices]

    return samples


def classify_audio(
    audio_path: str,
    confidence_threshold: float = DEFAULT_CONFIDENCE_THRESHOLD,
) -> list[dict]:
    """Run YAMNet on audio file, return timestamped events above threshold."""
    try:
        import tflite_runtime.interpreter as tflite
    except ImportError:
        try:
            import tensorflow.lite as tflite  # type: ignore[import]
        except ImportError:
            print(
                'ERROR: Neither tflite-runtime nor tensorflow is installed.\n'
                'Run: pip install tflite-runtime',
                file=sys.stderr,
            )
            sys.exit(1)

    model_path = download_model()
    class_names = load_class_names()

    print(f'Loading YAMNet TFLite model...', file=sys.stderr)
    interpreter = tflite.Interpreter(model_path=model_path)
    interpreter.allocate_tensors()

    input_details = interpreter.get_input_details()
    output_details = interpreter.get_output_details()

    print(f'Reading audio: {audio_path}', file=sys.stderr)
    samples = read_wav(audio_path)
    total_duration = len(samples) / YAMNET_SAMPLE_RATE
    print(f'Audio duration: {total_duration:.1f}s ({len(samples)} samples)', file=sys.stderr)

    events: list[dict] = []
    frame_step = YAMNET_FRAME_SAMPLES  # non-overlapping frames
    n_frames = len(samples) // frame_step

    for i in range(n_frames):
        start_sample = i * frame_step
        frame = samples[start_sample:start_sample + YAMNET_FRAME_SAMPLES]

        if len(frame) < YAMNET_FRAME_SAMPLES:
            frame = np.pad(frame, (0, YAMNET_FRAME_SAMPLES - len(frame)))

        # YAMNet expects float32 input of shape [frame_samples]
        input_data = frame.reshape(input_details[0]['shape']).astype(np.float32)
        interpreter.set_tensor(input_details[0]['index'], input_data)
        interpreter.invoke()

        scores = interpreter.get_tensor(output_details[0]['index'])[0]
        timestamp = round(start_sample / YAMNET_SAMPLE_RATE, 2)

        # Check each relevant class
        for class_idx, score in enumerate(scores):
            if class_idx >= len(class_names):
                break
            class_name = class_names[class_idx]
            if class_name in RELEVANT_CLASSES and float(score) >= confidence_threshold:
                events.append({
                    'timestamp': timestamp,
                    'event': RELEVANT_CLASSES[class_name],
                    'class': class_name,
                    'confidence': round(float(score), 3),
                })

    print(f'Detected {len(events)} relevant audio events', file=sys.stderr)
    return events


def main() -> None:
    parser = argparse.ArgumentParser(description='Classify audio events with YAMNet')
    parser.add_argument('--input', required=True, help='Path to input WAV file (16-bit mono)')
    parser.add_argument('--output', required=True, help='Path to write events JSON')
    parser.add_argument(
        '--threshold',
        type=float,
        default=DEFAULT_CONFIDENCE_THRESHOLD,
        help=f'Minimum confidence threshold (default: {DEFAULT_CONFIDENCE_THRESHOLD})',
    )
    args = parser.parse_args()

    events = classify_audio(args.input, args.threshold)

    with open(args.output, 'w') as f:
        json.dump(events, f, indent=2)

    print(f'Events written to {args.output}', file=sys.stderr)


if __name__ == '__main__':
    main()
