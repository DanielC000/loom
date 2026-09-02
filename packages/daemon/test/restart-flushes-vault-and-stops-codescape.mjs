import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card d671f1b8: `requestDaemonRestart` (the `daemon_restart` MCP tool, the path that actually fires for
// a manager's routine deploy) exits via a bare `process.exit(75)`, which — like the merge-danger-window
// gap `restart-merge-danger-window.mjs` closed — emits NO signal, so `gracefulShutdown`'s own cleanup
// (index.ts, bound only to SIGINT/SIGTERM/SIGHUP + the loopback `/internal/shutdown` hook) never ran for
// THIS path. Two consequences: a vault edit still inside its debounce window at restart time was silently
// dropped from git (recoverable only on the vault's NEXT edit — versioner.ts's chokidar watcher re-arms
// with `ignoreInitial: true` on boot, so it does NOT re-detect the pre-existing dirt), and the codescape
// `serve` child's stop() was skipped (harmless on Windows today — see index.ts's own doc on why — but not
// unconditional).
//
// Fixed by registering ONE shared cleanup function (index.ts's `flushVaultsAndStopCodescape`) with
// `SessionService` via `setShutdownCleanup`, invoked from inside `requestDaemonRestart`'s existing 300ms
// exit-flush timer — AFTER the delay (so the MCP response's own flush window is untouched) but BEFORE the
// actual `exit()` call.
//
// Proves, with a REAL git repo + REAL VaultVersioner (not a mock git):
//   (1) RED, using the SAME (fixed) code: with `shutdownCleanup` left UNREGISTERED — byte-identical to
//       every daemon_restart before this card, since the hook did not exist — a vault edit inside the
//       debounce window is ABSENT from git immediately after the restart's exit fires. This isolates the
//       registration itself as the cause (not "the debounce happened to fire on its own"): same repo, same
//       debounce window, same edit, only the registration differs.
//   (2) GREEN: with `shutdownCleanup` registered (mirroring what index.ts now does automatically at boot),
//       the SAME kind of pending edit LANDS as a real commit, observed immediately after exit fires.
//   (3) The registered cleanup runs strictly AFTER the 300ms flush delay, never before it (so it can never
//       delay the MCP response itself) — proven by an ordering timestamp, not assumed from the code.
//   (4) The cleanup is unconditional/shared: a codescape-stop tracker (a minimal stand-in, not the real
//       supervisor) flips true in the SAME registered call, proving one function drives both halves.
// Run: 1) build daemon (tsc -p tsconfig.json), 2) node test/restart-flushes-vault-and-stops-codescape.mjs
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { pollUntil } from "./_timing-guard.mjs";

process.env.LOOM_HOME = mkdtempManaged("loom-restart-flush-home-");
process.env.LOOM_SUPERVISED = "1"; // requestDaemonRestart refuses outright when unsupervised

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { clearRestartIntent } = await import("../dist/orchestration/restart.js");
const { VaultVersioner } = await import("../dist/vault/versioner.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const makeExit = () => { const calls = []; return { calls, fn: (code) => calls.push({ code, at: performance.now() }) }; };

const git = (cwd, args) => execSync(`git ${args}`, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init");
  git(dir, "config user.email restart-flush@example.com");
  git(dir, "config user.name restart-flush-test");
}
const commitCount = (dir) => parseInt(git(dir, "rev-list --all --count").trim() || "0", 10);

// LARGE relative to the whole test's wall time — the debounced async commit() must NOT have a chance to
// fire on its own during either case below, so any observed commit is provably from the exit-time flush,
// never a race against the versioner's own timer.
const DEBOUNCE_MS = 60_000;

const db = new Db();
const sessions = new SessionService(db, {}, new OrchestrationControl());

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const ids = { projId: `rfv-proj-${sfx}`, agentId: `rfv-agent-${sfx}`, mgrId: `rfv-mgr-${sfx}` };
const now = new Date().toISOString();
const FAKE_PROJECT_REPO = path.join(mkdtempManaged("loom-rfv-fake-repo-"), "repo"); // never touched on disk — this test never calls a real merge
const buildDeps = { runStep: async () => ({ code: 0, out: "" }) }; // instant green build, shared by every case below

try {
  db.insertProject({ id: ids.projId, name: "RFV", repoPath: FAKE_PROJECT_REPO, vaultPath: FAKE_PROJECT_REPO, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: ids.agentId, projectId: ids.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: ids.mgrId, projectId: ids.projId, agentId: ids.agentId, engineSessionId: null, title: null, cwd: FAKE_PROJECT_REPO, processState: "running", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  const vaultRepo = mkdtempManaged("loom-rfv-vault-");
  initRepo(vaultRepo);
  git(vaultRepo, 'commit --allow-empty -m "initial"'); // a real first commit, so rev-list count is meaningful
  const vc = new VaultVersioner(vaultRepo, DEBOUNCE_MS);
  await vc.start();

  const codescapeStop = { calls: 0, stop() { this.calls++; } };

  // --- (1) RED: shutdownCleanup left UNREGISTERED (the field's default -- what EVERY daemon_restart did
  // before this card, since the hook didn't exist at all) ---
  fs.writeFileSync(path.join(vaultRepo, "urgent.md"), "edited just before a daemon_restart\n");
  const beforeRed = commitCount(vaultRepo);
  check("(1-pre) edit is staged as a real pending change (debounce window, nothing committed yet)", beforeRed === 1);

  const exitRed = makeExit();
  const rRed = await sessions.requestDaemonRestart(ids.mgrId, "restart with no cleanup registered (RED)", { buildDeps, exit: exitRed.fn, mergeDangerGraceMs: 500 });
  check("(1) restarting:true", rRed.restarting === true);
  const exitFiredRed = await pollUntil(() => exitRed.calls.length > 0, { timeoutMs: 2000, intervalMs: 20 });
  check("(1) exit fired within the 300ms flush delay", exitFiredRed);
  check(
    "(1) RED: with shutdownCleanup unregistered, the pending vault edit is ABSENT from git immediately after exit fires " +
    "(this is the exact pre-fix behavior byte-for-byte, since the hook did not exist before this card)",
    commitCount(vaultRepo) === beforeRed,
  );
  check("(1) RED: codescape-stop tracker was NOT called (nothing was registered to call it)", codescapeStop.calls === 0);
  clearRestartIntent();

  // --- (2) GREEN: register the shared cleanup (mirrors index.ts's flushVaultsAndStopCodescape) ---
  let cleanupRanAt = null;
  sessions.setShutdownCleanup(() => {
    cleanupRanAt = performance.now();
    vc.flushSync();
    codescapeStop.stop();
  });

  const beforeGreen = commitCount(vaultRepo); // same repo, same still-uncommitted edit from (1) -- RED never touched it
  check("(2-pre) the same pending edit from (1) is still uncommitted (RED truly never flushed it)", beforeGreen === beforeRed);

  const exitGreen = makeExit();
  const tGreenStart = performance.now();
  const rGreen = await sessions.requestDaemonRestart(ids.mgrId, "restart with cleanup registered (GREEN)", { buildDeps, exit: exitGreen.fn, mergeDangerGraceMs: 500 });
  check("(2) restarting:true", rGreen.restarting === true);
  const exitFiredGreen = await pollUntil(() => exitGreen.calls.length > 0, { timeoutMs: 2000, intervalMs: 20 });
  check("(2) exit fired within the flush delay", exitFiredGreen);
  check(
    "(2) GREEN: with shutdownCleanup registered, the SAME kind of pending vault edit LANDS as a real commit " +
    "(control: identical repo/debounce/edit shape as (1), only the registration differs)",
    commitCount(vaultRepo) === beforeGreen + 1,
  );
  check("(2) GREEN: codescape-stop tracker WAS called by the SAME registered cleanup (one shared function, both halves)", codescapeStop.calls === 1);

  // --- (3) ordering: cleanup runs strictly AFTER the 300ms delay, before exit ---
  check(
    "(3) registered cleanup ran AFTER requestDaemonRestart returned (i.e. after the merge-danger wait settled), " +
    "not synchronously inline with it",
    cleanupRanAt !== null && cleanupRanAt >= tGreenStart,
  );
  check(
    "(3) cleanup's own timestamp lands at/around the 300ms flush delay (>=250ms after the call started), " +
    "consistent with running inside the exit-flush timer rather than before it",
    cleanupRanAt !== null && cleanupRanAt - tGreenStart >= 250,
  );
  check(
    "(3) exit's captured timestamp is >= cleanup's timestamp (cleanup completes before exit() is invoked, " +
    "same synchronous callback)",
    exitGreen.calls.length === 1 && exitGreen.calls[0].at >= cleanupRanAt,
  );
  clearRestartIntent();

  await vc.stop();
} finally {
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS -- daemon_restart's exit path now runs the SAME shared vault-flush + codescape-stop " +
    "cleanup gracefulShutdown already ran: a pending vault edit that was silently dropped before this card " +
    "now lands, proven against the SAME repo/timing with only the registration flipped (not a race against " +
    "the debounce timer), the cleanup never delays the 300ms MCP-response-flush window, and it drives both " +
    "halves (vault + codescape) from one place."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
