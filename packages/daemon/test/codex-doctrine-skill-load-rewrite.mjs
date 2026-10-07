import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 8b2efa99: the seeded agent prompts open "Load your **/X** doctrine skill first" — a claude session
// satisfies that through its skill loader, a codex session (no skill-invocation tool) cannot. The codex kickoff
// (withCodexRoleDoctrine, spawn time) must not carry that dangling instruction; the claude-resolved prompt must
// stay BYTE-IDENTICAL. Proves, against the REAL seeders:
//   (A) CLAUDE half: every seeded doctrine-skill prompt still hashes to its pre-change sha256 and still opens
//       with the exact instruction (nothing rewrote the seeds or the stored rows).
//   (B) CODEX half: each seeded prompt, run through withCodexRoleDoctrine for its role, carries no "/skill"
//       load instruction, refers to the delivered pointer (non-worker) / AGENTS.md (worker), and keeps the
//       rest of the prompt byte-identical.
//   (C) a user-edited prompt without the exact clause passes through byte-identical; a non-worker with NO
//       store file gets an "unavailable" wording that names no pointer; the REAL wired spawnCodexProcess
//       kickoff for a seeded manager prompt carries the pointer and no dangling load.
//
// Run: 1) build, 2) node test/codex-doctrine-skill-load-rewrite.mjs
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const TMP = mkdtempManaged("loom-codex-skill-load-home-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_DEV = "1"; // the Platform Lead/Auditor rig is dev-gated; seed it so its prompts are covered
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const SKILLS = path.join(TMP, "skills");
const ROLE_SKILL = { manager: "orchestrate", platform: "platform-lead", auditor: "platform-audit", "workspace-auditor": "workspace-audit", setup: "setup-assistant" };
for (const skill of Object.values(ROLE_SKILL)) {
  fs.mkdirSync(path.join(SKILLS, skill), { recursive: true });
  fs.writeFileSync(path.join(SKILLS, skill, "SKILL.md"), `# ${skill}\n`);
}

const { Db } = await import("../dist/db.js");
const { seedDefaultProfiles } = await import("../dist/profiles/seed.js");
const { seedSetupHome, seedSetupAuditorAgent, SETUP_PROJECT_NAME } = await import("../dist/setup/seed.js");
const { seedPlatformHome, PLATFORM_PROJECT_NAME } = await import("../dist/platform/seed.js");
const { WORKFLOW_TEMPLATES } = await import("../dist/setup/templates.js");
const doctrine = await import("../dist/pty/codex-doctrine.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SKILLS_DIR } = await import("../dist/paths.js");
check("(setup) SKILLS_DIR resolves under the temp LOOM_HOME", path.resolve(SKILLS_DIR) === path.resolve(SKILLS));

// --- collect every seeded prompt that opens with the doctrine-skill instruction, with its role -----------------
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const db = new Db(path.join(TMP, "seed.db"));
seedDefaultProfiles(db);
seedSetupHome(db);
seedSetupAuditorAgent(db);
seedPlatformHome(db);
/** label -> { prompt, role } */
const seeded = new Map();
for (const [proj, byName] of [
  [SETUP_PROJECT_NAME, { "Platform": "setup", "Workspace Auditor": "workspace-auditor" }],
  [PLATFORM_PROJECT_NAME, { "Platform Lead": "platform", "Platform Auditor": "auditor" }],
]) {
  const home = db.getReservedProjectByName(proj);
  for (const a of db.listAgents(home.id)) {
    if (byName[a.name]) seeded.set(`${proj}/${a.name}`, { prompt: a.startupPrompt, role: byName[a.name] });
  }
}
const seenTemplateAgents = new Set();
for (const t of WORKFLOW_TEMPLATES) {
  for (const a of t.agents) {
    if (seenTemplateAgents.has(a.name)) continue;
    seenTemplateAgents.add(a.name);
    seeded.set(`template/${a.name}`, { prompt: a.startupPrompt, role: a.name === "Orchestrator" ? "manager" : "worker" });
  }
}
db.close();
check("(setup) collected all 10 seeded doctrine-skill prompts (2 setup home + 2 platform home + 6 template agents)", seeded.size === 10);

// --- (A) CLAUDE half: pre-change sha256 of each seeded prompt (captured on unmodified main before this card) --
const PRE_CHANGE_SHA256 = {
  "Platform/Platform": "88e3d64e5b8f15885f78b73eaa429634c5870848417f0cad843d25faf8b01970",
  "Platform/Workspace Auditor": "b90846cb7e157db458fa5da5b63ded7b26eb558301a5cab686a14301a839ffe3",
  "Loom Platform/Platform Lead": "30473c61a1b7f116effa4d434409ea7ba0e445feaa0f7e0bcfe1a7403791649a",
  "Loom Platform/Platform Auditor": "e51c083b17ece2ba5fdf80736e7e4a841f404ab189b13cc0824e1111d8bd04cf",
  "template/Orchestrator": "1c600ab46acb7011418f5e6c5c8153492e21fc2b0df96ac26ce6f91591456a25",
  "template/Dev": "42aa1e782860590f96962840c9f2681df5dce92b9c7aa576ad24d31141e79037",
  "template/Bugfix": "066d4f1115b4ea56a8ddeb0b8ddc863f269c72561d5c843c7077c93563bbd774",
  "template/QA Tester": "30647db42a3734ef3eb70f405ebcadd503183c5df0749bf548389d59437444a1",
  "template/Web Designer": "d3c44135c5176e89392e534d4d576d99d6f15bf1702c77fdc290a66d3eee1091",
  "template/Code Reviewer": "db20790369ec31ade0651a81537b3816b8a0ac100cc3c361d1cc3deafda99ea9",
};
for (const [label, { prompt }] of seeded) {
  check(`(A) ${label}: seeded prompt still opens with the exact "Load your **/X** doctrine skill first" instruction`,
    /^Load your \*\*\/[A-Za-z0-9_-]+\*\* doctrine skill first — it is your operating manual/.test(prompt));
  check(`(A) ${label}: seeded prompt sha256 is byte-identical to pre-change (${sha(prompt)})`, PRE_CHANGE_SHA256[label] === sha(prompt));
}

// --- (B) CODEX half ---------------------------------------------------------------------------------------------
const DANGLING = /doctrine skill first|\*\*\/[A-Za-z0-9_-]+\*\*/;
for (const [label, { prompt, role }] of seeded) {
  const out = doctrine.withCodexRoleDoctrine(prompt, role);
  check(`(B) ${label} [${role}]: codex-resolved prompt has no dangling "/skill" load instruction`, !DANGLING.test(out));
  const body = role === "worker" ? out : out.slice(out.indexOf("\n\n") + 2); // strip the pointer paragraph for non-workers
  if (role === "worker") {
    check(`(B) ${label}: worker prompt points at the AGENTS.md doctrine, no role pointer prefix`, /AGENTS\.md/.test(out) && !out.startsWith("[loom:role-doctrine]"));
  } else {
    check(`(B) ${label}: non-worker prompt is prefixed by the pointer AND its instruction refers to that pointer`,
      out.startsWith("[loom:role-doctrine]") && /file named in the \[loom:role-doctrine\] pointer above/.test(body));
  }
  // What survives the rewrite: everything after the clause is byte-identical to the seeded prompt's tail.
  const tail = prompt.slice(prompt.indexOf("doctrine skill first") + "doctrine skill first".length);
  check(`(B) ${label}: the rest of the prompt after the clause is byte-identical`, body.endsWith(tail) && tail.length > 100);
}

// --- (C) edge cases ---------------------------------------------------------------------------------------------
const EDITED = "My own customized manager prompt — no load instruction here.\n\nBe concise.";
// Card 2f1c7846: a codex session now also gets the [loom:skills-note] paragraph (a worker always does), so the
// user's text is byte-identical AFTER the prepended paragraphs rather than the whole output being the prompt.
check("(C) a user-edited prompt without the exact clause is left byte-identical (only paragraphs are prepended)",
  doctrine.withCodexRoleDoctrine(EDITED, "worker").endsWith(`\n\n${EDITED}`) &&
  doctrine.withCodexRoleDoctrine(EDITED, "manager").endsWith(`\n\n${EDITED}`));
const orch = seeded.get("template/Orchestrator").prompt;
const noStore = doctrine.withCodexRoleDoctrine(orch, "manager", path.join(TMP, "empty-store"));
check("(C) no store file -> no pointer, and the wording does not name a pointer that was never delivered",
  !noStore.startsWith("[loom:role-doctrine]") && !/pointer above/.test(noStore) && /NOT available in this Codex session/.test(noStore) && !DANGLING.test(noStore));
const odd = doctrine.withCodexRoleDoctrine("Load your **/some-custom** doctrine skill first — x", "manager");
check("(C) a clause naming a skill that is not this role's doctrine is not mapped onto the pointer", !/pointer above/.test(odd.split("\n\n").slice(1).join("\n\n")) && !DANGLING.test(odd));

// --- (C) REAL wired spawnCodexProcess: a seeded manager prompt's kickoff -------------------------------------------
function makeFakePty() {
  let onDataCb = null;
  let onExitCb = null;
  return {
    pid: 5151, write() {},
    onData(cb) { onDataCb = cb; return { dispose() { onDataCb = null; } }; },
    onExit(cb) { onExitCb = cb; return { dispose() { onExitCb = null; } }; },
    kill() { const cb = onExitCb; onExitCb = null; cb?.({ exitCode: 0 }); }, resize() {},
    push(t) { onDataCb?.(t); },
  };
}
class FakeCodexHost extends PtyHost {
  sweepOrphanedDescendants(_rootPid) {}
  reapExitedDescendants(_rootPid) {} async probeRootSurvival(_rootPid, _sessionId) { return { foundAlive: false, identityConfirmed: false, enumerationFailed: false }; }
  constructor(ev) { super(ev); this.ptys = new Map(); this.kickoffs = new Map(); }
  createCodexPty(opts) { const f = makeFakePty(); this.ptys.set(opts.sessionId, f); return f; }
  enqueueStdin(sessionId, text, ...rest) { this.kickoffs.set(sessionId, text); return { queued: true }; }
}
const host = new FakeCodexHost({ onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onBusy() {}, onExit() {} });
const READY = "OpenAI Codex (v1.2.3)\n│ model:     gpt-6-astra medium                          │\n›  Ask Codex to do anything\n";
const cwd = mkdtempManaged("loom-codex-skill-load-spawn-");
// Card 7955458e ruling 1(a): PtyHost.spawn() now REFUSES harness:"codex" for role:"manager" (a
// TRANSCRIPT_ROOT_DENY_ROLES member) — call spawnCodexProcess directly to unit-test the kickoff
// composition logic itself, bypassing only the new spawn()-level dispatch refusal (every real production
// path still goes through spawn()).
host.spawnCodexProcess({ sessionId: "s-mgr", cwd, permission: {}, geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role: "manager", harness: "codex", startupPrompt: orch });
host.ptys.get("s-mgr").push(READY);
await waitUntil(() => host.kickoffs.has("s-mgr"), { label: "kickoff for seeded manager" });
const k = host.kickoffs.get("s-mgr");
check("(C) spawned codex manager kickoff: pointer names the orchestrate store file, no dangling load, task text kept",
  k.includes(path.join(SKILLS_DIR, "orchestrate", "SKILL.md")) && !DANGLING.test(k) && k.includes("You are this project's **Orchestrator**"));

console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
