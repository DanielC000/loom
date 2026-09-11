# 066a953b — STT model prefetch avoids the owner's first voice note failing

## Narrative

Found during a security review of the inbound-voice path (`packages/daemon/src/companion/stt.ts`): faster-whisper lazily downloads its model weights from the HF Hub on first construction. For `STT_MODEL_SIZE="small"` (~500MB), that download alone can exceed `STT_SUBPROCESS_TIMEOUT_MS` — so the owner's very first real voice note after a fresh deploy would fail as "unavailable," even though pip provisioning of the package itself had already succeeded. The failure mode is specifically a FIRST-USE one: pip readiness (package installed) and model readiness (weights cached) are two different things, and only the first was being tracked.

`prewarmStt` was extended to also warm the model itself (`transcribe.py`'s `--warm` mode — instantiate `WhisperModel` with no audio needed) once pip provisioning finishes, off the event loop, best-effort. By the time a real voice note arrives, the model weights are typically already cached under `HF_HOME`.

## Do not

- Do not treat a successful `ensurePythonPackageAsync` resolve as "STT is ready for a real request" — the package being installed and the model weights being downloaded are separate readiness conditions; only warming both closes the first-voice-note gap.

## Source

Inline comment in `packages/daemon/src/companion/stt.ts` (module header, "MODEL PREFETCH" paragraph), as of the companion closing sweep (card `9fe08ce5`). Introduced by commit `066a953b` ("inbound STT — transcribe Telegram voice notes via local faster-whisper, gated behind authz (VOICE-P2)"). No wording changed beyond joining wrapped source lines and stripping `//`/`*` markers.
