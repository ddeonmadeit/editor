"""Word-level transcription with faster-whisper, for reel ingest.

  python transcribe.py --model small.en [--lang en] [--prompt "names, jargon"] file...

Prints one JSON object per file to stdout:
  {"file": ..., "duration": s, "language": "en", "words": [[start, end, "text"], ...]}
Progress goes to stderr. Audio is decoded with ffmpeg (no PyAV needed).

Speech is first split at pauses (Silero VAD, bundled with faster-whisper) and each clip is
transcribed on its own. Whisper run over one long stream tends to skip repeated phrases,
and a retake is exactly a repeated phrase, so without this the fumbled take vanishes from
the transcript while still being in the audio.
"""
import argparse
import json
import os
import subprocess
import sys

import numpy as np


def load_audio(path, ffmpeg):
    raw = subprocess.run(
        [ffmpeg, "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
        capture_output=True,
        check=True,
    ).stdout
    return np.frombuffer(raw, np.float32)


def speech_clips(audio, gap=0.25):
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    clips = []
    for t in get_speech_timestamps(audio, VadOptions(min_silence_duration_ms=250, speech_pad_ms=80)):
        s, e = t["start"] / 16000, t["end"] / 16000
        if clips and s - clips[-1][1] < gap:
            clips[-1][1] = e
        else:
            clips.append([s, e])
    return clips


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--model", default="small.en")
    ap.add_argument("--lang", default=None)
    ap.add_argument("--prompt", default=None)
    ap.add_argument("--threads", type=int, default=0)
    args = ap.parse_args()

    from faster_whisper import WhisperModel

    try:
        import ctranslate2

        cuda = ctranslate2.get_cuda_device_count() > 0
    except Exception:
        cuda = False
    model = WhisperModel(
        args.model,
        device="cuda" if cuda else "cpu",
        compute_type="float16" if cuda else "int8",
        cpu_threads=args.threads or os.cpu_count() or 4,
    )
    lang = args.lang or ("en" if args.model.endswith(".en") else None)
    for i, path in enumerate(args.files):
        print(f"[{i + 1}/{len(args.files)}] {os.path.basename(path)}", file=sys.stderr, flush=True)
        audio = load_audio(path, os.environ.get("REEL_FFMPEG", "ffmpeg"))
        clips = speech_clips(audio)
        words, language = [], lang
        if not clips:
            print(json.dumps({"file": path, "duration": len(audio) / 16000, "language": lang, "words": []}), flush=True)
            continue
        segments, info = model.transcribe(
            audio,
            language=lang,
            word_timestamps=True,
            beam_size=5,
            condition_on_previous_text=False,
            initial_prompt=args.prompt,
            clip_timestamps=[x for c in clips for x in c],
        )
        language = info.language
        for seg in segments:
            for w in seg.words or []:
                words.append([round(float(w.start), 3), round(float(w.end), 3), w.word])
        print(json.dumps({"file": path, "duration": len(audio) / 16000, "language": language, "words": words}), flush=True)


if __name__ == "__main__":
    main()
