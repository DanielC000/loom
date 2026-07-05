/**
 * Loom Companion — local STT via the shared Python venv (Companion Voice epic, VOICE-P2). faster-whisper
 * is a Python LIBRARY, not a console-script, so it doesn't fit `pty/host.ts`'s markitdown "resolve a
 * console-script binary" shape directly — but `loomVenvBin("python")` resolves to the EXACT SAME path as
 * the venv's own interpreter, so `ensurePythonPackageAsync({ binary: "python", probeImport: "faster_whisper" })`
 * works UNCHANGED: its `fs.existsSync` check trivially passes (the interpreter exists as soon as the venv
 * is created) and the REAL check is the import probe. UNLIKE markitdown's console-script existence check,
 * that fs.existsSync can't distinguish "the venv exists" from "faster-whisper is installed in it" — so
 * readiness here is tracked by a MEMOIZED bool, flipped true ONLY after a successful
 * `ensurePythonPackageAsync` resolve (never by a bare file check), while still mirroring host.ts's
 * deduped-background-kick / retryable-after-terminal-outcome discipline.
 *
 * Transcription itself runs the bundled helper script (assets/python/transcribe.py, see paths.ts's
 * TRANSCRIBE_SCRIPT) via the venv's python — argv: an audio file path + an optional language code —
 * printing a JSON transcript to stdout. Bounded by its OWN subprocess timeout (STT_SUBPROCESS_TIMEOUT_MS),
 * independent of the pip-install bound, so a stuck/slow decode can never wedge the daemon.
 *
 * MODEL PREFETCH (security-review follow-up): faster-whisper lazily downloads its model weights from the
 * HF Hub on first construction — for STT_MODEL_SIZE="small" (~500MB) that download alone can exceed
 * STT_SUBPROCESS_TIMEOUT_MS, so the OWNER'S FIRST real voice note after a fresh deploy would fail
 * "unavailable" even though pip provisioning succeeded. `prewarmStt` therefore ALSO warms the model itself
 * (transcribe.py's `--warm` mode — instantiate WhisperModel with no audio needed) once pip provisioning
 * finishes, off the event loop, best-effort — so by the time a real voice note arrives the model weights
 * are typically already cached under HF_HOME.
 */
import path from "node:path";
import { spawn } from "node:child_process";
import { ensurePythonPackageAsync, type EnsurePythonResult } from "../python/venv.js";
import { LOOM_HOME, TRANSCRIBE_SCRIPT } from "../paths.js";
import type { CompanionTranscriber } from "./types.js";

/**
 * faster-whisper model size — a SINGLE named constant so bumping it is a one-line change here, never a
 * change to transcribe.py. "small" (~0.5–1GB) is the owner-approved quality tier — noticeably more
 * reliable than "base" at language auto-detection.
 */
export const STT_MODEL_SIZE = "small";

/** Bound (ms) for ONE transcribe subprocess call — independent of the pip-install bound below; a stuck or
 *  pathological decode is killed rather than wedging the daemon. Model download is NOT expected to happen
 *  here in steady state (see MODEL PREFETCH above) — this bound covers the decode itself. */
export const STT_SUBPROCESS_TIMEOUT_MS = 60_000;

/** Bound (ms) for the faster-whisper pip install — lighter than markitdown[all], but still give it room. */
const STT_PIP_INSTALL_TIMEOUT_MS = 300_000;

/** Bound (ms) for the model pre-warm (`--warm`) — generous, since it may need to download the model weights
 *  over the network on first boot; this runs OFF the request path (boot-time only), so a long bound here
 *  never risks a user-facing stall. */
const STT_MODEL_WARM_TIMEOUT_MS = 300_000;

/** Where the one-time faster-whisper model download lands — under LOOM_HOME, not the user's global HF
 *  cache, so Loom's Python footprint stays self-contained. */
function hfHomeDir(): string {
  return path.join(LOOM_HOME, "python", "hf-cache");
}

// Memoized readiness: the venv python path once a provision resolves `ready`; undefined until then (never
// holds null) — mirrors host.ts's `markitdownBin` memo.
let sttPythonBin: string | undefined;
let sttProvisionInFlight: Promise<void> | null = null;

/** TEST SEAM: swap the provisioner (failure-classification / retry tests), mirroring host.ts's markitdown seam. */
type SttProvisioner = (opts: Parameters<typeof ensurePythonPackageAsync>[0]) => Promise<EnsurePythonResult>;
let sttProvisioner: SttProvisioner = ensurePythonPackageAsync;
export function __setSttProvisionerForTest(fn?: SttProvisioner): void {
  sttProvisioner = fn ?? ensurePythonPackageAsync;
  sttProvisionInFlight = null;
  sttPythonBin = undefined;
}
/** TEST SEAM: directly seed (or clear) the memoized-ready bin, simulating an already-warm venv. */
export function __setSttPythonBinForTest(bin: string | undefined): void {
  sttPythonBin = bin;
}

/** Kick BACKGROUND provisioning of faster-whisper in the shared venv — deduped ONLY while genuinely
 *  in-flight, so a fresh kick is always possible after a terminal outcome (never a permanent dead-end).
 *  Never throws (ensurePythonPackageAsync never throws), never blocks the event loop. Returns the in-flight
 *  promise (new or already-running) so a caller (prewarmStt) can await the SAME kick instead of racing it. */
function kickSttProvision(pythonInterpreterPath?: string): Promise<void> {
  if (sttProvisionInFlight) return sttProvisionInFlight;
  sttProvisionInFlight = sttProvisioner({
    package: "faster-whisper",
    binary: "python",
    probeImport: "faster_whisper",
    timeoutMs: STT_PIP_INSTALL_TIMEOUT_MS,
    interpreterOverride: pythonInterpreterPath,
  })
    .then((res) => {
      if (res.outcome === "ready" && res.binary) {
        sttPythonBin = res.binary;
        // eslint-disable-next-line no-console
        console.warn(`[companion] faster-whisper venv ready (${res.binary}) — voice notes now transcribe.`);
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          `[companion] faster-whisper background provisioning FAILED (${res.outcome}) — voice notes degrade ` +
            `to a friendly ack until it's retried (a later voice note re-kicks provisioning).` +
            `${res.errorTail ? `\n  captured output tail:\n${res.errorTail}` : ""}`,
        );
      }
    })
    .catch(() => { /* ensurePythonPackageAsync never throws; belt-and-suspenders */ })
    .finally(() => { sttProvisionInFlight = null; });
  return sttProvisionInFlight;
}

/**
 * Cheap, synchronous readiness check: returns the memoized venv python path if ready, else null. A null
 * result KICKS background provisioning (deduped) as a side effect — so every caller (the gateway's
 * pre-download check, and transcribe() itself) both checks AND warms.
 */
function resolveSttPython(pythonInterpreterPath?: string): string | null {
  if (sttPythonBin) return sttPythonBin;
  kickSttProvision(pythonInterpreterPath);
  return null;
}

/** Bounded run of a transcribe.py invocation; resolves `{ok, stdout}` — never throws (spawn error, non-zero
 *  exit, and timeout all resolve `ok:false`). Shared by both a real transcribe call and the `--warm` model
 *  pre-fetch, which differ only in argv + bound. */
function runPythonHelper(pythonBin: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean, stdout: string) => { if (!settled) { settled = true; resolve({ ok, stdout }); } };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(pythonBin, [TRANSCRIBE_SCRIPT, ...args], {
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, HF_HOME: hfHomeDir(), LOOM_STT_MODEL_SIZE: STT_MODEL_SIZE },
      });
    } catch {
      done(false, "");
      return;
    }
    let stdout = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf-8"); });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* noop */ } done(false, stdout); }, timeoutMs);
    child.on("error", () => { clearTimeout(timer); done(false, stdout); });
    child.on("exit", (code) => { clearTimeout(timer); done(code === 0, stdout); });
  });
}

/** Bounded run of the transcribe helper script; resolves the transcript text or null on ANY failure (spawn
 *  error, non-zero exit, timeout, malformed stdout) — never throws. */
async function runTranscribeScript(pythonBin: string, filePath: string, langHint: string | null): Promise<string | null> {
  const { ok, stdout } = await runPythonHelper(pythonBin, [filePath, langHint ?? ""], STT_SUBPROCESS_TIMEOUT_MS);
  if (!ok) return null;
  try {
    const parsed: unknown = JSON.parse(stdout);
    const text = (parsed as { text?: unknown } | null)?.text;
    return typeof text === "string" ? text : null;
  } catch {
    return null;
  }
}

/** Bounded run of `transcribe.py --warm` — instantiates the model with no audio needed, so the one-time HF
 *  model download happens here (boot pre-warm) rather than inside a real voice note's tighter bound.
 *  Never throws; resolves whether the warm-up succeeded (for logging only — readiness doesn't depend on it). */
async function warmSttModel(pythonBin: string): Promise<boolean> {
  const { ok } = await runPythonHelper(pythonBin, ["--warm"], STT_MODEL_WARM_TIMEOUT_MS);
  return ok;
}

/**
 * Build the injected CompanionTranscriber — local faster-whisper via the shared venv. `pythonInterpreterPath`
 * is the human-only `python.interpreterPath` override (same resolution as the markitdown pre-warm).
 */
export function createFasterWhisperTranscriber(pythonInterpreterPath?: string): CompanionTranscriber {
  return {
    isReady() {
      return resolveSttPython(pythonInterpreterPath) !== null;
    },
    async transcribe({ filePath, langHint }) {
      const bin = resolveSttPython(pythonInterpreterPath);
      if (!bin) return null;
      return runTranscribeScript(bin, filePath, langHint);
    },
  };
}

/**
 * Pre-warm the shared venv's faster-whisper AHEAD of the first voice note (mirrors prewarmMarkitdown) —
 * best-effort, fully off the event loop (the returned promise is never awaited by callers; index.ts fires
 * this at boot and moves on). Warms BOTH the pip install (via resolveSttPython's background kick) AND the
 * model weights themselves (transcribe.py --warm) once provisioning succeeds, so a real deployment's first
 * voice note usually finds everything — venv, package, AND model — already warm.
 */
export function prewarmStt(pythonInterpreterPath?: string): void {
  void warmSttModelInBackground(pythonInterpreterPath);
}

async function warmSttModelInBackground(pythonInterpreterPath?: string): Promise<void> {
  let bin = resolveSttPython(pythonInterpreterPath);
  if (!bin) {
    // Cold: resolveSttPython() above already kicked (or joined) the deduped background pip-install — await
    // that SAME in-flight promise (never a second parallel kick) before attempting the model warm.
    if (sttProvisionInFlight) { await sttProvisionInFlight.catch(() => { /* logged inside kickSttProvision */ }); }
    bin = sttPythonBin ?? null;
  }
  if (!bin) return; // provisioning failed (or another caller's kick is still pending) — a later voice note retries both
  const warmed = await warmSttModel(bin);
  if (warmed) {
    // eslint-disable-next-line no-console
    console.warn(`[companion] faster-whisper model (${STT_MODEL_SIZE}) pre-warmed — the first voice note should transcribe fast.`);
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      "[companion] faster-whisper model pre-warm failed/timed out — the first real voice note will attempt " +
        "the model download itself, bounded by the per-call subprocess timeout.",
    );
  }
}
