import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion Capability & Permission-Lever Framework §1 — the human-only REST surface for
// companion_capability_grants (GET list / POST create / PUT update / DELETE), the ONLY writer of a grant
// (there is intentionally no MCP path — see companion-capability-grants.mjs's belt-and-suspenders check).
// Fully hermetic: a temp LOOM_HOME + a REAL Db + the REAL buildServer (app.inject), pty/sessions/etc.
// stubbed (these routes never touch a live pty). NO network, NO real claude, NO daemon. Covers the card's
// DoD (e) grants are human-REST-writable, plus REST-layer validation:
//   1. POST creates a grant (capability validated against the catalog, projectId validated to exist,
//      mode/config validated) and 201s it.
//   2. GET lists a session's grants.
//   3. PUT updates an EXISTING grant (e.g. flips read→act) and 404s when there's nothing to update.
//   4. DELETE removes a grant by (capability, projectId) and is idempotent.
//   5. The routes resolve "the companion" by sessionId: 404 on an unknown session, 400 on a session that
//      isn't role:"assistant" (mirrors every other companion REST resource).
//   6. Bad input (unknown capability slug, a non-existent projectId, an invalid mode) is rejected 400/404,
//      never silently coerced.
// Run: 1) build (turbo builds shared first), 2) node test/companion-grants-rest.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-companion-grants-rest-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

const dbFile = path.join(tmpHome, "loom.db");
const db = new Db(dbFile);
const stub = {};
// The grants GET reads `pty.liveStartedAt(sessionId)` (Code Review Major #1: server-derived apply-pending)
// — these routes never touch a real pty, so a stub returning null (no live process) is the right seam.
const ptyStub = { liveStartedAt: () => null };
const app = await buildServer({ db, pty: ptyStub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub });

const now = new Date().toISOString();
const projId = randomUUID();
db.insertProject({ id: projId, name: "Grants REST", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
const otherProjId = randomUUID();
db.insertProject({ id: otherProjId, name: "Grants REST — other", repoPath: otherProjId, vaultPath: otherProjId, config: {}, createdAt: now, archivedAt: null });

const companionAgentId = randomUUID();
db.insertAgent({ id: companionAgentId, projectId: projId, name: "Companion", startupPrompt: "MY_PERSONA", position: 0, profileId: null, endpoint: false, ioSchema: null });
const companionSessId = randomUUID();
db.insertSession({
  id: companionSessId, projectId: projId, agentId: companionAgentId, engineSessionId: "eng-companion", title: null, cwd: projId,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "assistant",
});

const workerAgentId = randomUUID();
db.insertAgent({ id: workerAgentId, projectId: projId, name: "Worker", startupPrompt: "WORKER_PROMPT", position: 1, profileId: null, endpoint: false, ioSchema: null });
const workerSessId = randomUUID();
db.insertSession({
  id: workerSessId, projectId: projId, agentId: workerAgentId, engineSessionId: "eng-worker", title: null, cwd: projId,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker",
});

const UNKNOWN_SESSION = randomUUID();

try {
  // ============ POST: create ============
  let created;
  {
    const res = await app.inject({ method: "POST", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "session-status" } });
    created = JSON.parse(res.payload);
    check("POST: 201", res.statusCode === 201);
    check("POST: created row carries {sessionId, capability, projectId:null, mode:'read', config:{}}",
      created.sessionId === companionSessId && created.capability === "session-status" && created.projectId === null && created.mode === "read" && JSON.stringify(created.config) === "{}");
    check("POST: the row round-trips through the db", db.listCompanionCapabilityGrantsForSession(companionSessId).length === 1);
  }
  // ============ POST: validation ============
  {
    const badCap = await app.inject({ method: "POST", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "not-a-real-lever" } });
    check("POST: an unknown capability slug → 400", badCap.statusCode === 400);

    const badProject = await app.inject({ method: "POST", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "session-status", projectId: "no-such-project" } });
    check("POST: a non-existent projectId → 404", badProject.statusCode === 404);

    const badMode = await app.inject({ method: "POST", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "session-status", mode: "delete-everything" } });
    check("POST: an invalid mode → 400", badMode.statusCode === 400);

    // CR fix: `mode` must also be validated against the TARGET capability's own `supportsMode` — a
    // well-formed "read"/"act" value that the capability itself doesn't support was previously accepted
    // silently, producing an inert grant the UI shows as "granted" but that gates nothing.
    const actOnReadOnly = await app.inject({ method: "POST", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "session-status", mode: "act" } });
    check("POST: mode:'act' on a read-only-only capability (session-status) → 400", actOnReadOnly.statusCode === 400);
    // The rejected write must not have touched the EXISTING session-status/null grant (created at the
    // top of this file) — still 'read', not silently flipped or duplicated.
    check("POST: the existing session-status grant is unchanged (still 'read')", db.getCompanionCapabilityGrant(companionSessId, "session-status", null)?.mode === "read");

    const readOnActOnly = await app.inject({ method: "POST", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "media-out", mode: "read" } });
    check("POST: mode:'read' on an act-only capability (media-out) → 400", readOnActOnly.statusCode === 400);
    check("POST: no inert grant row was created (media-out)", db.getCompanionCapabilityGrant(companionSessId, "media-out", null) === undefined);

    const readOnSessionSteer = await app.inject({ method: "POST", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "session-steer", mode: "read" } });
    check("POST: mode:'read' on another act-only capability (session-steer) → 400", readOnSessionSteer.statusCode === 400);

    // A mode the capability DOES support still succeeds — this isn't a blanket mode rejection.
    const actOnDecisionsRelay = await app.inject({ method: "POST", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "decisions-relay", mode: "act" } });
    check("POST: mode:'act' on a capability that supports it (decisions-relay) → 201", actOnDecisionsRelay.statusCode === 201);
    const cleanupDecisionsRelay = await app.inject({ method: "DELETE", url: `/api/companion/${companionSessId}/grants?capability=decisions-relay` });
    check("DELETE: cleanup the decisions-relay validation grant (test isolation)", cleanupDecisionsRelay.statusCode === 200);

    // The SAME check applies to PUT (an act→read downgrade attempt on an act-only capability must also
    // reject, not just a fresh POST) — set up an existing media-out grant via a supported mode first.
    const seedMediaOut = await app.inject({ method: "POST", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "media-out", mode: "act" } });
    check("POST: seed a well-formed media-out grant for the PUT check → 201", seedMediaOut.statusCode === 201);
    const putUnsupportedMode = await app.inject({ method: "PUT", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "media-out", mode: "read" } });
    check("PUT: mode:'read' on an act-only capability (media-out) → 400", putUnsupportedMode.statusCode === 400);
    check("PUT: the existing grant's mode is UNCHANGED after the rejected PUT", db.getCompanionCapabilityGrant(companionSessId, "media-out", null).mode === "act");
    const cleanupMediaOutMode = await app.inject({ method: "DELETE", url: `/api/companion/${companionSessId}/grants?capability=media-out` });
    check("DELETE: cleanup the media-out mode-validation grant (test isolation)", cleanupMediaOutMode.statusCode === 200);

    const badConfig = await app.inject({ method: "POST", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "session-status", config: "not-an-object" } });
    check("POST: a non-object config → 400", badConfig.statusCode === 400);

    // CR fix: the config-size bound must be a real UTF-8 BYTE bound, not a UTF-16 code-unit count. 1500
    // multibyte (3-byte-in-UTF-8) characters is ~1500 UTF-16 code units (well under the old .length-based
    // 4096 "limit") but ~4500 UTF-8 bytes (over the 4096-byte bound) — this must now be REJECTED.
    const multibyteOverBytes = await app.inject({
      method: "POST", url: `/api/companion/${companionSessId}/grants`,
      payload: { capability: "session-status", config: { note: "測".repeat(1500) } },
    });
    check("POST: a config within UTF-16 .length but OVER the real UTF-8 byte bound → 400 (byte bound, not code-unit bound)",
      multibyteOverBytes.statusCode === 400);

    // media-out's own config shape (card 3a81b0f2: {roots:string[]}) — checked ON TOP of the generic floor.
    const badMediaRootsType = await app.inject({ method: "POST", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "media-out", config: { roots: "not-an-array" } } });
    check("POST: media-out config.roots not an array → 400", badMediaRootsType.statusCode === 400);

    const badMediaRootsElement = await app.inject({ method: "POST", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "media-out", config: { roots: ["/ok/path", 42] } } });
    check("POST: media-out config.roots with a non-string element → 400", badMediaRootsElement.statusCode === 400);

    const badMediaRootsBlank = await app.inject({ method: "POST", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "media-out", config: { roots: ["   "] } } });
    check("POST: media-out config.roots with a blank string element → 400", badMediaRootsBlank.statusCode === 400);

    const goodMediaRoots = await app.inject({ method: "POST", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "media-out", config: { roots: ["/allowlisted/assets"] } } });
    check("POST: a well-formed media-out config.roots → 201", goodMediaRoots.statusCode === 201);

    // Absent/empty roots is still a VALID config (the lever's own conservative default: nothing
    // deliverable at runtime until the owner configures a root — mirrors decisions-relay's absent
    // decisionClasses default), so an empty-config PUT on the just-created row must succeed, not 400.
    const emptyMediaConfig = await app.inject({ method: "PUT", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "media-out", config: {} } });
    check("PUT: an absent media-out roots config is still valid (200)", emptyMediaConfig.statusCode === 200);

    // Test isolation: the good-config POST above created a real (media-out, null) grant row for
    // companionSessId — clean it up so the downstream session-status count/list assertions (which assume
    // exactly the 2 session-status rows this file seeds) stay accurate.
    const cleanupMedia = await app.inject({ method: "DELETE", url: `/api/companion/${companionSessId}/grants?capability=media-out` });
    check("DELETE: cleanup the media-out validation grant (test isolation)", cleanupMedia.statusCode === 200);

    // board-reach's own config shape (card a5c940a0: {authoredContent:boolean}) — checked ON TOP of the
    // generic floor, mirroring media-out's roots checks above. Fail-closed default OFF: absent is a VALID
    // config (byte-identical verbatim-required behavior), only a non-boolean value is rejected.
    const badAuthoredContentType = await app.inject({ method: "POST", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "board-reach", config: { authoredContent: "true" } } });
    check("POST: board-reach config.authoredContent as a string (not boolean) → 400", badAuthoredContentType.statusCode === 400);

    const goodAuthoredContent = await app.inject({ method: "POST", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "board-reach", config: { authoredContent: true } } });
    check("POST: a well-formed board-reach config.authoredContent:true → 201", goodAuthoredContent.statusCode === 201);

    // Absent authoredContent is still a VALID config (the lever's own fail-closed default: verbatim
    // required until the owner explicitly opts in — mirrors media-out's absent-roots default), so an
    // empty-config PUT on the just-created row must succeed, not 400.
    const emptyBoardReachConfig = await app.inject({ method: "PUT", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "board-reach", config: {} } });
    check("PUT: an absent board-reach authoredContent config is still valid (200)", emptyBoardReachConfig.statusCode === 200);

    // Test isolation: clean up the board-reach validation grant, same as media-out above.
    const cleanupBoardReach = await app.inject({ method: "DELETE", url: `/api/companion/${companionSessId}/grants?capability=board-reach` });
    check("DELETE: cleanup the board-reach validation grant (test isolation)", cleanupBoardReach.statusCode === 200);

    // git-push's own config shape (card a3c3ade8 Increment 1 / card 550d2add Increment 2:
    // {targets:("vault"|"repo")[], authoredContent:boolean}) — checked ON TOP of the generic floor,
    // mirroring media-out's roots + board-reach's authoredContent checks above. Fail-closed default:
    // absent targets is a VALID config (nothing committable until the owner explicitly allows a target),
    // only an unknown target value or a non-boolean authoredContent is rejected. "bogus" proves the
    // validator checks membership, not just element type; "repo" is now a WELL-FORMED, ADMITTED target
    // (Increment 2 widened GIT_PUSH_TARGETS) — the sibling case to Increment 1's own "vault" acceptance.
    const badGitPushTargetsType = await app.inject({ method: "POST", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "git-push", config: { targets: "not-an-array" } } });
    check("POST: git-push config.targets not an array → 400", badGitPushTargetsType.statusCode === 400);

    const badGitPushTargetsUnknown = await app.inject({ method: "POST", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "git-push", config: { targets: ["vault", "bogus"] } } });
    check("POST: git-push config.targets with an unknown element → 400", badGitPushTargetsUnknown.statusCode === 400);

    const goodGitPushTargetsRepo = await app.inject({ method: "POST", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "git-push", config: { targets: ["repo"] } } });
    check("POST: git-push config.targets:['repo'] → 201 (Increment 2 widened the target set)", goodGitPushTargetsRepo.statusCode === 201);

    const badGitPushAuthoredContentType = await app.inject({ method: "POST", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "git-push", config: { authoredContent: "true" } } });
    check("POST: git-push config.authoredContent as a string (not boolean) → 400", badGitPushAuthoredContentType.statusCode === 400);

    // Updates the SAME (capability, projectId) row the targets:['repo'] POST above just created — 200
    // (existed already), not 201. Also proves BOTH targets can be granted together.
    const goodGitPushConfig = await app.inject({ method: "POST", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "git-push", config: { targets: ["vault", "repo"], authoredContent: true } } });
    check("POST: a well-formed git-push config with both targets → 200 (updates the existing row)", goodGitPushConfig.statusCode === 200);

    // Absent targets/authoredContent is still a VALID config (fail-closed default: nothing committable,
    // verbatim required — mirrors media-out's absent-roots / board-reach's absent-authoredContent default).
    const emptyGitPushConfig = await app.inject({ method: "PUT", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "git-push", config: {} } });
    check("PUT: an absent git-push targets/authoredContent config is still valid (200)", emptyGitPushConfig.statusCode === 200);

    // Test isolation: clean up the git-push validation grant, same as media-out/board-reach above.
    const cleanupGitPush = await app.inject({ method: "DELETE", url: `/api/companion/${companionSessId}/grants?capability=git-push` });
    check("DELETE: cleanup the git-push validation grant (test isolation)", cleanupGitPush.statusCode === 200);
  }
  // ============ POST: a second, project-scoped grant for the SAME capability coexists ============
  // NOTE: this lifecycle section (through DELETE below) exercises a read→act flip mid-flow, so it uses
  // "decisions-relay" (supportsMode: read+act) rather than "session-status" (CR fix, read-only) — flipping
  // session-status to "act" is now correctly rejected (see the mode-vs-supportsMode block above). Unlike
  // session-status (created at the top of this file), decisions-relay needs its OWN null-project grant
  // created here first.
  let decisionsRelayCreated;
  {
    const base = await app.inject({ method: "POST", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "decisions-relay" } });
    decisionsRelayCreated = JSON.parse(base.payload);
    check("POST: a fresh decisions-relay (null-project) grant → 201", base.statusCode === 201);

    const res = await app.inject({ method: "POST", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "decisions-relay", projectId: otherProjId, mode: "read" } });
    check("POST: a project-scoped grant for the same capability is a SEPARATE row from the NULL 'own project' one", res.statusCode === 201);
    check("POST: the session now has 2 distinct decisions-relay grants", db.listCompanionCapabilityGrantsForSession(companionSessId).filter((g) => g.capability === "decisions-relay").length === 2);
  }
  // ============ GET: list ============
  {
    const res = await app.inject({ method: "GET", url: `/api/companion/${companionSessId}/grants` });
    const body = JSON.parse(res.payload);
    check("GET: 200", res.statusCode === 200);
    check("GET: lists all grants (the initial session-status + the two decisions-relay)", body.grants.length === 3);
    // Code Review Major #1: the GET exposes the live-process start time so the web panel can derive an
    // apply-pending state that survives a reload. The stub pty reports no live process ⇒ null.
    check("GET: carries liveProcessStartedAt (null with no live pty)", "liveProcessStartedAt" in body && body.liveProcessStartedAt === null);
  }
  // ============ PUT: update an EXISTING grant (read → act) ============
  {
    const res = await app.inject({ method: "PUT", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "decisions-relay", mode: "act" } });
    const body = JSON.parse(res.payload);
    check("PUT: 200 on an existing (capability, projectId) grant", res.statusCode === 200);
    check("PUT: mode flipped to 'act'", body.mode === "act");
    check("PUT: id is STABLE across the update (same row, not a new one)", body.id === decisionsRelayCreated.id);
    check("PUT: the OTHER (project-scoped) grant is untouched", db.getCompanionCapabilityGrant(companionSessId, "decisions-relay", otherProjId).mode === "read");

    const missing = await app.inject({ method: "PUT", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "decisions-relay", projectId: otherProjId, mode: "act", config: { x: 1 }, extra: "irrelevant" } });
    check("PUT: updates config too", JSON.parse(missing.payload).config.x === 1);

    const noRow = await app.inject({ method: "PUT", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "vault-read" } });
    check("PUT: no existing grant for that (capability, projectId) → 404 (must POST to create)", noRow.statusCode === 404);
  }
  // ============ POST: re-POSTing an EXISTING (capability, projectId) is an upsert → 200, not 201 (CR fix) ============
  {
    const res = await app.inject({ method: "POST", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "decisions-relay", mode: "read" } });
    const body = JSON.parse(res.payload);
    check("POST: re-POSTing an EXISTING grant → 200 (update), NOT 201 (would misreport it as freshly created)", res.statusCode === 200);
    check("POST: the update actually applied (mode flipped back to 'read')", body.mode === "read");
    check("POST: id is STABLE across the upsert (same row)", body.id === decisionsRelayCreated.id);
    check("POST: still exactly 2 decisions-relay grants for the session (no duplicate row)", db.listCompanionCapabilityGrantsForSession(companionSessId).filter((g) => g.capability === "decisions-relay").length === 2);
  }
  // ============ DELETE ============
  {
    const res = await app.inject({ method: "DELETE", url: `/api/companion/${companionSessId}/grants?capability=decisions-relay` });
    const body = JSON.parse(res.payload);
    check("DELETE: 200, ok:true", res.statusCode === 200 && body.ok === true);
    check("DELETE: the NULL-project grant is gone", db.getCompanionCapabilityGrant(companionSessId, "decisions-relay", null) === undefined);
    check("DELETE: the project-scoped grant for the SAME capability survives (scoped by projectId too)",
      db.getCompanionCapabilityGrant(companionSessId, "decisions-relay", otherProjId) !== undefined);

    const idempotent = await app.inject({ method: "DELETE", url: `/api/companion/${companionSessId}/grants?capability=decisions-relay` });
    check("DELETE: re-deleting an already-gone grant is a safe 200 no-op (idempotent)", idempotent.statusCode === 200);

    const badCap = await app.inject({ method: "DELETE", url: `/api/companion/${companionSessId}/grants?capability=not-a-real-lever` });
    check("DELETE: an unknown capability query param → 400", badCap.statusCode === 400);

    // Cleanup: remove the surviving project-scoped decisions-relay grant too (test isolation for the
    // sessionId guards section below, which re-lists via a plain capability name check only, but keep the
    // db tidy for anyone reading its final state).
    await app.inject({ method: "DELETE", url: `/api/companion/${companionSessId}/grants?capability=decisions-relay&projectId=${otherProjId}` });
  }
  // ============ resolve-by-sessionId guards (mirrors every other companion REST resource) ============
  {
    const notFound = await app.inject({ method: "GET", url: `/api/companion/${UNKNOWN_SESSION}/grants` });
    check("GET: unknown sessionId → 404", notFound.statusCode === 404);

    const wrongRole = await app.inject({ method: "GET", url: `/api/companion/${workerSessId}/grants` });
    check("GET: a non-assistant (worker) session → 400, not silently served", wrongRole.statusCode === 400);

    const postWrongRole = await app.inject({ method: "POST", url: `/api/companion/${workerSessId}/grants`, payload: { capability: "session-status" } });
    check("POST: a non-assistant (worker) session → 400", postWrongRole.statusCode === 400);
  }
} finally {
  try { await app.close(); } catch { /* ignore */ }
  try { db.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — companion_capability_grants is human-REST-writable (GET/POST/PUT/DELETE), validates the capability slug/projectId existence/mode/config shape (including mode against the TARGET capability's own supportsMode, on both POST and PUT, so an unsupported mode never produces an inert grant), POST creates + PUT updates-only (404 when nothing exists yet) + DELETE is idempotent, distinct (capability, projectId) rows coexist independently, and every route resolves by sessionId with the same 404/400 posture as every other companion REST resource."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
