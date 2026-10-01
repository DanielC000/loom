import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
// Card 37310431 — `loomHomeWriteDenyRules`/`withLoomHomeWriteDenyForSpawn` (pty/loom-home-deny.ts), the
// LOOM_HOME write-deny wired in at the single `PtyHost.createPty` spawn chokepoint. See
// loom-home-write-deny-real-spawn.mjs (MANUAL-ONLY) for the real-engine-honors-it proof and
// docs/decisions/37310431-loom-home-write-deny.md for the full investigation this implements.
//
// ROUND 2 (scope cut, design changed): dropped the live `readdirSync` union — a fail-closed "deny
// everything present" broke the Platform/Setup homes' own legitimate LOOM_HOME-rooted note writes (their
// `repoPath`/`vaultPath` are pinned to LOOM_HOME itself). `loomHomeWriteDenyRules` is now a flat map over
// the STATIC registry. A delta security review then added a SECOND, role-conditional registry
// (`LOOM_HOME_INSTRUCTION_WRITE_DENY_REGISTRY`) denying files a more-privileged future session reads as
// INSTRUCTIONS (`PLATFORM-LEAD-RESUME*.md`/`CLAUDE.md`/`.claude/**`), PER ENTRY — fix round 2 corrected
// this to exempt `platform` ONLY (not `setup`, which was wrongly exempted in the first draft) plus a
// plain, human-driven session (`role===null`) exempt from the whole registry — see the decision record.
//
// THIS FILE proves:
//   PART 1 — `canonicalizeExistingPath` (the realpath helper this module relies on for junction-safety)
//            genuinely collapses a junction/symlink alias to its real target, on THIS host.
//   PART 1c — `toClaudeAbsoluteGlob` (the documented `//<path>` / `//<drive>/<rest>` absolute-glob form,
//             Ruling A) on both a Windows-shaped and a POSIX-shaped input path, regardless of which OS
//             this file actually runs on — it's a pure string transform, not an fs-dependent one.
//   PART 2 — the pure rule-building function, in isolation (no DB, no pty, no claude): an EXACT rule-set
//            equality against the registry/registries (no readdir, no disk dependency), scratch/
//            workspaces/runs structurally absent for every role, the instruction registry's PER-ENTRY
//            role split (platform + plain exempt; setup/worker/manager/etc. all denied), idempotence of
//            `withLoomHomeWriteDenyForSpawn`.
//   PART 3 — a REAL (unsubclassed) `createPty`, through a real node.exe standing in for claude (same
//            technique as transcript-root-deny-chokepoint.mjs) — proves the mechanism is genuinely wired
//            into the shipped spawn path and the WRITTEN settings.json carries the right rules (in the
//            `//` documented form), not just correct in a unit test that never calls it.
//
// Run: 1) build (turbo builds shared first), 2) node test/loom-home-write-deny.mjs
import fs from "node:fs";
import path from "node:path";
import { mkdtempManaged, registerForCleanup, finishAndExit, useOwnLoomHome } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// @decision 37310431 — LOOM_HOME must be set, via `useOwnLoomHome`, BEFORE the FIRST dynamic import of
// ANYTHING that transitively imports `paths.js` (including `projects/repos.js`, below) — `paths.js`
// computes `LOOM_HOME` at MODULE-LOAD time and caches it; importing it even once before this line bakes
// in whatever `process.env.LOOM_HOME` was at that earlier moment (unset ⇒ the REAL `~/.loom`) for the
// rest of the process, silently. A real run of an earlier draft of this file reordered PART 1 ahead of
// this line and, as a direct consequence, PART 3's real spawn wrote a session settings.json under the
// REAL `~/.loom/tmp/settings/` — never touched by `rules.includes(...)`-shaped assertions (which stayed
// self-consistent against the SAME stale path on both sides) but caught by the readdir-vs-separately-
// written-file cross-check below, which is EXACTLY why that check exists.
const tmpHome = useOwnLoomHome("loom-hwd-");
requireHermeticEnv();

// =====================================================================================================
// PART 1 — the realpath building block, on its own
// =====================================================================================================
{
  const { canonicalizeExistingPath } = await import("../dist/projects/repos.js");
  const realTarget = mkdtempManaged("loom-home-deny-junction-target-");
  fs.writeFileSync(path.join(realTarget, "marker.txt"), "x");
  const junctionPath = path.join(mkdtempManaged("loom-home-deny-junction-parent-"), "alias");
  let junctionOk = true;
  try {
    fs.symlinkSync(realTarget, junctionPath, process.platform === "win32" ? "junction" : "dir");
  } catch (e) {
    junctionOk = false;
    console.log(`WARN  PART 1 skipped — could not create a junction/symlink on this host (${e.message}); the realpath building block is exercised indirectly by PART 2/3 below via the non-aliased LOOM_HOME instead.`);
  }
  if (junctionOk) {
    const resolved = canonicalizeExistingPath(junctionPath);
    check("canonicalizeExistingPath collapses a junction/symlink alias to its REAL target (not the alias path)",
      path.resolve(resolved).toLowerCase() === path.resolve(realTarget).toLowerCase());
    check("...and the resolved path genuinely reaches the real target's own content", fs.existsSync(path.join(resolved, "marker.txt")));
  }
}

// =====================================================================================================
// PART 1c — `toClaudeAbsoluteGlob` (Ruling A): the documented `//`-absolute form, both path shapes
// =====================================================================================================
{
  const { toClaudeAbsoluteGlob } = await import("../dist/pty/loom-home-deny.js");
  check("POSIX-shaped absolute path -> doubled leading slash (the documented //<path> form)",
    toClaudeAbsoluteGlob("/home/user/.loom/skills") === "//home/user/.loom/skills");
  check("Windows-shaped drive-letter path -> //<lowercase-drive>/<rest>, no colon",
    toClaudeAbsoluteGlob("C:/Users/danie/.loom/skills") === "//c/Users/danie/.loom/skills");
  check("Windows-shaped path with an UPPERCASE drive letter is still lowercased",
    toClaudeAbsoluteGlob("D:/x") === "//d/x");
  check("a path carrying real backslashes (not yet forward-slashed) is normalized first",
    toClaudeAbsoluteGlob("C:\\Users\\danie\\.loom") === "//c/Users/danie/.loom");
}

// =====================================================================================================
// PART 2 — the pure rule-building function, in isolation
// =====================================================================================================
const { ensureDirs, LOOM_HOME_WRITE_DENY_REGISTRY, LOOM_HOME_INSTRUCTION_WRITE_DENY_REGISTRY, SCRATCH_ROOT_DIR, WORKSPACE_ROOT, RUNS_DIR } = await import("../dist/paths.js");
const { loomHomeWriteDenyRules, withLoomHomeWriteDenyForSpawn, toClaudeAbsoluteGlob, LOOM_HOME_REAL } = await import("../dist/pty/loom-home-deny.js");

// Delta security review, nitpick: pin a few LITERAL registry entries directly, rather than relying only
// on the "exact map over the registry" comparison below (which derives its expectation FROM the registry
// itself — a registry bug that dropped/renamed one of these would still pass that comparison).
check("LOOM_HOME_WRITE_DENY_REGISTRY literally lists .env as a sensitive file",
  LOOM_HOME_WRITE_DENY_REGISTRY.some((e) => e.relPath === ".env" && e.kind === "file"));
check("LOOM_HOME_WRITE_DENY_REGISTRY literally lists loom.db-wal as a sensitive file",
  LOOM_HOME_WRITE_DENY_REGISTRY.some((e) => e.relPath === "loom.db-wal" && e.kind === "file"));
check("LOOM_HOME_WRITE_DENY_REGISTRY literally lists loom.db-shm as a sensitive file",
  LOOM_HOME_WRITE_DENY_REGISTRY.some((e) => e.relPath === "loom.db-shm" && e.kind === "file"));

ensureDirs(); // same production boot sequence loom-home-write-deny-real-spawn.mjs relies on

check("LOOM_HOME_WRITE_DENY_REGISTRY never lists SCRATCH_ROOT_DIR's own basename as a bare top-level relPath",
  !LOOM_HOME_WRITE_DENY_REGISTRY.some((e) => e.relPath === path.basename(SCRATCH_ROOT_DIR)));
check("LOOM_HOME_WRITE_DENY_REGISTRY never lists WORKSPACE_ROOT's own basename",
  !LOOM_HOME_WRITE_DENY_REGISTRY.some((e) => e.relPath === path.basename(WORKSPACE_ROOT)));
check("LOOM_HOME_WRITE_DENY_REGISTRY never lists RUNS_DIR's own basename",
  !LOOM_HOME_WRITE_DENY_REGISTRY.some((e) => e.relPath === path.basename(RUNS_DIR)));

const ruleForEntries = (entries) => new Set(entries.map((e) => {
  const abs = path.join(LOOM_HOME_REAL, e.relPath);
  const glob = toClaudeAbsoluteGlob(abs);
  return e.kind === "dir" ? `Edit(${glob}/**)` : `Edit(${glob})`;
}));

// --- fix round 2, item 1: for an EXEMPT role (platform ONLY — NOT setup, see the per-entry note below),
// the output is an EXACT map over the main registry ONLY — no instruction-registry rules, no readdir, no
// disk dependency at all ---
{
  const expected = ruleForEntries(LOOM_HOME_WRITE_DENY_REGISTRY);
  const rules = loomHomeWriteDenyRules({ role: "platform", sessionId: "s1" });
  check(`[platform] loomHomeWriteDenyRules returns EXACTLY one rule per MAIN registry entry (${expected.size} expected, ${rules.length} actual) — the instruction registry's per-entry exemptRoles exempts platform from every entry`,
    rules.length === expected.size && rules.every((r) => expected.has(r)));
}

// --- for a NON-exempt role (every role except platform — setup included, per fix round 2's
// correction), the output is an EXACT map over BOTH registries unioned ---
{
  const expected = new Set([...ruleForEntries(LOOM_HOME_WRITE_DENY_REGISTRY), ...ruleForEntries(LOOM_HOME_INSTRUCTION_WRITE_DENY_REGISTRY)]);
  for (const role of ["worker", "manager", "setup", "auditor", "workspace-auditor", "assistant", "operator", "run"]) {
    const rules = loomHomeWriteDenyRules({ role, sessionId: "s1" });
    check(`[${role}] loomHomeWriteDenyRules returns EXACTLY one rule per entry across BOTH registries (${expected.size} expected, ${rules.length} actual)`,
      rules.length === expected.size && rules.every((r) => expected.has(r)));
  }
}

// --- a plain, human-driven session (role===null) gets the MAIN registry only — exempt from the WHOLE
// instruction registry unconditionally (not per-entry — see loomHomeWriteDenyRules' own doc) ---
{
  const expected = ruleForEntries(LOOM_HOME_WRITE_DENY_REGISTRY);
  const rules = loomHomeWriteDenyRules({ role: null, sessionId: "s1" });
  check(`[plain, role=null] loomHomeWriteDenyRules returns EXACTLY one rule per MAIN registry entry (${expected.size} expected, ${rules.length} actual) — exempt from the whole instruction registry`,
    rules.length === expected.size && rules.every((r) => expected.has(r)));
}

// --- a registry-covered path that does NOT exist on disk yet is still denied (fail-closed, registry-only now) ---
{
  const rules = loomHomeWriteDenyRules({ role: "worker", sessionId: "s1" });
  check("a registry entry for a FILE not yet on disk still yields an exact Edit(//...) rule",
    rules.includes(`Edit(${toClaudeAbsoluteGlob(LOOM_HOME_REAL)}/skill-provenance.json)`));
  check("a registry entry for a DIR not yet on disk still yields an Edit(//.../**) rule",
    rules.includes(`Edit(${toClaudeAbsoluteGlob(LOOM_HOME_REAL)}/companion-skills/**)`));
}

// --- round 2 scope cut: an UNREGISTERED path present on disk is NOT denied — no live readdir pass anymore ---
{
  fs.writeFileSync(path.join(tmpHome, "unregistered-root-file.txt"), "x");
  fs.mkdirSync(path.join(tmpHome, "unregistered-dir"), { recursive: true });
  const rules = loomHomeWriteDenyRules({ role: "worker", sessionId: "s1" });
  check("an UNREGISTERED root FILE on disk is NOT denied (round 2 dropped the readdir pass — see decision record)",
    !rules.some((r) => r.includes("unregistered-root-file.txt")));
  check("an UNREGISTERED root DIR on disk is NOT denied either",
    !rules.some((r) => r.includes("unregistered-dir")));
}

// --- Write() is never emitted (the CLI rejects it — see the decision record) -----------------------------
{
  const rules = loomHomeWriteDenyRules({ role: "worker", sessionId: "s1" });
  check("no rule ever uses the Write(...) form (the CLI rejects it; only Edit(...) is valid)", !rules.some((r) => r.startsWith("Write(")));
}

// --- SCRATCH_ROOT_DIR, WORKSPACE_ROOT and RUNS_DIR: NEVER denied, for ANY role (round 2: structural
// omission from the registry — no per-role logic left to exercise) ---
{
  for (const role of ["worker", "manager", "platform", "setup", "auditor", "workspace-auditor", "assistant", "operator", "run", null]) {
    const rules = loomHomeWriteDenyRules({ role, sessionId: "s-excl" });
    check(`role '${String(role)}': scratch/ is never denied`, !rules.some((r) => r.includes("/tmp/scratch")));
    check(`role '${String(role)}': workspaces/ is never denied`, !rules.some((r) => r.includes("/workspaces")));
    check(`role '${String(role)}': runs/ is never denied`, !rules.some((r) => r.includes("/runs")));
  }
}

// --- delta security review, MAJOR finding (fix round 2, item 1 — Code Review CHANGES-NEEDED): the
// INSTRUCTION registry (PLATFORM-LEAD-RESUME*.md, CLAUDE.md, .claude/**) is denied PER ENTRY, and today
// every entry's exemption is `platform` ONLY — `setup` is DENIED all three (it was wrongly exempted in
// the first draft: setup is a lower-privilege operator with native Edit/Write/Bash and a cwd that's ALSO
// LOOM_HOME, so exempting it reopened the exact cross-role escalation this registry exists to close). A
// plain, human-driven session (role===null) stays exempt from the whole registry, unconditionally. ---
{
  const NON_EXEMPT = ["worker", "manager", "setup", "auditor", "workspace-auditor", "assistant", "operator", "run"];
  const EXEMPT = ["platform", null];
  for (const role of NON_EXEMPT) {
    const rules = loomHomeWriteDenyRules({ role, sessionId: "s1" });
    check(`[${String(role)}] the BASE resume doc (PLATFORM-LEAD-RESUME.md) IS denied`,
      rules.includes(`Edit(${toClaudeAbsoluteGlob(LOOM_HOME_REAL)}/PLATFORM-LEAD-RESUME*.md)`));
    check(`[${String(role)}] CLAUDE.md IS denied`, rules.includes(`Edit(${toClaudeAbsoluteGlob(LOOM_HOME_REAL)}/CLAUDE.md)`));
    check(`[${String(role)}] .claude/** IS denied`, rules.includes(`Edit(${toClaudeAbsoluteGlob(LOOM_HOME_REAL)}/.claude/**)`));
  }
  for (const role of EXEMPT) {
    const rules = loomHomeWriteDenyRules({ role, sessionId: "s1" });
    check(`[${String(role)}] the resume-doc glob is NOT denied (exempt)`, !rules.some((r) => r.includes("PLATFORM-LEAD-RESUME")));
    check(`[${String(role)}] CLAUDE.md is NOT denied (exempt)`, !rules.some((r) => r.includes("/CLAUDE.md")));
    check(`[${String(role)}] .claude/** is NOT denied (exempt)`, !rules.some((r) => r.includes("/.claude")));
  }
}

// --- the resume-doc ROTATION ARCHIVE (<name>.archive/) is untouched by either registry, for every role
// — confirms the platform-lead resume-doc rotation stays writable (nothing here denies it in the first
// place). NOT because only the daemon writes there (an agent can write a rotation archive too, per its
// own doctrine — Code Review caught that the earlier "daemon-written only" framing was wrong) — the real
// reason is that nothing auto-injects an ARCHIVED snapshot's content into a prompt;
// composePlatformLeadStartupPrompt reads only the ACTIVE resume doc, and an archive file is read on
// demand only, if something explicitly opens it. Checks for the SPECIFIC sibling path, not a bare
// "archive" substring — the main registry's unrelated top-level "archives" dir (session-transcript
// archives, sessions/transcript.ts) legitimately matches that substring for every role, and would make a
// bare substring check a false positive. ---
{
  const archiveSiblingPath = `${toClaudeAbsoluteGlob(LOOM_HOME_REAL)}/PLATFORM-LEAD-RESUME.md.archive`;
  for (const role of ["worker", "manager", "platform", "setup", "auditor", "workspace-auditor", "assistant", "operator", "run", null]) {
    const rules = loomHomeWriteDenyRules({ role, sessionId: "s1" });
    check(`[${String(role)}] the resume-doc rotation archive dir (PLATFORM-LEAD-RESUME.md.archive/) is never denied`,
      !rules.some((r) => r.includes(archiveSiblingPath)));
  }
}

// --- `withLoomHomeWriteDenyForSpawn`: unions into permission.deny, survives a custom entry, idempotent ---
{
  const CUSTOM_DENY = "Bash(rm -rf /:*)";
  const permission = { mode: "acceptEdits", allow: [], deny: [CUSTOM_DENY] };
  const out = withLoomHomeWriteDenyForSpawn(permission, { role: "worker", sessionId: "s1" });
  check("withLoomHomeWriteDenyForSpawn: the project's own custom deny entry survives (union, not replace)", out.deny.includes(CUSTOM_DENY));
  check("withLoomHomeWriteDenyForSpawn: at least one LOOM_HOME rule was actually added", out.deny.length > permission.deny.length);

  const idempotent = withLoomHomeWriteDenyForSpawn(out, { role: "worker", sessionId: "s1" });
  check("withLoomHomeWriteDenyForSpawn: idempotent — re-applying to an already-protected permission yields the SAME object reference", idempotent === out);
}

// --- the function never throws, for a normal (existing) LOOM_HOME ---
{
  let neverThrew = true;
  try { loomHomeWriteDenyRules({ role: "worker", sessionId: "s1" }); } catch { neverThrew = false; }
  check("loomHomeWriteDenyRules never throws on the spawn path", neverThrew);
}

// =====================================================================================================
// PART 3 — the REAL (unsubclassed) createPty, through a real node.exe standing in for claude
// =====================================================================================================
if (process.platform !== "win32") {
  console.log("SKIP  loom-home-write-deny.mjs part 3 — the LOOM_CLAUDE_BIN real-node.exe-substitution technique this file uses was only established/verified on Windows; see transcript-root-deny-chokepoint.mjs's own header for the same gap.");
} else {
  process.env.LOOM_CLAUDE_BIN = process.execPath;
  const { PtyHost } = await import("../dist/pty/host.js");
  const { SETTINGS_DIR, WORKTREES_DIR } = await import("../dist/paths.js");
  registerForCleanup(WORKTREES_DIR); // sibling of LOOM_HOME, created by production ensureDirs()

  const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
  const host = new PtyHost(events);
  const readWrittenDeny = (sessionId) => JSON.parse(fs.readFileSync(path.join(SETTINGS_DIR, `${sessionId}.json`), "utf8")).permissions?.deny ?? [];

  const sid = "lhwd-real-worker";
  try {
    host.spawn({ sessionId: sid, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [] }, geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role: "worker" });
    check("(real) host actually spawned a real process (exercised the REAL createPty, not a stub)", host.isAlive(sid));
    const written = readWrittenDeny(sid);
    check("(real) WRITTEN settings.json permissions.deny includes a LOOM_HOME rule, in the documented //-absolute form (e.g. the skill-provenance.json registry entry)",
      written.includes(`Edit(${toClaudeAbsoluteGlob(LOOM_HOME_REAL)}/skill-provenance.json)`));
    check("(real) WRITTEN settings.json permissions.deny does NOT include a Write(...) rule", !written.some((r) => r.startsWith("Write(")));
    check("(real) WRITTEN settings.json permissions.deny does NOT deny scratch/ or workspaces/", !written.some((r) => r.includes("/tmp/scratch") || r.includes("/workspaces")));
    check("(real) WRITTEN settings.json permissions.deny ALSO includes the instruction registry's CLAUDE.md rule (worker is non-exempt)",
      written.includes(`Edit(${toClaudeAbsoluteGlob(LOOM_HOME_REAL)}/CLAUDE.md)`));
  } finally {
    try { host.stop(sid, "hard"); } catch { /* best-effort cleanup */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — loomHomeWriteDenyRules/withLoomHomeWriteDenyForSpawn is correct in isolation (round 2: an exact, registry-based map with no readdir, Edit()-only, the //-absolute glob form on both path shapes, scratch/workspaces/runs structurally absent for every role, the instruction registry's PER-ENTRY exemption correctly splitting platform (exempt) + setup (denied, fix round 2) from every other role, plain (role===null) exempt from the whole registry unconditionally, idempotent, never throws), the junction-safety building block genuinely collapses an alias, AND the REAL (unsubclassed) createPty actually writes the computed rules into settings.json for a real spawn."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
