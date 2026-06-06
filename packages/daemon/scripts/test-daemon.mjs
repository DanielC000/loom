// `pnpm --filter @loom/daemon test:daemon` — run the daemon's HERMETIC, claude-free test suite,
// isolated BY CONSTRUCTION: every test runs in its OWN fresh temp LOOM_HOME, on a non-4317 LOOM_PORT,
// with LOOM_TEST=1 set. So "run the daemon tests" can NEVER touch the prod db (~/.loom/loom.db) or the
// prod daemon on :4317 — the failure mode that wiped prod on 2026-06-04 (see test/_guard.mjs + the
// db.ts prod-guard). Each test ALSO arms its own guard (import "./_guard.mjs"), so this envelope is
// belt-and-suspenders, not the only line of defence.
//
// Run after a build (the tests import dist/):  pnpm --filter @loom/daemon build && pnpm --filter @loom/daemon test:daemon
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, "..", "test");

// The stable hermetic suite: every test below boots NO external daemon and spawns NO real `claude`
// (in-process Db/SessionService against a fake pty, or self-contained fs/git). Each is verified green.
const HERMETIC = [
  "prod-guard",               // the guard itself
  "orch-model", "dead-id", "boot-reconcile", "boot-reconcile-keep-work", "merge-done-crash-recovery", "restart-intent", "restart-fleet",
  "profiles", "profiles-crud", "profile-spawn", "browser-testing-spawn", "platform-home", "platform-mgmt-surface", "platform-elevated-surface", "audit-surface",
  "agent-runs-keys", "agent-runs-primitive", "agent-runs-rest", "agent-runs-caps", "agent-runs-hardening", "agent-runs-audit",
  "tasks-filter", "tasks-priority", "config-bounds", "kanban-defaults", "transcript-encode", "alert-webhook",
  "session-archive", "all-archived-sessions",
  "claude-config", "trust-lock", "spawn-args",
  "context-watcher", "context-stats", "recycle-handoff", "wake",
  "idle-watch-foundation", "idle-watcher", "idle-report", "inbox-pull", "usage-status", "rate-limit-clear",
  "skills-inject", "skills-store-durability", "vault-lint", "vault-browser", "vault-writer", "git-writer",
  "worker-diff", "worktrees", "worktree-provision", "spawn-recut-stale-branch", "merge-finalize-resilient",
  "pty-busy-drain", "pty-resume-readiness", "pty-stop-queue", "resume-mode-cycles", "resume-mode-detect", "resume-mode-feedback", "shell-terminal",
  "db-backup",
];

// NOT run here (require a human-started isolated daemon and/or a real `claude` login, or are helpers):
//   • Real-claude / external-daemon (carry the guard; run manually per their header comment):
//     integration-e2e, orchestration-e2e, manager-live, messaging, mgmt-surface, orch-scope,
//     orch-spawn, mcp-scope, platform-scope, recycle, scheduler, scheduler-drain, scheduler-disabled,
//     usage-limit-detect, usage-limit-resume, worker-report, autonomy-rails, busy-flag, merge-gate,
//     board-consistency, skills-e2e, profiles-rest.
//   • Helpers: _trust-writer (child worker for trust-lock).

let pass = 0;
const failed = [];
const tmpRoots = [];

HERMETIC.forEach((name, i) => {
  const file = path.join(TEST_DIR, `${name}.mjs`);
  if (!fs.existsSync(file)) { console.log(`SKIP  ${name} (missing)`); return; }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `loom-td-${name}-`));
  tmpRoots.push(home);
  const port = 4400 + (i % 800); // non-4317, low-collision; tests run sequentially so reuse is fine
  const r = spawnSync(process.execPath, [file], {
    env: { ...process.env, LOOM_HOME: home, LOOM_PORT: String(port), LOOM_TEST: "1" },
    encoding: "utf8",
    timeout: 120_000,
  });
  const ok = r.status === 0;
  if (ok) pass++; else failed.push({ name, status: r.status, tail: (r.stdout || "").split("\n").filter(Boolean).slice(-1)[0] || (r.stderr || "").split("\n").filter(Boolean).slice(-1)[0] });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (exit ${r.status})`}`);
});

// Best-effort cleanup of the per-test temp homes (WAL handles may briefly hold a few on Windows).
for (const root of tmpRoots) {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { /* retry */ } }
}

console.log(`\n${pass}/${HERMETIC.length} hermetic daemon tests passed.`);
if (failed.length) {
  console.log("FAILURES:");
  for (const f of failed) console.log(`  - ${f.name} (exit ${f.status}): ${f.tail ?? ""}`);
  process.exit(1);
}
console.log("✅ hermetic daemon suite green — never touched prod.");
