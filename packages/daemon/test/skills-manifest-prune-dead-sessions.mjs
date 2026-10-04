// Regression guard for card 9d73e537: injectSkills prunes a shared manifest's KEYS for sessions the
// caller's injected predicate says are NOT currently live/starting. Without this, a shared-cwd manifest
// (manager/platform/setup/auditor/plain sessions sharing project.repoPath) grows without bound across
// every recycle generation, and a no-longer-live session's claimed skill name lingers in `otherClaimed`
// forever — permanently defeating the "never clobber the repo's own pre-existing skill" check for any
// name a session that's since gone idle ever touched.
//
// Deliberately "live" (processState live/starting), NOT "resumable" (resumability !== "dead") — Code
// Review round 2 caught that the resumability-based predicate under-pruned: an exited-but-resumable row
// (the ordinary steady state of a stopped worker/plain session) keeps `resumability:"resumable"` forever,
// so most of the real-world growth this card exists to stop would have survived unpruned. Pruning an
// exited-but-resumable session's claim is safe because injectSkills runs on EVERY createPty
// (fresh/resume/fork/recycle) — a session that's later actually resumed re-claims its own skills the
// moment it resumes, so nothing is lost between resumes but regenerable bookkeeping.
//
// Hermetic — sets LOOM_HOME to a temp dir BEFORE importing (paths.ts reads it at load). No claude. Section
// (0) uses a REAL Db to verify the ACTUAL `isSessionLive` closure index.ts wires (same
// `db.getSession(id).processState` expression, copied verbatim) against real inserted rows — proving the
// semantic distinction itself, not just that injectSkills prunes whatever boolean a stand-in predicate
// returns. Sections (1)-(4) exercise injectSkills' own pruning mechanics with a plain injected function —
// inject.ts itself must never import the DB directly.
// Run after build: node test/skills-manifest-prune-dead-sessions.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const readManifestFile = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

const root = path.join(os.tmpdir(), `loom-inject-prune-dead-${Date.now()}-${process.pid}`);
const home = path.join(root, "loomhome");
const skillsDir = path.join(home, "skills");
const cwd = path.join(root, "repo");
fs.mkdirSync(path.join(skillsDir, "loom-a"), { recursive: true });
fs.mkdirSync(path.join(skillsDir, "loom-b"), { recursive: true });
fs.mkdirSync(cwd, { recursive: true });
fs.writeFileSync(path.join(skillsDir, "loom-a", "SKILL.md"), "---\nname: loom-a\ndescription: A\n---\nA");
fs.writeFileSync(path.join(skillsDir, "loom-b", "SKILL.md"), "---\nname: loom-b\ndescription: B\n---\nB");

process.env.LOOM_HOME = home; // BEFORE importing — paths.ts computes SKILLS_DIR at load
const { injectSkills } = await import("../dist/skills/inject.js");
const { Db } = await import("../dist/db.js");

// ============ (0) the REAL index.ts closure, verbatim, against a REAL Db ============
// Mirrors index.ts's own `isSessionLive` wiring exactly: `db.getSession(id)` then
// `processState === "live" || processState === "starting"`. A missing row and an exited-but-resumable
// row (the case Code Review round 2 caught the resumability-based version under-pruning) must both read
// false; a live or starting row must read true.
{
  const db = new Db(path.join(root, "predicate-check.db"));
  const now = new Date().toISOString();
  db.insertProject({ id: "p", name: "P", repoPath: root, vaultPath: root, config: {}, createdAt: now, archivedAt: null, reserved: false });
  db.insertAgent({ id: "a", projectId: "p", name: "Agent", startupPrompt: "", position: 0, profileId: null });
  const base = { projectId: "p", agentId: "a", engineSessionId: null, title: null, cwd: root, busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" };
  db.insertSession({ ...base, id: "exited-resumable-sess", processState: "exited", resumability: "resumable" });
  db.insertSession({ ...base, id: "live-sess", processState: "live", resumability: "unknown" });
  db.insertSession({ ...base, id: "starting-sess", processState: "starting", resumability: "unknown" });
  const isSessionLive = (sessionId) => {
    const row = db.getSession(sessionId);
    return row != null && (row.processState === "live" || row.processState === "starting");
  };
  check("(0) exited-but-resumable row reads NOT live (the under-pruning Code Review caught)", isSessionLive("exited-resumable-sess") === false);
  check("(0) live row reads live", isSessionLive("live-sess") === true);
  check("(0) starting (mid-spawn) row reads live", isSessionLive("starting-sess") === true);
  check("(0) a row that doesn't exist (hard-deleted) reads NOT live", isSessionLive("never-existed-sess") === false);
  db.close(); // Windows: an open sqlite handle blocks the root rmSync cleanup below with EBUSY
}

const targetDir = path.join(cwd, ".claude", "skills");
const manifestPath = path.join(targetDir, ".loom-skills.json");

// Three OTHER sessions, all previously claiming loom-b (the shared-cwd "union" shape): one exited (but
// still reads resumability:"resumable" at the DB level — the under-pruned case round 2 caught), one
// genuinely live, one mid-spawn ("starting"). Pruning the exited one must never touch the still-live or
// still-starting ones.
function seedManifest() {
  fs.mkdirSync(path.join(targetDir, "loom-b"), { recursive: true });
  fs.writeFileSync(path.join(targetDir, "loom-b", "SKILL.md"), "---\nname: loom-b\ndescription: B\n---\nB");
  fs.writeFileSync(manifestPath, JSON.stringify({
    "exited-resumable-sess": ["loom-b"], // processState exited, resumability still "resumable" — must be pruned
    "live-sess": ["loom-b"],             // processState live — must survive
    "starting-sess": ["loom-b"],         // processState starting (mid-spawn) — must survive
  }));
}
const resetTarget = () => fs.rmSync(targetDir, { recursive: true, force: true });

try {
  // ============ (1) RED case: no predicate ⇒ no pruning at all (today's exact behavior, fail-safe) ============
  seedManifest();
  injectSkills(cwd, "me", ["loom-a"], null); // no 6th arg — the legacy call shape every existing caller/test uses
  let m = readManifestFile(manifestPath);
  check("(1) no predicate: exited-resumable-sess entry is NOT pruned (fail-safe default — this is the bug, left exactly as-is)", Array.isArray(m["exited-resumable-sess"]));
  check("(1) no predicate: live-sess / starting-sess entries untouched", Array.isArray(m["live-sess"]) && Array.isArray(m["starting-sess"]));
  check("(1) loom-b dir still present (nobody asked to remove it)", fs.existsSync(path.join(targetDir, "loom-b", "SKILL.md")));

  // ============ (2) GREEN case: an EXITED-but-resumable session IS pruned; LIVE and STARTING are NOT ============
  resetTarget();
  seedManifest();
  const queried = [];
  const isLive = (sid) => { queried.push(sid); return sid === "live-sess" || sid === "starting-sess"; };
  injectSkills(cwd, "me", ["loom-a"], null, false, isLive);
  m = readManifestFile(manifestPath);
  check("(2) exited-but-resumable session's entry IS pruned (the under-pruning Code Review caught)", !("exited-resumable-sess" in m));
  check("(2) live-sess entry survives with its claim intact", Array.isArray(m["live-sess"]) && m["live-sess"].includes("loom-b"));
  check("(2) starting-sess (mid-spawn) entry ALSO survives with its claim intact", Array.isArray(m["starting-sess"]) && m["starting-sess"].includes("loom-b"));
  check("(2) my own entry recorded normally", Array.isArray(m["me"]) && m["me"].includes("loom-a"));
  check("(2) loom-b dir still present (still claimed by live-sess/starting-sess — pruning a KEY never rmSync's a dir)", fs.existsSync(path.join(targetDir, "loom-b", "SKILL.md")));
  check("(2) loom-a delivered to me", fs.existsSync(path.join(targetDir, "loom-a", "SKILL.md")));
  check("(2) all three other sessions were asked", ["exited-resumable-sess", "live-sess", "starting-sess"].every((sid) => queried.includes(sid)));

  // ============ (3) a THROWING predicate for one id must not cost the rest of the prune pass ============
  resetTarget();
  seedManifest();
  const throwing = (sid) => { if (sid === "exited-resumable-sess") throw new Error("boom"); return false; }; // live-sess/starting-sess genuinely read not-live here
  injectSkills(cwd, "me", ["loom-a"], null, false, throwing);
  m = readManifestFile(manifestPath);
  check("(3) a throwing predicate call is swallowed: exited-resumable-sess entry KEPT (fail-safe on error, not a crash)", "exited-resumable-sess" in m);
  check("(3) live-sess correctly pruned (its own predicate call genuinely returned false)", !("live-sess" in m));
  check("(3) starting-sess correctly pruned too", !("starting-sess" in m));

  // ============ (4) the predicate is never asked about the CURRENT session's own key ============
  resetTarget();
  fs.mkdirSync(path.join(targetDir, "loom-a"), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify({ me: ["loom-a"] }));
  let queriedSelf = false;
  const selfSpy = (sid) => { if (sid === "me") queriedSelf = true; return true; };
  injectSkills(cwd, "me", ["loom-a"], null, false, selfSpy);
  check("(4) predicate is never asked about the CURRENT session id (it is live by definition, right now)", !queriedSelf);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — injectSkills prunes not-currently-live manifest keys (including exited-but-resumable, not just dead) via an injected predicate, fail-safe when absent/throwing, never touching a live/starting claim, a skill dir, or the current session's own key."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
