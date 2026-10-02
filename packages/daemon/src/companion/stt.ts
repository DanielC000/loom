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
 * @decision sha:066a953b — package-installed is NOT model-ready: without a prefetch, the owner's first
 * real voice note after a fresh deploy can fail "unavailable" while the model download still runs past
 * STT_SUBPROCESS_TIMEOUT_MS.
 *
 * `prewarmStt` therefore ALSO warms the model itself (transcribe.py's `--warm` mode — instantiate
 * WhisperModel with no audio needed) once pip provisioning finishes, off the event loop, best-effort — so
 * by the time a real voice note arrives the model weights are typically already cached under HF_HOME.
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
 *  Never throws; resolves whether the warm-up succeeded (for logging only — readiness doesn't depend on it).
 *  Runs OUTSIDE `acquireSttSlot`/`releaseSttSlot` (card 986bdddd round 2) — it's a boot-time, pre-traffic
 *  call with no concurrent companion transcription to contend with, so it deliberately doesn't take the
 *  global decode slot. See the decision record's "Do not" for the one way that could stop being true. */
async function warmSttModel(pythonBin: string): Promise<boolean> {
  const { ok } = await runPythonHelper(pythonBin, ["--warm"], STT_MODEL_WARM_TIMEOUT_MS);
  return ok;
}

// @decision 986bdddd — never raise this above 1 without first confirming the host can run that many
// faster-whisper decodes concurrently without starving every companion.

/** Global concurrency cap on faster-whisper transcription (companion-inbound serialization, card 986bdddd)
 *  — one `transcribe()` call across EVERY companion on the daemon at a time (the shared venv's decode is
 *  CPU-heavy; running more than one just slows every concurrent decode down, so this serializes rather than
 *  parallelizes). Bounds host resource exhaustion that per-route inbound serialization (chat-gateway.ts)
 *  does NOT: that fix only serializes messages WITHIN one chat, so N different chats each sending a voice
 *  note at once would otherwise still spawn N python subprocesses with no cap. */
const STT_MAX_CONCURRENT_TRANSCRIPTIONS = 1;

/** Bound (ms) on how long a `transcribe()` call may wait to ACQUIRE the slot above. Past this bound, the
 *  waiting call gives up and resolves `null` — the SAME "no transcript" result a real STT failure already
 *  produces, so a long queue degrades through the existing transcribe-unavailable ack instead of hanging a
 *  voice note indefinitely behind other voice notes. Exported (card 986bdddd round 2, Major) so
 *  chat-gateway.ts's INBOUND_QUEUE_MAX_WAIT_MS can be DERIVED from this value rather than an independently
 *  hand-picked literal that can silently drift below the real worst case. */
export const STT_ACQUIRE_MAX_WAIT_MS = 150_000;

let sttActiveCount = 0;
const sttAcquireWaiters: Array<() => void> = [];

/** TEST SEAM: override the cap/bound above for a test that wants to prove contention/timeout behavior
 *  without either spawning real subprocesses or waiting out a real 150s bound. */
let sttMaxConcurrent = STT_MAX_CONCURRENT_TRANSCRIPTIONS;
let sttAcquireMaxWaitMs = STT_ACQUIRE_MAX_WAIT_MS;
export function __setSttConcurrencyForTest(opts: { maxConcurrent?: number; acquireMaxWaitMs?: number } = {}): void {
  sttMaxConcurrent = opts.maxConcurrent ?? STT_MAX_CONCURRENT_TRANSCRIPTIONS;
  sttAcquireMaxWaitMs = opts.acquireMaxWaitMs ?? STT_ACQUIRE_MAX_WAIT_MS;
}
/** TEST SEAM: reset the concurrency gate itself between test cases in the same process (module state would
 *  otherwise leak a held slot or a stale waiter across cases in one test file). */
export function __resetSttConcurrencyGateForTest(): void {
  sttActiveCount = 0;
  sttAcquireWaiters.length = 0;
}

/** Acquire one of `sttMaxConcurrent` global transcription slots, bounded by `sttAcquireMaxWaitMs`. Resolves
 *  `true` once a slot is held (caller MUST `releaseSttSlot()` when done, success or failure), or `false` if
 *  the bound elapsed first (no slot held — nothing to release). Never throws. Exported (alongside
 *  `releaseSttSlot`) so a test can exercise the gate's contention/timeout/FIFO-wake behavior directly,
 *  without spawning a real transcription subprocess. */
export function acquireSttSlot(): Promise<boolean> {
  if (sttActiveCount < sttMaxConcurrent) {
    sttActiveCount++;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const onReady = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sttActiveCount++;
      resolve(true);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const idx = sttAcquireWaiters.indexOf(onReady);
      if (idx >= 0) sttAcquireWaiters.splice(idx, 1);
      resolve(false);
    }, sttAcquireMaxWaitMs);
    // Deliberately NOT unref'd — see chat-gateway.ts's `delay()` doc for why: in the real daemon process
    // this timer is never the only live handle, and unref'ing it only risks a standalone test script
    // dropping the timer before it fires.
    sttAcquireWaiters.push(onReady);
  });
}

/** Release a slot held via `acquireSttSlot()`, waking the longest-waiting queued acquirer, if any. */
export function releaseSttSlot(): void {
  sttActiveCount--;
  const next = sttAcquireWaiters.shift();
  if (next) next();
}

/** TEST SEAM: swap the "actually run the decode" step `createFasterWhisperTranscriber().transcribe()` calls
 *  AFTER acquiring the global slot — lets a test exercise the real acquire/release-around-transcribe wiring
 *  (including a throwing or null-resolving run still releasing the slot via the `finally` below) without a
 *  real python subprocess. Mirrors `__setSttProvisionerForTest`'s shape. */
type TranscribeRunner = (pythonBin: string, filePath: string, langHint: string | null) => Promise<string | null>;
let transcribeRunner: TranscribeRunner = runTranscribeScript;
export function __setTranscribeRunnerForTest(fn?: TranscribeRunner): void {
  transcribeRunner = fn ?? runTranscribeScript;
}

/**
 * Build the injected CompanionTranscriber — local faster-whisper via the shared venv. `pythonInterpreterPath`
 * is the human-only `python.interpreterPath` override (same resolution as the markitdown pre-warm).
 * `enabled` is the daemon-global `platform.companionVoiceEnabled` opt-in gate (default OFF — see
 * PlatformConfig's doc comment); when false, this NEVER calls `resolveSttPython` (so it never kicks venv
 * provisioning) and always reports not-ready, degrading through the EXISTING `transcribe-unavailable` path
 * exactly as if faster-whisper were never installed. Defaults to `true` so existing direct callers/tests are
 * unaffected — the daemon boot path is the one place that resolves and passes the real flag.
 */
export function createFasterWhisperTranscriber(pythonInterpreterPath?: string, enabled = true): CompanionTranscriber {
  return {
    isReady() {
      if (!enabled) return false;
      return resolveSttPython(pythonInterpreterPath) !== null;
    },
    async transcribe({ filePath, langHint }) {
      if (!enabled) return null;
      const bin = resolveSttPython(pythonInterpreterPath);
      if (!bin) return null;
      // Global concurrency cap (card 986bdddd): wait for a slot, bounded — a timed-out wait degrades to the
      // SAME "no transcript" result a real STT failure already produces (never a hang).
      const acquired = await acquireSttSlot();
      if (!acquired) return null;
      try {
        return await transcribeRunner(bin, filePath, langHint);
      } finally {
        releaseSttSlot();
      }
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
