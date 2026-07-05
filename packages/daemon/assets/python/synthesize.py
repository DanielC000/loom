#!/usr/bin/env python3
"""Loom Companion TTS helper (Companion Voice epic, VOICE-P3).

Invoked by the daemon (companion/tts.ts) via the shared venv's python — never run directly by a user.
The daemon treats this process as an OPAQUE, bounded subprocess: it only knows the call succeeded (exit 0,
the out-path now holds a playable OGG/Opus file) or failed (non-zero exit) — never parses audio itself.
Kept intentionally tiny, mirroring transcribe.py.

argv: <out-path> <lang-code> [voice]   — synthesize the text read from STDIN to <out-path> as OGG/Opus
      --warm                          — fetch + instantiate the model only (no text needed), so the
                                        one-time ~197MB Kokoro model (fp16) + voices download happens at
                                        daemon-boot pre-warm time, not inside a real reply's bounded call
The reply TEXT is read from stdin (not argv) so an arbitrary agent reply (multi-line, quotes, emoji) never
hits argv-length limits or shell-quoting — mirrors why the daemon spawns this with stdio piped, not shell:true.

env:  LOOM_TTS_MODEL_PRECISION (default "fp16") — which exported Kokoro ONNX weight file to fetch/use, so
      bumping quality/size is a one-line change on the daemon side, never a change to this file.
      LOOM_TTS_CACHE_DIR — where the one-time model + voices download lands (daemon sets this to a
      dedicated `kokoro-cache` dir under LOOM_HOME, kept separate from STT's HF_HOME so the two model
      caches never collide).

stdout (success, exit 0): one JSON line — {"ok": true} for a real synth (the audio is AT out-path),
                           {"warm": true} for --warm.
stderr (any failure):     a message; process exits non-zero. out-path is NEVER left partially written.
"""
import hashlib
import json
import os
import sys
import urllib.request
import uuid

# Kokoro's own GitHub release — the package does not auto-fetch model weights (unlike faster-whisper's HF
# Hub auto-download), so this script owns the one-time fetch itself. A versioned, stable release asset URL
# (not a moving target) — bumping to a newer release is a one-line change to RELEASE_TAG.
RELEASE_TAG = "model-files-v1.0"
RELEASE_BASE = f"https://github.com/thewh1teagle/kokoro-onnx/releases/download/{RELEASE_TAG}"
VOICES_FILE = "voices-v1.0.bin"

# SHA256 of the EXACT bytes this daemon was verified against (the VOICE-P3 real-audio smoke), keyed by
# filename — a pinned release TAG is not pinned BYTES (a GitHub release asset can be swapped after the fact
# by the maintainer or a compromised account, fetched over perfectly valid TLS, then EXECUTED by onnxruntime
# with zero detection). A downloaded file that doesn't match is REJECTED before it ever reaches onnxruntime
# — see download_if_missing. A future precision/tag bump ships its OWN hash (keyed by filename, so an
# unpinned new file fails closed rather than silently trusting unverified bytes).
KNOWN_HASHES = {
    "kokoro-v1.0.fp16.onnx": "c1610a859f3bdea01107e73e50100685af38fff88f5cd8e5c56df109ec880204",
    "voices-v1.0.bin": "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
}

# storedLangCode(lowercased) -> (kokoro lang id, default voice). The daemon's /lang command stores an
# ISO-639-1(-region) code (e.g. "en", "pt-BR"); Kokoro's `lang`/`voice` params use its own locale + voice-
# name convention. Unmapped/null falls back to DEFAULT_LANG_KEY so a voice reply ALWAYS synthesizes even
# when no /lang was ever set. Small + deliberately not exhaustive — extend as Loom adds companion locales.
LANG_MAP = {
    "en": ("en-us", "af_heart"),
    "en-us": ("en-us", "af_heart"),
    "en-gb": ("en-gb", "bf_emma"),
    "es": ("es", "ef_dora"),
    "fr": ("fr-fr", "ff_siwis"),
    "fr-fr": ("fr-fr", "ff_siwis"),
    "it": ("it", "if_sara"),
    "ja": ("ja", "jf_alpha"),
    "zh": ("cmn", "zf_xiaobei"),
    "cmn": ("cmn", "zf_xiaobei"),
    "pt": ("pt-br", "pf_dora"),
    "pt-br": ("pt-br", "pf_dora"),
}
DEFAULT_LANG_KEY = "en"


def resolve_lang_voice(lang_code, voice_override):
    key = (lang_code or "").strip().lower()
    kokoro_lang, default_voice = LANG_MAP.get(key, LANG_MAP[DEFAULT_LANG_KEY])
    voice = voice_override.strip() if voice_override and voice_override.strip() else default_voice
    return kokoro_lang, voice


def model_filename(precision):
    return "kokoro-v1.0.onnx" if precision == "f32" else f"kokoro-v1.0.{precision}.onnx"


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def download_if_missing(url, dest, filename):
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return
    expected = KNOWN_HASHES.get(filename)
    if not expected:
        raise RuntimeError(f"no pinned sha256 for {filename} — refusing to download an unverifiable file")
    # A PER-PROCESS-UNIQUE tmp path (mirror the randomUUID .ogg output on the daemon side): a real reply's
    # synthesize.py can race a concurrent --warm prefetch (or another concurrent reply) over the SAME model
    # file. A single SHARED fixed ".part" would let two writers interleave into one file, and os.replace
    # would then promote CORRUPT bytes into `dest` — onnxruntime then fails to load on every future synth,
    # silently, until a human clears the cache. A unique tmp per attempt means each writer produces its OWN
    # complete file; os.replace is then last-writer-wins-COMPLETE, never interleaved-garbage.
    tmp = f"{dest}.{os.getpid()}.{uuid.uuid4().hex}.part"
    try:
        with urllib.request.urlopen(url, timeout=1800) as resp, open(tmp, "wb") as f:
            while True:
                chunk = resp.read(1024 * 1024)
                if not chunk:
                    break
                f.write(chunk)
        actual = _sha256(tmp)
        if actual != expected:
            raise RuntimeError(f"sha256 mismatch for {filename}: expected {expected}, got {actual} — refusing to load")
        os.replace(tmp, dest)  # atomic — a killed/rejected download never leaves a corrupt "complete" file
    finally:
        # The unique-per-attempt tmp (unlike the old fixed-path version) is NOT self-overwriting on a later
        # retry, so a failed/rejected download must clean up its own part here or they'd accumulate.
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def ensure_model_files(cache_dir, precision):
    os.makedirs(cache_dir, exist_ok=True)
    model_name = model_filename(precision)
    model_path = os.path.join(cache_dir, model_name)
    voices_path = os.path.join(cache_dir, VOICES_FILE)
    download_if_missing(f"{RELEASE_BASE}/{model_name}", model_path, model_name)
    download_if_missing(f"{RELEASE_BASE}/{VOICES_FILE}", voices_path, VOICES_FILE)
    return model_path, voices_path


def validate_lang_map(kokoro):
    """Warn (non-fatal — --warm still succeeds) if a LANG_MAP default voice doesn't exist in the ACTUALLY
    loaded voices file — so a wrong/typo'd voice name surfaces in the boot log immediately instead of that
    locale silently degrading to text forever the first time a real reply requests it. The voices file's
    content is pinned by KNOWN_HASHES, so a pass here stays valid for the life of that pinned version."""
    try:
        loaded = set(kokoro.get_voices())
    except Exception as exc:  # pragma: no cover - diagnostic only, must never break --warm
        print(f"synthesize.py --warm: could not validate LANG_MAP voices: {exc}", file=sys.stderr)
        return
    for lang_key, (_kokoro_lang, voice) in LANG_MAP.items():
        if voice not in loaded:
            print(f"synthesize.py --warm: LANG_MAP['{lang_key}'] voice '{voice}' is NOT in the loaded voices set — that locale will fail until fixed", file=sys.stderr)


def encode_ogg_opus(samples, sample_rate, out_path):
    """Encode float32 PCM `samples` (mono, `sample_rate` Hz) to OGG/Opus at `out_path` via PyAV — PyAV's
    pip wheel bundles FFmpeg's shared libs (incl. libopus), so this needs NO system ffmpeg install. Writes
    to a `.part` sibling and renames atomically so a killed/failed encode never leaves a partial file at
    `out_path` for the caller to (mis)pick up."""
    import av
    import numpy as np

    tmp = out_path + ".part"
    try:
        try:
            av.Codec("libopus", "w")
            codec_name = "libopus"
        except Exception:
            codec_name = "opus"
        container = av.open(tmp, mode="w", format="ogg")
        try:
            stream = container.add_stream(codec_name, rate=48000, layout="mono")
            if codec_name == "opus":
                stream.codec_context.options = {"strict": "-2"}
            frame = av.AudioFrame.from_ndarray(
                np.expand_dims(samples.astype(np.float32), axis=0), format="fltp", layout="mono"
            )
            frame.sample_rate = sample_rate
            resampler = av.AudioResampler(format="fltp", layout="mono", rate=48000)
            for rframe in resampler.resample(frame):
                for packet in stream.encode(rframe):
                    container.mux(packet)
            for packet in stream.encode(None):
                container.mux(packet)
        finally:
            container.close()
        os.replace(tmp, out_path)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: synthesize.py <out-path> <lang-code> [voice]  |  synthesize.py --warm", file=sys.stderr)
        return 2
    precision = os.environ.get("LOOM_TTS_MODEL_PRECISION", "fp16")
    cache_dir = os.environ.get("LOOM_TTS_CACHE_DIR") or os.path.join(os.path.expanduser("~"), ".loom-tts-cache")

    model_path, voices_path = ensure_model_files(cache_dir, precision)

    from kokoro_onnx import Kokoro

    kokoro = Kokoro(model_path, voices_path)

    if sys.argv[1] == "--warm":
        # Constructing Kokoro above already loaded the model; run one throwaway synth so the FIRST real
        # reply doesn't pay for any one-time lazy init inside the model itself.
        kokoro.create("warm", voice=LANG_MAP[DEFAULT_LANG_KEY][1], speed=1.0, lang=LANG_MAP[DEFAULT_LANG_KEY][0])
        validate_lang_map(kokoro)
        print(json.dumps({"warm": True}))
        return 0

    out_path = sys.argv[1]
    lang_code = sys.argv[2] if len(sys.argv) > 2 else ""
    voice_arg = sys.argv[3] if len(sys.argv) > 3 else ""
    text = sys.stdin.read()
    if not text.strip():
        print("empty text on stdin", file=sys.stderr)
        return 2

    lang, voice = resolve_lang_voice(lang_code, voice_arg)
    samples, sample_rate = kokoro.create(text, voice=voice, speed=1.0, lang=lang)
    encode_ogg_opus(samples, sample_rate, out_path)
    print(json.dumps({"ok": True}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # the daemon only cares that this is non-zero + logged to stderr
        print(f"synthesize failed: {exc}", file=sys.stderr)
        sys.exit(1)
