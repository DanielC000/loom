import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 7f6c1cbb — the boot migration for the RETIRED Operator role (setup/retire-operator.ts).
//
// An install that ran the old code may hold: a stored `platform.operatorEnabled` override, the seeded
// "Elevated Operator" agent (pinned by `setup.operatorAgentId`) and bundled profile (role "operator"),
// user-made operator-role profiles, and operator-role session rows. This test builds that legacy state in
// real on-disk SQLite files under a temp LOOM_HOME (rows written exactly as the deleted seeder wrote them),
// closes + REOPENS the file (the "boot on the new code" step: Db open, then the same seedSetupHome /
// retireOperatorRole calls index.ts makes), and asserts:
//   (1) boot-time calls succeed and config validation does not choke on the stored key;
//   (2) PRISTINE agent + profile are removed, with their marker + sentinel;
//   (3) a CUSTOMIZED agent / profile is KEPT (profile role demoted to plain, agent + prompt untouched);
//   (4) an agent with session history is kept even when pristine, and so is its profile (bound);
//   (5) a user-made operator-role profile is demoted, never deleted;
//   (6) operator-role session rows become plain;
//   (7) a second run changes nothing; a corrupt config blob is never overwritten.
//
// What this does NOT cover: a DB copied from a real pre-migration install (workers never touch ~/.loom),
// and the real daemon boot (no daemon is booted here — only the migration's own calls are driven).
//
// Run: 1) build (turbo builds shared first), 2) node test/retire-operator-migration.mjs
import path from "node:path";
import { useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";

const tmpHome = useOwnLoomHome("loom-retire-op-");
requireHermeticEnv();

const { resolveConfig } = await import("@loom/shared");
const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { seedDefaultProfiles } = await import("../dist/profiles/seed.js");
const seed = await import("../dist/setup/seed.js");
const { retireOperatorRole } = await import("../dist/setup/retire-operator.js");
const { SETUP_HOME_OPERATOR_AGENT_ID_KEY, seededMarkerMigratedKey, resolveSetupHome } = await import("../dist/projects/reserved-home-markers.js");
const { validatePlatformConfigOverride } = await import("../dist/mcp/platform.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// The exact shipped values the deleted seeder wrote (copied from the pre-7f6c1cbb setup/seed.ts + profiles/seed.ts).
const SHIPPED_PROMPT = `You are the **Elevated Operator** — a bounded operator a human spawns deliberately to act on THEIR CURRENT PROJECT's working tree: switch/create local branches, commit changes, write notes into that project's vault, and push its current branch to its own remote. You are confined to the one project you're started in; you can never reach another project, run host/deploy commands, send data to a webhook, edit Loom's bundled skills, create schedules, or spawn/elevate other sessions.

Act only on the explicit task the human gives you this session. Confirm before an irreversible or ambiguous step. When you're done, say plainly what you changed (branch/commit/push/vault write) so the human can verify.`;
const SHIPPED_PROFILE = {
  name: "Elevated Operator", role: "operator",
  description: "Elevated Operator rig (off by default): a bounded, own-workspace-confined operator that can switch/create local branches, commit, write vault notes, and push its own project's branch on your behalf — never another project's. Requires enabling 'Elevated Operator' in Settings; spawned only by you.",
  allowDelta: [], skills: null, model: null, icon: "🛠️",
};

let n = 0;
/** A legacy install on disk: setup home + bundled profiles, plus the operator leftovers, flag ON. Returns the file path. */
function legacyInstall(opts) {
  const file = path.join(tmpHome, `legacy-${++n}.db`);
  const db = new Db(file);
  seedDefaultProfiles(db);
  seed.seedSetupHome(db);
  const home = resolveSetupHome(db);
  db.setPlatformConfig({ operatorEnabled: true, schedulerEnabled: true });
  db.insertProfile({ id: "prof-op", ...SHIPPED_PROFILE, ...(opts.profile ?? {}) });
  // The seed record the customization engine keeps (base_snapshot): what the profile was when seeded, or
  // — for a later default migration that rewrote fields AND the snapshot — what it was after that.
  db.setProfileBaseSnapshot("prof-op", JSON.stringify({ ...SHIPPED_PROFILE, ...(opts.snapshot ?? {}) }));
  if (opts.agent !== false) {
    db.insertAgent({
      id: "agent-op", projectId: home.id, name: "Elevated Operator", startupPrompt: opts.prompt ?? SHIPPED_PROMPT,
      position: 9, profileId: opts.agentProfileId === undefined ? "prof-op" : opts.agentProfileId, endpoint: false, ioSchema: null,
    });
    db.setMeta(SETUP_HOME_OPERATOR_AGENT_ID_KEY, "agent-op");
    db.setMeta(seededMarkerMigratedKey(SETUP_HOME_OPERATOR_AGENT_ID_KEY), "2026-01-01T00:00:00.000Z");
  }
  opts.extra?.(db, home);
  db.close();
  return { file, homeId: home.id };
}
const operatorSession = (db, id, projectId, agentId) => db.insertSession({
  id, projectId, agentId, engineSessionId: null, title: null, cwd: tmpHome, processState: "exited", resumability: "unknown",
  busy: false, createdAt: new Date().toISOString(), lastActivity: new Date().toISOString(), lastError: null, role: "operator",
  browserTesting: false, documentConversion: false, capabilities: [], restrictedTools: false, noCommit: false, skills: null, connections: [], vaultWrite: false,
});

/** The "next boot": reopen the file with the NEW code and run the calls index.ts makes. */
function bootOnNewCode(file) {
  const db = new Db(file);
  seedDefaultProfiles(db);
  seed.seedSetupHome(db);
  const result = retireOperatorRole(db);
  return { db, result };
}

// ===================== (A) pristine install: everything the old seeder wrote is cleaned up =====================
{
  const { file, homeId } = legacyInstall({});
  const { db, result } = bootOnNewCode(file);
  check("(A) boot calls ran and reported a change", result.changed === true);
  check("(A) the stored operatorEnabled key is gone from the persisted blob", !("operatorEnabled" in (db.getPlatformConfigRaw() ?? { operatorEnabled: 1 })));
  check("(A) ...and the unrelated stored key survived", db.getPlatformConfig().schedulerEnabled === true);
  check("(A) the stored blob passes the strict validator", validatePlatformConfigOverride(db.getPlatformConfig()).ok === true);
  check("(A) resolveConfig has no operatorEnabled", !("operatorEnabled" in resolveConfig(undefined, db.getPlatformConfig()).platform));
  check("(A) the pristine seeded agent is deleted", db.getAgent("agent-op") === undefined && result.agentDeleted === true);
  check("(A) the pristine seeded profile is deleted", db.getProfile("prof-op") === undefined && result.profilesDeleted === 1);
  check("(A) the marker AND its name-migration sentinel are cleared", !db.getMeta(SETUP_HOME_OPERATOR_AGENT_ID_KEY) && !db.getMeta(seededMarkerMigratedKey(SETUP_HOME_OPERATOR_AGENT_ID_KEY)));
  check("(A) the OTHER setup-home agents are untouched", db.listAgents(homeId).some((a) => a.name === "Platform"));
  check("(A) no profile carries the retired role", db.listProfileIdsWithRetiredOperatorRole().length === 0);

  // Control: the same boot over the same file again is a no-op.
  const again = retireOperatorRole(db);
  check("(A) CONTROL: a second run changes nothing", again.changed === false);

  // The REST config surface works over the migrated DB (a stored key used to make every PATCH 400).
  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, control: stub, usageStatus: stub });
  const get = await app.inject({ method: "GET", url: "/api/platform/config" });
  check("(A) GET /api/platform/config → 200 with no operatorEnabled in override or resolved", get.statusCode === 200 && !JSON.stringify(get.json()).includes("operatorEnabled"));
  const patch = await app.inject({ method: "PATCH", url: "/api/platform/config", payload: { coalesceAgentMessages: true } });
  check("(A) an ordinary PATCH → 200", patch.statusCode === 200);
  await app.close();
  db.close();
}

// ===================== (B) customized agent + profile + operator session: nothing the user owns is deleted =====================
{
  const { file, homeId } = legacyInstall({
    prompt: `${SHIPPED_PROMPT}\n\nAlso: always run the linter first.`, // the user edited the prompt
    profile: { description: "my own description", model: "claude-opus-4-8" }, // ...and the profile
    extra: (db, home) => operatorSession(db, "sess-b", home.id, "agent-op"),
  });
  const { db, result } = bootOnNewCode(file);
  const agent = db.getAgent("agent-op");
  check("(B) the customized agent is KEPT, prompt byte-identical", !!agent && agent.startupPrompt.endsWith("always run the linter first.") && result.agentKept === true && result.agentDeleted === false);
  check("(B) the customized profile is KEPT with its edits, role demoted to plain", db.getProfile("prof-op")?.role === null && db.getProfile("prof-op")?.description === "my own description" && db.getProfile("prof-op")?.model === "claude-opus-4-8");
  check("(B) the kept agent is still bound to its (now plain) profile", agent.profileId === "prof-op");
  check("(B) the operator-role session row became plain, row kept", db.getSession("sess-b") !== undefined && db.getSession("sess-b").role === null && result.sessionsDemoted === 1);
  check("(B) the marker is dropped even though the agent stays (no re-adoption by name)", !db.getMeta(SETUP_HOME_OPERATOR_AGENT_ID_KEY));
  check("(B) the stored operatorEnabled key is still stripped", !("operatorEnabled" in (db.getPlatformConfigRaw() ?? { operatorEnabled: 1 })));
  check("(B) the home still lists the kept agent", db.listAgents(homeId).some((a) => a.id === "agent-op"));
  db.close();
}

// ===================== (C) a pristine agent WITH session history is kept; its bound profile is demoted, not deleted =====================
{
  const { file } = legacyInstall({ extra: (db, home) => operatorSession(db, "sess-c", home.id, "agent-op") });
  const { db, result } = bootOnNewCode(file);
  check("(C) a pristine agent with history is kept", db.getAgent("agent-op") !== undefined && result.agentKept === true);
  check("(C) its bound, pristine profile is demoted to plain (not deleted: an agent still uses it)", db.getProfile("prof-op")?.role === null && result.profilesDeleted === 0 && result.profilesDemoted === 1);
  check("(C) its history session is plain now", db.getSession("sess-c").role === null);
  db.close();
}

// ===================== (D) a user-made operator-role profile is demoted, never deleted =====================
{
  const { file } = legacyInstall({
    agent: false,
    extra: (db, home) => {
      db.insertProfile({ id: "prof-mine", name: "My Operator Rig", role: "operator", description: "mine", allowDelta: [], skills: null, model: null, icon: "▲" });
      db.insertAgent({ id: "agent-mine", projectId: home.id, name: "Mine", startupPrompt: "x", position: 20, profileId: "prof-mine", endpoint: false, ioSchema: null });
    },
  });
  const { db } = bootOnNewCode(file);
  check("(D) the user's operator-role profile is kept with role null", db.getProfile("prof-mine")?.role === null && db.getProfile("prof-mine")?.name === "My Operator Rig");
  check("(D) the agent bound to it is untouched", db.getAgent("agent-mine")?.profileId === "prof-mine");
  check("(D) the PRISTINE unbound seeded profile in the same DB is deleted (control: demote vs delete is decided per profile)", db.getProfile("prof-op") === undefined);
  db.close();
}

// ===================== (G) pristine by its OWN snapshot, though later default migrations rewrote model/harness =====================
{
  const rewritten = { model: "claude-opus-5-5", harness: "claude" }; // what a real upgraded install's row carries
  const { file } = legacyInstall({ agent: false, profile: rewritten, snapshot: rewritten });
  const { db, result } = bootOnNewCode(file);
  check("(G) a profile equal to its own base_snapshot (model/harness rewritten by a later migration) is DELETED", db.getProfile("prof-op") === undefined && result.profilesDeleted === 1);
  db.close();
}

// ===================== (H) a user edit relative to the snapshot keeps the profile (demoted) =====================
{
  const { file } = legacyInstall({ agent: false, profile: { icon: "🔧" } }); // snapshot keeps the shipped icon
  const { db, result } = bootOnNewCode(file);
  check("(H) a profile edited away from its base_snapshot is KEPT with role null and its edit", db.getProfile("prof-op")?.role === null && db.getProfile("prof-op")?.icon === "🔧" && result.profilesDeleted === 0 && result.profilesDemoted === 1);
  db.close();
  // CONTROL for (G): same rewritten model but the snapshot still says null => that IS an edit => kept.
  const c = legacyInstall({ agent: false, profile: { model: "claude-opus-5-5" } });
  const { db: db2 } = bootOnNewCode(c.file);
  check("(H) CONTROL: a model differing from a snapshot that says null is an edit, KEPT", db2.getProfile("prof-op")?.model === "claude-opus-5-5" && db2.getProfile("prof-op")?.role === null);
  db2.close();
}

// ===================== (E) a name-twin human agent is never adopted =====================
{
  const { file } = legacyInstall({
    agent: false, // no marker: the seeder never ran on this install, but a human named an agent "Elevated Operator"
    extra: (db, home) => db.insertAgent({ id: "human-twin", projectId: home.id, name: "Elevated Operator", startupPrompt: SHIPPED_PROMPT, position: 30, profileId: null, endpoint: false, ioSchema: null }),
  });
  const { db } = bootOnNewCode(file);
  check("(E) a same-named agent WITHOUT the id marker is never deleted (marker-only identity)", db.getAgent("human-twin") !== undefined);
  db.close();
}

// ===================== (F) a corrupt config blob is never overwritten; a fresh install is a no-op =====================
{
  const file = path.join(tmpHome, "corrupt.db");
  const db0 = new Db(file);
  db0.close();
  const Database = (await import("better-sqlite3")).default;
  const raw = new Database(file);
  raw.prepare("INSERT INTO platform_config (id, override_json, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET override_json = excluded.override_json").run("{not json", new Date().toISOString());
  raw.close();
  const db = new Db(file);
  const result = retireOperatorRole(db);
  check("(F) a corrupt blob is left untouched (never replaced by {})", db.isPlatformConfigCorrupt() === true && result.configKeyStripped === false);
  db.close();

  const fresh = new Db(path.join(tmpHome, "fresh.db"));
  seedDefaultProfiles(fresh);
  seed.seedSetupHome(fresh);
  check("(F) a fresh install (no operator leftovers, no config row) is a clean no-op", retireOperatorRole(fresh).changed === false);
  check("(F) ...and a fresh install never seeds an Elevated Operator profile any more", !fresh.listProfiles().some((p) => p.name === "Elevated Operator"));
  fresh.close();
}

console.log(failures === 0 ? "\n✅ ALL PASS — the Operator retirement migration cleans pristine leftovers, keeps everything customized, and is idempotent." : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
