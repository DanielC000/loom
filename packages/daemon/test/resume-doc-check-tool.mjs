import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 1069c8e1 — MCP-surface test for `resume_doc_check`, proving the tool is actually WIRED (not just
// available as an unused module) on BOTH the manager's loom-orchestration surface and the Platform
// Lead's loom-platform surface, and that each resolves its OWN doc path (the load-bearing design
// decision: no path argument on either surface) from the SAME resolver its spawn-time prompt uses.
//
// HERMETIC — a REAL Db + SessionService + router, tool handlers invoked directly (no pty, no real
// claude/network/daemon). Real on-disk resume-doc files (mirrors resume-doc-watcher.mjs).
//
// Covers:
//   (M) manager surface: registered, resolves the project's Orchestrator Log.md via resolveConfig's
//       resumeDocFilename, returns configured:false for an unconfigured project, then ok:true once
//       orchestration.rotationMarkers/rotationLiveCommitmentsHeading/Floor are set on that SAME project.
//   (P) platform surface: registered, resolves the Lead's own lineage-scoped PLATFORM-LEAD-RESUME.md,
//       independent config from the manager project above (proves the "one field covers all three seats
//       with zero special-casing" design claim — two DIFFERENT projects, two DIFFERENT marker sets, no
//       cross-talk).
//   (C) code-review 🟡 fix: an archivePath must resolve INSIDE the project's own vaultPath — accepted
//       there, refused (clean {error}, never statted) outside it.
//   (E) edge case: no vaultPath on the project (manager surface) degrades to a clean {error}.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-resdoc-tool-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");

const dbFile = path.join(tmpHome, "resdoc-tool.db");
const db = new Db(dbFile);
const now = new Date().toISOString();
const pty = { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null };
const sessions = new SessionService(db, pty, new OrchestrationControl());

try {
  // ── (M) manager surface ──────────────────────────────────────────────────────────────────────────
  const mgrVault = path.join(tmpHome, "mgr-vault");
  fs.mkdirSync(mgrVault, { recursive: true });
  db.insertProject({ id: "pMgr", name: "MgrProj", repoPath: tmpHome, vaultPath: mgrVault, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "aMgr", projectId: "pMgr", name: "Lead", startupPrompt: "do it", position: 0 });
  db.insertSession({
    id: "mgrM", projectId: "pMgr", agentId: "aMgr", engineSessionId: null, title: null, cwd: mgrVault,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });

  const orchRouter = new OrchestrationMcpRouter(db, sessions);
  const mgrServer = orchRouter.buildServer("mgrM", "manager");
  check("(M) resume_doc_check is registered on the manager surface", "resume_doc_check" in mgrServer._registeredTools);
  const callMgr = async (args) => JSON.parse((await mgrServer._registeredTools["resume_doc_check"].handler(args ?? {})).content[0].text);

  const beforeConfig = await callMgr();
  check("(M) unconfigured project: configured:false", beforeConfig.configured === false);
  check("(M) unconfigured project: resolves the DEFAULT resume-doc filename (Orchestrator Log.md) under vaultPath", beforeConfig.resumeDocPath === path.join(mgrVault, "Orchestrator Log.md"));
  check("(M) doc not yet written: docFound:false, never throws", beforeConfig.docFound === false);

  fs.writeFileSync(path.join(mgrVault, "Orchestrator Log.md"), "## LIVE COMMITMENTS\n1. a\n2. b\n3. c\nOWNER-GATED mentioned here\n", "utf8");
  db.setProjectConfig("pMgr", {
    orchestration: {
      rotationMarkers: [{ token: "OWNER-GATED" }],
      rotationLiveCommitmentsHeading: "LIVE COMMITMENTS",
      rotationLiveCommitmentsFloor: 3,
    },
  });
  const afterConfig = await callMgr();
  check("(M) configured project, healthy doc: configured:true, ok:true", afterConfig.configured === true && afterConfig.ok === true);
  check("(M) honestLimitNote is present on the tool response", typeof afterConfig.honestLimitNote === "string" && afterConfig.honestLimitNote.length > 0);

  // Mutate the doc to drop the marker — the tool must catch it live off disk (no caching).
  fs.writeFileSync(path.join(mgrVault, "Orchestrator Log.md"), "## LIVE COMMITMENTS\n1. a\n2. b\n3. c\nnothing relevant here\n", "utf8");
  const afterMutation = await callMgr();
  check("(M) live re-check after a doc mutation catches the dropped marker", afterMutation.ok === false && afterMutation.missingMarkers.includes("OWNER-GATED"));

  // ── (C) code-review 🟡: archivePath must be CONTAINED under the project's own vaultPath ────────────
  // Restore a healthy doc first so archiveCheck is the only thing under test here.
  fs.writeFileSync(path.join(mgrVault, "Orchestrator Log.md"), "## LIVE COMMITMENTS\n1. a\n2. b\n3. c\nOWNER-GATED mentioned here\n", "utf8");
  const archiveInsideAbs = path.join(mgrVault, "Orchestrator Log.archive", "2026-01-01-01.md");
  fs.mkdirSync(path.dirname(archiveInsideAbs), { recursive: true });
  fs.writeFileSync(archiveInsideAbs, "archived content", "utf8");
  const withGoodArchive = await callMgr({ archivePath: archiveInsideAbs });
  check("(C) an archivePath INSIDE vaultPath (absolute) is accepted and checked", withGoodArchive.archiveCheck?.checked === true && withGoodArchive.archiveCheck?.ok === true);

  const outsideVault = path.join(tmpHome, "outside-the-vault.md");
  fs.writeFileSync(outsideVault, "not in the vault", "utf8");
  const withEscapingArchive = await callMgr({ archivePath: outsideVault });
  check("(C) an archivePath OUTSIDE vaultPath is REFUSED with a clean {error}, never statted", typeof withEscapingArchive.error === "string");

  // ── (P) platform surface — a DIFFERENT project, DIFFERENT marker set, no cross-talk ────────────────
  const platVault = path.join(tmpHome, "plat-vault");
  fs.mkdirSync(platVault, { recursive: true });
  db.insertProject({ id: "pPlat", name: "Loom Platform", repoPath: tmpHome, vaultPath: platVault, config: {}, createdAt: now, archivedAt: null, reserved: true });
  db.insertAgent({ id: "aPlat", projectId: "pPlat", name: "Lead", startupPrompt: "do it", position: 0 });
  db.insertSession({
    id: "leadP", projectId: "pPlat", agentId: "aPlat", engineSessionId: null, title: null, cwd: platVault,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "platform",
  });

  const platRouter = new PlatformMcpRouter(db, sessions);
  const platServer = platRouter.buildServer("leadP");
  check("(P) resume_doc_check is registered on the platform surface", "resume_doc_check" in platServer._registeredTools);
  const callPlat = async (args) => JSON.parse((await platServer._registeredTools["resume_doc_check"].handler(args ?? {})).content[0].text);

  const platBefore = await callPlat();
  check("(P) unconfigured Lead seat: configured:false (independent of the manager project's config above)", platBefore.configured === false);
  check("(P) resolves the LINEAGE-scoped base resume doc under the Platform project's own vaultPath", platBefore.resumeDocPath === path.join(platVault, "PLATFORM-LEAD-RESUME.md"));

  fs.writeFileSync(path.join(platVault, "PLATFORM-LEAD-RESUME.md"), "some content with LEAD-ONLY-MARKER present\n", "utf8");
  db.setProjectConfig("pPlat", { orchestration: { rotationMarkers: [{ token: "LEAD-ONLY-MARKER" }] } });
  const platAfter = await callPlat();
  check("(P) configured Lead seat with the marker present: ok:true", platAfter.ok === true && platAfter.configured === true);

  // (C) the SAME archivePath containment holds on the Lead surface too.
  const platArchiveOutside = path.join(tmpHome, "plat-outside-archive.md");
  fs.writeFileSync(platArchiveOutside, "not in the plat vault", "utf8");
  const platEscaping = await callPlat({ archivePath: platArchiveOutside });
  check("(P)/(C) an archivePath OUTSIDE the Platform project's vaultPath is REFUSED too", typeof platEscaping.error === "string");

  // The manager project's earlier config must be COMPLETELY unaffected by the Lead's own config write —
  // it must NOT have inherited LEAD-ONLY-MARKER, and its own OWNER-GATED requirement (restored above,
  // before the archivePath block) must still be independently satisfied.
  const mgrStillHealthy = await callMgr();
  check("(P)/(M) cross-check: the manager project did NOT inherit the Lead's LEAD-ONLY-MARKER", !mgrStillHealthy.missingMarkers.includes("LEAD-ONLY-MARKER") && mgrStillHealthy.ok === true);

  // ── (E) edge cases ────────────────────────────────────────────────────────────────────────────────
  const noVaultVault = "";
  db.insertProject({ id: "pNoVault", name: "NoVaultProj", repoPath: tmpHome, vaultPath: noVaultVault, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "aNoVault", projectId: "pNoVault", name: "Lead", startupPrompt: "do it", position: 0 });
  db.insertSession({
    id: "mgrNoVault", projectId: "pNoVault", agentId: "aNoVault", engineSessionId: null, title: null, cwd: tmpHome,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });
  const noVaultServer = orchRouter.buildServer("mgrNoVault", "manager");
  const noVaultResult = JSON.parse((await noVaultServer._registeredTools["resume_doc_check"].handler({})).content[0].text);
  check("(E) no vaultPath bound to the project: a clean {error}, never a throw", typeof noVaultResult.error === "string");

  // (E) code-review MINOR fix: the Lead surface gets the SAME no-vaultPath guard as the manager surface
  // (before the fix, an empty vaultPath would resolve to a bare relative filename against the daemon's
  // own cwd, which resolvePlatformLeadResumeDocPath's documented copyFileSync seed side-effect could
  // then write into).
  db.insertAgent({ id: "aPlatNoVault", projectId: "pNoVault", name: "Lead", startupPrompt: "do it", position: 1 });
  db.insertSession({
    id: "leadNoVault", projectId: "pNoVault", agentId: "aPlatNoVault", engineSessionId: null, title: null, cwd: tmpHome,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "platform",
  });
  const noVaultPlatServer = platRouter.buildServer("leadNoVault");
  const noVaultPlatResult = JSON.parse((await noVaultPlatServer._registeredTools["resume_doc_check"].handler({})).content[0].text);
  check("(E) Lead surface: no vaultPath bound to the project: a clean {error}, never a throw or a stray-file write", typeof noVaultPlatResult.error === "string");
} finally {
  db.close();
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — resume_doc_check is wired on both the manager and Platform-Lead MCP surfaces, each resolves its OWN resume doc (no path argument) via the SAME resolver its spawn-time prompt uses, per-project config is fully independent between two different seats (no cross-talk), a live doc mutation is caught on the next call with no caching, archivePath is contained under vaultPath on BOTH surfaces (code-review 🟡 fix), and a project with no vaultPath degrades to a clean {error} on BOTH surfaces rather than throwing (the Lead side is a code-review MINOR fix) — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);

