import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Merge-gate KILL-CLASSIFICATION test (card bcba83a1 — the gate "lies" under memory pressure). HERMETIC:
// NO daemon, no live claude. Proves the pieces d1fbdf38 left UNTESTED that this card's auto-retry now
// depends on:
//   (A) classifyGateFailure's three buckets, as a pure function over constructed GateStepResult shapes.
//   (B) runGateStep's OWN-TIMEOUT capture is REAL, not just asserted on paper: a genuinely hanging child,
//       killed by OUR OWN bound, resolves the settled-race exactly once with signal:"SIGKILL",
//       timedOut:true, status:null — and does so close to the timeout, never hanging the test itself.
//   (C) the injection-hygiene strip (CR e926d258 Minor): CONTROL_CHAR_RE removes ESC (and every other C0
//       control char) from a string, turning the bracketed-paste terminator `\x1b[201~` into the inert
//       literal text `[201~` — the exact neutralization confirmWorkerMerge now applies to a gate's
//       outputTail/failingTest before piping it through enqueueStdin.
//
// A REAL external (non-self, non-our-timeout) SIGKILL was investigated as the "real signal" alternative
// the card's DoD allows ("via an injected runner or a real signal if feasible") — on this platform
// (win32) it is NOT feasible: a child killed by a THIRD-PARTY process (`taskkill /F /PID`, the closest
// simulation of a real OOM-killer) reports close(1, null) to the parent, no signal at all — confirmed by
// hand before writing this file. Node only annotates `signal` on close when the SAME process's own
// `ChildProcess.kill()` requested it (see runGateStep's own timeout branch below, which hardcodes the
// result rather than relying on the child's real close event for exactly this reason). So the
// external-kill ("kill") classification bucket is proven at the SessionService/confirmWorkerMerge layer
// via an injected gate runner in merge-gate-retry.mjs, where a deterministic fake is the only honest way
// to represent "an OS killed this out from under us" on every platform this daemon runs on.
// Run: 1) build daemon (pnpm build), 2) node test/gate-kill-classify.mjs
import { classifyGateFailure, runGateStep, GATE_RETRY_ENABLED, GATE_RETRY_SETTLE_MS } from "../dist/orchestration/gate-runner.js";
import { CONTROL_CHAR_RE } from "../dist/pty/host.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- (A) classifyGateFailure: pure classification over constructed shapes ---
check("(classify) clean non-zero exit, no signal, no timeout -> 'genuine'",
  classifyGateFailure({ failedSignal: null, failedTimedOut: false }) === "genuine");
check("(classify) signal set, OUR timeout NOT the cause -> 'kill' (the OOM/external-kill shape)",
  classifyGateFailure({ failedSignal: "SIGKILL", failedTimedOut: false }) === "kill");
check("(classify) timedOut:true (our own bound) -> 'timeout', even though runGateStep always pairs it with signal:SIGKILL",
  classifyGateFailure({ failedSignal: "SIGKILL", failedTimedOut: true }) === "timeout");
check("(classify) timedOut:true with no signal recorded still -> 'timeout' (our bound is the authoritative cause)",
  classifyGateFailure({ failedSignal: null, failedTimedOut: true }) === "timeout");
check("(classify) 'kill' and 'timeout' are both distinct from 'genuine' (both retry-eligible)",
  classifyGateFailure({ failedSignal: "SIGKILL", failedTimedOut: false }) !== "genuine" &&
  classifyGateFailure({ failedSignal: "SIGKILL", failedTimedOut: true }) !== "genuine");

// --- (B) runGateStep: a REAL hanging child, killed by OUR OWN timeout bound ---
{
  const started = Date.now();
  const HANG_SCRIPT = "setTimeout(() => {}, 30000)"; // outlives the tiny timeout below by a wide margin
  const timeoutMs = 300;
  const result = await runGateStep(`node -e "${HANG_SCRIPT}"`, process.cwd(), timeoutMs);
  const elapsed = Date.now() - started;
  check("(hang) our own timeout bound fires: timedOut:true", result.timedOut === true);
  check("(hang) our own timeout bound fires: signal:'SIGKILL'", result.signal === "SIGKILL");
  check("(hang) our own timeout bound fires: status:null (never exited on its own)", result.status === null);
  check("(hang) the settled-race resolves ONCE, promptly (well under 10x the timeout bound, never hangs the test)",
    elapsed < timeoutMs * 10);
}

// --- (C) injection hygiene: CONTROL_CHAR_RE strips C0 control chars, incl. the ESC that starts a
//     bracketed-paste terminator, turning it into inert literal text ---
{
  const raw = `FAIL widget.spec.js\x1b[31m colorized\x1b[0m\x1b[201~rm -rf /\x1b[201~ trailing text`;
  const sanitized = raw.replace(CONTROL_CHAR_RE, "");
  check("(sanitize) the sanitized string contains no raw ESC (0x1B) byte", !sanitized.includes("\x1b"));
  check("(sanitize) the bracketed-paste terminator becomes inert literal text, not a live escape",
    sanitized.includes("[201~") && !sanitized.includes("\x1b[201~"));
  check("(sanitize) ordinary printable content (the FAIL line, the payload text) survives untouched",
    sanitized.includes("FAIL widget.spec.js") && sanitized.includes("rm -rf /") && sanitized.includes("trailing text"));
}

// --- env-overridable constants sanity (mirrors host.ts's Number(process.env.LOOM_X) || default pattern);
//     the actual override-takes-effect proof lives in merge-gate-retry-disabled.mjs (a fresh process
//     needs the env var set BEFORE this module is first imported) ---
check("(env) GATE_RETRY_ENABLED defaults true with no env override", GATE_RETRY_ENABLED === true);
check("(env) GATE_RETRY_SETTLE_MS defaults to a positive, sane delay", Number.isFinite(GATE_RETRY_SETTLE_MS) && GATE_RETRY_SETTLE_MS > 0);

console.log(failures === 0
  ? "\n✅ ALL PASS — classifyGateFailure's three buckets are correct, a real hanging child is genuinely killed by our own timeout bound (settled-race resolves once), and the control-char strip neutralizes an embedded bracketed-paste terminator while leaving ordinary output untouched."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
