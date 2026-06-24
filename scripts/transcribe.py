#!/usr/bin/env python3
"""Transcribe audio with faster-whisper + OpenCC (繁→简).

Called as a subprocess from the Node.js downloader.
Reads JSON from stdin, writes JSON to stdout.

Input (stdin):
  {
    "wav_path": "/path/to/audio.wav",
    "model": "small",
    "language": null,
    "device": "cpu",
    "compute_type": "int8",
    "no_simplify": false
  }

Output (stdout):
  {
    "segments": [{"start": 0.0, "end": 2.5, "text": "..."}],
    "transcript": "full text...",
    "meta": {
      "model": "small",
      "language": "zh",
      "language_probability": 0.98,
      "device": "cpu",
      "compute_type": "int8"
    }
  }

On error, exits with non-zero code and writes error to stderr.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional


def load_whisper(model_name: str, device: str, compute_type: str):
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("缺少 faster-whisper，请运行：pip install -U faster-whisper", file=sys.stderr)
        sys.exit(1)
    return WhisperModel(model_name, device=device, compute_type=compute_type)


def transcribe(
    model,
    audio_path: str,
    language: Optional[str] = None,
) -> tuple:
    seg_iter, detected = model.transcribe(
        audio_path, language=language, beam_size=5, vad_filter=True,
    )
    segments = []
    for s in seg_iter:
        text = s.text.strip()
        if text:
            segments.append({
                "start": round(float(s.start), 3),
                "end": round(float(s.end), 3),
                "text": text,
            })

    meta = {
        "language": getattr(detected, "language", None),
        "language_probability": round(getattr(detected, "language_probability", 0), 4),
    }
    return segments, meta


def simplify_text(text: str) -> str:
    try:
        import opencc
        converter = opencc.OpenCC("t2s.json")
        return converter.convert(text)
    except Exception:
        return text


def simplify_segments(segments: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    for seg in segments:
        seg["text"] = simplify_text(seg["text"])
        seg["simplified"] = True
    return segments


def main():
    raw = sys.stdin.read()
    try:
        req = json.loads(raw)
    except json.JSONDecodeError:
        print("stdin JSON 解析失败", file=sys.stderr)
        sys.exit(1)

    wav_path = req.get("wav_path")
    if not wav_path or not Path(wav_path).is_file():
        print(f"音频文件不存在：{wav_path}", file=sys.stderr)
        sys.exit(1)

    model_name = req.get("model", "small")
    language = req.get("language")  # None = auto-detect
    device = req.get("device", "cpu")
    compute_type = req.get("compute_type", "int8")
    no_simplify = req.get("no_simplify", False)

    # Strip "auto" to None for auto-detect
    if language == "auto":
        language = None

    model = load_whisper(model_name, device, compute_type)
    segments, detected_meta = transcribe(model, wav_path, language)

    # 繁→简
    if not no_simplify:
        segments = simplify_segments(segments)

    transcript = "\n".join(s["text"] for s in segments)

    result = {
        "segments": segments,
        "transcript": transcript,
        "meta": {
            "model": model_name,
            "language": detected_meta.get("language"),
            "language_probability": detected_meta.get("language_probability"),
            "device": device,
            "compute_type": compute_type,
        },
    }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
