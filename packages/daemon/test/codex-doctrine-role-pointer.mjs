import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 4bb795bb (C1): a codex NON-worker session (manager/platform/auditor/workspace-auditor/setup) gets its
// role doctrine as a POINTER to the canonical store copy `<SKILLS_DIR>/<skill>/SKILL.md`, delivered atop its
// KICKOFF (not AGENTS.md — non-worker cwd is the shared project.repoPath; see codexRoleDoctrinePointer's doc).
// Covers: the pure pointer fn per role, roles with no doctrine skill, a missing store file, worker exclusion,
// AGENTS.md never touched for any of these roles (repo's own file byte-identical), and the REAL wired
// spawnCodexProcess kickoff carrying the pointer.
//
// Run: 1) build, 2) node test/codex-doctrine-role-pointer.mjs
import fs from "node:fs";
import path from "node:path";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const TMP = mkdtempManaged("loom-codex-role-pointer-home-");
process.env.LOOM_HOME = TMP;
const SKILLS = path.join(TMP, "skills");
const ROLE_SKILL = { manager: "orchestrate", platform: "platform-lead", auditor: "platform-audit", "workspace-auditor": "workspace-audit", setup: "setup-assistant" };
for (const skill of Object.values(ROLE_SKILL)) {
  fs.mkdirSync(path.join(SKILLS, skill), { recursive: true });
  fs.writeFileSync(path.join(SKILLS, skill, "SKILL.md"), `# ${skill}\n`);
}

const doctrine = await import("../dist/pty/codex-doctrine.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SKILLS_DIR } = await import("../dist/paths.js");
check("(setup) SKILLS_DIR resolves under the temp LOOM_HOME", path.resolve(SKILLS_DIR) === path.resolve(SKILLS));

// --- per-role pointer names the correct store path -------------------------------------------------------
for (const [role, skill] of Object.entries(ROLE_SKILL)) {
  const p = doctrine.codexRoleDoctrinePointer(role);
  const want = path.join(SKILLS_DIR, skill, "SKILL.md");
  check(`${role}: pointer names ${skill}/SKILL.md store path and says to read it first`, typeof p === "string" && p.includes(want) && /read it in full BEFORE/.test(p));
  const others = Object.values(ROLE_SKILL).filter((s) => s !== skill);
  check(`${role}: pointer names no OTHER role's skill`, typeof p === "string" && others.every((s) => !p.includes(path.join(SKILLS_DIR, s))));
}

// --- roles with no doctrine / worker / missing store file ------------------------------------------------
for (const role of ["worker", "operator", "assistant", "run", null, undefined]) {
  check(`role ${String(role)}: no pointer`, doctrine.codexRoleDoctrinePointer(role) === null);
  // Card 2f1c7846: such a session may now get the by-name [loom:skills-note] paragraph (codex-skills-note.mjs owns
  // that); what this test pins is that it never gets a ROLE pointer and the kickoff body is left verbatim.
  const k = doctrine.withCodexRoleDoctrine("KICK", role);
  check(`role ${String(role)}: no role-doctrine pointer, kickoff body verbatim`, !k.includes("[loom:role-doctrine]") && (k === "KICK" || k.endsWith("\n\nKICK")));
  const kEmpty = doctrine.withCodexRoleDoctrine("KICK", role, path.join(TMP, "empty-store"));
  check(`role ${String(role)}: with no skill files in the store the kickoff is ${role === "worker" ? "only the AGENTS.md note + body" : "fully unchanged"}`,
    role === "worker" ? (kEmpty.startsWith("[loom:skills-note]") && kEmpty.endsWith("\n\nKICK")) : kEmpty === "KICK");
}
check("missing store SKILL.md: no pointer (never point at a file that isn't there)", doctrine.codexRoleDoctrinePointer("manager", path.join(TMP, "empty-store")) === null);
check("withCodexRoleDoctrine keeps the kickoff body verbatim after the pointer", doctrine.withCodexRoleDoctrine("KICK-BODY", "manager").endsWith("\n\nKICK-BODY"));

// --- AGENTS.md is never written/clobbered for a non-worker role ------------------------------------------
for (const role of Object.keys(ROLE_SKILL)) {
  const own = mkdtempManaged(`loom-codex-role-pointer-own-${role}-`);
  fs.writeFileSync(path.join(own, "AGENTS.md"), "REPO OWN AGENTS\n");
  doctrine.injectCodexDoctrine(own, role);
  check(`${role}: repo's own AGENTS.md byte-identical`, fs.readFileSync(path.join(own, "AGENTS.md"), "utf8") === "REPO OWN AGENTS\n");
  const bare = mkdtempManaged(`loom-codex-role-pointer-bare-${role}-`);
  doctrine.injectCodexDoctrine(bare, role);
  check(`${role}: no AGENTS.md created in a shared cwd`, !fs.existsSync(path.join(bare, "AGENTS.md")));
}

// --- REAL wired spawnCodexProcess: the kickoff it enqueues carries the pointer ---------------------------
function makeFakePty() {
  let onDataCb = null;
  let onExitCb = null;
  return {
    pid: 5150, write() {},
    onData(cb) { onDataCb = cb; return { dispose() { onDataCb = null; } }; },
    onExit(cb) { onExitCb = cb; return { dispose() { onExitCb = null; } }; },
    kill() { const cb = onExitCb; onExitCb = null; cb?.({ exitCode: 0 }); }, resize() {},
    push(t) { onDataCb?.(t); },
  };
}
class FakeCodexHost extends PtyHost {
  sweepOrphanedDescendants(_rootPid) {}
  reapExitedDescendants(_rootPid) {} async probeRootSurvival(_rootPid, _sessionId) { return { foundAlive: false, identityConfirmed: false, enumerationFailed: false }; }
  async captureRootCreationRow(_pid) { return null; }
  constructor(ev) { super(ev); this.ptys = new Map(); this.kickoffs = new Map(); }
  createCodexPty(opts) { const f = makeFakePty(); this.ptys.set(opts.sessionId, f); return f; }
  enqueueStdin(sessionId, text, ...rest) { this.kickoffs.set(sessionId, text); return { queued: true }; }
}
const host = new FakeCodexHost({ onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onBusy() {}, onExit() {} });
const READY = "OpenAI Codex (v1.2.3)\n│ model:     gpt-6-astra medium                          │\n›  Ask Codex to do anything\n";
for (const role of ["manager", "worker"]) {
  const cwd = mkdtempManaged(`loom-codex-role-pointer-spawn-${role}-`);
  // Card 7955458e ruling 1(a): PtyHost.spawn() now REFUSES harness:"codex" for a TRANSCRIPT_ROOT_DENY_ROLES
  // role (manager included) — a real, structural guarantee this role can never reach createCodexPty in
  // production. This file unit-tests the kickoff/doctrine-pointer COMPOSITION logic itself (which still
  // exists, is still correct to test, and still lives inside spawnCodexProcess regardless of whether a
  // real caller can reach it for this role) — call spawnCodexProcess directly to bypass ONLY the new
  // spawn()-level dispatch refusal, not a weakening of it (every real production path still goes through spawn()).
  host.spawnCodexProcess({ sessionId: `s-${role}`, cwd, permission: {}, geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role, harness: "codex", startupPrompt: "TASK-BODY" });
  host.ptys.get(`s-${role}`).push(READY);
  await waitUntil(() => host.kickoffs.has(`s-${role}`), { label: `kickoff for ${role}` });
  const k = host.kickoffs.get(`s-${role}`);
  if (role === "manager") {
    check("spawned manager kickoff carries the orchestrate store pointer AND the original task body",
      k.includes(path.join(SKILLS_DIR, "orchestrate", "SKILL.md")) && k.endsWith("TASK-BODY"));
  } else {
    // Card 2f1c7846: a worker now also gets the [loom:skills-note] (its /worker -> AGENTS.md mapping); still no role pointer.
    check("spawned worker kickoff carries no role pointer and the task body verbatim (worker doctrine stays in AGENTS.md)",
      !k.includes("[loom:role-doctrine]") && k.endsWith("\n\nTASK-BODY") && k.startsWith("[loom:skills-note]"));
  }
}

console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
