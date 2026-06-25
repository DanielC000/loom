import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Markitdown provisioning is DIAGNOSTIC, RETRYABLE, and BOUNDED — the regression test for the
// "silent, undiagnosable, one-shot black box" defect (card f9268cc6).
//
// THE BUG (observed): a user with THREE valid Pythons on PATH enabled documentConversion, yet provisioning
// dead-ended with the lumped "no base Python >=3.10, or venv/pip failed" log and NEVER retried — because
//   1. venv/pip ran with stdio:'ignore' so the REAL failure (proxy/SSL/timeout) was discarded;
//   2. the 3-min pip bound killed the heavy markitdown[all] download and mislabeled it generic failure;
//   3. a PERMANENT one-shot (markitdownProvisionTried) blocked every retry for the life of the process —
//      even re-saving the profile silently no-op'd;
//   4. no status surface anywhere (only a buried console.warn).
//
// THE FIX (asserted here): ensurePythonPackageAsync now resolves a CLASSIFIED { binary, outcome, errorTail }
// (no-base-python / venv-create-failed / pip-failed / timeout / ready / disabled), the kick maps that onto a
// status model {state: idle|installing|ready|failed, reason, errorTail, binary, lastAttemptAt} read by the
// human-only REST layer, the kick is RETRYABLE (deduped only while genuinely in-flight, not a permanent
// one-shot), and the markitdown pip bound is raised to 15 min.
//
// HERMETIC: a temp LOOM_HOME with NO venv + LOOM_PYTHON_NO_PROVISION=1, and a fake provisioner INJECTED via
// __setMarkitdownProvisionerForTest so every outcome is driven WITHOUT building a real venv or hitting the
// network. We trigger the spawn-path kick through markitdownMcpServer() (the cold-resolve path).
//
// Run: 1) build, 2) node test/markitdown-provision-diagnostic.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic: temp LOOM_HOME with NO venv; venv-resolution path (not the LOOM_MARKITDOWN_BIN override seam);
// provisioning DISABLED (belt-and-suspenders — the injected fake replaces the real provisioner entirely). Set
// BEFORE importing dist so paths.ts captures LOOM_HOME and host.ts module state starts fresh. ---
const tmpHome = path.join(os.tmpdir(), `loom-mddiag-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpHome, { recursive: true });
process.env.LOOM_HOME = tmpHome;
delete process.env.LOOM_MARKITDOWN_BIN;
process.env.LOOM_PYTHON_NO_PROVISION = "1";

const {
  markitdownMcpServer, buildMcpServers, getMarkitdownProvisionStatus,
  __markitdownProvisionKicks, __setMarkitdownProvisionerForTest,
} = await import("../dist/pty/host.js");
const { loomVenvDir } = await import("../dist/python/venv.js");

// Flush the kick's microtask chain (fake resolve → .then → .finally) to a macrotask boundary.
const flush = () => new Promise((r) => setTimeout(r, 10));
// A fake provisioner that resolves immediately to a fixed classified result (no venv, no network).
const fixed = (result) => async () => result;
// A GATED fake: returns a promise we resolve by hand, so we can observe the `installing` state mid-flight.
let gate;
const newGate = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); gate = { promise, resolve }; };
const gated = () => gate.promise;
const READY_BIN = path.join(loomVenvDir(), "Scripts", "markitdown-mcp.exe"); // a plausible absolute path

// ===================== (a) FAILURE CLASSIFICATION — the specific reason + tail, not the lumped message =====================
// pip non-zero ⇒ failed + reason 'pip-failed' + the captured stderr tail (the SSL/proxy/resolver reason).
__setMarkitdownProvisionerForTest(fixed({ binary: null, outcome: "pip-failed", errorTail: "ERROR: Could not fetch URL (SSLError: CERTIFICATE_VERIFY_FAILED)" }));
check("(a) after reset the status is idle", getMarkitdownProvisionStatus().state === "idle");
check("(a) markitdownMcpServer() returns null on the cold path", markitdownMcpServer() === null);
check("(a) the cold resolve kicked provisioning once", __markitdownProvisionKicks() === 1);
await flush();
let s = getMarkitdownProvisionStatus();
check("(a) pip non-zero ⇒ state 'failed'", s.state === "failed");
check("(a) pip non-zero ⇒ reason 'pip-failed' (not the lumped message)", s.reason === "pip-failed");
check("(a) pip non-zero ⇒ the captured stderr tail is surfaced", typeof s.errorTail === "string" && s.errorTail.includes("CERTIFICATE_VERIFY_FAILED"));
check("(a) a failed attempt records lastAttemptAt", typeof s.lastAttemptAt === "number");

// timeout (killed by the bound) ⇒ failed + reason 'timeout' (distinct from a plain non-zero exit).
__setMarkitdownProvisionerForTest(fixed({ binary: null, outcome: "timeout", errorTail: "...downloading onnxruntime (killed at the bound)" }));
markitdownMcpServer();
await flush();
s = getMarkitdownProvisionStatus();
check("(a) timeout ⇒ state 'failed'", s.state === "failed");
check("(a) timeout ⇒ reason 'timeout' (the heavy install exceeding the bound, not a generic failure)", s.reason === "timeout");
check("(a) timeout ⇒ captured tail surfaced", typeof s.errorTail === "string" && s.errorTail.includes("onnxruntime"));

// no base python ⇒ failed + reason 'no-base-python' (no tail — nothing ran).
__setMarkitdownProvisionerForTest(fixed({ binary: null, outcome: "no-base-python" }));
markitdownMcpServer();
await flush();
s = getMarkitdownProvisionStatus();
check("(a) no base python ⇒ state 'failed'", s.state === "failed");
check("(a) no base python ⇒ reason 'no-base-python'", s.reason === "no-base-python");
check("(a) no base python ⇒ no errorTail (nothing ran to capture)", s.errorTail === undefined);

// ===================== (b) RETRYABILITY — a fresh kick is allowed after a failed attempt (one-shot no longer permanent) =====================
__setMarkitdownProvisionerForTest(fixed({ binary: null, outcome: "pip-failed", errorTail: "boom" }));
markitdownMcpServer();          // kick #1
await flush();
check("(b) first attempt failed", getMarkitdownProvisionStatus().state === "failed");
check("(b) exactly one kick so far", __markitdownProvisionKicks() === 1);
markitdownMcpServer();          // a LATER spawn / explicit retry — must be ALLOWED (no permanent one-shot)
check("(b) a fresh kick is allowed after a terminal failure (retryable, not a dead-end)", __markitdownProvisionKicks() === 2);
check("(b) re-kick flips the status back to 'installing'", getMarkitdownProvisionStatus().state === "installing");
await flush();

// Concurrent kicks dedupe to ONE in-flight install (never parallel pip installs).
__setMarkitdownProvisionerForTest(gated);
newGate();
markitdownMcpServer();
markitdownMcpServer();
markitdownMcpServer();          // 3 concurrent cold resolves
check("(b) concurrent kicks dedupe to ONE in-flight install (no parallel pip)", __markitdownProvisionKicks() === 1);
check("(b) while in-flight the status is 'installing'", getMarkitdownProvisionStatus().state === "installing");
gate.resolve({ binary: READY_BIN, outcome: "ready" });
await flush();
check("(b) after the single in-flight install resolves ready, status is 'ready'", getMarkitdownProvisionStatus().state === "ready");

// ===================== (c) STATUS TRANSITIONS — idle → installing → ready / → failed =====================
// idle → installing → ready
__setMarkitdownProvisionerForTest(gated);
newGate();
check("(c) starts idle", getMarkitdownProvisionStatus().state === "idle");
markitdownMcpServer();
let mid = getMarkitdownProvisionStatus();
check("(c) idle → installing on kick", mid.state === "installing");
check("(c) installing records lastAttemptAt", typeof mid.lastAttemptAt === "number");
gate.resolve({ binary: READY_BIN, outcome: "ready" });
await flush();
let done = getMarkitdownProvisionStatus();
check("(c) installing → ready on success", done.state === "ready");
check("(c) ready exposes the resolved absolute binary", done.binary === READY_BIN);
check("(c) ready clears the failure fields", done.reason === undefined && done.errorTail === undefined);

// idle → installing → failed
__setMarkitdownProvisionerForTest(gated);
newGate();
markitdownMcpServer();
check("(c) installing again on a fresh kick", getMarkitdownProvisionStatus().state === "installing");
gate.resolve({ binary: null, outcome: "venv-create-failed", errorTail: "Error: [Errno 13] Permission denied" });
await flush();
let failed = getMarkitdownProvisionStatus();
check("(c) installing → failed on a venv-create failure", failed.state === "failed");
check("(c) failed carries reason 'venv-create-failed'", failed.reason === "venv-create-failed");
check("(c) failed carries the captured tail", typeof failed.errorTail === "string" && failed.errorTail.includes("Permission denied"));

// getMarkitdownProvisionStatus returns a COPY (mutating it can't corrupt the live status).
const snap = getMarkitdownProvisionStatus();
snap.state = "idle"; snap.reason = undefined;
check("(c) the getter returns a COPY (external mutation does not affect the live status)", getMarkitdownProvisionStatus().state === "failed");

// ===================== (c2) WARM-RESOLVE WITHOUT A KICK ⇒ ready (a manual/already-present venv, or the
// LOOM_MARKITDOWN_BIN override) — status must NOT sit stuck at idle while the tool actually works =====================
__setMarkitdownProvisionerForTest(); // restore real provisioner + reset status→idle, memo + kicks→0
check("(c2) reset back to idle before the warm-resolve case", getMarkitdownProvisionStatus().state === "idle");
process.env.LOOM_MARKITDOWN_BIN = process.execPath; // a real absolute binary → resolves warm with NO kick
const warmSrv = markitdownMcpServer();
check("(c2) the warm override resolves a stdio server (no kick needed)", warmSrv !== null && warmSrv.command === process.execPath);
const warm = getMarkitdownProvisionStatus();
check("(c2) a warm-resolved binary marks status 'ready' (not stuck at idle)", warm.state === "ready");
check("(c2) ready exposes the resolved binary even though no kick ran", warm.binary === process.execPath);
check("(c2) the warm resolve did NOT kick background provisioning", __markitdownProvisionKicks() === 0);
delete process.env.LOOM_MARKITDOWN_BIN; // keep the env clean for the remaining checks

// ===================== (d-ish) the OFF map stays byte-identical even with the new status surface =====================
const off = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker", documentConversion: false });
const noFlag = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker" });
check("(d) documentConversion OFF map is byte-identical to a no-flag spawn (status surface is additive)",
  JSON.stringify(off) === JSON.stringify(noFlag));

// No real venv was ever built (the injected fake + the disable seam held).
check("(d) NO real venv was created (fakes only — no venv/pip/network)", !fs.existsSync(loomVenvDir()));

// Restore the real provisioner so we leave no global seam armed.
__setMarkitdownProvisionerForTest();
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — markitdown provisioning is DIAGNOSTIC (classified outcome + captured error tail, not the lumped message), RETRYABLE (deduped only while in-flight — a fresh kick is allowed after a terminal failure; concurrent kicks never launch parallel pip), and STATUS-tracked (idle→installing→ready/failed via a copy-returning getter for the human-only REST layer) — all hermetic, no real venv/pip/network."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
