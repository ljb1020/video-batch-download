#!/usr/bin/env python3
"""Persistent transcription server — model loaded once, reused for all requests.

Usage:
  python transcribe_server.py --model small --device cuda --compute-type float16 [--no-simplify]

Protocol (stdin/stdout, one JSON per line):
  Request:  {"wav_path": "...", "language": "zh"}
  Response: {"segments": [...], "transcript": "...", "meta": {...}}
  Stop:     {"stop": true}  (or stdin EOF)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def _add_nvidia_dll_dirs():
    """Add NVIDIA CUDA/cuDNN DLL directories to the search path (Windows)."""
    if sys.platform != "win32":
        return
    site_nvidia = Path(sys.prefix) / "Lib" / "site-packages" / "nvidia"
    if not site_nvidia.is_dir():
        return
    dirs = []
    for sub in site_nvidia.iterdir():
        bin_dir = sub / "bin"
        if bin_dir.is_dir():
            dirs.append(str(bin_dir))
            os.add_dll_directory(str(bin_dir))
    if dirs:
        os.environ["PATH"] = ";".join(dirs) + ";" + os.environ.get("PATH", "")


_add_nvidia_dll_dirs()


def load_whisper(model_name: str, device: str, compute_type: str):
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(
            "Missing faster-whisper. Run: pip install -U faster-whisper",
            file=sys.stderr,
        )
        sys.exit(1)
    return WhisperModel(model_name, device=device, compute_type=compute_type)


def transcribe(model, audio_path, language=None):
    seg_iter, detected = model.transcribe(
        audio_path, language=language, beam_size=5, vad_filter=False
    )
    segments = []
    for s in seg_iter:
        text = s.text.strip()
        if text:
            segments.append(
                {
                    "start": round(float(s.start), 3),
                    "end": round(float(s.end), 3),
                    "text": text,
                }
            )
    meta = {
        "language": getattr(detected, "language", None),
        "language_probability": round(
            getattr(detected, "language_probability", 0), 4
        ),
    }
    return segments, meta


def simplify_segments(segments, converter):
    for seg in segments:
        seg["text"] = converter.convert(seg["text"])
        seg["simplified"] = True
    return segments


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="small")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--compute-type", default="int8", dest="compute_type")
    parser.add_argument("--no-simplify", action="store_true")
    args = parser.parse_args()

    # Load model eagerly at startup
    model = load_whisper(args.model, args.device, args.compute_type)
    print(
        f"[server] model loaded: {args.model} ({args.device}/{args.compute_type})",
        file=sys.stderr,
        flush=True,
    )

    converter = None

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            print(json.dumps({"error": "invalid JSON"}), flush=True)
            continue

        if req.get("stop"):
            break

        wav_path = req.get("wav_path")
        if not wav_path:
            print(json.dumps({"error": "missing wav_path"}), flush=True)
            continue

        if not Path(wav_path).is_file():
            print(
                json.dumps({"error": f"Audio file not found: {wav_path}"}),
                flush=True,
            )
            continue

        language = req.get("language")
        if language == "auto":
            language = None
        no_simplify = req.get("no_simplify", args.no_simplify)

        segments, detected_meta = transcribe(model, wav_path, language)

        if not no_simplify:
            if converter is None:
                try:
                    import opencc
                    converter = opencc.OpenCC("t2s.json")
                except ImportError:
                    print(
                        "Missing opencc-python-reimplemented. Run: pip install opencc-python-reimplemented",
                        file=sys.stderr,
                    )
                    print(json.dumps({"error": "opencc not installed, cannot simplify text"}), flush=True)
                    continue
            segments = simplify_segments(segments, converter)

        transcript = "\n".join(s["text"] for s in segments)

        result = {
            "segments": segments,
            "transcript": transcript,
            "meta": {
                "model": args.model,
                "language": detected_meta.get("language"),
                "language_probability": detected_meta.get("language_probability"),
                "device": args.device,
                "compute_type": args.compute_type,
            },
        }
        print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
