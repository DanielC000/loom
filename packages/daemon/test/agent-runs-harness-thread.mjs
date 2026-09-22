import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 56e6c046: startRun resolved the agent's profile-pinned `harness` (via resolveAgentSpawn) but never
// threaded it onto the session row or into its `pty.spawn()` call — a `run` session always booted as
// claude regardless of what its profile pinned, silently. DETERMINISTIC, CLAUDE-FREE, NETWORK-FREE
// (same style as agent-runs-profile-attrs.mjs): isolated LOOM_HOME, a REAL Db + SessionService driven
// against a FAKE pty, a REAL temp git repo so createRunSnapshot's git plumbing runs.
//
// The whole defect is that a persisted value never reached `spawn()` — a test asserting persistence alone
// would pass against the bug — so this test's observation point is the OPTS OBJECT PASSED TO
// `PtyHost.spawn()` itself (the exact call site `startRun` makes), captured by overriding `spawn()` on a
// PtyHost subclass, one level ABOVE `createPty()`: a codex-harness spawn dispatches to `spawnCodexProcess`
// BEFORE ever reaching `createPty` (see `PtyHost.spawn`'s own `opts.harness === "codex"` dispatch), so
// asserting via the `createPty()` seam (as agent-runs-profile-attrs.mjs does for model/skills) would never
// even fire for the codex case this test needs to cover.
//
// Proves:
//   1. a run of a codex-pinned agent -> the opts object reaching `pty.spawn()` carries `harness:"codex"`,
//      AND the DB session row also pins it (both must be true — this is not a persistence-only check).
//   2. a run of a PLAIN (no-profile) agent -> opts.harness is undefined (byte-identical to before the fix)
//      and the DB row's harness is undefined too.
//   3. no quiet role-scoped side effect: `disallowedToolsForRole("run")` is unaffected by harness (it is
//      keyed on role alone) — confirms DoD item 3 (fixing harness threading must not quietly opt `run`
//      into the harness-self-scheduling disallow list, which deliberately excludes it).
//
// Run: 1) build (turbo builds shared first), 2) node test/agent-runs-harness-thread.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME (set BEFORE importing dist — paths.ts reads it at import time) ---
const tmpHome = path.join(os.tmpdir(), `loom-runs-harness-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { PtyHost, disallowedToolsForRole, HARNESS_SCHEDULING_TOOLS } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { runSnapshotDir } = await import("../dist/runs/snapshot.js");

// --- a real temp git repo with a committed file so createRunSnapshot has a HEAD to extract ---
const repo = path.join(os.tmpdir(), `loom-runs-harness-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# agent-runs harness-thread test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=r@loom -c user.name=r");

const now = new Date().toISOString();
const PROJECT_ID = "pRunHarness";
const db = new Db();
db.insertProject({ id: PROJECT_ID, name: "RunHarnessProj", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
// A profile that pins harness:"codex"; the endpoint agent runs under it.
db.insertProfile({ id: "profRunHarness", name: "RunHarnessRig", role: null, description: "codex-pinned rig", allowDelta: [], skills: null, model: null, icon: null, harness: "codex" });
db.insertAgent({ id: "agentCodex", projectId: PROJECT_ID, name: "Codex", startupPrompt: "CODEX_DOCTRINE", position: 0, profileId: "profRunHarness", endpoint: true, ioSchema: null });
// A plain (no-profile) endpoint agent -> the regression guard (byte-identical to before the fix).
db.insertAgent({ id: "agentPlain", projectId: PROJECT_ID, name: "Plain", startupPrompt: "PLAIN_DOCTRINE", position: 1, profileId: null, endpoint: true, ioSchema: null });

// --- fake pty capturing every opts object passed to the PUBLIC spawn() boundary, one level above
// createPty() — see the file header for why: a codex-harness spawn dispatches away before createPty
// would ever be reached, so this is the right (and only correct) observation point for this bug. Built
// on the SAME shared createPty() seam every other test uses (createSeamHost), so the claude/plain path
// still gets a fully fake pty (no real settings-file writes) — only spawn() itself is further overridden
// here to capture opts and to short-circuit the real codex dispatch. ---
class SeamHost extends createSeamHost(PtyHost) {
  constructor(events) { super(events); this.capture = []; }
  spawn(opts) {
    this.capture.push(opts);
    // Skip the real dispatch for a codex-harness opts: `spawnCodexProcess` is a real, separate subprocess
    // codepath (covered by its own dedicated real-spawn tests) — this test only needs to prove the opts
    // object ITSELF carries `harness:"codex"` when it reaches this boundary, not exercise codex's boot.
    if (opts.harness === "codex") return;
    return super.spawn(opts);
  }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());
const optsFor = (sid) => host.capture.find((o) => o.sessionId === sid);

try {
  // ===================== 1. a run of a codex-pinned agent threads harness onto the ACTUAL spawn =====================
  const { session } = await svc.startRun({ agentId: "agentCodex", input: { q: 1 }, schema: null });
  const o = optsFor(session.id);

  check("1 THE FIX: opts reaching pty.spawn() carries harness:\"codex\" (was never threaded -> always claude)",
    o?.harness === "codex");
  check("1 NOT persistence-only: the DB session row also pins harness:\"codex\"", db.getSession(session.id).harness === "codex");
  check("1 role is still 'run' (harness threading did not touch role)", o?.role === "run" && db.getSession(session.id).role === "run");

  // ===================== 2. regression guard: a PLAIN-agent run has no harness (byte-identical) =====================
  const { session: sPlain } = await svc.startRun({ agentId: "agentPlain", input: { q: 2 }, schema: null });
  const oPlain = optsFor(sPlain.id);
  check("2 plain-agent run: opts.harness is undefined (no profile -> \"claude\", byte-identical)", oPlain?.harness === undefined);
  check("2 plain-agent run: DB row harness is undefined (today's default)", db.getSession(sPlain.id).harness === undefined);

  // ===================== 3. DoD item 3: harness threading must not quietly opt 'run' into a role-scoped set =====================
  // HARNESS_SCHEDULING_TOOLS is a role-scoped disallow list that deliberately EXCLUDES "run" (an
  // owner-interactive terminal may legitimately self-schedule) — it is keyed on role alone, never on
  // harness, so this fix (which only threads harness) cannot have changed it. Assert it directly rather
  // than trusting that by inspection alone.
  const runDisallow = disallowedToolsForRole("run");
  check("3 'run' role's disallow list still excludes every HARNESS_SCHEDULING_TOOLS entry (unaffected by harness threading)",
    HARNESS_SCHEDULING_TOOLS.every((t) => !runDisallow.includes(t)));
} finally {
  // GC the disposable run snapshot dirs the test created, then drop the db + temp dirs.
  try { for (const o of host.capture) { if (o.cwd?.startsWith(runSnapshotDir(""))) fs.rmSync(o.cwd, { recursive: true, force: true }); } } catch { /* best-effort */ }
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a run of a codex-pinned agent threads harness onto the actual pty.spawn() call (not just the DB row); a plain-agent run stays byte-identical; 'run' role's harness-scheduling exclusion is unaffected — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
