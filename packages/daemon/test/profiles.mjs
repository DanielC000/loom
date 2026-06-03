// Profiles data-model + resolver test (Topics→Agents rename + Agent/Profile boundary). HERMETIC like
// orch-model.mjs: isolated LOOM_HOME, imports dist/* + @loom/shared, no daemon, no real claude. Covers:
//   (a) a legacy DB migrates: the structural rename `topics`→`agents` (+ FK columns) runs once, the
//       additive `agents.profile_id` is added, `profiles.startup_prompt` is renamed → `description`
//       (value preserved), and existing rows survive intact;
//   (b) resolveProfile — a profile supplies role/allow/skills/model/icon, the injected prompt ALWAYS
//       comes from the agent (no prompt-merge; a blank agent prompt stays blank), and a NULL/absent
//       profile ⇒ the plain backstop;
//   (c) the bundled profiles seed (present, correct roles) and seeding twice is idempotent.
// Run: 1) build (turbo builds shared first), 2) node test/profiles.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-profiles-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
const DB_FILE = path.join(process.env.LOOM_HOME, "loom.db");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- (a/migration) seed a LEGACY DB: the pre-rename `topics` table (+ a row) and a `profiles` table
// whose prompt column is still named `startup_prompt`. This is the shape the structural migration
// (migrateTopicsToAgents, which runs BEFORE exec(SCHEMA)) must rename in place.
{
  const old = new Database(DB_FILE);
  old.exec(`CREATE TABLE topics (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
    startup_prompt TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0
  );`);
  old.prepare("INSERT INTO topics (id,project_id,name,startup_prompt,position) VALUES (?,?,?,?,?)")
    .run("legacyAgent", "pLegacy", "Legacy", "legacy prompt", 0);
  old.exec(`CREATE TABLE profiles (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT,
    startup_prompt TEXT NOT NULL DEFAULT '', allow_delta TEXT NOT NULL DEFAULT '[]',
    skills TEXT, model TEXT, icon TEXT
  );`);
  old.prepare("INSERT INTO profiles (id,name,role,startup_prompt) VALUES (?,?,?,?)")
    .run("legacyProf", "LegacyRig", "worker", "old prompt text");
  const hasTopics = old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='topics'").get();
  const hasAgents = old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agents'").get();
  check("(a) precondition: legacy DB has `topics`, NOT `agents`", !!hasTopics && hasAgents === undefined);
  old.close();
}

// Opening with the real Db runs migrateTopicsToAgents (structural, once) + exec(SCHEMA) + the additive
// migrations.
const { Db } = await import("../dist/db.js");
const { resolveProfile } = await import("@loom/shared");
const { seedDefaultProfiles, BUNDLED_PROFILES } = await import("../dist/profiles/seed.js");
const { validateProfile } = await import("../dist/profiles/validate.js");

const db = new Db(); // uses LOOM_HOME/loom.db

// Inspect the migrated schema directly.
const raw = new Database(DB_FILE, { readonly: true });
const tableNames = new Set(raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name));
check("(a) structural migration: `topics` renamed to `agents`", tableNames.has("agents") && !tableNames.has("topics"));
check("(a) migration: profiles table present", tableNames.has("profiles"));
const agentCols = new Set(raw.prepare("PRAGMA table_info(agents)").all().map((c) => c.name));
check("(a) migration: agents.profile_id column added", agentCols.has("profile_id"));
const profileCols = new Set(raw.prepare("PRAGMA table_info(profiles)").all().map((c) => c.name));
check("(a) migration: profiles.startup_prompt renamed → description",
  profileCols.has("description") && !profileCols.has("startup_prompt"));
const legacyProfDesc = raw.prepare("SELECT description FROM profiles WHERE id='legacyProf'").get();
check("(a) migration: the legacy profile's prompt value moved into `description`",
  legacyProfDesc?.description === "old prompt text");
raw.close();

const legacyAgent = db.getAgent("legacyAgent");
check("(a) migration: legacy row survives the rename as an agent (name + prompt preserved)",
  legacyAgent?.name === "Legacy" && legacyAgent?.startupPrompt === "legacy prompt");
check("(a) migration: the migrated agent's new profileId defaults to null",
  legacyAgent?.profileId === null);

// Re-opening the migrated DB is idempotent (the guard sees `agents`, skips the structural rename).
db.close();
const db2 = new Db();
check("(a) re-open is idempotent (still one agent row, no crash)", db2.getAgent("legacyAgent")?.name === "Legacy");
db2.close();
const db3 = new Db();

// --- (b) resolveProfile: rig from the profile, prompt ALWAYS from the agent (no merge) -----------
const profile = {
  id: "prof1", name: "Dev", role: "worker",
  description: "a UI-only blurb — never injected",
  allowDelta: ["Bash(pnpm test:*)"], skills: ["worker"], model: "claude-opus-4-8", icon: "🛠️",
};

const withProfile = resolveProfile({ startupPrompt: "the agent prompt" }, profile);
check("(b) profile supplies role/allow/skills/model/icon",
  withProfile.role === "worker" &&
  JSON.stringify(withProfile.allow) === JSON.stringify(["Bash(pnpm test:*)"]) &&
  JSON.stringify(withProfile.skills) === JSON.stringify(["worker"]) &&
  withProfile.model === "claude-opus-4-8" && withProfile.icon === "🛠️");
check("(b) the injected prompt is the AGENT's, NOT the profile's description",
  withProfile.startupPrompt === "the agent prompt");

// A blank agent prompt stays blank EVEN with a profile — there is no fallback to the profile (the
// merge branch was deleted; an empty prompt = a session that boots but is inert, by design).
check("(b) blank ('') agent prompt + profile stays blank (no prompt-merge)",
  resolveProfile({ startupPrompt: "" }, profile).startupPrompt === "");
check("(b) null agent prompt + profile resolves to '' (no fallback to the profile)",
  resolveProfile({ startupPrompt: null }, profile).startupPrompt === "");

// NULL / absent profile ⇒ the plain backstop: role null, agent prompt verbatim, no allow/skills/etc.
const backstop = resolveProfile({ startupPrompt: "just the agent prompt" }, null);
check("(b) null profile ⇒ plain backstop",
  backstop.role === null && backstop.startupPrompt === "just the agent prompt" &&
  JSON.stringify(backstop.allow) === "[]" && backstop.skills === null &&
  backstop.model === null && backstop.icon === null);
check("(b) null profile + empty prompt stays empty",
  resolveProfile({ startupPrompt: "" }, null).startupPrompt === "");
const backstopUndef = resolveProfile({ startupPrompt: "p" });
check("(b) absent profile (undefined) ⇒ same backstop",
  backstopUndef.role === null && backstopUndef.startupPrompt === "p" &&
  backstopUndef.allow.length === 0 && backstopUndef.skills === null);

// --- (c) bundled profiles seed: present, correct roles, idempotent ---------------------------
const seeded1 = seedDefaultProfiles(db3);
check("(c) first seed returns every bundled profile name",
  seeded1.length === BUNDLED_PROFILES.length &&
  BUNDLED_PROFILES.every((b) => seeded1.includes(b.name)));

const byName = new Map(db3.listProfiles().map((p) => [p.name, p]));
check("(c) bundled roles correct (Orchestrator=manager, Dev/Bugfix=worker, Planning/Content=plain, Platform-lead=platform)",
  byName.get("Orchestrator")?.role === "manager" &&
  byName.get("Dev")?.role === "worker" && byName.get("Bugfix")?.role === "worker" &&
  byName.get("Planning & Triage")?.role === null && byName.get("Content Strategy")?.role === null &&
  byName.get("Platform-lead")?.role === "platform");

// A bundled profile carries a non-empty `description` blurb (and no injected prompt).
const orch = byName.get("Orchestrator");
check("(c) bundled profile has a description blurb", typeof orch?.description === "string" && orch.description.length > 0);

// A seeded profile round-trips its JSON columns (allowDelta [] / skills null) through toProfile.
const dev = byName.get("Dev");
check("(c) seeded profile round-trips JSON columns (allowDelta=[], skills=null)",
  Array.isArray(dev?.allowDelta) && dev.allowDelta.length === 0 && dev.skills === null);

const countAfter1 = db3.listProfiles().length;
const seeded2 = seedDefaultProfiles(db3); // second seed: idempotent — no duplicates, nothing new
check("(c) second seed is idempotent (no names re-seeded)", seeded2.length === 0);
check("(c) second seed adds no duplicate rows", db3.listProfiles().length === countAfter1);

// --- (bonus) the strict validator mirrors the config-override validator --------------------
check("(validator) accepts a minimal writable shape + fills defaults", (() => {
  const r = validateProfile({ name: "X" });
  return r.ok && r.value.role === null && r.value.allowDelta.length === 0 &&
    r.value.skills === null && r.value.description === "";
})());
check("(validator) rejects an unknown key (.strict typo guard)", validateProfile({ name: "X", bogus: 1 }).ok === false);
check("(validator) rejects a bad role enum", validateProfile({ name: "X", role: "boss" }).ok === false);

db3.close(); // free the WAL file handle before removing the temp dir (Windows)
try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — topics→agents migrates, resolveProfile sources the prompt from the agent, seed is idempotent."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
