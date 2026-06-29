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
  "orch-model", "dead-id", "boot-reconcile", "boot-reconcile-keep-work", "merge-done-crash-recovery", "restart-intent", "restart-fleet", "build-gate-integrity",
  "scheduler-auditor-budget", // auditors lifted out of the manager cap → their own small budget (hermetic, daemon-free)
  "scheduler-fire-failed",    // a thrown scheduled spawn records a durable schedule_fire_failed event (not just stderr)
  "restart-resume-coherence", // PL Auditor finding #11: resume nudges NOTE the file-read tracking reset; ONE coherent resume turn, no bare-"Continue" disclaimer (card 5d8dea5f)
  "restart-wake-classification", // card 5907b71e: cheap no-op wake for an unaffected bystander + completion-escalation de-dup (one completion = one turn)

  "manager-context-block", // PL Auditor finding #8: managers get the "Where things live" absolute repo+vault block; workers stay byte-identical
  "worker-prompt", // card af902717: workers get their agent base brief composed ahead of the kickoff (spawn) / handoff (recycle); empty brief degrades to dynamic-only
  "profiles", "profiles-crud", "profile-customization", "profile-spawn", "setup-profile", "setup-home", "browser-testing-spawn", "document-conversion-spawn", "markitdown-provision-nonblocking", "markitdown-prewarm", "markitdown-provision-diagnostic", "platform-dev-flag", "platform-home", "platform-home-rest", "platform-lead-singleton", "platform-lead-recycle", "platform-mgmt-surface", "platform-elevated-surface", "platform-agent-update", "platform-config", "platform-messaging", "platform-cross-project-task", "project-rebind", "audit-surface", "setup-surface", "setup-bind-identity", "setup-singleton", "setup-first-run", "workspace-auditor-role", "user-audit-surface", "user-audit-handoff", "surface-subset", "workspace-auditor-start",
  "platform-prompt-migration",
  "agent-runs-keys", "agent-runs-primitive", "agent-runs-rest", "agent-runs-idempotency", "agent-runs-caps", "agent-runs-spend", "agent-runs-hardening", "agent-runs-audit",
  "audit-log", // replayable + diffable session/run audit log over the existing orchestration_events + sessions store (timeline + LCS/kind-delta diff + human-only REST)
  "tasks-filter", "tasks-priority", "task-delete", "task-column-guard", "kanban-columns-schema", "column-lifecycle", "column-presets", "preset-prompts", "preset-prompt-suggestions", "config-bounds", "config-rewire", "project-config-patch", "kanban-defaults", "transcript-encode", "alert-webhook",
  "ensure-obsidian", // card ab67eba3: Obsidian auto-start — config plumbing + human-only path gating + the vault preflight's gate/probe/fallback/launch-command construction (no real GUI launch)
  "session-archive", "session-list-summary", "all-archived-sessions", "periodic-snapshot", "shutdown-snapshot", "shutdown-endpoint", "mgmt-project-agent", "mgr-own-project-scope", "web-static-serve", "version", "cli-args", "cli-direct-invocation", "cli-service", "cli-channel", "update-check", "update-endpoint",
  "mcp-list-budget", // PL Auditor finding #5: default list_all_agents + audit list_sessions fit the token budget

  "claude-config", "trust-lock", "spawn-args", "disallow-prompt-tools",
  "context-watcher", "context-watcher-escalate", "context-stats", "recycle-handoff", "recycle-pending-carry", "spawn-allow-baseline", "wake", "worker-reported-state", "crash-recovery-watcher", "busy-worker-watcher",
  "idle-watch-foundation", "idle-watcher", "idle-report", "inbox-pull", "usage-status", "rate-limit-clear", "rate-limit-cascade", "usage-limit-spawn-wake",
  "skills-inject", "skills-inject-durability", "skills-subset-spawn", "respawn-profile-attrs", "skills-store-durability", "skills-publish-drift", "skills-customization", "skills-adopt-fastforward", "skills-autoff-boot", "vault-lint", "vault-browser", "vault-raw", "vault-writer", "vault-versioner-wiring", "git-writer", "git-identity-warning",
  "worker-diff", "worktrees", "worktree-provision", "spawn-recut-stale-branch", "merge-finalize-resilient", "merge-confirm-idempotent", "merge-review-diffstat", "merge-stranded-backstop", "worker-report-precheck", "worker-report-pending-guard", "worker-report-orphan-wake", "worker-exited-without-report", "worker-spawn-agent-gate", "worker-spawn-task-gate", "worker-spawn-live-task-guard", "worker-spawn-toctou-race", "worker-spawn-humanhold-guard", "project-config-column-orphan",
  "worker-spawn-agent-name", // PL Auditor finding #10 (card 03615ee0): worker_spawn agentId by NAME/slug + "did you mean" nearest-match + lowest-position collision rule
  "worker-report-delivery-status", // card fc9a27d5: worker_report/platform_escalate DeliveryStatus enum + parked-parent wake
  "merge-orphaned-to-main",

  "pty-busy-drain", "pty-coalesce-drain", "pty-rate-limit-park-drain", "pty-composer-dirty", "pty-queue-mutations", "pty-queue-rest", "pty-resume-readiness", "pty-stop-queue", "pty-interrupt-redirect", "redirect-worker", "spawn-env", "queued-message-durability", "graceful-stop", "resume-mode-cycles", "resume-mode-detect", "resume-mode-feedback", "shell-terminal",
  "db-backup",
  "crashlog", // card c00be6e8: top-level fatal-exit handler writes a diagnosable crashlog under .loom; clean/restart exits don't
  "my-context-gate", // PL Auditor finding #9: my_context folds in the RESOLVED project gateCommand, READ-ONLY (no set/propose surface)
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
