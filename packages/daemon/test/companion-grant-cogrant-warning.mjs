import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion grant-time CO-GRANT RISK ADVISORIES (owner decision 4c33a1bc, 2026-07-12) — a WARNING (never a
// block) surfaced at grant time when the owner co-grants a risky COMBINATION of levers. Computed SERVER-side
// (the single source of truth for the risk model — computeCoGrantWarnings, companion/capabilities.ts) and
// returned as a `warnings` array on the grants GET / POST / PUT responses; the web grant panel renders it.
// Fully hermetic: a temp LOOM_HOME + a REAL Db + the REAL buildServer (app.inject), pty/sessions stubbed —
// same envelope as companion-grants-rest.mjs. Covers the card 9beb5ae5 DoD server-side test:
//   1. A BENIGN single grant (transcript-read alone; session-steer alone) carries NO warning.
//   2. The PRIMARY risky co-grant (transcript-read read + session-steer act) → the POST response, the GET,
//      and a PUT all carry the "transcript-steer-launder" warning. The grant itself still SUCCEEDS.
//   3. CROSS-PROJECT counts: transcript-read on project A + session-steer on project B still warns.
//   4. Revoking one side of the pair CLEARS the warning (GET re-derives it from the whole grant set).
//   5. The SECONDARY warning ("multi-tier-a-window") fires when 2+ distinct Tier-A act levers
//      (decisions-relay act + board-reach act) are co-granted, and not for a single Tier-A act grant.
// Run: 1) build (turbo builds shared first), 2) node test/companion-grant-cogrant-warning.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-companion-cogrant-warning-${Date.now()}-${process.pid}`);
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
const ptyStub = { liveStartedAt: () => null };
const app = await buildServer({ db, pty: ptyStub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub });

const now = new Date().toISOString();
const projId = randomUUID();
db.insertProject({ id: projId, name: "Co-grant A", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
const otherProjId = randomUUID();
db.insertProject({ id: otherProjId, name: "Co-grant B", repoPath: otherProjId, vaultPath: otherProjId, config: {}, createdAt: now, archivedAt: null });

const companionAgentId = randomUUID();
db.insertAgent({ id: companionAgentId, projectId: projId, name: "Companion", startupPrompt: "MY_PERSONA", position: 0, profileId: null, endpoint: false, ioSchema: null });
const companionSessId = randomUUID();
db.insertSession({
  id: companionSessId, projectId: projId, agentId: companionAgentId, engineSessionId: "eng-companion", title: null, cwd: projId,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "assistant",
});

const base = `/api/companion/${companionSessId}/grants`;
const post = (payload) => app.inject({ method: "POST", url: base, payload });
const put = (payload) => app.inject({ method: "PUT", url: base, payload });
const del = (capability, projectId) => app.inject({ method: "DELETE", url: `${base}?capability=${capability}${projectId ? `&projectId=${projectId}` : ""}` });
const getGrants = () => app.inject({ method: "GET", url: base });
const hasWarn = (arr, code) => Array.isArray(arr) && arr.some((w) => w.code === code);
const findWarn = (arr, code) => (Array.isArray(arr) ? arr.find((w) => w.code === code) : undefined);

try {
  // ============ 1. A benign single grant carries NO warning ============
  {
    const res = await post({ capability: "transcript-read" }); // read-only lever, one ingredient of the pair
    const body = JSON.parse(res.payload);
    check("POST transcript-read alone → 201", res.statusCode === 201);
    check("POST transcript-read alone → response carries a warnings array", Array.isArray(body.warnings));
    check("POST transcript-read alone → NO launder warning (only one side of the pair)", !hasWarn(body.warnings, "transcript-steer-launder"));
    check("POST transcript-read alone → the grant row itself is intact (additive warnings field)", body.capability === "transcript-read" && body.mode === "read");

    const g = await getGrants();
    check("GET with only transcript-read → warnings empty", JSON.parse(g.payload).warnings.length === 0);
  }

  // ============ 2. The risky co-grant → launder warning on POST + GET, grant still succeeds ============
  {
    const res = await post({ capability: "session-steer", mode: "act" }); // the act half of the pair
    const body = JSON.parse(res.payload);
    check("POST session-steer act (completing the pair) → 201 (grant SUCCEEDS, not blocked)", res.statusCode === 201);
    check("POST session-steer act → response carries the transcript-steer-launder warning", hasWarn(body.warnings, "transcript-steer-launder"));
    const w = findWarn(body.warnings, "transcript-steer-launder");
    check("the launder warning has an owner-facing title + detail", !!w && typeof w.title === "string" && w.title.length > 0 && typeof w.detail === "string" && w.detail.length > 0);

    const g = JSON.parse((await getGrants()).payload);
    check("GET now carries the launder warning too (persistent, whole-grant-set derived)", hasWarn(g.warnings, "transcript-steer-launder"));
    check("the grant actually persisted (both rows present)", db.listCompanionCapabilityGrantsForSession(companionSessId).length === 2);
  }

  // ============ 2b. A PUT on the pair also carries the warning ============
  {
    // Re-affirm the session-steer act grant via PUT (its only supported mode is act) — the response must
    // still surface the launder warning, since the pair is still present in the whole grant set.
    const res = await put({ capability: "session-steer", mode: "act" });
    check("PUT session-steer → 200", res.statusCode === 200);
    check("PUT response carries the launder warning while the pair stands", hasWarn(JSON.parse(res.payload).warnings, "transcript-steer-launder"));
  }

  // ============ 3. CROSS-PROJECT: transcript-read on A + session-steer on B still warns ============
  {
    // Revoke the own-project (null) session-steer, re-grant it scoped to the OTHER project — transcript-read
    // stays on the own project. The pair now spans two projects, which is exactly the risk, so it must warn.
    await del("session-steer");
    const res = await post({ capability: "session-steer", projectId: otherProjId, mode: "act" });
    check("POST session-steer act on a DIFFERENT project → 201", res.statusCode === 201);
    check("cross-project pair (transcript-read on A + session-steer on B) still warns", hasWarn(JSON.parse(res.payload).warnings, "transcript-steer-launder"));
  }

  // ============ 4. Revoking one side CLEARS the warning ============
  {
    await del("transcript-read"); // remove the read half
    const g = JSON.parse((await getGrants()).payload);
    check("GET after revoking transcript-read → launder warning cleared", !hasWarn(g.warnings, "transcript-steer-launder"));
    // Clean up the remaining session-steer grant so the Tier-A section starts from a known state.
    await del("session-steer", otherProjId);
    check("grant set is empty again", db.listCompanionCapabilityGrantsForSession(companionSessId).length === 0);
  }

  // ============ 5. Secondary: multi-Tier-A shared-window ceiling ============
  {
    const one = await post({ capability: "decisions-relay", mode: "act" });
    check("POST decisions-relay act → 201", one.statusCode === 201);
    check("a SINGLE Tier-A act grant carries NO multi-tier-a-window warning", !hasWarn(JSON.parse(one.payload).warnings, "multi-tier-a-window"));

    const two = await post({ capability: "board-reach", mode: "act" });
    check("POST board-reach act (2nd distinct Tier-A) → 201", two.statusCode === 201);
    check("2+ distinct Tier-A act levers → multi-tier-a-window warning fires", hasWarn(JSON.parse(two.payload).warnings, "multi-tier-a-window"));

    // Downgrading one back to read drops it below the 2-distinct-Tier-A threshold → warning clears.
    const downgrade = await put({ capability: "board-reach", mode: "read" });
    check("PUT board-reach act→read → 200", downgrade.statusCode === 200);
    check("dropping below 2 Tier-A act levers clears the multi-tier-a-window warning", !hasWarn(JSON.parse(downgrade.payload).warnings, "multi-tier-a-window"));
  }
} finally {
  try { await app.close(); } catch { /* ignore */ }
  try { db.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — grant-time co-grant advisories: the transcript-read + session-steer launder pair (incl. cross-project) and the 2+ Tier-A shared-window ceiling both surface a warning on the grants GET/POST/PUT responses, a single/benign grant surfaces none, revoking a side clears it, and the grant itself always succeeds (warning, never a block)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
