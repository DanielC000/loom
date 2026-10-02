import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// agent_clone / agent_clone_batch — the Platform Lead surface's batch/templated agent creation
// primitive (card 54da5815). DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, same harness shape as
// platform-mgmt-surface.mjs: a REAL Db driven against the REAL PlatformMcpRouter over an in-process
// MCP InMemoryTransport (no HTTP, no external daemon, no pty at all — these tools never spawn).
//
// Proves the DoD:
//   (a) agent_clone provisions a clone of a source agent into a target project via the SAME
//       createAgentCore path agent_create uses — name/startupPrompt/profileId carry over, nameOverride
//       and promptPatch REPLACE their field when given, project/agent 404s match agent_create's.
//   (b) LEAST-PRIVILEGE: cloning an agent whose profile role is platform/auditor is REJECTED (clone's own
//       narrower role check, clonedProfileRoleError) — mirrors the guard on assigning an elevated profile
//       directly — and creates NO agent. Card a06650d2 (fix round): cloning a NON-elevated-role profile
//       that still carries connections/capabilities/vaultWrite is ALSO rejected — but via a SEPARATE
//       field-only check on THIS agent-facing tool itself (cloneSourceFieldError, mcp/platform.ts), never
//       inside the shared cloneAgentCore core (which the human-only REST companion auto-clone route also
//       calls, and must keep its pre-card no-field-check behaviour — see companion-provision.mjs (6i)).
//   (c) agent_clone_batch clones one source into MANY target projects in one call, each entry
//       independent (a bad target's error doesn't block the others), same least-privilege guard applies
//       per-entry.
//   (d) agent_create/agent_update: assigning an elevated-role profileId directly is UNCHANGED (still
//       allowed — administering the Lead's own rigs is this surface's job), but card a06650d2 adds a NEW
//       rejection for a profileId carrying connections/capabilities/vaultWrite, on both tools.
//
// Run: 1) build (turbo builds shared first), 2) node test/platform-agent-clone.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (so nothing touches the real ~/.loom or ~/.claude). Set
// BEFORE importing dist (paths.ts reads LOOM_HOME at import time). ---
const tmpHome = path.join(os.tmpdir(), `loom-clone-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

import { requireHermeticEnv } from "./_guard.mjs";
import { commitAll } from "./_git-commit.mjs";
requireHermeticEnv(); // confirm LOOM_HOME is the temp dir (no port — this test runs no HTTP daemon)

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// --- a real temp git repo so the (unused-by-these-tools) spawn cwd validation never trips ---
const repo = path.join(os.tmpdir(), `loom-clone-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# agent-clone test repo\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=clone@loom -c user.name=clone");

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pSrc", name: "Source", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertProject({ id: "pA", name: "Sibling A", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertProject({ id: "pB", name: "Sibling B", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });

db.insertProfile({ id: "profQA", name: "QA Tester", role: "worker", description: "qa rig", allowDelta: [], skills: null, model: null, icon: "🧪", browserTesting: true });
db.insertProfile({ id: "profPlatform", name: "Platform Rig", role: "platform", description: "elevated rig", allowDelta: [], skills: null, model: null, icon: "🛡️" });
db.insertProfile({ id: "profAuditor", name: "Auditor Rig", role: "auditor", description: "elevated rig", allowDelta: [], skills: null, model: null, icon: "🔎" });
// Card a06650d2: a NON-elevated (worker) role that still carries a human-only field — the shared
// agentAssignableProfileError predicate's FIELD check applies regardless of role or allowElevatedRoles.
db.insertProfile({ id: "profVaultWrite", name: "Vault Rig", role: "worker", description: "vault-write rig", allowDelta: [], skills: null, model: null, icon: "📓", vaultWrite: true });
// Card 1f52bc75: representative coverage for the field axis's 3 newly-checked members (documentConversion
// here — see clone-core-field-check.mjs for exhaustive coverage of all 4 including harness/allowDelta).
db.insertProfile({ id: "profDocConversion", name: "DocConversion Rig", role: "worker", description: "doc-conversion rig", allowDelta: [], skills: null, model: null, icon: "📄", documentConversion: true });

// The source agents to clone: a plain one, one with an ordinary (worker) profile, two with an
// elevated (platform/auditor) profile, and one with a non-elevated-but-field-bearing (vaultWrite) profile
// — the escalation-reject fixtures.
db.insertAgent({ id: "agentPlain", projectId: "pSrc", name: "Web Designer", startupPrompt: "You build UI for {{site}}.", position: 0, profileId: null });
db.insertAgent({ id: "agentQA", projectId: "pSrc", name: "QA", startupPrompt: "You test {{site}}.", position: 1, profileId: "profQA" });
db.insertAgent({ id: "agentPlatform", projectId: "pSrc", name: "Lead-ish", startupPrompt: "elevated", position: 2, profileId: "profPlatform" });
db.insertAgent({ id: "agentAuditor", projectId: "pSrc", name: "Audit-ish", startupPrompt: "elevated", position: 3, profileId: "profAuditor" });
db.insertAgent({ id: "agentVaultWrite", projectId: "pSrc", name: "Vault-ish", startupPrompt: "vault-write", position: 4, profileId: "profVaultWrite" });
db.insertAgent({ id: "agentDocConversion", projectId: "pSrc", name: "DocConversion-ish", startupPrompt: "doc-conversion", position: 5, profileId: "profDocConversion" });

// A no-op SessionService/PtyHost — these tools never touch sessions, but the router constructor needs one.
// LOCAL OVERRIDE (not _seam-host-fixture.mjs's shared SeamHost, card ec7983c6): createPty() throws by
// design ("agent_clone tools must never spawn a pty") — there is no onExit/kill to share.
class SeamHost extends PtyHost {
  createPty() { throw new Error("agent_clone tools must never spawn a pty"); }
  stop() {}
}
const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());
const router = new PlatformMcpRouter(db, svc);

const parse = (res) => JSON.parse(res.content[0].text);

try {
  const server = router.buildServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "platform-clone-test", version: "0" });
  await client.connect(clientT);
  const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));

  const tools = (await client.listTools()).tools.map((t) => t.name);
  check("surface includes agent_clone", tools.includes("agent_clone"));
  check("surface includes agent_clone_batch", tools.includes("agent_clone_batch"));

  // ===================== (a) agent_clone — the happy path =====================
  const nAgentsBefore = db.listAgents("pA").length;
  const cloned = await call("agent_clone", { sourceAgentId: "agentPlain", targetProjectId: "pA" });
  check("(a) agent_clone: returns a new agent (no error)", !!cloned.id && !cloned.error);
  check("(a) agent_clone: lands in the target project", cloned.projectId === "pA");
  check("(a) agent_clone: carries the source name verbatim (no nameOverride given)", cloned.name === "Web Designer");
  check("(a) agent_clone: carries the source startupPrompt verbatim (no promptPatch given)", cloned.startupPrompt === "You build UI for {{site}}.");
  check("(a) agent_clone: carries the source profileId (null here)", cloned.profileId === null);
  check("(a) agent_clone: persists to the Db", db.getAgent(cloned.id)?.projectId === "pA" && db.listAgents("pA").length === nAgentsBefore + 1);
  check("(a) agent_clone: source agent is untouched (clone, not move)", db.getAgent("agentPlain")?.projectId === "pSrc");

  // nameOverride + promptPatch REPLACE their field.
  const clonedPatched = await call("agent_clone", {
    sourceAgentId: "agentPlain", targetProjectId: "pB",
    nameOverride: "Web Designer (Sibling B)", promptPatch: "You build UI for siteB.example.com.",
  });
  check("(a) agent_clone: nameOverride replaces the name", clonedPatched.name === "Web Designer (Sibling B)");
  check("(a) agent_clone: promptPatch replaces the startupPrompt", clonedPatched.startupPrompt === "You build UI for siteB.example.com.");

  // A non-elevated profileId carries over unchanged.
  const clonedQA = await call("agent_clone", { sourceAgentId: "agentQA", targetProjectId: "pA" });
  check("(a) agent_clone: an ordinary (worker-role) profileId carries over", clonedQA.profileId === "profQA" && !clonedQA.error);

  // 404s mirror agent_create's.
  const cloneBadSource = await call("agent_clone", { sourceAgentId: "ghost", targetProjectId: "pA" });
  check("(a) agent_clone: 404 on an unknown source agent", cloneBadSource.error === "source agent not found");
  const cloneBadTarget = await call("agent_clone", { sourceAgentId: "agentPlain", targetProjectId: "ghost" });
  check("(a) agent_clone: 404 on an unknown target project (matches agent_create)", cloneBadTarget.error === "project not found");

  // ===================== (b) LEAST-PRIVILEGE — the escalation-reject case =====================
  const nAgentsPSrcBefore = db.listAgents("pSrc").length;
  const cloneElevPlatform = await call("agent_clone", { sourceAgentId: "agentPlatform", targetProjectId: "pA" });
  check("(b) agent_clone REJECTS cloning a platform-role-profiled agent",
    typeof cloneElevPlatform.error === "string" && /platform/i.test(cloneElevPlatform.error) && !cloneElevPlatform.id);
  const cloneElevAuditor = await call("agent_clone", { sourceAgentId: "agentAuditor", targetProjectId: "pA" });
  check("(b) agent_clone REJECTS cloning an auditor-role-profiled agent",
    typeof cloneElevAuditor.error === "string" && /auditor/i.test(cloneElevAuditor.error) && !cloneElevAuditor.id);
  // Card a06650d2: the FIELD check applies to clone too, even for a NON-elevated (worker) role — this
  // agent-facing tool checks the source profile's fields itself (cloneSourceFieldError), skipRoleCheck,
  // since role is clonedProfileRoleError's own job.
  const cloneVaultWrite = await call("agent_clone", { sourceAgentId: "agentVaultWrite", targetProjectId: "pA" });
  check("(b) agent_clone REJECTS cloning a vaultWrite-carrying (non-elevated-role) profiled agent",
    typeof cloneVaultWrite.error === "string" && /vaultWrite/i.test(cloneVaultWrite.error) && !cloneVaultWrite.id);
  // Card 1f52bc75: representative coverage for the 3 newly-checked field members (documentConversion).
  const cloneDocConversion = await call("agent_clone", { sourceAgentId: "agentDocConversion", targetProjectId: "pA" });
  check("(b) agent_clone REJECTS cloning a documentConversion-carrying (non-elevated-role) profiled agent",
    typeof cloneDocConversion.error === "string" && /documentConversion/i.test(cloneDocConversion.error) && !cloneDocConversion.id);
  check("(b) neither rejected clone created an agent anywhere", db.listAgents("pSrc").length === nAgentsPSrcBefore);

  // ===================== (c) agent_clone_batch — one source, many targets =====================
  const batch = await call("agent_clone_batch", {
    sourceAgentId: "agentPlain",
    targets: [
      { targetProjectId: "pA", nameOverride: "Web Designer (A2)" },
      { targetProjectId: "pB", promptPatch: "You build UI for siteB2.example.com." },
      { targetProjectId: "ghost" }, // bad entry — must not block the other two
    ],
  });
  check("(c) agent_clone_batch: returns one result per target, in order", Array.isArray(batch) && batch.length === 3);
  check("(c) agent_clone_batch: entry 0 succeeds with the nameOverride applied",
    batch[0].targetProjectId === "pA" && batch[0].agent?.name === "Web Designer (A2)" && !batch[0].error);
  check("(c) agent_clone_batch: entry 1 succeeds with the promptPatch applied",
    batch[1].targetProjectId === "pB" && batch[1].agent?.startupPrompt === "You build UI for siteB2.example.com." && !batch[1].error);
  check("(c) agent_clone_batch: entry 2 (bad target) surfaces its OWN error, not a thrown exception",
    batch[2].targetProjectId === "ghost" && batch[2].error === "project not found" && !batch[2].agent);
  check("(c) agent_clone_batch: the two good entries persisted despite the bad one",
    !!db.getAgent(batch[0].agent.id) && !!db.getAgent(batch[1].agent.id));

  // The batch's per-entry guard is the SAME clonedProfileRoleError check as the single-clone path.
  const batchElev = await call("agent_clone_batch", {
    sourceAgentId: "agentPlatform",
    targets: [{ targetProjectId: "pA" }, { targetProjectId: "pB" }],
  });
  check("(c) agent_clone_batch: LEAST-PRIVILEGE applies per-entry too (both targets rejected)",
    batchElev.every((r) => typeof r.error === "string" && /platform/i.test(r.error) && !r.agent));

  // The batch's FIELD check (cloneSourceFieldError, computed ONCE for the shared sourceAgentId) is
  // applied to every entry too — same case as (b) above, but through agent_clone_batch.
  const batchVaultWrite = await call("agent_clone_batch", {
    sourceAgentId: "agentVaultWrite",
    targets: [{ targetProjectId: "pA" }, { targetProjectId: "pB" }],
  });
  check("(c) agent_clone_batch: the FIELD check applies per-entry too (both targets rejected, vaultWrite)",
    batchVaultWrite.every((r) => typeof r.error === "string" && /vaultWrite/i.test(r.error) && !r.agent));

  // Card 1f52bc75: same per-entry coverage for documentConversion.
  const batchDocConversion = await call("agent_clone_batch", {
    sourceAgentId: "agentDocConversion",
    targets: [{ targetProjectId: "pA" }, { targetProjectId: "pB" }],
  });
  check("(c) agent_clone_batch: the FIELD check applies per-entry too (both targets rejected, documentConversion)",
    batchDocConversion.every((r) => typeof r.error === "string" && /documentConversion/i.test(r.error) && !r.agent));

  // ===================== (d) REGRESSION — agent_create/agent_update unchanged =====================
  const created = await call("agent_create", { projectId: "pA", name: "Fresh", startupPrompt: "hi", profileId: "profQA" });
  check("(d) agent_create: still works exactly as before", created.name === "Fresh" && created.profileId === "profQA" && !created.error);
  const createdBadProject = await call("agent_create", { projectId: "ghost", name: "x" });
  check("(d) agent_create: 404 unchanged", createdBadProject.error === "project not found");
  const updated = await call("agent_update", { agentId: created.id, name: "Fresh2" });
  check("(d) agent_update: still works exactly as before", updated.name === "Fresh2" && !updated.error);
  // Card a06650d2: agent_create/agent_update on THIS surface deliberately still ALLOW an elevated
  // profileId directly — administering the Lead's own elevated rigs is this surface's job
  // (allowElevatedRoles:true, per the 3de74275 decision record's amendment) — but a profile carrying
  // connections/capabilities/vaultWrite is now REJECTED regardless of role, on both tools.
  const createdElevDirect = await call("agent_create", { projectId: "pA", name: "DirectElevated", profileId: "profPlatform" });
  check("(d) agent_create: assigning an elevated profileId DIRECTLY is still allowed on this surface (role check lifted)",
    createdElevDirect.profileId === "profPlatform" && !createdElevDirect.error);
  const createdVaultWrite = await call("agent_create", { projectId: "pA", name: "DirectVaultWrite", profileId: "profVaultWrite" });
  check("(d) agent_create: REJECTS a vaultWrite-carrying profileId even though the role check is lifted here",
    typeof createdVaultWrite.error === "string" && /vaultWrite/i.test(createdVaultWrite.error) && !createdVaultWrite.id);
  const updatedElevDirect = await call("agent_update", { agentId: created.id, profileId: "profAuditor" });
  check("(d) agent_update: assigning an elevated profileId DIRECTLY is still allowed on this surface (role check lifted)",
    updatedElevDirect.profileId === "profAuditor" && !updatedElevDirect.error);
  const updatedVaultWrite = await call("agent_update", { agentId: created.id, profileId: "profVaultWrite" });
  check("(d) agent_update: REJECTS a vaultWrite-carrying profileId even though the role check is lifted here",
    typeof updatedVaultWrite.error === "string" && /vaultWrite/i.test(updatedVaultWrite.error));
  check("(d) agent_update: the rejected vaultWrite patch left the agent's profile UNCHANGED (still profAuditor)",
    db.getAgent(created.id)?.profileId === "profAuditor");
  // Card 1f52bc75: representative coverage for the 3 newly-checked field members (documentConversion) —
  // same shape as vaultWrite immediately above.
  const createdDocConversion = await call("agent_create", { projectId: "pA", name: "DirectDocConversion", profileId: "profDocConversion" });
  check("(d) agent_create: REJECTS a documentConversion-carrying profileId even though the role check is lifted here",
    typeof createdDocConversion.error === "string" && /documentConversion/i.test(createdDocConversion.error) && !createdDocConversion.id);
  const updatedDocConversion = await call("agent_update", { agentId: created.id, profileId: "profDocConversion" });
  check("(d) agent_update: REJECTS a documentConversion-carrying profileId even though the role check is lifted here",
    typeof updatedDocConversion.error === "string" && /documentConversion/i.test(updatedDocConversion.error));
  check("(d) agent_update: the rejected documentConversion patch left the agent's profile UNCHANGED (still profAuditor)",
    db.getAgent(created.id)?.profileId === "profAuditor");

  await client.close();
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — agent_clone provisions a clone via the SAME createAgentCore path as agent_create (name/startupPrompt/profileId carry over, nameOverride/promptPatch replace their field), agent_clone_batch clones one source into many targets independently (a bad entry doesn't block the others), the least-privilege guard rejects cloning a platform/auditor-profiled OR a connections/capabilities/vaultWrite-carrying agent (single AND batch), and agent_create/agent_update still allow an elevated-role profileId directly but now reject a connections/capabilities/vaultWrite-carrying one (card a06650d2)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
