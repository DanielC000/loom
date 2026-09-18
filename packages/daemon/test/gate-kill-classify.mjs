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
//   (D) card c59b3e39: pins, as an automated regression, the "confirmed by hand" claim just below — a
//       REAL runGateStep run, under a compound `shell:true` command (mirroring this project's own `&&`
//       gateCommand), whose descendant is force-killed by a THIRD-PARTY process (`taskkill /F /PID`).
//       Covers BOTH the shell's DIRECT child and a deeper GRANDCHILD, to settle whether depth matters —
//       it does not: both report the identical (code, signal:null) shape, so `classifyGateFailure` reads
//       BOTH as "genuine", never "kill". WINDOWS-ONLY (see (D)'s own comment for why POSIX is untested
//       here, not merely unasserted).
//
// A REAL external (non-self, non-our-timeout) SIGKILL was investigated as the "real signal" alternative
// the card's DoD allows ("via an injected runner or a real signal if feasible") — on this platform
// (win32) it is NOT feasible: a child killed by a THIRD-PARTY process (`taskkill /F /PID`, the closest
// simulation of a real OOM-killer) reports close(1, null) to the parent, no signal at all — confirmed by
// hand before writing this file, and now pinned mechanically by section (D) below (card c59b3e39). Node
// only annotates `signal` on close when the SAME process's own `ChildProcess.kill()` requested it (see
// runGateStep's own timeout branch below, which hardcodes the result rather than relying on the child's
// real close event for exactly this reason). So the external-kill ("kill") classification bucket is
// proven at the SessionService/confirmWorkerMerge layer via an injected gate runner in
// merge-gate-retry.mjs, where a deterministic fake is the only honest way to represent "an OS killed this
// out from under us" on every platform this daemon runs on — section (D) below does not change that; it
// only pins the REAL Windows shape that makes the injected fake necessary in the first place.
// Run: 1) build daemon (pnpm build), 2) node test/gate-kill-classify.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn as spawnProcess } from "node:child_process";
import { classifyGateFailure, runGateStep } from "../dist/orchestration/gate-runner.js";
import { CONTROL_CHAR_RE } from "../dist/pty/host.js";
import { resolveConfig } from "@loom/shared";
import { waitUntil } from "./_wait.mjs";

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

// --- (D) card c59b3e39: a REAL external kill of a descendant under a COMPOUND `shell:true` command
//     (mirroring runGateStep's own spawn shape AND this project's own `&&`-chained gateCommand — see
//     `my_context().gateCommand`) — does close() report a signal? Covers BOTH the shell's DIRECT child
//     and a deeper GRANDCHILD, to settle whether depth changes the answer. WINDOWS-ONLY hard assertion:
//     a real OS-level signal has genuinely different semantics on POSIX (a shell may tail-exec its last
//     command, or a real SIGKILL may be forwarded through actual signal delivery) — that is UNTESTED by
//     this card (no POSIX host was available to it), not merely unasserted, so this section skips there
//     rather than guessing. If a future POSIX investigation establishes the answer there, extend this
//     section — don't invent an assertion for a platform nobody has run it on.
if (process.platform !== "win32") {
  // Card 85bd4052's WARN-line convention: a bare SKIP is discarded by test-daemon.mjs once this file
  // reports PASS overall, leaving zero trace on ubuntu-latest CI that section (D) never ran there.
  console.log("WARN  SKIP  gate-kill-classify.mjs (D) — real external-kill signal shape is Windows-only verified (card c59b3e39); not asserted on POSIX.");
} else {
  const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const q = (p) => `"${p}"`;
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-gkc-extkill-"));

  const runExternalKillCase = async (label, { command, pidFile }) => {
    const resultPromise = runGateStep(command, scratchDir, 10_000);
    await waitUntil(() => fs.existsSync(pidFile), { timeoutMs: 5000, label: `${label}: pid file written` });
    const targetPid = Number(fs.readFileSync(pidFile, "utf8").trim());
    check(`(D:${label}) the target pid file was actually written (the target really started)`,
      Number.isFinite(targetPid) && targetPid > 0);

    const tk = spawnProcess("taskkill", ["/PID", String(targetPid), "/F"], { stdio: "ignore" });
    await new Promise((resolve) => { tk.on("close", resolve); tk.on("error", resolve); });
    await waitUntil(() => !isAlive(targetPid), { timeoutMs: 5000, label: `${label}: target actually gone` });
    check(`(D:${label}) the external taskkill actually killed the target (positive confirmation, not assumed)`, !isAlive(targetPid));

    const result = await resultPromise;
    check(`(D:${label}) runGateStep settled via a REAL close event, not our own timeout bound`, result.timedOut === false);
    check(`(D:${label}) close() reports NO signal for a third-party-killed descendant on win32`, result.signal === null);
    check(`(D:${label}) close() reports a plain non-zero exit code instead`, typeof result.status === "number" && result.status !== 0);

    const classification = classifyGateFailure({ failedSignal: result.signal ?? null, failedTimedOut: result.timedOut ?? false });
    check(`(D:${label}) classifyGateFailure MISCLASSIFIES this real external kill as "genuine", never "kill"`,
      classification === "genuine");
  };

  // D1 — DIRECT CHILD: the compound command's first step IS the killed process (one hop under the shell).
  const directPidFile = path.join(scratchDir, "direct.pid");
  const directScript = path.join(scratchDir, "direct.cjs");
  fs.writeFileSync(directScript, [
    "const fs = require(\"node:fs\");",
    `fs.writeFileSync(${JSON.stringify(directPidFile)}, String(process.pid));`,
    "setInterval(() => {}, 1000);",
  ].join("\n"));
  await runExternalKillCase("direct-child", {
    command: `${q(process.execPath)} ${q(directScript)} && ${q(process.execPath)} -e "0"`,
    pidFile: directPidFile,
  });

  // D2 — GRANDCHILD: the compound command's first step spawns ITS OWN child (a SEPARATE script file,
  // not an inline `-e` string — nesting JSON.stringify'd paths inside an already-quoted `-e` argument
  // breaks on an unescaped embedded `"`), forwards that child's exit status as its own (the real shape of
  // e.g. `pnpm` forwarding a forked test-runner's exit code) — so the shell's close event still settles
  // NATURALLY off the grandchild's death, never via our own timeout.
  const gcPidFile = path.join(scratchDir, "grandchild.pid");
  const grandchildScript = path.join(scratchDir, "grandchild.cjs");
  fs.writeFileSync(grandchildScript, [
    "const fs = require(\"node:fs\");",
    `fs.writeFileSync(${JSON.stringify(gcPidFile)}, String(process.pid));`,
    "setInterval(() => {}, 1000);",
  ].join("\n"));
  const midpointScript = path.join(scratchDir, "midpoint.cjs");
  fs.writeFileSync(midpointScript, [
    "const { spawn } = require(\"node:child_process\");",
    `const gc = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(grandchildScript)}], { stdio: "ignore" });`,
    "gc.on(\"exit\", (code) => process.exit(code ?? 1));",
    "gc.on(\"error\", () => process.exit(1));",
  ].join("\n"));
  await runExternalKillCase("grandchild", {
    command: `${q(process.execPath)} ${q(midpointScript)} && ${q(process.execPath)} -e "0"`,
    pidFile: gcPidFile,
  });

  try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
}

// --- gate-retry policy defaults sanity (sweep G3: promoted from gate-runner.js module constants to
//     @loom/shared's live-resolvable OrchestrationConfig.gateRetry — see resolveConfig); the actual
//     override-takes-effect proof lives in merge-gate-retry-disabled.mjs / merge-gate-retry.mjs, and the
//     full precedence (override > env > default, both resolveConfig paths) in platform-config.mjs (23) ---
const gateRetryDefault = resolveConfig(undefined).orchestration.gateRetry;
check("(defaults) gateRetry.enabled defaults true with no env override", gateRetryDefault.enabled === true);
check("(defaults) gateRetry.settleMs defaults to a positive, sane delay", Number.isFinite(gateRetryDefault.settleMs) && gateRetryDefault.settleMs > 0);

console.log(failures === 0
  ? "\n✅ ALL PASS — classifyGateFailure's three buckets are correct, a real hanging child is genuinely killed by our own timeout bound (settled-race resolves once), the control-char strip neutralizes an embedded bracketed-paste terminator while leaving ordinary output untouched, and (win32) a real third-party kill of either a direct child or a grandchild under a compound command reports no signal — classifyGateFailure reads both as 'genuine', never 'kill'."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
