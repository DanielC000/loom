#!/usr/bin/env python3
"""Loom Companion STT helper (Companion Voice epic, VOICE-P2).

Invoked by the daemon (companion/stt.ts) via the shared venv's python — never run directly by a user.
The daemon treats this process as an OPAQUE, bounded subprocess: it parses stdout ONLY on a zero exit and
otherwise just knows the call failed. Kept intentionally tiny.

argv: <audio-file-path> [lang-code]   — transcribe a real clip
      --warm                         — instantiate the model only (forces the one-time HF model download
                                        to happen at daemon-boot pre-warm time, not inside a real voice
                                        note's bounded transcribe call)
env:  LOOM_STT_MODEL_SIZE (default "small") — the faster-whisper model size, so bumping quality is a
      one-line change on the daemon side, never a change to this file.
      HF_HOME — set by the daemon so the one-time model download lands under LOOM_HOME.

stdout (success, exit 0): one JSON line — {"text": "...", "language": "en"} for a real transcribe,
                           {"warm": true} for --warm.
stderr (any failure):     a message; process exits non-zero.
"""
import json
import os
import sys


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: transcribe.py <audio-file> [lang-code]  |  transcribe.py --warm", file=sys.stderr)
        return 2
    model_size = os.environ.get("LOOM_STT_MODEL_SIZE", "small")

    from faster_whisper import WhisperModel

    model = WhisperModel(model_size, device="cpu", compute_type="int8")

    if sys.argv[1] == "--warm":
        # Loading the model above already triggered (or reused the cached) HF Hub download — nothing else
        # to do. No audio file is needed for a warm-up.
        print(json.dumps({"warm": True}))
        return 0

    audio_path = sys.argv[1]
    lang = sys.argv[2].strip() if len(sys.argv) > 2 and sys.argv[2].strip() else None
    segments, info = model.transcribe(audio_path, language=lang)
    text = "".join(segment.text for segment in segments).strip()
    print(json.dumps({"text": text, "language": info.language}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # the daemon only cares that this is non-zero + logged to stderr
        print(f"transcribe failed: {exc}", file=sys.stderr)
        sys.exit(1)
