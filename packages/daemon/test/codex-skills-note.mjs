import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 2f1c7846: codex has no skill loader, so a by-name skill instruction that is NOT the seeded doctrine clause
// (the Web Designer's "invoke the web-design skill by name", a DB brief's Step 0 "Run /worker") used to dangle.
// The codex kickoff now carries ONE generic [loom:skills-note] (codexSkillsNote, pty/codex-doctrine.ts) that says
// how to READ such an instruction. Proves, hermetically (no real codex spawn):
//   (1) the list is computed from store dirs that really hold a SKILL.md — a dir without one, or a subset name
//       missing from the store, is never listed;
//   (2) the profile-pinned `skills` subset filters the list, but the role's own doctrine skill is kept;
//   (3) a WORKER's list omits `worker` and its note maps /worker to the condensed AGENTS.md, never the store copy;
//   (4) the single alias rule: `/pickup` with only `loom-pickup` in the store -> listed + the loom-<name> rule;
//   (5) the user's brief is never rewritten (byte-identical tail), the order is pointer, note, brief;
//   (6) nothing to say -> no note (empty store, non-worker); worker with an empty store still gets the AGENTS.md line;
//   (7) the note stays short (bounded chars even with the whole real skill set listed);
//   (8) the REAL wired spawnCodexProcess kickoff carries the note, honouring opts.skills.
// The claude half (seeded prompts byte-identical) is codex-doctrine-skill-load-rewrite.mjs (A): claude never
// reaches withCodexRoleDoctrine.
//
// Run: 1) build, 2) node test/codex-skills-note.mjs
import fs from "node:fs";
import path from "node:path";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const TMP = mkdtempManaged("loom-codex-skills-note-home-");
process.env.LOOM_HOME = TMP;
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const doctrine = await import("../dist/pty/codex-doctrine.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SKILLS_DIR } = await import("../dist/paths.js");
check("(setup) SKILLS_DIR resolves under the temp LOOM_HOME", path.resolve(SKILLS_DIR) === path.resolve(path.join(TMP, "skills")));

function makeStore(name, skillNames, { noSkillMd = [] } = {}) {
  const dir = mkdtempManaged(`loom-codex-skills-note-${name}-`);
  for (const s of skillNames) {
    fs.mkdirSync(path.join(dir, s), { recursive: true });
    if (!noSkillMd.includes(s)) fs.writeFileSync(path.join(dir, s, "SKILL.md"), `# ${s}\n`);
  }
  return dir;
}
/** The comma-separated names after "Skills available:" (null when the note has no such sentence). */
const listed = (note) => { const m = note?.match(/Skills available: ([^.]*)\./); return m ? m[1].split(", ") : null; };

// --- (1) list = store dirs holding SKILL.md -----------------------------------------------------------------------
const full = makeStore("full", ["worker", "web-design", "loom-pickup", "orchestrate", "ideate", "hollow"], { noSkillMd: ["hollow"] });
const mgr = doctrine.codexSkillsNote("manager", null, full);
check("(1) manager note lists exactly the store skills that have a SKILL.md, sorted (a dir with no SKILL.md is not listed)",
  JSON.stringify(listed(mgr)) === JSON.stringify(["ideate", "loom-pickup", "orchestrate", "web-design", "worker"]));
check("(1) the note names the store path once, as <storeDir>/<name>/SKILL.md", mgr.includes(path.join(full, "<name>", "SKILL.md")) && mgr.split(full).length === 2);
check("(1) a non-worker note does NOT carry the worker AGENTS.md clause", !/AGENTS\.md/.test(mgr));

// --- (2) subset filtering, role skill force-kept -------------------------------------------------------------------
const sub = doctrine.codexSkillsNote("manager", ["web-design", "ghost"], full);
check("(2) subset [web-design, ghost]: lists web-design + the role's own doctrine skill; NOT loom-pickup/ideate/ghost/hollow",
  JSON.stringify(listed(sub)) === JSON.stringify(["orchestrate", "web-design"]));
check("(2) an empty subset means every store skill (same as null)", doctrine.codexSkillsNote("manager", [], full) === mgr);

// --- (3) worker: no `worker` in the list, /worker -> AGENTS.md ---------------------------------------------------
const wk = doctrine.codexSkillsNote("worker", null, full);
check("(3) worker note omits `worker` from the list but keeps the others",
  JSON.stringify(listed(wk)) === JSON.stringify(["ideate", "loom-pickup", "orchestrate", "web-design"]));
check("(3) worker note maps /worker to the condensed AGENTS.md at the worktree root and forbids opening a store copy",
  /`\/worker` doctrine is the condensed AGENTS\.md at your worktree root \(if present\), already loaded — do not open a store copy/.test(wk));
const wkSub = doctrine.codexSkillsNote("worker", ["web-design"], full);
check("(3) worker + subset [web-design] (the Web Designer shape): lists only web-design", JSON.stringify(listed(wkSub)) === JSON.stringify(["web-design"]));

// --- (4) the loom-<name> alias rule -------------------------------------------------------------------------------
const pickupStore = makeStore("pickup", ["loom-pickup"]);
const STEP0 = "Step 0: run `/pickup Loom` for project context.\n\nThen do the task.";
const pk = doctrine.withCodexRoleDoctrine(STEP0, "manager", pickupStore);
check("(4) `/pickup` with only loom-pickup in the store: loom-pickup is listed and the loom-<name> rule is stated",
  JSON.stringify(listed(pk)) === JSON.stringify(["loom-pickup"]) && /if <name> is not listed but loom-<name> is, use loom-<name>/.test(pk));
check("(4) no other aliasing/fuzzy matching is stated (the note names no other rename rule)", !/alias|similar|closest|fuzzy|prefix/i.test(pk));

// --- (5) brief untouched, order pointer -> note -> brief ------------------------------------------------------------
const ordered = doctrine.withCodexRoleDoctrine(STEP0, "manager", full);
const paras = ordered.split("\n\n");
check("(5) manager kickoff = role-doctrine pointer, then skills note, then the brief byte-identical",
  paras[0].startsWith("[loom:role-doctrine]") && paras[1].startsWith("[loom:skills-note]") && ordered.endsWith(`\n\n${STEP0}`));
check("(5) the note is a single paragraph (no blank line inside it)", paras.length === 2 + STEP0.split("\n\n").length);
const wOut = doctrine.withCodexRoleDoctrine(STEP0, "worker", full);
check("(5) worker kickoff = skills note then the brief byte-identical (no role pointer)", wOut.startsWith("[loom:skills-note]") && wOut.endsWith(`\n\n${STEP0}`) && !wOut.includes("[loom:role-doctrine]"));

// --- (6) nothing to say / empty store ---------------------------------------------------------------------------------
const empty = makeStore("empty", []);
check("(6) empty store + non-worker: no note", doctrine.codexSkillsNote("manager", null, empty) === null && doctrine.withCodexRoleDoctrine(STEP0, "manager", empty) === STEP0);
const allHollow = makeStore("hollow-only", ["a", "b"], { noSkillMd: ["a", "b"] });
check("(6) store of dirs with no SKILL.md + non-worker: no note", doctrine.codexSkillsNote("manager", null, allHollow) === null);
check("(6) missing store dir + non-worker: no note, no throw", doctrine.codexSkillsNote("manager", null, path.join(TMP, "does-not-exist")) === null);
const wEmpty = doctrine.codexSkillsNote("worker", null, empty);
check("(6) empty store + worker: still the AGENTS.md line, and says no skill files are available (no dangling list)",
  wEmpty !== null && /No skill files are available/.test(wEmpty) && /AGENTS\.md/.test(wEmpty) && listed(wEmpty) === null);
check("(6) subset naming only a missing skill (worker, empty intersection): no list, no dangling name", !/ghost/.test(doctrine.codexSkillsNote("worker", ["ghost"], full)));

// --- (7) size ---------------------------------------------------------------------------------------------------------
const real = makeStore("real", ["codescape", "ideate", "loom-doc-hygiene", "loom-pickup", "loom-session-end", "loom-task-start", "orchestrate", "platform-audit", "platform-lead", "research", "setup-assistant", "web-design", "worker", "workspace-audit"]);
const worst = doctrine.codexSkillsNote("worker", null, real);
console.log(`     worst-case worker note: ${worst.length} chars (store path ${real.length} chars)`);
check("(7) worst-case note (whole real skill set listed) is bounded — excluding the store path, under 900 chars", worst.length - real.length < 900);

// --- (8) REAL wired spawnCodexProcess ------------------------------------------------------------------------------
for (const s of ["worker", "web-design", "loom-pickup", "orchestrate"]) {
  fs.mkdirSync(path.join(SKILLS_DIR, s), { recursive: true });
  fs.writeFileSync(path.join(SKILLS_DIR, s, "SKILL.md"), `# ${s}\n`);
}
function makeFakePty() {
  let onDataCb = null;
  let onExitCb = null;
  return {
    pid: 5152, write() {},
    onData(cb) { onDataCb = cb; return { dispose() { onDataCb = null; } }; },
    onExit(cb) { onExitCb = cb; return { dispose() { onExitCb = null; } }; },
    kill() { const cb = onExitCb; onExitCb = null; cb?.({ exitCode: 0 }); }, resize() {},
    push(t) { onDataCb?.(t); },
  };
}
class FakeCodexHost extends PtyHost {
  reapExitedDescendants(_rootPid) {}
  constructor(ev) { super(ev); this.ptys = new Map(); this.kickoffs = new Map(); }
  createCodexPty(opts) { const f = makeFakePty(); this.ptys.set(opts.sessionId, f); return f; }
  enqueueStdin(sessionId, text, ...rest) { this.kickoffs.set(sessionId, text); return { queued: true }; }
}
const host = new FakeCodexHost({ onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onBusy() {}, onExit() {} });
const READY = "OpenAI Codex (v1.2.3)\n│ model:     gpt-6-astra medium                          │\n›  Ask Codex to do anything\n";
const BRIEF = "You are the Web Designer. Also invoke the **web-design** skill by name for UI work.";
async function kickoff(sessionId, extra) {
  const cwd = mkdtempManaged(`loom-codex-skills-note-spawn-${sessionId}-`);
  host.spawn({ sessionId, cwd, permission: {}, geometry: { cols: 120, rows: 40 }, sessionEnv: {}, harness: "codex", startupPrompt: BRIEF, ...extra });
  host.ptys.get(sessionId).push(READY);
  await waitUntil(() => host.kickoffs.has(sessionId), { label: `kickoff for ${sessionId}` });
  return host.kickoffs.get(sessionId);
}
const kw = await kickoff("s-worker-sub", { role: "worker", skills: ["web-design"] });
check("(8) spawned codex worker with skills:[web-design]: kickoff = note listing only web-design, then the brief untouched",
  kw.startsWith("[loom:skills-note]") && JSON.stringify(listed(kw)) === JSON.stringify(["web-design"]) && kw.endsWith(`\n\n${BRIEF}`) && /AGENTS\.md/.test(kw));
const kw2 = await kickoff("s-worker-all", { role: "worker", skills: null });
check("(8) spawned codex worker with no subset: lists every store skill except worker", JSON.stringify(listed(kw2)) === JSON.stringify(["loom-pickup", "orchestrate", "web-design"]));
const km = await kickoff("s-mgr", { role: "manager", skills: ["loom-pickup"] });
check("(8) spawned codex manager: pointer, then note (subset ∪ orchestrate), then the brief",
  km.startsWith("[loom:role-doctrine]") && JSON.stringify(listed(km)) === JSON.stringify(["loom-pickup", "orchestrate"]) && km.endsWith(`\n\n${BRIEF}`));

console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
