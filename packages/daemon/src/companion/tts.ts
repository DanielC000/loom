/**
 * Loom Companion — local TTS via the shared Python venv (Companion Voice epic, VOICE-P3). Mirrors
 * companion/stt.ts EXACTLY: kokoro-onnx is a Python LIBRARY, not a console-script, so
 * `ensurePythonPackageAsync({ binary: "python", probeImport: "kokoro_onnx" })` works unchanged (the venv's
 * own interpreter path resolves trivially; the REAL check is the import probe). Readiness is a MEMOIZED
 * bool, flipped true ONLY after a successful `ensurePythonPackageAsync` resolve — never a bare file check.
 *
 * Synthesis itself runs the bundled helper script (assets/python/synthesize.py, see paths.ts's
 * SYNTHESIZE_SCRIPT) via the venv's python — argv: an out-path + lang code + optional voice, with the
 * reply TEXT piped over stdin (never argv — avoids argv-length limits and shell-quoting on an arbitrary
 * agent reply). Bounded by its OWN subprocess timeout (TTS_SUBPROCESS_TIMEOUT_MS), independent of the
 * pip-install bound, so a stuck/slow synth can never wedge the daemon.
 *
 * MODEL PREFETCH: unlike faster-whisper (which lazily downloads from the HF Hub on first construction),
 * kokoro-onnx does NOT auto-fetch its weights — synthesize.py owns that one-time download itself (from
 * Kokoro's own GitHub release, see the script). `prewarmTts` warms BOTH the pip install AND the model +
 * voices download (synthesize.py's `--warm` mode) once pip provisioning finishes, off the event loop, so a
 * real deployment's first voice reply after boot usually finds everything already warm.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { ensurePythonPackageAsync, type EnsurePythonResult } from "../python/venv.js";
import { LOOM_HOME, SYNTHESIZE_SCRIPT } from "../paths.js";
import type { CompanionSynthesizer } from "./types.js";

/** Kokoro ONNX weight precision — a SINGLE named constant so bumping it is a one-line change here, never a
 *  change to synthesize.py. "fp16" (~170MB) is the size/quality tradeoff the owner approved — noticeably
 *  smaller than the f32 export (~310MB) with no audible quality loss for a chat companion's voice replies. */
export const TTS_MODEL_PRECISION = "fp16";

/** Bound (ms) for ONE synthesize subprocess call — independent of the pip-install bound below; a stuck or
 *  pathological synth is killed rather than wedging the daemon. Model download is NOT expected to happen
 *  here in steady state (see MODEL PREFETCH above) — this bound covers the synth + encode itself. */
export const TTS_SUBPROCESS_TIMEOUT_MS = 60_000;

/** Bound (ms) for the kokoro-onnx pip install — onnxruntime's wheel is sizeable, so this gets more room
 *  than STT's faster-whisper bound (a slow onnxruntime fetch on a corporate network shouldn't misclassify
 *  as a spurious timeout). */
const TTS_PIP_INSTALL_TIMEOUT_MS = 600_000;

/** Bound (ms) for the model pre-warm (`--warm`) — generous, since it downloads the ~170MB model + ~27MB
 *  voices file over the network on first boot; this runs OFF the request path (boot-time only), so a long
 *  bound here never risks a user-facing stall. */
const TTS_MODEL_WARM_TIMEOUT_MS = 600_000;

/** A pathologically long reply (e.g. a big pasted log/diff) would just burn the full subprocess bound
 *  synthesizing audio nobody wants to sit through as a voice note — skip straight to the text degrade
 *  instead of ever spawning a synth for it. Comfortably above a normal chat reply, well below "someone
 *  pasted a whole file". */
export const TTS_MAX_TEXT_LENGTH = 4_000;

/** Where the one-time Kokoro model + voices download lands — its OWN dedicated dir under LOOM_HOME, kept
 *  separate from STT's HF_HOME cache (kokoro-onnx doesn't fetch via the HF Hub the way faster-whisper
 *  does, so overloading hf-cache would just be a confusing footprint, not a real HF cache). */
function kokoroCacheDir(): string {
  return path.join(LOOM_HOME, "python", "kokoro-cache");
}

/** Where a synthesized reply's temp audio file lands — the SAME dir STT's downloaded voice notes use
 *  (LOOM_HOME/tmp/companion-audio), so there is exactly one temp-audio lifecycle to reason about. */
function audioTmpDir(): string {
  return path.join(LOOM_HOME, "tmp", "companion-audio");
}

// Memoized readiness: the venv python path once a provision resolves `ready`; undefined until then (never
// holds null) — mirrors stt.ts's sttPythonBin memo.
let ttsPythonBin: string | undefined;
let ttsProvisionInFlight: Promise<void> | null = null;

/** TEST SEAM: swap the provisioner (failure-classification / retry tests), mirroring stt.ts's seam. */
type TtsProvisioner = (opts: Parameters<typeof ensurePythonPackageAsync>[0]) => Promise<EnsurePythonResult>;
let ttsProvisioner: TtsProvisioner = ensurePythonPackageAsync;
export function __setTtsProvisionerForTest(fn?: TtsProvisioner): void {
  ttsProvisioner = fn ?? ensurePythonPackageAsync;
  ttsProvisionInFlight = null;
  ttsPythonBin = undefined;
}
/** TEST SEAM: directly seed (or clear) the memoized-ready bin, simulating an already-warm venv. */
export function __setTtsPythonBinForTest(bin: string | undefined): void {
  ttsPythonBin = bin;
}

/** Kick BACKGROUND provisioning of kokoro-onnx in the shared venv — deduped ONLY while genuinely in-flight,
 *  so a fresh kick is always possible after a terminal outcome (never a permanent dead-end). Never throws,
 *  never blocks the event loop. Returns the in-flight promise (new or already-running) so a caller
 *  (prewarmTts) can await the SAME kick instead of racing it. */
function kickTtsProvision(pythonInterpreterPath?: string): Promise<void> {
  if (ttsProvisionInFlight) return ttsProvisionInFlight;
  ttsProvisionInFlight = ttsProvisioner({
    package: "kokoro-onnx",
    binary: "python",
    probeImport: "kokoro_onnx",
    timeoutMs: TTS_PIP_INSTALL_TIMEOUT_MS,
    interpreterOverride: pythonInterpreterPath,
  })
    .then((res) => {
      if (res.outcome === "ready" && res.binary) {
        ttsPythonBin = res.binary;
        // eslint-disable-next-line no-console
        console.warn(`[companion] kokoro-onnx venv ready (${res.binary}) — voice replies can now synthesize.`);
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          `[companion] kokoro-onnx background provisioning FAILED (${res.outcome}) — voice replies degrade ` +
            `to text until it's retried (a later voice reply re-kicks provisioning).` +
            `${res.errorTail ? `\n  captured output tail:\n${res.errorTail}` : ""}`,
        );
      }
    })
    .catch(() => { /* ensurePythonPackageAsync never throws; belt-and-suspenders */ })
    .finally(() => { ttsProvisionInFlight = null; });
  return ttsProvisionInFlight;
}

/** Cheap, synchronous readiness check: returns the memoized venv python path if ready, else null. A null
 *  result KICKS background provisioning (deduped) as a side effect — mirrors stt.ts's resolveSttPython. */
function resolveTtsPython(pythonInterpreterPath?: string): string | null {
  if (ttsPythonBin) return ttsPythonBin;
  kickTtsProvision(pythonInterpreterPath);
  return null;
}

/** Bounded run of a synthesize.py invocation; resolves `{ok}` — never throws (spawn error, non-zero exit,
 *  and timeout all resolve `ok:false`). Shared by both a real synth call and the `--warm` model pre-fetch,
 *  which differ only in argv/stdin + bound. */
function runPythonHelper(
  pythonBin: string,
  args: string[],
  stdin: string,
  timeoutMs: number,
): Promise<{ ok: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => { if (!settled) { settled = true; resolve({ ok }); } };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(pythonBin, [SYNTHESIZE_SCRIPT, ...args], {
        // stderr is IGNORED, not piped-and-left-undrained: nothing here consumes child.stderr, and a
        // chatty onnxruntime/PyAV writing enough to fill the OS pipe buffer would otherwise block the
        // child's write() until this process reads it — which never happens — stalling the call all the
        // way out to `timeoutMs` instead of failing fast. Diagnosability is unaffected: a failure is still
        // reported via the non-zero exit code (the caller doesn't parse stderr text either way).
        stdio: ["pipe", "ignore", "ignore"],
        env: {
          ...process.env,
          LOOM_TTS_CACHE_DIR: kokoroCacheDir(),
          LOOM_TTS_MODEL_PRECISION: TTS_MODEL_PRECISION,
        },
      });
    } catch {
      done(false);
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* noop */ } done(false); }, timeoutMs);
    child.on("error", () => { clearTimeout(timer); done(false); });
    child.on("exit", (code) => { clearTimeout(timer); done(code === 0); });
    try {
      child.stdin?.write(stdin);
      child.stdin?.end();
    } catch { /* a dead/closed stdin here just means the exit handler above reports failure */ }
  });
}

/** Bounded run of the synthesize helper script; resolves `{filePath, cleanup}` on success or null on ANY
 *  failure (spawn error, non-zero exit, timeout) — never throws. The out-path is unique per call
 *  (randomUUID) so concurrent replies never collide. */
async function runSynthesizeScript(
  pythonBin: string,
  text: string,
  lang: string | null,
  voice: string | null,
): Promise<{ filePath: string; cleanup: () => Promise<void> } | null> {
  const dir = audioTmpDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${randomUUID()}.ogg`);
  const { ok } = await runPythonHelper(pythonBin, [filePath, lang ?? "", voice ?? ""], text, TTS_SUBPROCESS_TIMEOUT_MS);
  if (!ok) {
    // A timeout-kill can race the subprocess having ALREADY renamed a complete file into place a moment
    // earlier (encode_ogg_opus's os.replace is atomic, but the parent's kill/exit-code observation isn't
    // synchronized with it) — don't leave an orphaned .ogg behind just because we reported failure.
    if (fs.existsSync(filePath)) { try { fs.unlinkSync(filePath); } catch { /* best-effort */ } }
    return null;
  }
  if (!fs.existsSync(filePath)) return null;
  return {
    filePath,
    cleanup: async () => { try { await fs.promises.unlink(filePath); } catch { /* best-effort */ } },
  };
}

/** Bounded run of `synthesize.py --warm` — fetches the model + voices file and instantiates Kokoro, so the
 *  one-time download happens here (boot pre-warm) rather than inside a real reply's tighter bound. Never
 *  throws; resolves whether the warm-up succeeded (for logging only — readiness doesn't depend on it). */
async function warmTtsModel(pythonBin: string): Promise<boolean> {
  const { ok } = await runPythonHelper(pythonBin, ["--warm"], "", TTS_MODEL_WARM_TIMEOUT_MS);
  return ok;
}

/**
 * Build the injected CompanionSynthesizer — local kokoro-onnx via the shared venv. `pythonInterpreterPath`
 * is the human-only `python.interpreterPath` override (same resolution as STT/markitdown pre-warm).
 */
export function createKokoroSynthesizer(pythonInterpreterPath?: string): CompanionSynthesizer {
  return {
    isReady() {
      return resolveTtsPython(pythonInterpreterPath) !== null;
    },
    async synthesize({ text, lang, voice }) {
      if (text.length > TTS_MAX_TEXT_LENGTH) return null; // skip straight to the text degrade — never burn the subprocess bound on a reply nobody wants read aloud in full
      const bin = resolveTtsPython(pythonInterpreterPath);
      if (!bin) return null;
      return runSynthesizeScript(bin, text, lang, voice);
    },
  };
}

/**
 * Pre-warm the shared venv's kokoro-onnx AHEAD of the first voice reply (mirrors prewarmStt) —
 * best-effort, fully off the event loop (the returned promise is never awaited by callers; index.ts fires
 * this at boot and moves on). Warms BOTH the pip install (via resolveTtsPython's background kick) AND the
 * model + voices download (synthesize.py --warm) once provisioning succeeds.
 */
export function prewarmTts(pythonInterpreterPath?: string): void {
  void warmTtsModelInBackground(pythonInterpreterPath);
}

async function warmTtsModelInBackground(pythonInterpreterPath?: string): Promise<void> {
  let bin = resolveTtsPython(pythonInterpreterPath);
  if (!bin) {
    // Cold: resolveTtsPython() above already kicked (or joined) the deduped background pip-install — await
    // that SAME in-flight promise (never a second parallel kick) before attempting the model warm.
    if (ttsProvisionInFlight) { await ttsProvisionInFlight.catch(() => { /* logged inside kickTtsProvision */ }); }
    bin = ttsPythonBin ?? null;
  }
  if (!bin) return; // provisioning failed (or another caller's kick is still pending) — a later reply retries both
  const warmed = await warmTtsModel(bin);
  if (warmed) {
    // eslint-disable-next-line no-console
    console.warn(`[companion] kokoro-onnx model (${TTS_MODEL_PRECISION}) pre-warmed — the first voice reply should synthesize fast.`);
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      "[companion] kokoro-onnx model pre-warm failed/timed out — the first real voice reply will attempt " +
        "the model download itself, bounded by the per-call subprocess timeout.",
    );
  }
}
