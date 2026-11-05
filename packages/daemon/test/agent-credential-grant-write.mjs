import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Agent-level credential grant WRITE PATH (card caca806c) — the first dedicated proof that a
// cross-project grant is refused AT WRITE TIME, not just at use time.
//
// Covers:
//   (0) validateAgentPatch: connections/capabilities are IGNORED without allowCredentialGrants (PATCH
//       semantics: key present in the raw body, absent from the returned patch), honored WITH it, bad
//       shapes rejected, and a RESERVED legacy slug (browser-testing/document-conversion) rejected —
//       those stay credential-free and PROFILE-only (mirrors validateProfile's own rejection).
//   (1) agentCredentialGrantCrossProjectError (pure predicate): a global (projectId:null) connection is
//       reachable from any project; a same-project connection is reachable; a DIFFERENT-project
//       connection is refused, naming the offending id; an unknown id is NOT this guard's concern
//       (use-time fails closed instead); both `connections` and `capabilities[].connectionId` are swept.
//   (2) REST POST /api/agents/:id end to end: a same-project grant succeeds and round-trips on the
//       agent row; a cross-project grant via `connections` is refused 400 with the EXACT predicate text;
//       a cross-project grant via `capabilities[].connectionId` is ALSO refused 400, end to end over the
//       real route (the pure predicate alone, section (1), never exercised this through REST); a
//       reserved-slug capability is refused 400 with the validator's text; an oauth2-bound
//       requiresConnection capability is refused via the REUSED capabilityGrantBindingError (same
//       function the profile write path already uses) — never a second, drifting copy; an agent-level
//       grant for a slug its own BOUND PROFILE already grants is refused (card caca806c item 3(b):
//       agentCapabilityProfileCollisionError), with a non-colliding slug unaffected (negative control).
//
// Run: 1) build (turbo builds shared first), 2) node test/agent-credential-grant-write.mjs
import path from "node:path";
import { useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";

const tmpHome = useOwnLoomHome("loom-agent-cred-grant-");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { validateAgentPatch, agentCredentialGrantCrossProjectError } = await import("../dist/agents/validate.js");
const { capabilityGrantBindingError } = await import("../dist/profiles/validate.js");
const { createConnection, createOAuthConnection, getConnectionMetadata } = await import("../dist/connections/store.js");
const { RESERVED_CAPABILITY_SLUGS, createCapabilityDef } = await import("../dist/capabilities/registry.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// ===================== (0) validateAgentPatch: connections/capabilities gating =====================
{
  const hasProfile = () => true;
  // PATCH semantics: present in the raw body, but allowCredentialGrants NOT set -> dropped entirely.
  const noOptIn = validateAgentPatch({ connections: ["c1"], capabilities: [{ slug: "x" }] }, hasProfile, { allowEndpointFlags: false });
  check("(0) without allowCredentialGrants: connections is NOT in the returned patch (PATCH-absent, not just empty)", noOptIn.ok === true && !("connections" in noOptIn.patch));
  check("(0) without allowCredentialGrants: capabilities is NOT in the returned patch either", noOptIn.ok === true && !("capabilities" in noOptIn.patch));

  const optIn = validateAgentPatch({ connections: ["c1", "c2"], capabilities: [{ slug: "x", connectionId: "c1" }] }, hasProfile, { allowEndpointFlags: false, allowCredentialGrants: true });
  check("(0) with allowCredentialGrants: connections IS honored", optIn.ok === true && JSON.stringify(optIn.patch.connections) === JSON.stringify(["c1", "c2"]));
  check("(0) with allowCredentialGrants: capabilities IS honored", optIn.ok === true && JSON.stringify(optIn.patch.capabilities) === JSON.stringify([{ slug: "x", connectionId: "c1" }]));

  const badConn = validateAgentPatch({ connections: ["ok", 5] }, hasProfile, { allowEndpointFlags: false, allowCredentialGrants: true });
  check("(0) a non-string entry in connections is rejected (invalid)", badConn.ok === false && badConn.kind === "invalid");
  const badCap = validateAgentPatch({ capabilities: [{ connectionId: "c1" }] }, hasProfile, { allowEndpointFlags: false, allowCredentialGrants: true }); // missing slug
  check("(0) a capability entry missing 'slug' is rejected (invalid)", badCap.ok === false && badCap.kind === "invalid");

  // Reserved legacy slug: must stay on the Profile's browserTesting/documentConversion booleans, never
  // reachable through an agent's own capabilities array.
  for (const slug of RESERVED_CAPABILITY_SLUGS) {
    const r = validateAgentPatch({ capabilities: [{ slug }] }, hasProfile, { allowEndpointFlags: false, allowCredentialGrants: true });
    check(`(0) a reserved legacy slug ('${slug}') in capabilities is rejected`, r.ok === false && r.kind === "invalid" && /reserved builtin slug/.test(r.error));
  }
  // NEGATIVE CONTROL: a non-reserved slug is unaffected by the new check.
  const okCap = validateAgentPatch({ capabilities: [{ slug: "some-owner-capability" }] }, hasProfile, { allowEndpointFlags: false, allowCredentialGrants: true });
  check("(0) NEGATIVE CONTROL: a non-reserved slug is still accepted", okCap.ok === true);
}

// ===================== (1) agentCredentialGrantCrossProjectError (pure predicate) =====================
{
  const projectOfConn = new Map([["connGlobal", null], ["connSameProj", "pA"], ["connOtherProj", "pB"]]);
  const lookup = (id) => (projectOfConn.has(id) ? projectOfConn.get(id) : undefined);

  check("(1) a global (projectId:null) connection is reachable from any project",
    agentCredentialGrantCrossProjectError({ connections: ["connGlobal"] }, "pA", lookup) === null);
  check("(1) a SAME-project connection is reachable",
    agentCredentialGrantCrossProjectError({ connections: ["connSameProj"] }, "pA", lookup) === null);
  const crossErr = agentCredentialGrantCrossProjectError({ connections: ["connOtherProj"] }, "pA", lookup);
  check("(1) a DIFFERENT-project connection is REFUSED", typeof crossErr === "string");
  check("(1) the refusal names the offending connection id", crossErr.includes("connOtherProj"));
  check("(1) an UNKNOWN id is NOT this guard's concern (use-time fails closed instead)",
    agentCredentialGrantCrossProjectError({ connections: ["connUnknown"] }, "pA", lookup) === null);
  // The capabilities[].connectionId path is swept too, independently of connections.
  check("(1) a cross-project connectionId bound via capabilities is ALSO refused",
    typeof agentCredentialGrantCrossProjectError({ capabilities: [{ slug: "x", connectionId: "connOtherProj" }] }, "pA", lookup) === "string");
  check("(1) a capability grant with NO connectionId is unaffected",
    agentCredentialGrantCrossProjectError({ capabilities: [{ slug: "x" }] }, "pA", lookup) === null);
  check("(1) NEGATIVE CONTROL: no connections/capabilities keys at all -> null",
    agentCredentialGrantCrossProjectError({}, "pA", lookup) === null);
}

// ===================== (2) REST POST /api/agents/:id end to end =====================
{
  const dbFile = path.join(tmpHome, "rest.db");
  const db = new Db(dbFile);
  const now = new Date().toISOString();
  db.insertProject({ id: "pA", name: "A", repoPath: "pA", vaultPath: "pA", config: {}, createdAt: now, archivedAt: null });
  db.insertProject({ id: "pB", name: "B", repoPath: "pB", vaultPath: "pB", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "agentA", projectId: "pA", name: "AgentA", startupPrompt: "", position: 0, profileId: null });

  const connA = createConnection(db, { name: "ConnA", host: "a.example", authScheme: "bearer", secret: "sek-A", projectId: "pA" });
  const connB = createConnection(db, { name: "ConnB", host: "b.example", authScheme: "bearer", secret: "sek-B", projectId: "pB" });
  const connGlobal = createConnection(db, { name: "ConnGlobal", host: "g.example", authScheme: "api-key", secret: "sek-G" });
  const connOAuth = createOAuthConnection(db, {
    name: "ConnOAuth", host: "o.example", provider: "custom",
    clientId: "cid", clientSecret: "csecret", authUrl: "https://o.example/auth", tokenUrl: "https://o.example/token", scopes: ["read"],
  });
  createCapabilityDef(db, {
    slug: "guard-test-cap", name: "Guard Test", description: "test cap", transport: "stdio", kind: "bundled",
    provision: { command: process.execPath, args: [] }, toolAllowlist: [], wantsScratchDir: false,
    requiresConnection: true, secretEnvVar: "GUARD_TEST_TOKEN",
  });
  // A SECOND requiresConnection def, dedicated to the capabilities[].connectionId cross-project case
  // below — reusing "guard-test-cap" there would also trip the oauth2-binding guard (connB is "bearer",
  // not oauth2, so it wouldn't, but a dedicated def keeps each refusal isolated to ONE mechanism).
  createCapabilityDef(db, {
    slug: "guard-test-cap-2", name: "Guard Test 2", description: "test cap 2", transport: "stdio", kind: "bundled",
    provision: { command: process.execPath, args: [] }, toolAllowlist: [], wantsScratchDir: false,
    requiresConnection: true, secretEnvVar: "GUARD_TEST_TOKEN_2",
  });

  const stub = {};
  const app = await buildServer({
    db, pty: { enqueueStdin: () => ({ delivered: true }) }, sessions: stub, mcp: stub, orchMcp: stub,
    platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
  });

  // (2a) SAME-project connection grant: succeeds and round-trips.
  const okRes = await app.inject({ method: "POST", url: "/api/agents/agentA", payload: { connections: [connA.id, connGlobal.id] } });
  check("(2a) same-project + global connection grant: 200", okRes.statusCode === 200);
  check("(2a) the agent row carries both granted ids", JSON.stringify(db.getAgent("agentA").connections ?? []) === JSON.stringify([connA.id, connGlobal.id]));

  // (2b) CROSS-project connection grant (via `connections`): refused 400, body.error matches the predicate's own text.
  const crossRes = await app.inject({ method: "POST", url: "/api/agents/agentA", payload: { connections: [connB.id] } });
  check("(2b) cross-project connection grant: 400", crossRes.statusCode === 400);
  const expectedCrossErr = agentCredentialGrantCrossProjectError({ connections: [connB.id] }, "pA", (id) => getConnectionMetadata(db, id)?.projectId);
  check("(2b) the REST refusal body matches the predicate's own text EXACTLY", JSON.parse(crossRes.body).error === expectedCrossErr);
  check("(2b) the refused write did NOT land (agent row unchanged from 2a)", JSON.stringify(db.getAgent("agentA").connections ?? []) === JSON.stringify([connA.id, connGlobal.id]));

  // (2b-2) CROSS-project connection grant via `capabilities[].connectionId` — the OTHER half of the
  // same predicate's sweep, now exercised end to end over the real route (section (1) above only ever
  // proved this against the bare pure predicate, never through REST).
  const crossCapRes = await app.inject({ method: "POST", url: "/api/agents/agentA", payload: { capabilities: [{ slug: "guard-test-cap-2", connectionId: connB.id }] } });
  check("(2b-2) cross-project connectionId bound via capabilities[]: 400", crossCapRes.statusCode === 400);
  const expectedCrossCapErr = agentCredentialGrantCrossProjectError({ capabilities: [{ slug: "guard-test-cap-2", connectionId: connB.id }] }, "pA", (id) => getConnectionMetadata(db, id)?.projectId);
  check("(2b-2) the REST refusal body matches the predicate's own text EXACTLY", JSON.parse(crossCapRes.body).error === expectedCrossCapErr);
  check("(2b-2) the refused write did NOT land (agent row still carries no capabilities)", JSON.stringify(db.getAgent("agentA").capabilities ?? []) === JSON.stringify([]));

  // (2c) a RESERVED legacy slug via REST: refused 400, reuses the validator's own text.
  const reservedRes = await app.inject({ method: "POST", url: "/api/agents/agentA", payload: { capabilities: [{ slug: RESERVED_CAPABILITY_SLUGS[0] }] } });
  check("(2c) a reserved legacy slug via REST: 400", reservedRes.statusCode === 400);
  check("(2c) names 'reserved builtin slug'", /reserved builtin slug/.test(JSON.parse(reservedRes.body).error));

  // (2d) an oauth2-bound requiresConnection capability: refused via the REUSED capabilityGrantBindingError
  // (same function profiles/validate.ts already uses) — proves the agent write path shares it rather than
  // carrying a second, independently-drifting copy. "guard-test-cap" is a real requiresConnection:true
  // def created above (mirrors the equivalent check in test/profiles.mjs).
  const oauthRes = await app.inject({ method: "POST", url: "/api/agents/agentA", payload: { capabilities: [{ slug: "guard-test-cap", connectionId: connOAuth.id }] } });
  check("(2d) an oauth2 connection bound to a requiresConnection capability: 400", oauthRes.statusCode === 400);
  const expectedOAuthErr = capabilityGrantBindingError([{ slug: "guard-test-cap", connectionId: connOAuth.id }], db);
  check("(2d) the REST refusal matches capabilityGrantBindingError's own text EXACTLY (shared, not duplicated)", JSON.parse(oauthRes.body).error === expectedOAuthErr);

  // (2e) card afe1bc90 R4 (replaces caca806c's slug-collision case, retired with the profile-level
  // capabilities field): an agent-level capabilities write is refused when the agent's bound profile runs
  // the CODEX harness — every registry capability is stdio-shaped and codex mounts nothing for it.
  db.insertProfile({
    id: "profCollision", name: "Codex Rig", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null,
    harness: "codex",
  });
  db.insertProfile({
    id: "profClaudeRig", name: "Claude Rig", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null,
  });
  db.insertAgent({ id: "agentCollision", projectId: "pA", name: "AgentCollision", startupPrompt: "", position: 0, profileId: "profCollision" });
  const collisionRes = await app.inject({ method: "POST", url: "/api/agents/agentCollision", payload: { capabilities: [{ slug: "guard-test-cap" }] } });
  check("(2e) an agent-level capability grant on an agent bound to a codex profile: 400", collisionRes.statusCode === 400);
  check("(2e) the refusal names codex", /codex/.test(JSON.parse(collisionRes.body).error));
  check("(2e) the refused write did NOT land", JSON.stringify(db.getAgent("agentCollision").capabilities ?? []) === JSON.stringify([]));
  // NEGATIVE CONTROL: the SAME grant on an agent bound to a claude-harness profile lands.
  db.insertAgent({ id: "agentClaude", projectId: "pA", name: "AgentClaude", startupPrompt: "", position: 5, profileId: "profClaudeRig" });
  const noCollisionRes = await app.inject({ method: "POST", url: "/api/agents/agentClaude", payload: { capabilities: [{ slug: "some-other-slug" }] } });
  check("(2e) NEGATIVE CONTROL: the same grant on a claude-profiled agent: 200", noCollisionRes.statusCode === 200);
  check("(2e) ...and it lands", JSON.stringify(db.getAgent("agentClaude").capabilities ?? []) === JSON.stringify([{ slug: "some-other-slug" }]));
  // (2e-rebind) rebinding a capability-carrying agent ONTO a codex profile is refused too.
  const rebindRes = await app.inject({ method: "POST", url: "/api/agents/agentClaude", payload: { profileId: "profCollision" } });
  check("(2e) rebinding a capability-carrying agent onto a codex profile: 400", rebindRes.statusCode === 400 && db.getAgent("agentClaude").profileId === "profClaudeRig");
  // (2e-flip) flipping the CLAUDE profile to codex under that bound capability-carrying agent is refused (REST profile PUT).
  const flipRes = await app.inject({ method: "PUT", url: "/api/profiles/profClaudeRig", payload: { harness: "codex" } });
  check("(2e) PUT /api/profiles flipping a profile to codex under a bound capability-carrying agent: 400", flipRes.statusCode === 400 && db.getProfile("profClaudeRig").harness !== "codex");

  // (2f) a single PATCH carrying BOTH `profileId` and `capabilities` must check the codex rule against the
  // POST-patch profile, never the one being replaced. Two agents, each starting on the OPPOSITE side from
  // where the patch lands it — checking `existing.profileId` would get BOTH wrong, in opposite directions.
  db.insertAgent({ id: "agentPatchSwitchIn", projectId: "pA", name: "AgentPatchSwitchIn", startupPrompt: "", position: 2, profileId: null });
  const switchInRes = await app.inject({
    method: "POST", url: "/api/agents/agentPatchSwitchIn",
    payload: { profileId: "profCollision", capabilities: [{ slug: "guard-test-cap" }] },
  });
  check("(2f) profile-less agent PATCHing profileId+capabilities onto a colliding slug in ONE call: 400 (checked against the POST-patch profile, not the pre-patch null)", switchInRes.statusCode === 400);
  check("(2f) ...and the refused write did NOT land (profileId still null)", db.getAgent("agentPatchSwitchIn").profileId === null);

  db.insertAgent({ id: "agentPatchSwitchOut", projectId: "pA", name: "AgentPatchSwitchOut", startupPrompt: "", position: 3, profileId: "profCollision" });
  const switchOutRes = await app.inject({
    method: "POST", url: "/api/agents/agentPatchSwitchOut",
    payload: { profileId: null, capabilities: [{ slug: "guard-test-cap" }] },
  });
  check("(2f) NEGATIVE CONTROL: an agent PATCHing profileId:null (clearing the colliding profile) + the SAME slug in ONE call: 200 (checked against the POST-patch null, not the pre-patch colliding profile)", switchOutRes.statusCode === 200);
  check("(2f) ...and it lands", JSON.stringify(db.getAgent("agentPatchSwitchOut").capabilities ?? []) === JSON.stringify([{ slug: "guard-test-cap" }]) && db.getAgent("agentPatchSwitchOut").profileId === null);

  // (3) toAgent corrupt-row hardening: a hand-corrupted agents.connections/capabilities JSON text must
  // never make listAgents/getAgent throw, and must read as [] (same guard shape as toProfile's own
  // connections/capabilities — db.ts's toAgent wraps each JSON.parse in its own try/catch).
  db.insertAgent({ id: "agentCorrupt", projectId: "pA", name: "AgentCorrupt", startupPrompt: "", position: 1, profileId: null });
  db.db.prepare("UPDATE agents SET connections = ? WHERE id = ?").run("{not valid json", "agentCorrupt");
  db.db.prepare("UPDATE agents SET capabilities = ? WHERE id = ?").run("[{broken", "agentCorrupt");
  let corruptGetThrew = false;
  let corruptGetResult;
  try { corruptGetResult = db.getAgent("agentCorrupt"); } catch { corruptGetThrew = true; }
  check("(3) getAgent NEVER throws on a corrupt connections/capabilities row", !corruptGetThrew);
  check("(3) getAgent reads the corrupt connections column as []", JSON.stringify(corruptGetResult?.connections) === JSON.stringify([]));
  check("(3) getAgent reads the corrupt capabilities column as []", JSON.stringify(corruptGetResult?.capabilities) === JSON.stringify([]));
  let corruptListThrew = false;
  let corruptListResult;
  try { corruptListResult = db.listAgents("pA"); } catch { corruptListThrew = true; }
  check("(3) listAgents NEVER throws with a corrupt row present among healthy siblings", !corruptListThrew);
  const corruptInList = corruptListResult?.find((a) => a.id === "agentCorrupt");
  check("(3) listAgents' own copy of the corrupt row ALSO reads as []", JSON.stringify(corruptInList?.connections) === JSON.stringify([]) && JSON.stringify(corruptInList?.capabilities) === JSON.stringify([]));
  check("(3) the corrupt row's failure never blocked a healthy sibling from resolving", corruptListResult?.some((a) => a.id === "agentCollision"));

  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — validateAgentPatch gates connections/capabilities on allowCredentialGrants, rejects bad shapes and reserved legacy slugs; agentCredentialGrantCrossProjectError refuses a cross-project grant (naming the id) while a global/same-project/unknown id all pass; the real REST POST /api/agents/:id end-to-end enforces all of it with the exact predicate text for BOTH `connections` and `capabilities[].connectionId`, reusing (not duplicating) capabilityGrantBindingError for the oauth2-binding refusal; (card caca806c item 3(b)) an agent-level grant for a slug its own bound profile already grants is refused, with a non-colliding slug unaffected; and toAgent never throws on a hand-corrupted connections/capabilities row, degrading to [] for both getAgent and listAgents without blocking a healthy sibling."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
