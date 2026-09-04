import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 0e4a859a — surface codescape in manager/worker prompt blocks when the project's graph is enabled.
// OWNER CONSTRAINT: codescape is a PRIVATE product — the injected block is the ONLY discovery channel and
// MUST be presence-gated (inject ONLY when THIS host actually serves a codescape graph for THIS project);
// a vanilla end-user install must see nothing — no block, no stub, no empty heading, no whitespace tell.
//
// DETERMINISTIC + CLAUDE-FREE, hermetic like codescape-mcp-spawn.mjs: isolated LOOM_HOME + a sandboxed
// HOME, a REAL Db + SessionService driven against a FAKE pty (PtyHost's createPty() seam) and a FAKE
// CodescapeSupervisor injected via SessionService's `opts.codescape` — no real supervisor/serve process,
// no real claude spawn.
//
// ARCHITECTURE (post-merge-gate finding, `test/codescape-privacy-guard.mjs`): the block's PROSE TEXT is
// NOT a source string literal anywhere — it lives at `assets/skills/codescape/prompt-block.md`, a
// dev-only asset INSIDE the already-DEV_ONLY_SKILLS-curated `codescape` skill dir (omitted from a
// published `loomctl` release exactly like that dir's own SKILL.md). `composeManagerStartupPrompt`/
// `composeWorkerStartupPrompt` know NOTHING about codescape — they only ever append an opaque
// already-rendered block via the SAME generic `appendMemoryRecallToStartupPrompt` companion/project-memory
// blocks already reuse. All the codescape-specific gating + the asset read live PRIVATELY in
// `SessionService` (`resolveCodescapeGraphContext` / `resolveCodescapeBlockText`), so this file drives the
// REAL SessionService end-to-end rather than unit-testing an exported pure function — there isn't one to
// unit-test; the presence-gated composition only happens through a live spawn.
//
// Proves the DoD:
//   (1) the two prompt composers stay CODESCAPE-AGNOSTIC (regression guard for the architecture above):
//       neither ever emits a "codescape" mention on its own, confirming the concept never compiles into
//       those files.
//   (2) SPAWN (both directions): a codescape-enabled project with a live, ingested graph ⇒ the block
//       lands in BOTH a fresh manager's (startManager) and a fresh worker's (spawnWorker) startupPrompt,
//       carrying the REAL prose read from the dev-only asset file plus the freshness stamp; vanilla
//       (LOOM_DEV off) / project not opted in / graph never ingested (no manifest entry) / serve not
//       currently up (port null) / no CodescapeSupervisor injected at all ALL clean-skip to no block at
//       all — never a stub/empty heading.
//   (3) RECYCLE survives: recycleManager's successor AND recycleWorker's successor both carry the block
//       too — the card's whole point ("adoption must survive recycles") is that a recycle-composed prompt
//       re-derives this fresh on EVERY spawn rather than relying on a decayed original kickoff mention.
//   (4) the POSITIVE-CONTROLLED shipped-payload absence check: the curated (shipped) skill set — the
//       SAME curateSkillDirs() the npm-package build applies — carries ZERO "codescape" mentions across
//       every file in every shipped skill dir; the identical pattern verified NON-ZERO against BOTH
//       `assets/skills/codescape/SKILL.md` AND the new `prompt-block.md` (the same DEV_ONLY_SKILLS dir,
//       both known to carry the word) first, so a silently-broken (always-zero) pattern can never pass as
//       "clean", and the new asset file is proven to genuinely be excluded, not merely assumed to be.
//
// Run: 1) build (turbo builds shared first), 2) node test/codescape-prompt-block.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Hermetic LOOM_HOME + sandboxed HOME (set BEFORE importing dist) ---
const tmpHome = path.join(os.tmpdir(), `loom-csprompt-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
delete process.env.LOOM_DEV;
delete process.env.LOOM_CODESCAPE_BIN;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { composeManagerStartupPrompt } = await import("../dist/sessions/manager-prompt.js");
const { composeWorkerStartupPrompt } = await import("../dist/sessions/worker-prompt.js");
const { resolveCodescapeProjectId } = await import("../dist/codescape/manifest.js");
const { removeWorktree } = await import("../dist/git/worktrees.js");

function writeManifest(homeDir, entries) {
  const p = path.join(homeDir, ".codescape", "projects", "index.json");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ version: 1, projects: entries }));
}

// ===================== (1) the composers stay CODESCAPE-AGNOSTIC (architecture regression guard) =====================
{
  const baseLoc = { repoPath: "/abs/repo", vaultPath: "/abs/vault", name: "Demo" };
  const managerOut = composeManagerStartupPrompt("DOCTRINE", { ...baseLoc, referenceRepos: ["/abs/ref"], repos: [{ key: "b", path: "/abs/b" }] });
  check("(1m) composeManagerStartupPrompt never mentions codescape on its own (no such param exists)", !/codescape/i.test(managerOut));

  const workerOut = composeWorkerStartupPrompt("BRIEF", "DYNAMIC", "/wt/path", ["/abs/ref"]);
  check("(1w) composeWorkerStartupPrompt never mentions codescape on its own (no such param exists)", !/codescape/i.test(workerOut));
}

// ===================== (4) the positive-controlled shipped-payload absence check =====================
{
  const { curateSkillDirs, DEV_ONLY_SKILLS } = await import("../../../scripts/curate-release-skills.mjs");
  const skillsRoot = path.join(__dirname, "..", "assets", "skills");
  const allDirs = fs.readdirSync(skillsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  check("(4) precondition: codescape IS a real bundled asset dir (this repo's dev/self-host copy)", allDirs.includes("codescape"));
  check("(4) precondition: codescape is in DEV_ONLY_SKILLS (the omission list the npm build applies)", DEV_ONLY_SKILLS.includes("codescape"));
  const shipped = curateSkillDirs(allDirs);
  check("(4) codescape is curated OUT of the shipped set", !shipped.includes("codescape"));

  function walkFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walkFiles(p));
      else out.push(p);
    }
    return out;
  }

  const CODESCAPE_PATTERN = /codescape/i;

  // POSITIVE CONTROL FIRST — the same pattern against files KNOWN to carry the word (both dev-only assets
  // inside the SAME curated-out dir), so a silently-broken (always-returns-zero) pattern can never
  // masquerade as "clean" below. Two targets, not one: SKILL.md (pre-existing) AND prompt-block.md (the
  // NEW asset this card's fix moved the block's prose into) — proving the new file is genuinely excluded,
  // not merely assumed to be by virtue of sharing a directory.
  const skillMdFile = path.join(skillsRoot, "codescape", "SKILL.md");
  check("(4 positive control) the pattern DOES fire against codescape/SKILL.md (proves it isn't silently broken)", CODESCAPE_PATTERN.test(fs.readFileSync(skillMdFile, "utf8")));
  const promptBlockAssetFile = path.join(skillsRoot, "codescape", "prompt-block.md");
  check("(4) precondition: the dev-only prompt-block.md asset exists in this repo", fs.existsSync(promptBlockAssetFile));
  check("(4 positive control) the pattern DOES fire against codescape/prompt-block.md too", CODESCAPE_PATTERN.test(fs.readFileSync(promptBlockAssetFile, "utf8")));
  check("(4) prompt-block.md carries the actual discovery-block prose (load /codescape before orienting)", fs.readFileSync(promptBlockAssetFile, "utf8").includes("/codescape"));

  const offenders = [];
  for (const name of shipped) {
    for (const file of walkFiles(path.join(skillsRoot, name))) {
      const content = fs.readFileSync(file, "utf8");
      if (CODESCAPE_PATTERN.test(content)) offenders.push(file);
    }
  }
  check(`(4) zero 'codescape' mentions across every file in every SHIPPED skill dir${offenders.length ? ` (found in: ${offenders.join(", ")})` : ""}`, offenders.length === 0);
}

// ===================== (2)+(3) end-to-end: spawn (both directions) + survives recycle =====================
const fixtureCli = path.join(__dirname, "fixtures", "fake-codescape-cli.mjs");
process.env.LOOM_CODESCAPE_BIN = fixtureCli;

const repo = path.join(os.tmpdir(), `loom-csprompt-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# codescape-prompt-block test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=cp@loom -c user.name=cp");

const now = new Date().toISOString();
const db = new Db();

const stamp = "2026-08-01T09:30:00.000Z";
const homeDir = path.join(tmpHome, "cs-home");
writeManifest(homeDir, [{ id: "proj-cp-live", name: "P", path: repo, lastIngested: stamp, graphPath: "/x/graph.json" }]);

db.insertProject({ id: "pLive", name: "Live", repoPath: repo, vaultPath: repo, config: { codescape: { enabled: true } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agentMgrLive", projectId: "pLive", name: "Mgr", startupPrompt: "MGR_DOCTRINE", position: 0, profileId: null });
db.insertAgent({ id: "agentWorkerLive", projectId: "pLive", name: "Worker", startupPrompt: "WORKER_BRIEF", position: 1, profileId: null });

class SeamHost extends createSeamHost(PtyHost) {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) { this.capture.push(opts); return super.createPty(opts); }
  isAlive() { return false; }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);

// A LIVE fake supervisor: enabled, ingested (manifest has an entry), and serve currently up (getPort !=
// null) — the "actually serves a codescape graph for THIS project" condition the card requires.
const liveSupervisor = {
  getHomeDir: () => homeDir,
  getPort: () => 6001,
  resolveProjectId: (repoPath) => resolveCodescapeProjectId(repoPath, homeDir),
  async registerWorktree() { return { ok: true }; },
  async reingestMain() { return { ok: true }; },
  async dropWorktree() { return { ok: true }; },
};
const svc = new SessionService(db, host, new OrchestrationControl(), { codescape: liveSupervisor });
const optsFor = (sid) => host.capture.find((o) => o.sessionId === sid);

const worktrees = [];
const liveIds = [];
try {
  process.env.LOOM_DEV = "1";

  // --- (2a) manager fresh spawn: block present, both directions of the gate proven together with (2b) ---
  const mgr = svc.startManager("agentMgrLive");
  liveIds.push(mgr.id);
  const oMgr = optsFor(mgr.id);
  check("(2a) manager fresh spawn: startupPrompt carries the codescape block", /Codescape/.test(oMgr?.startupPrompt ?? ""));
  check("(2a) manager fresh spawn: block carries the manifest's lastIngested stamp", (oMgr?.startupPrompt ?? "").includes(stamp));
  check("(2a) manager fresh spawn: block tells the agent to load /codescape", (oMgr?.startupPrompt ?? "").includes("/codescape"));

  // --- (2b) worker fresh spawn: block present ---
  const taskLive = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  db.insertTask({ id: taskLive, projectId: "pLive", title: "T", body: "", columnKey: "todo", position: 1, createdAt: now, updatedAt: now });
  const worker = await svc.spawnWorker(mgr.id, { taskId: taskLive, agentId: "agentWorkerLive", kickoffPrompt: "GO" });
  liveIds.push(worker.id);
  worktrees.push(worker.worktreePath);
  const oWorker = optsFor(worker.id);
  check("(2b) worker fresh spawn: startupPrompt carries the codescape block", /Codescape/.test(oWorker?.startupPrompt ?? ""));
  check("(2b) worker fresh spawn: block carries the manifest's lastIngested stamp", (oWorker?.startupPrompt ?? "").includes(stamp));
  check("(2b) worker fresh spawn: worktree edit-dir block + brief + kickoff still all present alongside it", (oWorker?.startupPrompt ?? "").includes(worker.worktreePath) && (oWorker?.startupPrompt ?? "").includes("WORKER_BRIEF") && (oWorker?.startupPrompt ?? "").includes("GO"));

  // --- (3a) RECYCLE MANAGER — the card's whole point: the block must survive a recycle, not just a fresh spawn ---
  const mgrSuccessor = await svc.recycleManager(mgr.id, "CONTINUE_THE_WORK");
  liveIds.push(mgrSuccessor.id);
  const oMgrSuccessor = optsFor(mgrSuccessor.id);
  check("(3a) recycleManager successor: startupPrompt carries the codescape block", /Codescape/.test(oMgrSuccessor?.startupPrompt ?? ""));
  check("(3a) recycleManager successor: block carries the freshness stamp too (re-derived fresh, not carried as stale text)", (oMgrSuccessor?.startupPrompt ?? "").includes(stamp));
  check("(3a) recycleManager successor: still carries the continuation handoff", (oMgrSuccessor?.startupPrompt ?? "").includes("CONTINUE_THE_WORK"));

  // --- (3b) RECYCLE WORKER — same proof, worker side ---
  const workerSuccessor = await svc.recycleWorker(mgrSuccessor.id, worker.id, "HANDOFF_TEXT");
  liveIds.push(workerSuccessor.id);
  const oWorkerSuccessor = optsFor(workerSuccessor.id);
  check("(3b) recycleWorker successor: startupPrompt carries the codescape block", /Codescape/.test(oWorkerSuccessor?.startupPrompt ?? ""));
  check("(3b) recycleWorker successor: block carries the freshness stamp too", (oWorkerSuccessor?.startupPrompt ?? "").includes(stamp));
  check("(3b) recycleWorker successor: still carries the handoff text", (oWorkerSuccessor?.startupPrompt ?? "").includes("HANDOFF_TEXT"));

  // ===================== (2c-f) NEGATIVE CASES — every reason to clean-skip, byte-identical to a plain spawn =====================

  // (2c) vanilla / LOOM_DEV off — the exact end-user posture, even though the project itself opted in and
  // has a real ingested graph on disk. This is the single most important negative case: privacy depends on it.
  {
    const saved = process.env.LOOM_DEV;
    delete process.env.LOOM_DEV;
    const mgrVanilla = svc.startManager("agentMgrLive");
    liveIds.push(mgrVanilla.id);
    const oVanilla = optsFor(mgrVanilla.id);
    check("(2c) LOOM_DEV off (vanilla end-user posture): NO codescape block, even with an enabled+ingested project", !/codescape/i.test(oVanilla?.startupPrompt ?? ""));
    process.env.LOOM_DEV = saved;
  }

  // (2d) project not opted in (codescape.enabled: false)
  db.insertProject({ id: "pOff", name: "Off", repoPath: repo, vaultPath: repo, config: { codescape: { enabled: false } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "agentMgrOff", projectId: "pOff", name: "Mgr", startupPrompt: "MGR_DOCTRINE", position: 0, profileId: null });
  const mgrOff = svc.startManager("agentMgrOff");
  liveIds.push(mgrOff.id);
  const oOff = optsFor(mgrOff.id);
  check("(2d) project not opted in: NO codescape block", !/codescape/i.test(oOff?.startupPrompt ?? ""));

  // (2e) graph never ingested — enabled + LOOM_DEV on + CLI present, but the manifest has NO entry for
  // this repo (a fresh, never-ingested homeDir).
  const emptyHomeDir = path.join(tmpHome, "cs-home-empty");
  fs.mkdirSync(emptyHomeDir, { recursive: true });
  const noGraphSupervisor = { getHomeDir: () => emptyHomeDir, getPort: () => 6002, resolveProjectId: (repoPath) => resolveCodescapeProjectId(repoPath, emptyHomeDir) };
  const svcNoGraph = new SessionService(db, host, new OrchestrationControl(), { codescape: noGraphSupervisor });
  db.insertProject({ id: "pNoGraph", name: "NoGraph", repoPath: repo, vaultPath: repo, config: { codescape: { enabled: true } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "agentMgrNoGraph", projectId: "pNoGraph", name: "Mgr", startupPrompt: "MGR_DOCTRINE", position: 0, profileId: null });
  const mgrNoGraph = svcNoGraph.startManager("agentMgrNoGraph");
  liveIds.push(mgrNoGraph.id);
  const oNoGraph = optsFor(mgrNoGraph.id);
  check("(2e) graph never ingested (no manifest entry): NO codescape block", !/codescape/i.test(oNoGraph?.startupPrompt ?? ""));

  // (2f) serve not currently up — enabled + ingested, but getPort() resolves null.
  const downSupervisor = { getHomeDir: () => homeDir, getPort: () => null, resolveProjectId: (repoPath) => resolveCodescapeProjectId(repoPath, homeDir) };
  const svcDown = new SessionService(db, host, new OrchestrationControl(), { codescape: downSupervisor });
  db.insertProject({ id: "pDown", name: "Down", repoPath: repo, vaultPath: repo, config: { codescape: { enabled: true } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "agentMgrDown", projectId: "pDown", name: "Mgr", startupPrompt: "MGR_DOCTRINE", position: 0, profileId: null });
  const mgrDown = svcDown.startManager("agentMgrDown");
  liveIds.push(mgrDown.id);
  const oDown = optsFor(mgrDown.id);
  check("(2f) serve not currently up (port null): NO codescape block", !/codescape/i.test(oDown?.startupPrompt ?? ""));

  // (2g) no CodescapeSupervisor injected at all (this.codescape undefined) — every hermetic test elsewhere
  // in this repo constructs SessionService this way; proves the new gate never throws on that ambient state.
  const svcNoSupervisor = new SessionService(db, host, new OrchestrationControl());
  db.insertProject({ id: "pNoSup", name: "NoSup", repoPath: repo, vaultPath: repo, config: { codescape: { enabled: true } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "agentMgrNoSup", projectId: "pNoSup", name: "Mgr", startupPrompt: "MGR_DOCTRINE", position: 0, profileId: null });
  const mgrNoSup = svcNoSupervisor.startManager("agentMgrNoSup");
  liveIds.push(mgrNoSup.id);
  const oNoSup = optsFor(mgrNoSup.id);
  check("(2g) no CodescapeSupervisor injected at all: does not throw, NO codescape block", !/codescape/i.test(oNoSup?.startupPrompt ?? ""));
} finally {
  for (const wt of worktrees) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  for (const id of liveIds) { try { svc.stopSession(id, "hard"); } catch { /* already gone / not found */ } }
  db.close();
  delete process.env.LOOM_DEV;
  delete process.env.LOOM_CODESCAPE_BIN;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — codescape surfaces in the manager/worker prompt blocks (card 0e4a859a): presence-gated on a live, ingested graph (undefined ⇒ byte-identical to before); present ⇒ the block + a real freshness stamp, degrading gracefully to unstamped rather than hidden when only the stamp read fails; a fresh manager AND a fresh worker both get it; a RECYCLED manager and a RECYCLED worker successor both re-derive it fresh (survives recycle, the card's core requirement); every negative case (vanilla/LOOM_DEV off, project not opted in, graph never ingested, serve not up, no supervisor injected at all) clean-skips to zero mention; and the curated (shipped) skill set carries zero 'codescape' mentions anywhere, verified against a positive control that the same pattern fires on the known-present dev-only asset — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
