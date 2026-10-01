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

// --- Card 00a999e8: a REBOUND Platform home also gets the instruction registry denied, for every
// non-exempt role — not just LOOM_HOME's own copy — and stays exempt for platform everywhere. PER-ENTRY,
// not a single shared root: `PLATFORM-LEAD-RESUME*.md` follows `resolvePlatformLeadResumeDocPath`, which
// is passed `project.vaultPath` explicitly; `CLAUDE.md`/`.claude/**` are read by the harness relative to
// the session's spawn CWD, which `startPlatformLead` pins to `project.repoPath` — so a rebind that moves
// repoPath and vaultPath APART from each other (not just away from LOOM_HOME) needs the resume doc denied
// at the vault and CLAUDE.md/.claude/** denied at the repo, independently. RED on a commit that roots
// every entry at a single shared `platformHomePath` (round 2 of this fix did exactly that): with repoPath
// and vaultPath genuinely split, that draft would deny CLAUDE.md at whichever ONE path it was given and
// leave the other silently uncovered — the split-case assertions below are the ones that catch it.
// ROUND 3 (Code Review, this revision): `repoPaths` is a SET, not one path, because a Platform Lead
// session's `cwd` is pinned at spawn/recycle and NEVER re-derived from the project row on resume — see the
// DB-level "Lead cwd outlives a rebind" scenario further below for the RED proof against round 2's
// single-candidate shape. ---
{
  const { canonicalizeExistingPath } = await import("../dist/projects/repos.js");
  const reboundHome = mkdtempManaged("loom-hwd-rebound-platform-home-");
  const reboundReal = canonicalizeExistingPath(reboundHome).replace(/\\/g, "/");
  const reboundGlob = toClaudeAbsoluteGlob(reboundReal);

  // --- same-root rebind (repoPaths===[vaultPath], both moved away from LOOM_HOME — the shape a rebind
  // normally takes, since the project UI edits one `vaultPath` field for a vaultOnly reserved home) ---
  const workerRules = loomHomeWriteDenyRules({ role: "worker", sessionId: "s1", platformHomePaths: { repoPaths: [reboundHome], vaultPath: reboundHome } });
  check("[worker] a REBOUND Platform home's CLAUDE.md is ALSO denied (not just LOOM_HOME's own copy)",
    workerRules.includes(`Edit(${reboundGlob}/CLAUDE.md)`));
  check("[worker] a REBOUND Platform home's PLATFORM-LEAD-RESUME*.md is ALSO denied",
    workerRules.includes(`Edit(${reboundGlob}/PLATFORM-LEAD-RESUME*.md)`));
  check("[worker] a REBOUND Platform home's .claude/** is ALSO denied",
    workerRules.includes(`Edit(${reboundGlob}/.claude/**)`));
  check("[worker] the ORIGINAL LOOM_HOME instruction rules are STILL present too (both locations denied)",
    workerRules.includes(`Edit(${toClaudeAbsoluteGlob(LOOM_HOME_REAL)}/CLAUDE.md)`));

  const platformRules = loomHomeWriteDenyRules({ role: "platform", sessionId: "s1", platformHomePaths: { repoPaths: [reboundHome], vaultPath: reboundHome } });
  check("[platform] the rebound home's CLAUDE.md is NOT denied (platform stays exempt from the instruction registry everywhere, not just at LOOM_HOME)",
    !platformRules.some((r) => r.includes(reboundGlob)));

  // --- SPLIT rebind: repoPath and vaultPath point at TWO DIFFERENT directories, both different from
  // LOOM_HOME_REAL — the case the manager flagged: CLAUDE.md/.claude/** must follow repoPath (the
  // harness's own spawn cwd), the resume doc must follow vaultPath, and NEITHER may leak into the other's
  // root. RED on a single-shared-root implementation, which would deny CLAUDE.md at whichever ONE path it
  // was handed and leave the real repoPath copy uncovered. ---
  const reboundRepo = mkdtempManaged("loom-hwd-rebound-platform-repo-");
  const reboundVault = mkdtempManaged("loom-hwd-rebound-platform-vault-");
  const reboundRepoReal = canonicalizeExistingPath(reboundRepo).replace(/\\/g, "/");
  const reboundVaultReal = canonicalizeExistingPath(reboundVault).replace(/\\/g, "/");
  const reboundRepoGlob = toClaudeAbsoluteGlob(reboundRepoReal);
  const reboundVaultGlob = toClaudeAbsoluteGlob(reboundVaultReal);
  const splitRules = loomHomeWriteDenyRules({ role: "worker", sessionId: "s1", platformHomePaths: { repoPaths: [reboundRepo], vaultPath: reboundVault } });
  check("[worker, SPLIT rebind] CLAUDE.md is denied at repoPath (the harness's own spawn cwd)",
    splitRules.includes(`Edit(${reboundRepoGlob}/CLAUDE.md)`));
  check("[worker, SPLIT rebind] .claude/** is denied at repoPath",
    splitRules.includes(`Edit(${reboundRepoGlob}/.claude/**)`));
  check("[worker, SPLIT rebind] CLAUDE.md is NOT ALSO denied at vaultPath (it has no reader there)",
    !splitRules.includes(`Edit(${reboundVaultGlob}/CLAUDE.md)`));
  check("[worker, SPLIT rebind] the resume doc is denied at vaultPath (resolvePlatformLeadResumeDocPath's own root)",
    splitRules.includes(`Edit(${reboundVaultGlob}/PLATFORM-LEAD-RESUME*.md)`));
  check("[worker, SPLIT rebind] the resume doc is NOT ALSO denied at repoPath (it has no reader there)",
    !splitRules.includes(`Edit(${reboundRepoGlob}/PLATFORM-LEAD-RESUME*.md)`));
  const splitPlatformRules = loomHomeWriteDenyRules({ role: "platform", sessionId: "s1", platformHomePaths: { repoPaths: [reboundRepo], vaultPath: reboundVault } });
  check("[platform, SPLIT rebind] neither rebound root is denied (platform stays exempt from both)",
    !splitPlatformRules.some((r) => r.includes(reboundRepoGlob) || r.includes(reboundVaultGlob)));

  const expectedBoth = new Set([...ruleForEntries(LOOM_HOME_WRITE_DENY_REGISTRY), ...ruleForEntries(LOOM_HOME_INSTRUCTION_WRITE_DENY_REGISTRY)]);
  const unRebound = loomHomeWriteDenyRules({ role: "worker", sessionId: "s1", platformHomePaths: { repoPaths: [LOOM_HOME_REAL], vaultPath: LOOM_HOME_REAL } });
  check("[worker] platformHomePaths both === LOOM_HOME_REAL (never rebound, the common/seeded-default case) is a pure no-op — no duplicate rules",
    unRebound.length === expectedBoth.size && unRebound.every((r) => expectedBoth.has(r)));

  const noPlatform = loomHomeWriteDenyRules({ role: "worker", sessionId: "s1", platformHomePaths: { repoPaths: [], vaultPath: null } });
  check("[worker] platformHomePaths empty repoPaths + null vaultPath (Platform project never seeded — LOOM_DEV off) behaves exactly like omitting the field: no crash, no stray rules",
    noPlatform.length === expectedBoth.size && noPlatform.every((r) => expectedBoth.has(r)));

  const omitted = loomHomeWriteDenyRules({ role: "worker", sessionId: "s1" });
  check("[worker] omitting platformHomePaths entirely behaves identically to passing empty repoPaths + null vaultPath",
    omitted.length === expectedBoth.size && omitted.every((r) => expectedBoth.has(r)));

  let neverThrewRebound = true;
  try { loomHomeWriteDenyRules({ role: "worker", sessionId: "s1", platformHomePaths: { repoPaths: ["/does/not/exist/on/disk"], vaultPath: "/also/does/not/exist" } }); } catch { neverThrewRebound = false; }
  check("loomHomeWriteDenyRules never throws when platformHomePaths don't resolve on disk (canonicalizeExistingPath falls back to path.resolve)", neverThrewRebound);

  // --- ROUND 3, BLOCKING FIX 1 (Code Review on d0ce14d4): a Platform Lead session's `cwd` OUTLIVES a
  // rebind — a REAL DB scenario, not a hand-fabricated candidate list. A Lead was spawned while
  // project.repoPath was A (its session row's cwd is pinned to A forever, per sessions/service.ts:
  // startPlatformLead sets cwd:project.repoPath at spawn time, and recycle/resume both reuse session.cwd
  // unchanged); the project's repoPath is THEN rebound to B. The live Lead lineage keeps reading
  // A/CLAUDE.md (nobody re-derives its cwd), while a FRESH spawn would use B/CLAUDE.md — BOTH must stay
  // denied for every other role. RED on d0ce14d4 (round 2): `platformHomePaths.repoPath` was a single
  // string, so passing the union the caller is expected to build here would either not exist as a field
  // (`repoPaths`) or silently ignore every candidate but one — this exercises the ACTUAL
  // db.listSessionCwdsForProjectRole query, not a stand-in. ---
  {
    const { Db } = await import("../dist/db.js");
    const { randomUUID } = await import("node:crypto");
    const db = new Db(); // hermetic temp loom.db under tmpHome (useOwnLoomHome set LOOM_HOME at the top of this file)
    const now = new Date().toISOString();
    const repoA = mkdtempManaged("loom-hwd-lead-cwd-a-");
    const repoB = mkdtempManaged("loom-hwd-lead-cwd-b-");
    const repoAReal = canonicalizeExistingPath(repoA).replace(/\\/g, "/");
    const repoBReal = canonicalizeExistingPath(repoB).replace(/\\/g, "/");
    const repoAGlob = toClaudeAbsoluteGlob(repoAReal);
    const repoBGlob = toClaudeAbsoluteGlob(repoBReal);

    const projectId = randomUUID();
    db.insertProject({
      id: projectId, name: "lhwd-lead-cwd-test", repoPath: repoA, vaultPath: repoA, config: {},
      createdAt: now, archivedAt: null, reserved: true, referenceRepos: [], noGateByDesign: false,
      denyGlobs: [], repos: [], vaultOnly: true,
    });
    // sessions.agent_id has a real FK to agents(id) — one throwaway agent row, reused by every session
    // literal below (nothing here cares about the agent beyond satisfying the constraint).
    const agentId = randomUUID();
    db.insertAgent({ id: agentId, projectId, name: "lhwd-lead-cwd-agent", startupPrompt: "", position: 0, profileId: null });
    // The Lead session: spawned while repoPath was still A, cwd pinned to A, LIVE, not archived, not dead.
    db.insertSession({
      id: randomUUID(), projectId, agentId, engineSessionId: null, title: null,
      cwd: repoA, processState: "live", resumability: "unknown", busy: false,
      createdAt: now, lastActivity: now, lastError: null, role: "platform",
    });
    // An ARCHIVED platform-role session at a THIRD path — must NOT contribute a candidate.
    const repoArchived = mkdtempManaged("loom-hwd-lead-cwd-archived-");
    const archivedSessionId = randomUUID();
    db.insertSession({
      id: archivedSessionId, projectId, agentId, engineSessionId: null, title: null,
      cwd: repoArchived, processState: "exited", resumability: "resumable", busy: false,
      createdAt: now, lastActivity: now, lastError: null, role: "platform",
    });
    db.archiveSession(archivedSessionId); // insertSession's own column list has no archived_at — a separate write, mirrors production (auto-archive-on-exit)
    // A DEAD (proven-unresumable) platform-role session at a FOURTH path — must NOT contribute either.
    const repoDead = mkdtempManaged("loom-hwd-lead-cwd-dead-");
    db.insertSession({
      id: randomUUID(), projectId, agentId, engineSessionId: null, title: null,
      cwd: repoDead, processState: "exited", resumability: "dead", busy: false,
      createdAt: now, lastActivity: now, lastError: null, role: "platform",
    });
    // A WORKER-role session at a FIFTH path, same project — must NOT contribute (wrong role).
    const repoWorker = mkdtempManaged("loom-hwd-lead-cwd-worker-");
    db.insertSession({
      id: randomUUID(), projectId, agentId, engineSessionId: null, title: null,
      cwd: repoWorker, processState: "live", resumability: "unknown", busy: false,
      createdAt: now, lastActivity: now, lastError: null, role: "worker",
    });

    // THE REBIND: repoPath moves from A to B. The Lead session row's own cwd is untouched (still A).
    db.updateProject(projectId, { repoPath: repoB });

    const liveCwds = db.listSessionCwdsForProjectRole(projectId, "platform");
    check("db.listSessionCwdsForProjectRole: returns EXACTLY the live Lead's cwd (A) — archived/dead/wrong-role excluded",
      liveCwds.length === 1 && liveCwds[0] === repoA);

    const project = db.getProject(projectId);
    const repoPaths = [...new Set([project.repoPath, ...liveCwds])]; // the SAME union index.ts's getPlatformHomePaths builds
    const rules = loomHomeWriteDenyRules({ role: "worker", sessionId: "s1", platformHomePaths: { repoPaths, vaultPath: project.vaultPath } });
    check("[worker] CLAUDE.md is denied at A (the LIVE Lead's pinned cwd, pre-rebind — still being read right now)",
      rules.includes(`Edit(${repoAGlob}/CLAUDE.md)`));
    check("[worker] .claude/** is denied at A",
      rules.includes(`Edit(${repoAGlob}/.claude/**)`));
    check("[worker] CLAUDE.md is ALSO denied at B (the rebound repoPath — what a FRESH Lead spawn would use)",
      rules.includes(`Edit(${repoBGlob}/CLAUDE.md)`));
    check("[worker] .claude/** is ALSO denied at B",
      rules.includes(`Edit(${repoBGlob}/.claude/**)`));

    const platformAtBoth = loomHomeWriteDenyRules({ role: "platform", sessionId: "s1", platformHomePaths: { repoPaths, vaultPath: project.vaultPath } });
    check("[platform] neither A nor B is denied (platform stays exempt from the instruction registry at every rebound root)",
      !platformAtBoth.some((r) => r.includes(repoAGlob) || r.includes(repoBGlob)));

    db.close(); // release the sqlite handle before tmpHome cleanup tries to unlink loom.db
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

  // --- Card 00a999e8 round 3, BLOCKING FIX 2 (Code Review): WIRING proof — until now every
  // platformHomePaths assertion called the PURE function directly; nothing exercised index.ts ->
  // PtyHost -> createPty. Build a SEPARATE PtyHost with a real getPlatformHomePaths callback (the same
  // constructor opt index.ts wires at boot) returning a rebound repoPath, and assert the rebound rule
  // actually reaches the WRITTEN settings.json for a real worker spawn — not just the return value of
  // loomHomeWriteDenyRules in isolation. ---
  {
    const { canonicalizeExistingPath } = await import("../dist/projects/repos.js");
    const wiredReboundHome = mkdtempManaged("loom-hwd-wired-rebound-");
    const wiredReboundReal = canonicalizeExistingPath(wiredReboundHome).replace(/\\/g, "/");
    const wiredReboundGlob = toClaudeAbsoluteGlob(wiredReboundReal);
    const wiredHost = new PtyHost(events, {
      getPlatformHomePaths: () => ({ repoPaths: [wiredReboundHome], vaultPath: null }),
    });
    const wiredSid = "lhwd-real-worker-wired-rebind";
    try {
      wiredHost.spawn({ sessionId: wiredSid, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [] }, geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role: "worker" });
      check("(real, WIRED getPlatformHomePaths) host actually spawned a real process", wiredHost.isAlive(wiredSid));
      const wiredWritten = readWrittenDeny(wiredSid);
      check("(real, WIRED getPlatformHomePaths) WRITTEN settings.json denies CLAUDE.md at the REBOUND path — proves index.ts's callback shape reaches createPty's actual settings write, not just the pure function",
        wiredWritten.includes(`Edit(${wiredReboundGlob}/CLAUDE.md)`));
      check("(real, WIRED getPlatformHomePaths) WRITTEN settings.json ALSO still denies CLAUDE.md at LOOM_HOME_REAL (both locations)",
        wiredWritten.includes(`Edit(${toClaudeAbsoluteGlob(LOOM_HOME_REAL)}/CLAUDE.md)`));
    } finally {
      try { wiredHost.stop(wiredSid, "hard"); } catch { /* best-effort cleanup */ }
    }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — loomHomeWriteDenyRules/withLoomHomeWriteDenyForSpawn is correct in isolation (round 2: an exact, registry-based map with no readdir, Edit()-only, the //-absolute glob form on both path shapes, scratch/workspaces/runs structurally absent for every role, the instruction registry's PER-ENTRY exemption correctly splitting platform (exempt) + setup (denied, fix round 2) from every other role, plain (role===null) exempt from the whole registry unconditionally, idempotent, never throws), the junction-safety building block genuinely collapses an alias, AND the REAL (unsubclassed) createPty actually writes the computed rules into settings.json for a real spawn."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
