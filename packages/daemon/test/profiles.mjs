// Agent Profiles data-model + resolver test (Topics→Profiles P1). HERMETIC like orch-model.mjs:
// isolated LOOM_HOME, imports dist/* + @loom/shared, no daemon, no real claude. Covers:
//   (a) a legacy (pre-profiles) DB migrates ADDITIVELY — the profiles table is created,
//       topics.profile_id is added, and existing topic rows survive intact (profileId null);
//   (b) resolveProfile precedence — a profile supplies role/allow/skills/model/icon, the topic's
//       own startupPrompt overrides the profile's (a prompt-less topic falls back to it), and a
//       NULL/absent profile ⇒ EXACTLY today's backstop;
//   (c) the bundled profiles seed (present, correct roles) and seeding twice is idempotent.
// Run: 1) build (turbo builds shared first), 2) node test/profiles.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-profiles-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
const DB_FILE = path.join(process.env.LOOM_HOME, "loom.db");
const now = new Date().toISOString();

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- (a/migration) seed a pre-profiles DB: a `topics` table WITHOUT profile_id and NO profiles table.
{
  const old = new Database(DB_FILE);
  old.exec(`CREATE TABLE topics (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
    startup_prompt TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0
  );`);
  old.prepare("INSERT INTO topics (id,project_id,name,startup_prompt,position) VALUES (?,?,?,?,?)")
    .run("legacyTopic", "pLegacy", "Legacy", "legacy prompt", 0);
  const hadProfiles = old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='profiles'").get();
  check("(a) precondition: legacy DB has NO profiles table", hadProfiles === undefined);
  old.close();
}

// Opening with the real Db must run the idempotent migrations (CREATE TABLE profiles + ALTER topics).
const { Db } = await import("../dist/db.js");
const { resolveProfile } = await import("@loom/shared");
const { seedDefaultProfiles, BUNDLED_PROFILES } = await import("../dist/profiles/seed.js");
const { validateProfile } = await import("../dist/profiles/validate.js");

const db = new Db(); // uses LOOM_HOME/loom.db

// Inspect the migrated schema directly.
const raw = new Database(DB_FILE, { readonly: true });
const profilesTable = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='profiles'").get();
check("(a) migration: profiles table created", profilesTable?.name === "profiles");
const topicCols = new Set(raw.prepare("PRAGMA table_info(topics)").all().map((c) => c.name));
check("(a) migration: topics.profile_id column added", topicCols.has("profile_id"));
raw.close();

const legacyTopic = db.getTopic("legacyTopic");
check("(a) migration: legacy topic row intact (name + prompt preserved)",
  legacyTopic?.name === "Legacy" && legacyTopic?.startupPrompt === "legacy prompt");
check("(a) migration: legacy topic's new profileId defaults to null",
  legacyTopic?.profileId === null);

// --- (b) resolveProfile precedence -----------------------------------------------------------
const profile = {
  id: "prof1", name: "Dev", role: "worker",
  startupPrompt: "profile default prompt",
  allowDelta: ["Bash(pnpm test:*)"], skills: ["worker"], model: "claude-opus-4-8", icon: "🛠️",
};

// Topic with its OWN (non-empty) prompt → topic prompt overrides the profile's; everything else from
// the profile.
const withProfile = resolveProfile({ startupPrompt: "topic override prompt" }, profile);
check("(b) profile supplies role/allow/skills/model/icon",
  withProfile.role === "worker" &&
  JSON.stringify(withProfile.allow) === JSON.stringify(["Bash(pnpm test:*)"]) &&
  JSON.stringify(withProfile.skills) === JSON.stringify(["worker"]) &&
  withProfile.model === "claude-opus-4-8" && withProfile.icon === "🛠️");
check("(b) non-empty topic.startupPrompt overrides the profile prompt",
  withProfile.startupPrompt === "topic override prompt");

// A prompt-less topic (null) falls back to the profile's prompt (per-topic override is opt-in).
const fallback = resolveProfile({ startupPrompt: null }, profile);
check("(b) prompt-less topic (null) falls back to the profile prompt",
  fallback.startupPrompt === "profile default prompt");

// Empty-as-absent (profile PRESENT): an empty/whitespace per-topic prompt also falls back to the
// profile's default. This is the real-DB case — topics.startup_prompt is NOT NULL DEFAULT '', so a
// profile-topic with no per-topic prompt presents '' (never null); without this the profile's prompt
// would be dead code.
check("(b) empty ('') topic prompt + profile falls back to the profile prompt",
  resolveProfile({ startupPrompt: "" }, profile).startupPrompt === "profile default prompt");
check("(b) whitespace-only topic prompt + profile falls back to the profile prompt",
  resolveProfile({ startupPrompt: "   \n " }, profile).startupPrompt === "profile default prompt");

// NULL / absent profile ⇒ EXACTLY today's backstop behavior.
const backstop = resolveProfile({ startupPrompt: "just the topic prompt" }, null);
check("(b) null profile ⇒ today's backstop EXACTLY",
  backstop.role === null && backstop.startupPrompt === "just the topic prompt" &&
  JSON.stringify(backstop.allow) === "[]" && backstop.skills === null &&
  backstop.model === null && backstop.icon === null);
// Backstop keeps the topic prompt VERBATIM — empty-as-absent does NOT apply without a profile, so a
// plain (profile-less) topic with an empty prompt stays a plain session with no prompt (today's behavior).
check("(b) null profile + empty prompt stays empty (empty-as-absent is profile-present ONLY)",
  resolveProfile({ startupPrompt: "" }, null).startupPrompt === "");
const backstopUndef = resolveProfile({ startupPrompt: "p" });
check("(b) absent profile (undefined) ⇒ same backstop",
  backstopUndef.role === null && backstopUndef.startupPrompt === "p" &&
  backstopUndef.allow.length === 0 && backstopUndef.skills === null);

// --- (c) bundled profiles seed: present, correct roles, idempotent ---------------------------
const seeded1 = seedDefaultProfiles(db);
check("(c) first seed returns every bundled profile name",
  seeded1.length === BUNDLED_PROFILES.length &&
  BUNDLED_PROFILES.every((b) => seeded1.includes(b.name)));

const byName = new Map(db.listProfiles().map((p) => [p.name, p]));
check("(c) bundled roles correct (Orchestrator=manager, Dev/Bugfix=worker, Planning/Content=plain, Platform-lead=platform)",
  byName.get("Orchestrator")?.role === "manager" &&
  byName.get("Dev")?.role === "worker" && byName.get("Bugfix")?.role === "worker" &&
  byName.get("Planning & Triage")?.role === null && byName.get("Content Strategy")?.role === null &&
  byName.get("Platform-lead")?.role === "platform");

// A seeded profile round-trips its JSON columns (allowDelta [] / skills null) through toProfile.
const dev = byName.get("Dev");
check("(c) seeded profile round-trips JSON columns (allowDelta=[], skills=null)",
  Array.isArray(dev?.allowDelta) && dev.allowDelta.length === 0 && dev.skills === null);

const countAfter1 = db.listProfiles().length;
const seeded2 = seedDefaultProfiles(db); // second seed: idempotent — no duplicates, nothing new
check("(c) second seed is idempotent (no names re-seeded)", seeded2.length === 0);
check("(c) second seed adds no duplicate rows", db.listProfiles().length === countAfter1);

// --- (bonus) the strict validator mirrors the config-override validator --------------------
check("(validator) accepts a minimal writable shape + fills defaults", (() => {
  const r = validateProfile({ name: "X" });
  return r.ok && r.value.role === null && r.value.allowDelta.length === 0 &&
    r.value.skills === null && r.value.startupPrompt === "";
})());
check("(validator) rejects an unknown key (.strict typo guard)", validateProfile({ name: "X", bogus: 1 }).ok === false);
check("(validator) rejects a bad role enum", validateProfile({ name: "X", role: "boss" }).ok === false);

db.close(); // free the WAL file handle before removing the temp dir (Windows)
try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — profiles migrate additively, resolveProfile honors precedence + backstop, seed is idempotent."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
