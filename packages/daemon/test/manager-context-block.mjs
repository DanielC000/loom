import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// PL Auditor finding #8 — "Where things live" manager context block. DETERMINISTIC + CLAUDE-FREE,
// hermetic like profile-spawn.mjs: isolated LOOM_HOME, a REAL Db + SessionService driven against a
// FAKE pty injected via PtyHost's createPty() seam — no real claude, no daemon, no network. A real
// temp git repo backs the project so spawnWorker's createWorktree (real git) works.
//
// Proves the DoD:
//   (1) a spawned MANAGER session's composed startupPrompt CONTAINS the project's absolute repoPath
//       AND vaultPath (the "Where things live" pre-block), with the agent's OWN prompt preserved after;
//   (1b) a RECYCLE-SUCCESSOR manager (recycleManager) gets the SAME block — it used to build its
//        startupPrompt directly (warmup + continuation only), skipping composeManagerStartupPrompt, so
//        a fresh successor manager had no absolute resume-doc path and Globbed for it on boot;
//   (1c) a PROFILE-DERIVED manager spawn (startNew, no explicit caller role — the DEFAULT "Spawn from
//        profile" button) ALSO gets the block — it used to resolve role==="manager" purely from the
//        agent's profile but skip composeManagerStartupPrompt entirely (only the explicit role:"manager"
//        path, startManager, applied it), so the most common real-world manager spawn cold-booted blind;
//   (2) a WORKER spawn does NOT get the MANAGER block (its opening is its agent brief + the kickoff — card af902717);
//   (3) the pure composeManagerStartupPrompt wraps/derives correctly (incl. the no-own-prompt case);
//   (3e) card 809cc4b5: an oversized on-disk resume doc gets a [loom:resume-doc-size] note PREPENDED
//        ahead of the "Where things live" block (mirrors the Platform Lead's own size-warning, now
//        shared via resume-doc-notes.ts); a missing or small doc emits no note;
//   (4) the pickup + orchestrate skill ASSETS instruct reading the resume doc by ABSOLUTE path.
//
// Run: 1) build (turbo builds shared first), 2) node test/manager-context-block.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Hermetic LOOM_HOME (set BEFORE importing dist — paths.ts reads it at import time) ---
const tmpHome = path.join(os.tmpdir(), `loom-mctxblk-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { composeManagerStartupPrompt } = await import("../dist/sessions/manager-prompt.js");
const { RESUME_DOC_WARN_BYTES, resolveResumeDocPath } = await import("../dist/sessions/resume-doc-notes.js");

// --- a real temp git repo so spawnWorker's createWorktree (real git) has a HEAD to branch off, and a
//     SEPARATE vault dir so we can prove BOTH absolute roots land in the block (not one path twice) ---
const repo = path.join(os.tmpdir(), `loom-mctxblk-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# manager-context-block test\n");
execSync(`git init -q && git add . && git -c user.email=mc@loom -c user.name=mc commit -q -m init`, { cwd: repo });
const vault = path.join(os.tmpdir(), `loom-mctxblk-vault-${Date.now()}`);
fs.mkdirSync(vault, { recursive: true });

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pM", name: "MProj", repoPath: repo, vaultPath: vault, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agentMgr", projectId: "pM", name: "Orchestrator", startupPrompt: "AGENT_MGR_DOCTRINE", position: 0, profileId: null });
db.insertAgent({ id: "agentWorker", projectId: "pM", name: "Dev", startupPrompt: "AGENT_WORKER_PROMPT", position: 1, profileId: null });
// a manager-ROLE PROFILE + an agent bound to it, so a role-omitted "auto" spawn (startNew, no explicit
// caller role) resolves role==="manager" purely from the profile — the fresh-boot gap this DoD covers.
db.insertProfile({ id: "profMgr", name: "Orchestrator Rig", role: "manager", description: "", allowDelta: [], skills: null, model: null, icon: null });
db.insertAgent({ id: "agentMgrProfile", projectId: "pM", name: "Profile Orchestrator", startupPrompt: "AGENT_MGR_PROFILE_DOCTRINE", position: 2, profileId: "profMgr" });
// a live manager so spawnWorker has a parent; worker_spawn validates the taskId is a real, non-terminal task
db.insertSession({
  id: "mgr1", projectId: "pM", agentId: "agentMgr", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false,
  createdAt: now, lastActivity: now, lastError: null, role: "manager",
});
const taskW = "44444444-4444-4444-8444-444444444444";
db.insertTask({ id: taskW, projectId: "pM", title: "WORK", body: "", columnKey: "todo", position: 1, createdAt: now, updatedAt: now });

// --- the fake pty + a PtyHost subclass that captures every SpawnOpts via the createPty() seam ---
class SeamHost extends PtyHost {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) {
    this.capture.push(opts);
    return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} };
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

let workerWorktree = null;
try {
  // ===================== (3) pure composeManagerStartupPrompt =====================
  const composed = composeManagerStartupPrompt("DOCTRINE_BODY", { repoPath: "/abs/repo", vaultPath: "/abs/vault", name: "Demo" });
  check("(3) pure: block carries the absolute repoPath", composed.includes("/abs/repo"));
  check("(3) pure: block carries the absolute vaultPath", composed.includes("/abs/vault"));
  check("(3) pure: block header present", composed.includes("## Where things live"));
  check("(3) pure: block carries the fully-resolved Resume doc line (vaultPath is ALREADY the project's vault dir — NOT doubled with Projects/<name>)", composed.includes("**Resume doc:**") && composed.includes(path.join("/abs/vault", "Orchestrator Log.md")) && !composed.includes(path.join("/abs/vault", "Projects", "Demo")));
  check("(3) pure: the agent's OWN prompt is preserved AFTER the block", composed.includes("DOCTRINE_BODY") && composed.indexOf("Where things live") < composed.indexOf("DOCTRINE_BODY"));
  check("(3) pure: instructs never to Glob", /never Glob/i.test(composed));
  const blockOnly = composeManagerStartupPrompt(undefined, { repoPath: "/abs/repo", vaultPath: "/abs/vault", name: "Demo" });
  check("(3) pure: undefined own-prompt → block-only (no crash, no trailing prompt)", blockOnly.includes("## Where things live") && blockOnly.includes("/abs/vault"));
  const blankCase = composeManagerStartupPrompt("   ", { repoPath: "/r", vaultPath: "/v", name: "Demo" });
  check("(3) pure: blank/whitespace own-prompt → block-only (trimmed away)", blankCase.includes("## Where things live") && blankCase.trimEnd().endsWith("reconstruct it."));

  // ===================== (3c) reference-repos epic Phase 3: referenceRepos block =====================
  const noRefs = composeManagerStartupPrompt("DOCTRINE_BODY", { repoPath: "/abs/repo", vaultPath: "/abs/vault", name: "Demo" });
  const emptyRefs = composeManagerStartupPrompt("DOCTRINE_BODY", { repoPath: "/abs/repo", vaultPath: "/abs/vault", name: "Demo", referenceRepos: [] });
  check("(3c) pure: no referenceRepos ⇒ byte-identical to the pre-Phase-3 composition", noRefs === composed);
  check("(3c) pure: empty referenceRepos ⇒ byte-identical to omitted", emptyRefs === composed);
  check("(3c) pure: no referenceRepos ⇒ no 'Also referenced' block", !composed.includes("Also referenced"));
  const withRefs = composeManagerStartupPrompt("DOCTRINE_BODY", { repoPath: "/abs/repo", vaultPath: "/abs/vault", name: "Demo", referenceRepos: ["/abs/refA", "/abs/refB"] });
  check("(3c) pure: non-empty referenceRepos ⇒ 'Also referenced' block present", withRefs.includes("Also referenced"));
  check("(3c) pure: both reference repo paths listed", withRefs.includes("/abs/refA") && withRefs.includes("/abs/refB"));
  check("(3c) pure: read-only framing present (never commit there)", /never commit there/i.test(withRefs));
  check("(3c) pure: own doctrine still preserved after the ref block", withRefs.includes("DOCTRINE_BODY"));
  check("(3c) pure: primary repoPath block still present alongside the ref block", withRefs.includes("## Where things live") && withRefs.includes("/abs/repo"));

  // ===================== (3b) DoD: a vault folder WITH A SPACE → emitted resume-doc path matches the real on-disk path EXACTLY =====================
  // The bug: managers reconstruct the path from memory and mis-spell the vault root ("Obsidian\Vault" vs the
  // real "Obsidian Vault" with a space), then fall back to the forbidden Glob. The fix builds it server-side
  // via path.join, so a space round-trips. Prove it by creating the file on disk and matching the emitted path.
  // vaultPath is ALREADY the project's vault dir (e.g. ".../Obsidian Vault/Projects/Fire Studio") — it is
  // NOT the vault root, so the resume doc must NOT re-append "Projects/<name>" on top of it.
  const spaceProjectName = "Fire Studio"; // a project name that ALSO contains a space
  const spaceVaultDir = path.join(os.tmpdir(), `loom-mctxblk-spacevault-${Date.now()}`, "Obsidian Vault", "Projects", spaceProjectName);
  const realResumeDoc = path.join(spaceVaultDir, "Orchestrator Log.md");
  fs.mkdirSync(spaceVaultDir, { recursive: true });
  fs.writeFileSync(realResumeDoc, "# Orchestrator Log\n");
  const spaceComposed = composeManagerStartupPrompt("BODY", { repoPath: "/abs/repo", vaultPath: spaceVaultDir, name: spaceProjectName });
  check("(3b) space-in-vault: emitted resume-doc path is the EXACT real on-disk path", spaceComposed.includes(realResumeDoc));
  check("(3b) space-in-vault: that emitted path actually exists on disk (it's the real file)", fs.existsSync(realResumeDoc) && spaceComposed.includes(realResumeDoc));
  check("(3b) space-in-vault: the space in the vault folder is PRESERVED (not collapsed/escaped)", spaceComposed.includes("Obsidian Vault"));
  try { fs.rmSync(path.dirname(path.dirname(path.dirname(path.dirname(realResumeDoc)))), { recursive: true, force: true }); } catch { /* best-effort */ }

  // ===================== (3e) card 809cc4b5: an oversized resume doc ⇒ the size-warning note fires
  // (SPAWN-time half of the proactive nudge; ResumeDocWatcher covers the mid-session half separately) =====
  const sizeVault = path.join(os.tmpdir(), `loom-mctxblk-sizevault-${Date.now()}`);
  fs.mkdirSync(sizeVault, { recursive: true });
  const sizeResumeDoc = path.join(sizeVault, "Orchestrator Log.md");

  // No doc on disk yet (a fresh project) ⇒ no note, no crash.
  const noteNone = composeManagerStartupPrompt("BODY", { repoPath: "/abs/repo", vaultPath: sizeVault, name: "SizeDemo" });
  check("(3e) no resume doc on disk ⇒ no size-warning note", !noteNone.includes("[loom:resume-doc-size]"));

  // A small, healthy doc, well under the warn threshold ⇒ still no note.
  fs.writeFileSync(sizeResumeDoc, "# Orchestrator Log\n\nSTATE: nothing notable.\n");
  const noteSmall = composeManagerStartupPrompt("BODY", { repoPath: "/abs/repo", vaultPath: sizeVault, name: "SizeDemo" });
  check("(3e) a small resume doc ⇒ no size-warning note", !noteSmall.includes("[loom:resume-doc-size]"));

  // A doc at/over RESUME_DOC_WARN_BYTES ⇒ the note fires, names the doc's own path, and PRECEDES the
  // "Where things live" pointer block (mirrors the Platform Lead's ordering — warn before pointing).
  fs.writeFileSync(sizeResumeDoc, "x".repeat(RESUME_DOC_WARN_BYTES + 1024));
  const noteOversized = composeManagerStartupPrompt("BODY", { repoPath: "/abs/repo", vaultPath: sizeVault, name: "SizeDemo" });
  check("(3e) an oversized resume doc ⇒ the size-warning note fires", noteOversized.includes("[loom:resume-doc-size]"));
  check("(3e) the size-warning note names the doc's own absolute path", noteOversized.includes(sizeResumeDoc));
  check("(3e) the size-warning note precedes the 'Where things live' pointer block", noteOversized.indexOf("[loom:resume-doc-size]") < noteOversized.indexOf("Where things live"));
  check("(3e) the agent's own doctrine still rides along after everything", noteOversized.includes("BODY"));
  try { fs.rmSync(sizeVault, { recursive: true, force: true }); } catch { /* best-effort */ }

  // ===================== (3f) card c1f2f095: composeManagerStartupPrompt honors a per-project
  // resumeDocFilename override instead of always hardcoding "Orchestrator Log.md" =====================
  const customName = "Selbstläufer — Orchestrator Resume.md"; // the real-world drifted filename from the incident
  const customComposed = composeManagerStartupPrompt("BODY", { repoPath: "/abs/repo", vaultPath: "/abs/vault", name: "Demo", resumeDocFilename: customName });
  check("(3f) pure: a resumeDocFilename override changes the emitted Resume doc path", customComposed.includes(path.join("/abs/vault", customName)));
  check("(3f) pure: the default filename is NOT emitted when an override is set", !customComposed.includes(path.join("/abs/vault", "Orchestrator Log.md")));
  const omittedComposed = composeManagerStartupPrompt("BODY", { repoPath: "/abs/repo", vaultPath: "/abs/vault", name: "Demo" });
  check("(3f) pure: an OMITTED resumeDocFilename still falls back to the default (byte-identical to before this card)", omittedComposed.includes(path.join("/abs/vault", "Orchestrator Log.md")));

  // ===================== (3g) card c1f2f095: resolveResumeDocPath defense-in-depth — even a
  // traversal value that somehow bypassed the agent-facing validator (e.g. a direct DB edit) can never
  // make the daemon vouch for a path OUTSIDE the project's vault =====================
  check("(3g) resolveResumeDocPath: a plain filename resolves under vaultPath", resolveResumeDocPath("/abs/vault", "Custom.md") === path.join("/abs/vault", "Custom.md"));
  check("(3g) resolveResumeDocPath: undefined ⇒ default filename", resolveResumeDocPath("/abs/vault", undefined) === path.join("/abs/vault", "Orchestrator Log.md"));
  check("(3g) resolveResumeDocPath: empty string ⇒ default filename", resolveResumeDocPath("/abs/vault", "") === path.join("/abs/vault", "Orchestrator Log.md"));
  const escaped = resolveResumeDocPath("/abs/vault", "../../etc/passwd");
  check("(3g) resolveResumeDocPath: a traversal override does NOT escape vaultPath (never contains 'passwd')", !escaped.includes("passwd"));
  check("(3g) resolveResumeDocPath: a traversal override falls back to the DEFAULT filename, not the raw escape target", escaped === path.join("/abs/vault", "Orchestrator Log.md"));

  // ===================== (1e) card c1f2f095: an end-to-end manager spawn for a project whose config
  // sets orchestration.resumeDocFilename picks up the CUSTOM path, not the hardcoded default =====================
  const vaultCustom = path.join(os.tmpdir(), `loom-mctxblk-vaultcustom-${Date.now()}`);
  fs.mkdirSync(vaultCustom, { recursive: true });
  db.insertProject({
    id: "pCustom", name: "CustomProj", repoPath: repo, vaultPath: vaultCustom,
    config: { orchestration: { resumeDocFilename: customName } }, createdAt: now, archivedAt: null,
  });
  db.insertAgent({ id: "agentMgrCustom", projectId: "pCustom", name: "Orchestrator", startupPrompt: "AGENT_MGR_CUSTOM_DOCTRINE", position: 0, profileId: null });
  const sMCustom = svc.startManager("agentMgrCustom");
  const oMCustom = optsFor(sMCustom.id);
  check("(1e) manager spawn with a project resumeDocFilename override carries the CUSTOM resume-doc path", oMCustom?.startupPrompt?.includes(path.join(vaultCustom, customName)));
  check("(1e) manager spawn with a project resumeDocFilename override does NOT carry the default filename", !oMCustom?.startupPrompt?.includes(path.join(vaultCustom, "Orchestrator Log.md")));
  try { fs.rmSync(vaultCustom, { recursive: true, force: true }); } catch { /* best-effort */ }

  // ===================== (1) MANAGER spawn → composed startupPrompt CONTAINS both absolute roots =====================
  const sM = svc.startManager("agentMgr");
  const oM = optsFor(sM.id);
  check("(1) manager spawn opts.startupPrompt contains the absolute repoPath", oM?.startupPrompt?.includes(repo));
  check("(1) manager spawn opts.startupPrompt contains the absolute vaultPath", oM?.startupPrompt?.includes(vault));
  check("(1) manager spawn opts.startupPrompt carries the 'Where things live' block", oM?.startupPrompt?.includes("## Where things live"));
  check("(1) manager spawn opts.startupPrompt carries the resolved resume-doc path (vaultPath is already the project's vault dir — not doubled)", oM?.startupPrompt?.includes(path.join(vault, "Orchestrator Log.md")));
  check("(1) manager spawn preserves the agent's OWN doctrine after the block", oM?.startupPrompt?.includes("AGENT_MGR_DOCTRINE"));
  check("(1) manager session is live + role manager", db.getSession(sM.id).processState === "live" && oM?.role === "manager");
  check("(1) project pM has no referenceRepos ⇒ manager spawn carries NO 'Also referenced' block (byte-identical guarantee)", !oM?.startupPrompt?.includes("Also referenced"));

  // ===================== (1b) MANAGER RECYCLE (successor spawn) also gets the block — the fix: a =====
  // recycle-successor manager is a fresh boot exactly like startManager's first spawn, and used to
  // build its startupPrompt directly (warmup + continuation only) WITHOUT composeManagerStartupPrompt —
  // so a successor manager had no absolute resume-doc path and Globbed for it (the boot-stall bug).
  const sMR = await svc.recycleManager("mgr1", "successor: pick up the fleet from here.");
  const oMR = optsFor(sMR.id);
  check("(1b) recycle-successor manager opts.startupPrompt carries the 'Where things live' block", oMR?.startupPrompt?.includes("## Where things live"));
  check("(1b) recycle-successor manager opts.startupPrompt carries the resolved ABSOLUTE resume-doc path (not vault-relative)", oMR?.startupPrompt?.includes(path.join(vault, "Orchestrator Log.md")));
  check("(1b) recycle-successor manager opts.startupPrompt still carries the continuation handoff text", oMR?.startupPrompt?.includes("successor: pick up the fleet from here."));
  check("(1b) recycle-successor manager opts.startupPrompt still carries the agent's warm-up doctrine", oMR?.startupPrompt?.includes("AGENT_MGR_DOCTRINE"));
  check("(1b) recycle-successor manager session is live + role manager", db.getSession(sMR.id).processState === "live" && oMR?.role === "manager");

  // ===================== (1c) PROFILE-DERIVED manager spawn via startNew (the default "Spawn from =====
  // profile" button, role omitted) also gets the block — the gap: only the EXPLICIT role:"manager"
  // path (startManager) applied composeManagerStartupPrompt; a role-omitted "+New"/"auto" spawn that
  // resolves role==="manager" purely from the agent's profile used to skip it entirely, so the DEFAULT
  // spawn button on a manager-profiled agent cold-booted with no absolute "Where things live" block.
  const sMP = svc.startNew("agentMgrProfile");
  const oMP = optsFor(sMP.id);
  check("(1c) profile-derived manager spawn (startNew, role omitted) resolves role=manager", oMP?.role === "manager");
  check("(1c) profile-derived manager spawn opts.startupPrompt carries the 'Where things live' block", oMP?.startupPrompt?.includes("## Where things live"));
  check("(1c) profile-derived manager spawn opts.startupPrompt carries the resolved absolute resume-doc path", oMP?.startupPrompt?.includes(path.join(vault, "Orchestrator Log.md")));
  check("(1c) profile-derived manager spawn preserves the agent's OWN doctrine after the block", oMP?.startupPrompt?.includes("AGENT_MGR_PROFILE_DOCTRINE"));

  // ===================== (1d) reference-repos epic Phase 3: a project WITH referenceRepos injects the =====
  // 'Also referenced (read-only)' block into a real manager spawn (not just the pure function above).
  const refRepoA = path.join(os.tmpdir(), `loom-mctxblk-refA-${Date.now()}`);
  const refRepoB = path.join(os.tmpdir(), `loom-mctxblk-refB-${Date.now()}`);
  fs.mkdirSync(refRepoA, { recursive: true });
  fs.mkdirSync(refRepoB, { recursive: true });
  const repoR = path.join(os.tmpdir(), `loom-mctxblk-repoR-${Date.now()}`);
  fs.mkdirSync(repoR, { recursive: true });
  fs.writeFileSync(path.join(repoR, "README.md"), "# ref-repos manager test\n");
  execSync(`git init -q && git add . && git -c user.email=mc@loom -c user.name=mc commit -q -m init`, { cwd: repoR });
  const vaultR = path.join(os.tmpdir(), `loom-mctxblk-vaultR-${Date.now()}`);
  fs.mkdirSync(vaultR, { recursive: true });
  db.insertProject({ id: "pR", name: "RefProj", repoPath: repoR, vaultPath: vaultR, config: {}, createdAt: now, archivedAt: null, referenceRepos: [refRepoA, refRepoB] });
  db.insertAgent({ id: "agentMgrRef", projectId: "pR", name: "Orchestrator", startupPrompt: "AGENT_MGR_REF_DOCTRINE", position: 0, profileId: null });
  const sMRef = svc.startManager("agentMgrRef");
  const oMRef = optsFor(sMRef.id);
  check("(1d) referenceRepos manager spawn carries the 'Also referenced' block", oMRef?.startupPrompt?.includes("Also referenced"));
  check("(1d) referenceRepos manager spawn lists BOTH reference repo absolute paths", oMRef?.startupPrompt?.includes(refRepoA) && oMRef?.startupPrompt?.includes(refRepoB));
  check("(1d) referenceRepos manager spawn carries the read-only framing (never commit there)", /never commit there/i.test(oMRef?.startupPrompt ?? ""));
  check("(1d) referenceRepos manager spawn still carries the primary repo's 'Where things live' block + own doctrine", oMRef?.startupPrompt?.includes("## Where things live") && oMRef?.startupPrompt?.includes(repoR) && oMRef?.startupPrompt?.includes("AGENT_MGR_REF_DOCTRINE"));
  try { fs.rmSync(refRepoA, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(refRepoB, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repoR, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(vaultR, { recursive: true, force: true }); } catch { /* best-effort */ }

  // ===================== (2) WORKER spawn does NOT get the MANAGER block (card af902717: it DOES now carry its agent brief) =====================
  const w = await svc.spawnWorker("mgr1", { taskId: taskW, agentId: "agentWorker", kickoffPrompt: "WORKER_KICKOFF" });
  workerWorktree = w.worktreePath;
  const oW = optsFor(w.id);
  check("(2) worker spawn opts.startupPrompt carries its agent brief THEN the kickoff", oW?.startupPrompt?.includes("AGENT_WORKER_PROMPT") && oW?.startupPrompt?.includes("WORKER_KICKOFF") && oW.startupPrompt.indexOf("AGENT_WORKER_PROMPT") < oW.startupPrompt.indexOf("WORKER_KICKOFF"));
  check("(2) worker spawn opts.startupPrompt does NOT carry the manager 'Where things live' block", !oW?.startupPrompt?.includes("Where things live"));

  // ===================== (4) skill ASSETS instruct read-by-absolute-path =====================
  const pickup = fs.readFileSync(path.join(__dirname, "..", "assets", "skills", "pickup", "SKILL.md"), "utf8");
  const orchestrate = fs.readFileSync(path.join(__dirname, "..", "assets", "skills", "orchestrate", "SKILL.md"), "utf8");
  check("(4) pickup asset references the 'Where things live' context block", /Where things live/.test(pickup));
  check("(4) pickup asset derives the resume doc path (Orchestrator Log.md)", /Orchestrator Log\.md/.test(pickup));
  check("(4) pickup asset instructs ABSOLUTE-path read, never Glob", /ABSOLUTE path/.test(pickup) && /never Glob/i.test(pickup));
  check("(4) orchestrate asset references the 'Where things live' context block", /Where things live/.test(orchestrate));
  check("(4) orchestrate asset derives the resume doc path (Orchestrator Log.md)", /Orchestrator Log\.md/.test(orchestrate));
  check("(4) orchestrate asset instructs ABSOLUTE-path read, never Glob", /ABSOLUTE path/.test(orchestrate) && /never Glob/i.test(orchestrate));
} finally {
  try { if (workerWorktree) { const { removeWorktree } = await import("../dist/git/worktrees.js"); await removeWorktree(repo, workerWorktree); } } catch { /* best-effort */ }
  db.close(); // free the WAL handle before removing the temp dir (Windows)
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(vault, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — managers get the 'Where things live' block (both absolute roots), workers stay byte-identical, the pickup/orchestrate assets instruct absolute-path reads, and a project's orchestration.resumeDocFilename override (card c1f2f095) is the single source of truth for the injected resume-doc path, defense-in-depth-contained to the vault root — claude-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
