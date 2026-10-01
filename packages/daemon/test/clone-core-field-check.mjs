import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Round-2 security review BLOCKING finding on card a06650d2 (fix round 2): every EXISTING test that
// exercises createAgentCore/cloneAgentCore's field check does so through an agent-facing MCP pre-check
// (cloneSourceFieldError, mcp/platform.ts's agent_clone/agent_clone_batch) that ALSO rejects — so if
// createAgentCore's/cloneAgentCore's OWN default (no opts) regressed from fail-closed to fail-open, every
// one of those tests would stay green, masking the regression. The reviewer proved this directly: a
// one-line dist patch forcing cloneAgentCore to always pass `humanAuthorized: true` left
// platform-agent-clone.mjs, companion-provision.mjs, platform-mgmt-surface.mjs,
// agent-assignable-profile-guard.mjs, AND connections-store.mjs all green.
//
// This file calls createAgentCore/cloneAgentCore DIRECTLY (bypassing every MCP-layer pre-check), so ONLY
// the core's own `agentAssignableProfileError(profile, opts)` call is ever exercised. Proves:
//   (a) createAgentCore(db, {...profileId: X}, /* no opts */) REJECTS when X's profile carries a non-empty
//       connections, OR a non-empty capabilities, OR vaultWrite:true (each tested separately, all on a
//       non-elevated "worker" role, to isolate the FIELD axis from the ROLE axis) — zero agent rows
//       created in every case.
//   (b) cloneAgentCore(db, sourceAgentId, targetProjectId, {}, /* no opts */) REJECTS the same way for a
//       SOURCE agent bound to each of those profiles — zero agent rows created.
//   (c) a CLEAN profile still SUCCEEDS through both functions with no opts (regression guard — proves the
//       check isn't unconditionally rejecting everything).
//   (d) `{ humanAuthorized: true }` on both functions SKIPS the field check (the opt-out actually works) —
//       but does NOT skip the ROLE check (an elevated-role source is still rejected via
//       clonedProfileRoleError/createAgentCore's own role branch even with humanAuthorized:true).
//
// RED-PROVEN manually (see the fix commit this file ships in): dist/agents/clone-core.js's cloneAgentCore
// was patched to always pass `{ skipRoleCheck: true, humanAuthorized: true }` (ignoring its own `opts`
// param) regardless of caller intent — (b)'s three REJECTS flipped to unexpected successes with real agent
// rows created, confirming this file's own checks are capable of catching exactly the regression class the
// review found. The patch was then reverted byte-for-byte and this file re-run GREEN before committing.
//
// Run: 1) build (turbo builds shared first), 2) node test/clone-core-field-check.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-clonecore-fieldcheck-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { Db } = await import("../dist/db.js");
const { createAgentCore, cloneAgentCore } = await import("../dist/agents/clone-core.js");

try {
  const db = new Db(path.join(tmpHome, "loom.db"));
  const now = new Date().toISOString();
  db.insertProject({ id: "pSrc", name: "Source", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
  db.insertProject({ id: "pTarget", name: "Target", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });

  // Non-elevated (worker) role, each carrying ONE human-only field — isolates the FIELD axis from ROLE.
  db.insertProfile({ id: "profConnections", name: "Connections Rig", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null, connections: ["connX"] });
  db.insertProfile({ id: "profCapabilities", name: "Capabilities Rig", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null, capabilities: [{ slug: "some-cap" }] });
  db.insertProfile({ id: "profVaultWrite", name: "VaultWrite Rig", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null, vaultWrite: true });
  db.insertProfile({ id: "profClean", name: "Clean Rig", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null });

  const FIELD_CASES = [
    { profileId: "profConnections", label: "connections", pattern: /connections/i },
    { profileId: "profCapabilities", label: "capabilities", pattern: /capabilities/i },
    { profileId: "profVaultWrite", label: "vaultWrite", pattern: /vaultWrite/i },
  ];

  // ===================== (a) createAgentCore, NO opts — fail-closed by default =====================
  for (const { profileId, label, pattern } of FIELD_CASES) {
    const before = db.listAgents("pTarget").length;
    const res = createAgentCore(db, { projectId: "pTarget", name: `CreateDirect-${label}`, profileId });
    check(`(a) createAgentCore with NO opts REJECTS a profile carrying ${label}`, res.ok === false && pattern.test(res.error ?? ""));
    check(`(a) createAgentCore: the rejected ${label} call created NO agent row`, db.listAgents("pTarget").length === before);
  }

  // ===================== (b) cloneAgentCore, NO opts — fail-closed by default =====================
  for (const { profileId, label, pattern } of FIELD_CASES) {
    const sourceAgentId = `agentSource-${label}`;
    db.insertAgent({ id: sourceAgentId, projectId: "pSrc", name: `Source-${label}`, startupPrompt: "x", position: 0, profileId });
    const before = db.listAgents("pTarget").length;
    const res = cloneAgentCore(db, sourceAgentId, "pTarget", {});
    check(`(b) cloneAgentCore with NO opts REJECTS a source profile carrying ${label}`, res.ok === false && pattern.test(res.error ?? ""));
    check(`(b) cloneAgentCore: the rejected ${label} clone created NO agent row`, db.listAgents("pTarget").length === before);
  }

  // ===================== (c) a CLEAN profile still succeeds through both, no opts (regression guard) ====
  const cleanCreate = createAgentCore(db, { projectId: "pTarget", name: "CleanCreateDirect", profileId: "profClean" });
  check("(c) createAgentCore with NO opts SUCCEEDS for a clean profile (regression guard)",
    cleanCreate.ok === true && cleanCreate.agent.profileId === "profClean");
  db.insertAgent({ id: "agentSourceClean", projectId: "pSrc", name: "SourceClean", startupPrompt: "x", position: 1, profileId: "profClean" });
  const cleanClone = cloneAgentCore(db, "agentSourceClean", "pTarget", {});
  check("(c) cloneAgentCore with NO opts SUCCEEDS for a clean source profile (regression guard)",
    cleanClone.ok === true && cleanClone.agent.profileId === "profClean");

  // ===================== (d) humanAuthorized:true SKIPS the field check, never the role check ===========
  const haCreate = createAgentCore(db, { projectId: "pTarget", name: "VaultWriteWithHA", profileId: "profVaultWrite" }, { humanAuthorized: true });
  check("(d) createAgentCore({ humanAuthorized: true }) SKIPS the field check for a vaultWrite profile",
    haCreate.ok === true && haCreate.agent.profileId === "profVaultWrite");
  db.insertAgent({ id: "agentSourceVaultWrite2", projectId: "pSrc", name: "SourceVaultWrite2", startupPrompt: "x", position: 2, profileId: "profVaultWrite" });
  const haClone = cloneAgentCore(db, "agentSourceVaultWrite2", "pTarget", {}, { humanAuthorized: true });
  check("(d) cloneAgentCore({ humanAuthorized: true }) SKIPS the field check for a vaultWrite source profile",
    haClone.ok === true && haClone.agent.profileId === "profVaultWrite");

  // humanAuthorized:true must NEVER lift the ROLE check (clonedProfileRoleError's own axis).
  db.insertProfile({ id: "profPlatformElev", name: "Elevated Rig", role: "platform", description: "", allowDelta: [], skills: null, model: null, icon: null });
  db.insertAgent({ id: "agentSourceElevated", projectId: "pSrc", name: "SourceElevated", startupPrompt: "x", position: 3, profileId: "profPlatformElev" });
  const beforeElevHA = db.listAgents("pTarget").length;
  const elevHAClone = cloneAgentCore(db, "agentSourceElevated", "pTarget", {}, { humanAuthorized: true });
  check("(d) humanAuthorized:true does NOT lift the ROLE check (an elevated-role source clone still rejects)",
    elevHAClone.ok === false && /platform/i.test(elevHAClone.error ?? ""));
  check("(d) the rejected elevated+humanAuthorized clone created NO agent row", db.listAgents("pTarget").length === beforeElevHA);

  db.close();
} finally {
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — createAgentCore/cloneAgentCore's OWN field check (connections/capabilities/vaultWrite) is fail-closed by default (no opts) for both direct-create and clone, a clean profile still succeeds through both (regression guard), humanAuthorized:true skips the field check but never the role check — exercised directly, bypassing every MCP-layer pre-check, so a regression in the cores' own default can never hide behind an agent-facing check that happens to also reject."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
