import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card ad34efb5 — surface renamed-aside stale worktree dirs (`<path>.stale-<ts>`, see
// renameWorktreeDirAside) for reclaim. REAL filesystem under a temp LOOM_HOME, NO claude and NO live
// daemon.
//
// PART 1 (pure, no Db): listStaleAsideWorktrees's enumeration rule + its two negative controls,
// isStaleAsideWorktreeDir's basename regex, and reclaimStaleAsideWorktreeDir's own guards (basename
// refusal, out-of-root refusal, missing, truncated-size propagation, happy-path removal).
//
// PART 2 (Db + SessionService): listStaleWorktreeLeftovers's byte-total aggregation,
// reclaimStaleWorktreeLeftover's fresh re-derivation (TOCTOU), its case/trailing-separator-insensitive
// matching (manager review note 2), its defensive no-live-claimant refusal, its process-reap scoping, and
// buildServedStatus's count-only `staleWorktreeLeftovers` field (incl. the clean-host 0/null case).
//
// Run: 1) build (pnpm build), 2) node packages/daemon/test/stale-worktree-leftovers.mjs
import fs from "node:fs";
import path from "node:path";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";

useOwnLoomHome("loom-swl-home-");
requireHermeticEnv();

const {
  listStaleAsideWorktrees, repoKeysByProjectFromProjects, isStaleAsideWorktreeDir,
  reclaimStaleAsideWorktreeDir, resolveWorktreePath, isRegisteredRepoKeyAxisDir,
} = await import("../dist/git/worktrees.js");
const { WORKTREES_DIR } = await import("../dist/paths.js");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { buildServedStatus } = await import("../dist/served-status.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const mkStaleAside = (cleanPath, ts) => {
  const p = `${cleanPath}.stale-${ts}`;
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, "leftover.txt"), "half-removed orphan content\n");
  return p;
};

// ================================================================================================
// PART 1 — pure functions, no Db
// ================================================================================================

// --- isStaleAsideWorktreeDir basename regex ---
check("isStaleAsideWorktreeDir matches a real stale-aside basename", isStaleAsideWorktreeDir("C:\\x\\key.stale-1700000000000"));
check("isStaleAsideWorktreeDir rejects a plain task-key basename", !isStaleAsideWorktreeDir("C:\\x\\abc123def456"));
check("isStaleAsideWorktreeDir rejects a repoKey literally containing 'stale' but no numeric suffix", !isStaleAsideWorktreeDir("C:\\x\\stale-service"));
check("isStaleAsideWorktreeDir rejects a non-numeric suffix", !isStaleAsideWorktreeDir("C:\\x\\key.stale-abc"));

// --- (1) primary-axis enumeration ---
{
  const proj = "projSwlA";
  const cleanPath = resolveWorktreePath(proj, "taskA-primary");
  const stalePath = mkStaleAside(cleanPath, 1700000000000);
  const entries = listStaleAsideWorktrees(WORKTREES_DIR);
  const hit = entries.find((e) => e.path === stalePath);
  check("(1) primary-axis stale dir is enumerated", !!hit);
  check("(1) projectId is the project dir name", hit?.projectId === proj);
  check("(1) staleSinceMs is parsed straight from the suffix", hit?.staleSinceMs === 1700000000000);
  fs.rmSync(stalePath, { recursive: true, force: true });
}

// --- (2) secondary-repo-axis enumeration, registry-driven ---
{
  const proj = "projSwlB";
  const repoKey = "secondary-repo";
  const cleanPath = resolveWorktreePath(proj, "taskB-secondary", repoKey);
  const stalePath = mkStaleAside(cleanPath, 1700000000001);
  const withRegistry = listStaleAsideWorktrees(WORKTREES_DIR, repoKeysByProjectFromProjects([{ id: proj, repos: [{ key: repoKey }] }]));
  check("(2) secondary-axis stale dir IS found when repoKeysByProject names the repoKey", !!withRegistry.find((e) => e.path === stalePath && e.projectId === proj));
  const withoutRegistry = listStaleAsideWorktrees(WORKTREES_DIR);
  check("(2) the SAME dir is NOT found when repoKeysByProject is omitted (degrades to primary-axis-only, by design)", !withoutRegistry.find((e) => e.path === stalePath));
  const wrongRegistry = listStaleAsideWorktrees(WORKTREES_DIR, repoKeysByProjectFromProjects([{ id: proj, repos: [{ key: "some-other-repo" }] }]));
  check("(2) still NOT found when the registry names a DIFFERENT repoKey for this project (never a guess)", !wrongRegistry.find((e) => e.path === stalePath));
  fs.rmSync(stalePath, { recursive: true, force: true });
}

// --- (3) NEGATIVE CONTROL: a live (un-suffixed) worktree dir is never listed ---
{
  const proj = "projSwlC";
  const livePath = resolveWorktreePath(proj, "taskC-live");
  fs.mkdirSync(livePath, { recursive: true });
  fs.writeFileSync(path.join(livePath, "package.json"), "{}\n");
  const entries = listStaleAsideWorktrees(WORKTREES_DIR);
  check("(3) NEGATIVE CONTROL: a plain live worktree dir (no suffix) is never listed as a leftover", !entries.find((e) => e.path === livePath));
  fs.rmSync(livePath, { recursive: true, force: true });
}

// --- (4) NEGATIVE CONTROL: a repoKey dir containing a stale-shaped grandchild is never surfaced unless
//     that repoKey is REGISTERED — proves the probe is registry-driven, not name-shape-guessed, even
//     when the inner content really does look like a leftover.
{
  const proj = "projSwlD";
  const unregisteredRepoKey = "unregistered-repo";
  const cleanPath = resolveWorktreePath(proj, "taskD-unregistered", unregisteredRepoKey);
  const stalePath = mkStaleAside(cleanPath, 1700000000002);
  const entries = listStaleAsideWorktrees(WORKTREES_DIR, repoKeysByProjectFromProjects([{ id: proj, repos: [] }]));
  check("(4) NEGATIVE CONTROL: a genuinely stale-shaped grandchild under an UNREGISTERED repoKey dir is never surfaced", !entries.find((e) => e.path === stalePath));
  fs.rmSync(stalePath, { recursive: true, force: true });
}

// --- (17) MAJOR FIX (Code Review b674e1fb round 2): a registered repoKey shaped like a renamed-aside
//     leftover (e.g. "svc.stale-1") must NEVER be treated as one — its axis dir holds that repo's LIVE
//     worktrees one level below. Before this fix the enumeration's basename-shape check ran BEFORE the
//     registry check, so the axis dir was listed as reclaimable and a reclaim call on it deleted the live
//     worktree beneath. Proven RED against the pre-fix code in this same seat (reverted worktrees.ts,
//     rebuilt, confirmed this exact section failed: the axis dir WAS listed and the direct reclaim call
//     reported "removed" instead of "refused" — then restored and reconfirmed green below).
{
  const proj = "projSwlMajor";
  const dangerousRepoKey = "svc.stale-1"; // matches STALE_ASIDE_SUFFIX_RE by basename alone
  const axisPath = path.join(WORKTREES_DIR, proj, dangerousRepoKey);
  const liveWorktreePath = resolveWorktreePath(proj, "taskMajor-live", dangerousRepoKey);
  fs.mkdirSync(liveWorktreePath, { recursive: true });
  fs.writeFileSync(path.join(liveWorktreePath, "package.json"), "{}\n"); // simulates a real live worktree
  const registry = repoKeysByProjectFromProjects([{ id: proj, repos: [{ key: dangerousRepoKey }] }]);

  const entries = listStaleAsideWorktrees(WORKTREES_DIR, registry);
  check("(17) MAJOR FIX: the axis dir itself is NEVER listed as a stale leaf, even though its name matches .stale-<ts>", !entries.find((e) => e.path === axisPath));
  check("(17) MAJOR FIX: the live worktree beneath it is not listed either", !entries.find((e) => e.path === liveWorktreePath));

  const directOutcome = await reclaimStaleAsideWorktreeDir(axisPath, undefined, { repoKeysByProject: registry, worktreesRoot: WORKTREES_DIR });
  check("(17) MAJOR FIX: reclaimStaleAsideWorktreeDir independently REFUSES the axis dir even when called directly (never trusting the listing alone)", directOutcome.outcome === "refused");
  check("(17) MAJOR FIX: the live worktree is still intact after the refused direct reclaim attempt", fs.existsSync(liveWorktreePath) && fs.existsSync(path.join(liveWorktreePath, "package.json")));
  check("(17) MAJOR FIX: the axis dir itself still exists", fs.existsSync(axisPath));

  fs.rmSync(liveWorktreePath, { recursive: true, force: true });
  fs.rmSync(axisPath, { recursive: true, force: true });
}

// --- isRegisteredRepoKeyAxisDir: the independent, path-based re-derivation reclaim relies on ---
{
  const proj = "projSwlAxis";
  const registry = repoKeysByProjectFromProjects([{ id: proj, repos: [{ key: "svc.stale-9" }] }]);
  const axisPath = path.join(WORKTREES_DIR, proj, "svc.stale-9");
  check("isRegisteredRepoKeyAxisDir: true for the axis dir itself", isRegisteredRepoKeyAxisDir(axisPath, registry, WORKTREES_DIR));
  check("isRegisteredRepoKeyAxisDir: false for a path ONE level deeper (a real leaf under the axis, never the axis itself)", !isRegisteredRepoKeyAxisDir(path.join(axisPath, "someTask"), registry, WORKTREES_DIR));
  check("isRegisteredRepoKeyAxisDir: false for an UNREGISTERED key under the same project", !isRegisteredRepoKeyAxisDir(path.join(WORKTREES_DIR, proj, "other-key"), registry, WORKTREES_DIR));
  check("isRegisteredRepoKeyAxisDir: false for a DIFFERENT project using the same registered key name", !isRegisteredRepoKeyAxisDir(path.join(WORKTREES_DIR, "someOtherProj", "svc.stale-9"), registry, WORKTREES_DIR));
}

// --- isRegisteredRepoKeyAxisDir case-fold (card 98039b36): a legacy case-only-distinct pair ("Svc"/"svc"),
//     exempted into the registry by validateRepoRegistry's `existingKeys` mechanism, shares ONE physical
//     dir on win32's case-insensitive filesystem — the plain exact-match lookup alone is blind to a THIRD
//     casing the real on-disk dir could be reported under. Folds case ON WIN32 ONLY (mirrors
//     projects/repos.ts's `comparisonKey` platform-conditional posture).
{
  const proj = "projSwlCaseFold";
  const registry = repoKeysByProjectFromProjects([{ id: proj, repos: [{ key: "Svc" }, { key: "svc" }] }]);
  const differentCaseTarget = path.join(WORKTREES_DIR, proj, "SVC"); // a THIRD casing, not a stored spelling
  if (process.platform === "win32") {
    check("isRegisteredRepoKeyAxisDir (win32): a third casing of a registered key still matches, case-folded", isRegisteredRepoKeyAxisDir(differentCaseTarget, registry, WORKTREES_DIR));
  } else {
    check("isRegisteredRepoKeyAxisDir (non-win32): a differently-cased path is correctly NOT folded (a real POSIX filesystem is case-sensitive)", !isRegisteredRepoKeyAxisDir(differentCaseTarget, registry, WORKTREES_DIR));
  }
  // NEGATIVE CONTROL: a key with no case-insensitive match to ANY registered spelling is still false —
  // proves the fold isn't a blanket "always true", on every platform.
  check("isRegisteredRepoKeyAxisDir: NEGATIVE CONTROL — no case-insensitive match at all is still false", !isRegisteredRepoKeyAxisDir(path.join(WORKTREES_DIR, proj, "totally-different"), registry, WORKTREES_DIR));
}

// --- (20) card 98039b36, Code Review b0369501 finding 1: a case-only single-key RENAME survives on
//     win32's case-PRESERVING filesystem — the live axis dir stays on disk under its OLD casing after the
//     registry is renamed. Before the shared isRegisteredRepoKeyName helper, listStaleAsideWorktrees's own
//     unfolded exact-match check treated that dir as UNREGISTERED and never descended into it, so a real
//     .stale-<ts> leftover nested beneath it was never enumerated — permanently invisible, permanently
//     un-reclaimable. @decision 98039b36 fixes this by routing both call sites through one shared,
//     case-folded helper.
{
  const proj = "projSwlRename";
  const oldCasedRepoKey = "Svc"; // the ORIGINAL casing a worktree axis dir was physically cut under
  const renamedRepoKey = "svc";  // the registry's CURRENT (renamed) spelling — same key, case-only rename
  const liveWorktreePath = resolveWorktreePath(proj, "taskRename-live", oldCasedRepoKey);
  fs.mkdirSync(liveWorktreePath, { recursive: true });
  fs.writeFileSync(path.join(liveWorktreePath, "package.json"), "{}\n"); // a real live worktree beneath the axis
  const axisPath = path.join(WORKTREES_DIR, proj, oldCasedRepoKey);
  const leftoverPath = mkStaleAside(path.join(axisPath, "orphanedTask"), 1700000000030);
  // The registry now names ONLY the renamed spelling — simulates a PATCH that renamed "Svc" -> "svc".
  const registry = repoKeysByProjectFromProjects([{ id: proj, repos: [{ key: renamedRepoKey }] }]);

  if (process.platform === "win32") {
    const entries = listStaleAsideWorktrees(WORKTREES_DIR, registry);
    check("(20) win32: a leftover nested under a case-RENAMED axis dir IS still found (shared case-folded helper)", !!entries.find((e) => e.path === leftoverPath));
    check("(20) win32: the live axis dir itself is still never listed as a leftover", !entries.find((e) => e.path === axisPath));
    check("(20) win32: the live worktree beneath the axis dir is not listed either", !entries.find((e) => e.path === liveWorktreePath));
  } else {
    check("(20) non-win32 control: skipped (a case-only rename collision is a win32-only hazard)", true);
  }
  fs.rmSync(axisPath, { recursive: true, force: true });
}

// --- (21) card 98039b36, Code Review b0369501 finding 1, stale-SUFFIX-SHAPED-key variant: a registered
//     key itself shaped like a renamed-aside leftover (e.g. "Svc.stale-1", grandfathered via existingKeys)
//     case-renamed to "svc.stale-1" — the LIVE axis dir survives on disk under the OLD casing. Before the
//     shared helper, the unfolded registry check missed it and the basename-shape fallback then wrongly
//     LISTED the live axis dir itself as a reclaimable leftover (the actual reclaim was always refused
//     independently by isRegisteredRepoKeyAxisDir's own fold — this test is about the LISTING being wrong,
//     not about data loss).
{
  const proj = "projSwlRenameStaleShape";
  const oldCasedRepoKey = "Svc.stale-1";
  const renamedRepoKey = "svc.stale-1";
  const axisPath = path.join(WORKTREES_DIR, proj, oldCasedRepoKey);
  const liveWorktreePath = resolveWorktreePath(proj, "taskRenameStale-live", oldCasedRepoKey);
  fs.mkdirSync(liveWorktreePath, { recursive: true });
  fs.writeFileSync(path.join(liveWorktreePath, "package.json"), "{}\n");
  const registry = repoKeysByProjectFromProjects([{ id: proj, repos: [{ key: renamedRepoKey }] }]);

  if (process.platform === "win32") {
    const entries = listStaleAsideWorktrees(WORKTREES_DIR, registry);
    check("(21) win32: the live axis dir (case-renamed, stale-suffix-shaped key) is NEVER listed as a leftover", !entries.find((e) => e.path === axisPath));
  } else {
    check("(21) non-win32 control: skipped (a case-only rename collision is a win32-only hazard)", true);
  }
  fs.rmSync(axisPath, { recursive: true, force: true });
}

// --- (18) a stale-named junction/symlink is skipped by enumeration and refused by confinement (nit 3c) ---
{
  const proj = "projSwlJunction";
  const outsideTarget = path.join(path.dirname(WORKTREES_DIR), `swl-junction-target-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(outsideTarget, { recursive: true });
  fs.writeFileSync(path.join(outsideTarget, "real-file.txt"), "do not touch\n");
  const junctionPath = `${resolveWorktreePath(proj, "taskJunction")}.stale-1700000000020`;
  fs.mkdirSync(path.dirname(junctionPath), { recursive: true });
  fs.symlinkSync(outsideTarget, junctionPath, process.platform === "win32" ? "junction" : "dir");

  const entries = listStaleAsideWorktrees(WORKTREES_DIR);
  check("(18) a stale-named junction/symlink is SKIPPED by enumeration, never listed as a leftover", !entries.find((e) => e.path === junctionPath));

  const outcome = await reclaimStaleAsideWorktreeDir(junctionPath, undefined, { repoKeysByProject: new Map() });
  check("(18) reclaimStaleAsideWorktreeDir REFUSES a stale-named junction/symlink (confinement: its real target resolves outside the worktrees root)", outcome.outcome === "refused");
  check("(18) its REAL target is untouched", fs.existsSync(path.join(outsideTarget, "real-file.txt")));

  try { fs.rmdirSync(junctionPath); } catch { /* best-effort: unlink the link itself, never recurse through it */ }
  fs.rmSync(outsideTarget, { recursive: true, force: true });
}

// --- (6) reclaimStaleAsideWorktreeDir happy path ---
{
  const proj = "projSwlE";
  const cleanPath = resolveWorktreePath(proj, "taskE-happy");
  const stalePath = mkStaleAside(cleanPath, 1700000000003);
  const outcome = await reclaimStaleAsideWorktreeDir(stalePath, undefined, { repoKeysByProject: new Map() });
  check("(6) happy path: outcome is removed", outcome.outcome === "removed");
  check("(6) happy path: bytesReclaimed is a measured non-negative number", typeof outcome.bytesReclaimed === "number" && outcome.bytesReclaimed >= 0);
  check("(6) happy path: the dir is actually gone from disk", !fs.existsSync(stalePath));
}

// --- (7) reclaimStaleAsideWorktreeDir REFUSES a path failing the basename regex ---
{
  const proj = "projSwlF";
  const cleanPath = resolveWorktreePath(proj, "taskF-refuse-basename");
  fs.mkdirSync(cleanPath, { recursive: true });
  fs.writeFileSync(path.join(cleanPath, "do-not-touch.txt"), "live content\n");
  const outcome = await reclaimStaleAsideWorktreeDir(cleanPath, undefined, { repoKeysByProject: new Map() }); // the ORIGINAL, un-suffixed path
  check("(7) REFUSES a path whose basename doesn't match .stale-<ts>", outcome.outcome === "refused");
  check("(7) nothing was touched — the dir still exists", fs.existsSync(cleanPath));
  fs.rmSync(cleanPath, { recursive: true, force: true });
}

// --- (8) reclaimStaleAsideWorktreeDir refuses an out-of-WORKTREES_DIR path even with a stale-shaped basename ---
{
  const outsidePath = path.join(path.dirname(WORKTREES_DIR), `outside-swl.stale-1700000000004`);
  fs.mkdirSync(outsidePath, { recursive: true });
  const outcome = await reclaimStaleAsideWorktreeDir(outsidePath, undefined, { repoKeysByProject: new Map() });
  check("(8) REFUSES a stale-shaped basename sitting OUTSIDE WORKTREES_DIR", outcome.outcome === "refused");
  check("(8) nothing was touched", fs.existsSync(outsidePath));
  fs.rmSync(outsidePath, { recursive: true, force: true });
}

// --- (9) truncated-size measurement propagates honestly ---
{
  const proj = "projSwlG";
  const cleanPath = resolveWorktreePath(proj, "taskG-truncated");
  const stalePath = mkStaleAside(cleanPath, 1700000000005);
  const outcome = await reclaimStaleAsideWorktreeDir(stalePath, undefined, {
    measureSize: async () => ({ bytes: 42, truncated: true }),
    repoKeysByProject: new Map(),
  });
  check("(9) a truncated measurement propagates as sizeTruncated:true on the removed outcome", outcome.outcome === "removed" && outcome.sizeTruncated === true && outcome.bytesReclaimed === 42);
}

// --- (10) missing path ---
{
  const proj = "projSwlH";
  const neverCreated = `${resolveWorktreePath(proj, "taskH-missing")}.stale-1700000000006`;
  const outcome = await reclaimStaleAsideWorktreeDir(neverCreated, undefined, { repoKeysByProject: new Map() });
  check("(10) a stale-shaped path that never existed on disk reports missing", outcome.outcome === "missing");
}

// --- (19) card e3fcd8ea item 1: repoKeysByProject is REQUIRED — omitting it (or the whole `deps` arg)
// refuses, never silently skipping the independent registry-axis guard ---
{
  const proj = "projSwlRequiredRegistry";
  const cleanPath = resolveWorktreePath(proj, "taskRequired");
  const stalePath = mkStaleAside(cleanPath, 1700000000007);
  const outcome = await reclaimStaleAsideWorktreeDir(stalePath, undefined, {});
  check("(19) a deps object with repoKeysByProject MISSING REFUSES rather than silently skipping the registry-axis guard", outcome.outcome === "refused");
  check("(19) reason names the missing repoKeysByProject", /repoKeysByProject/.test(outcome.reason ?? ""));
  check("(19) nothing was touched", fs.existsSync(stalePath));
  fs.rmSync(stalePath, { recursive: true, force: true });

  // (19b) the `deps?.` optional-chaining path: `deps` itself omitted entirely (a 2-arg call), never just
  // an empty object — proves the runtime fail-closed check tolerates a caller passing fewer args than the
  // signature declares, not only one that passes `{}`.
  const cleanPath2 = resolveWorktreePath(proj, "taskRequired2");
  const stalePath2 = mkStaleAside(cleanPath2, 1700000000008);
  const outcome2 = await reclaimStaleAsideWorktreeDir(stalePath2, undefined);
  check("(19b) omitting the whole `deps` argument ALSO refuses (the deps?. undefined path)", outcome2.outcome === "refused");
  check("(19b) nothing was touched", fs.existsSync(stalePath2));
  fs.rmSync(stalePath2, { recursive: true, force: true });
}

// ================================================================================================
// PART 2 — Db + SessionService
// ================================================================================================
const now = new Date().toISOString();
const db = new Db(path.join(process.env.LOOM_HOME, "loom.db"));
db.insertProject({ id: "projSwlSvc", name: "SWL Service Project", repoPath: process.env.LOOM_HOME, vaultPath: process.env.LOOM_HOME, config: {}, createdAt: now, archivedAt: null, reserved: false });

try {
  // --- (11) listStaleWorktreeLeftovers aggregation ---
  {
    const cleanPath = resolveWorktreePath("projSwlSvc", "taskSvc-listing");
    const stalePath = mkStaleAside(cleanPath, 1700000000010);
    const sessions = new SessionService(db, {}, new OrchestrationControl());
    const listing = await sessions.listStaleWorktreeLeftovers();
    const hit = listing.entries.find((e) => e.path === stalePath);
    check("(11) listStaleWorktreeLeftovers finds the seeded leftover", !!hit);
    check("(11) projectName is resolved via db.getProject", hit?.projectName === "SWL Service Project");
    check("(11) bytes is a measured non-negative number", typeof hit?.bytes === "number" && hit.bytes >= 0);
    check("(11) count/totalBytes are consistent with entries", listing.count === listing.entries.length && listing.totalBytes === listing.entries.reduce((a, e) => a + e.bytes, 0));
    fs.rmSync(stalePath, { recursive: true, force: true });
  }

  // --- (12) reclaimStaleWorktreeLeftover re-derives fresh (TOCTOU) — refuses a never-existed path ---
  {
    const sessions = new SessionService(db, {}, new OrchestrationControl());
    const neverExisted = `${resolveWorktreePath("projSwlSvc", "taskSvc-toctou")}.stale-1700000000011`;
    const outcome = await sessions.reclaimStaleWorktreeLeftover(neverExisted);
    check("(12) a path absent from a fresh re-derivation is refused, never force-deleted", outcome.outcome === "refused");
  }

  // --- (13) case / trailing-separator-insensitive matching (manager review note 2) ---
  {
    const cleanPath = resolveWorktreePath("projSwlSvc", "taskSvc-caseinsensitive");
    const stalePath = mkStaleAside(cleanPath, 1700000000012);
    const sessions = new SessionService(db, {}, new OrchestrationControl());
    const withTrailingSep = stalePath + path.sep;
    const outcome = await sessions.reclaimStaleWorktreeLeftover(withTrailingSep);
    check("(13) a path differing only by a trailing separator still matches and reclaims", outcome.outcome === "removed");
    check("(13) the real dir is actually gone", !fs.existsSync(stalePath));
  }
  if (process.platform === "win32") {
    const cleanPath = resolveWorktreePath("projSwlSvc", "taskSvc-caseinsensitive-win32");
    const stalePath = mkStaleAside(cleanPath, 1700000000013);
    const sessions = new SessionService(db, {}, new OrchestrationControl());
    const upperCased = stalePath.toUpperCase();
    const outcome = await sessions.reclaimStaleWorktreeLeftover(upperCased);
    check("(13-win32) a path differing only by CASE still matches and reclaims (win32 case-insensitivity)", outcome.outcome === "removed");
    check("(13-win32) the real dir is actually gone", !fs.existsSync(stalePath));
  } else {
    console.log("SKIP  (13-win32) case-insensitive matching is a win32-only guarantee (normForCompare only lowercases on win32) — not exercised on this platform.");
  }

  // --- (14) defensive no-live-claimant refusal ---
  {
    const cleanPath = resolveWorktreePath("projSwlSvc", "taskSvc-claimant");
    const stalePath = mkStaleAside(cleanPath, 1700000000014);
    db.insertAgent({ id: "agentSwlClaimant", projectId: "projSwlSvc", name: "Claimant", startupPrompt: "", position: 0, profileId: null });
    db.insertSession({
      id: "sessSwlClaimant", projectId: "projSwlSvc", agentId: "agentSwlClaimant", engineSessionId: null, title: null, cwd: stalePath,
      processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
      role: "worker", worktreePath: stalePath,
    });
    const sessions = new SessionService(db, {}, new OrchestrationControl());
    const outcome = await sessions.reclaimStaleWorktreeLeftover(stalePath);
    check("(14) a path artificially claimed by a live session row is REFUSED (defensive, structurally shouldn't happen)", outcome.outcome === "refused");
    check("(14) the dir was NOT touched", fs.existsSync(stalePath));
    fs.rmSync(stalePath, { recursive: true, force: true });
  }

  // --- (15) process-reap is invoked scoped to the exact path ---
  {
    const cleanPath = resolveWorktreePath("projSwlSvc", "taskSvc-reap");
    const stalePath = mkStaleAside(cleanPath, 1700000000015);
    const reapCalls = [];
    const sessions = new SessionService(db, {}, new OrchestrationControl(), {
      reapWorktreeProcesses: async (p) => { reapCalls.push(p); return { killedPids: [] }; },
    });
    const outcome = await sessions.reclaimStaleWorktreeLeftover(stalePath);
    check("(15) reap was invoked exactly once", reapCalls.length === 1);
    check("(15) reap was scoped to the EXACT stale path (never a bare image name/port)", reapCalls[0] === stalePath);
    check("(15) removal still succeeded", outcome.outcome === "removed");
  }

  // --- (16) buildServedStatus's count-only staleWorktreeLeftovers field ---
  {
    const dbClean = new Db(path.join(process.env.LOOM_HOME, "loom-clean.db"));
    const cleanStatus = buildServedStatus(dbClean);
    check("(16) a clean host (no leftovers under this fresh WORKTREES_DIR tree) reports count:0", cleanStatus.staleWorktreeLeftovers.count === 0);
    check("(16) and oldestStaleSinceMs:null", cleanStatus.staleWorktreeLeftovers.oldestStaleSinceMs === null);
    dbClean.close();

    const cleanPath = resolveWorktreePath("projSwlSvc", "taskSvc-servedstatus");
    const stalePath = mkStaleAside(cleanPath, 1700000000016);
    const status = buildServedStatus(db);
    check("(16) served_status's field is COUNT-ONLY (no byte total) — no bytes/totalBytes key present", !("bytes" in status.staleWorktreeLeftovers) && !("totalBytes" in status.staleWorktreeLeftovers));
    check("(16) count reflects the seeded leftover", status.staleWorktreeLeftovers.count >= 1);
    check("(16) oldestStaleSinceMs is the minimum staleSinceMs across every leftover currently on disk", status.staleWorktreeLeftovers.oldestStaleSinceMs <= 1700000000016);
    fs.rmSync(stalePath, { recursive: true, force: true });
  }

  // --- (16b) MINOR FIX (Code Review b674e1fb): buildServedStatus's registry-read catch is narrowed to
  //     the STUB case (missing listAllProjects/listArchivedProjects) — a REAL error from those methods
  //     now warns instead of vanishing silently, and a partial test stub still degrades quietly.
  {
    const realWarn = console.warn;
    const warns = [];
    console.warn = (...a) => { warns.push(a.join(" ")); };
    try {
      const stubMissingBoth = { listAllSessions: () => [] };
      buildServedStatus(stubMissingBoth);
      check("(16b) a stub missing both registry methods degrades SILENTLY — no warn", warns.length === 0);

      const stubThrows = {
        listAllSessions: () => [],
        listAllProjects: () => { throw new Error("boom-real-db-error"); },
        listArchivedProjects: () => [],
      };
      const statusThrown = buildServedStatus(stubThrows);
      check("(16b) a REAL error from a present registry method now WARNS instead of being silently swallowed", warns.some((w) => w.includes("[served-status]") && w.includes("boom-real-db-error")));
      check("(16b) and buildServedStatus still returns (degrades to primary-axis-only) rather than throwing", typeof statusThrown.staleWorktreeLeftovers?.count === "number");
    } finally {
      console.warn = realWarn;
    }
  }

  // --- (17b) MAJOR FIX, via the REST-facing SessionService surface: a registered repoKey shaped like a
  //     renamed-aside leftover, with a LIVE worktree underneath, is never listed by
  //     listStaleWorktreeLeftovers, and reclaimStaleWorktreeLeftover (the POST path) refuses it, leaving
  //     the live worktree intact. Same proven case as (17) above, through the human-facing methods.
  {
    const dangerousRepoKey = "svc.stale-2";
    db.updateProject("projSwlSvc", { repos: [{ key: dangerousRepoKey, path: process.env.LOOM_HOME }] });
    const axisPath = path.join(WORKTREES_DIR, "projSwlSvc", dangerousRepoKey);
    const liveWorktreePath = resolveWorktreePath("projSwlSvc", "taskSvcMajor-live", dangerousRepoKey);
    fs.mkdirSync(liveWorktreePath, { recursive: true });
    fs.writeFileSync(path.join(liveWorktreePath, "package.json"), "{}\n");

    const sessions = new SessionService(db, {}, new OrchestrationControl());
    const listing = await sessions.listStaleWorktreeLeftovers();
    check("(17b) MAJOR FIX: listStaleWorktreeLeftovers never lists the axis dir", !listing.entries.find((e) => e.path === axisPath));

    const outcome = await sessions.reclaimStaleWorktreeLeftover(axisPath);
    check("(17b) MAJOR FIX: reclaimStaleWorktreeLeftover REFUSES the axis dir", outcome.outcome === "refused");
    check("(17b) MAJOR FIX: the live worktree under it is untouched", fs.existsSync(liveWorktreePath) && fs.existsSync(path.join(liveWorktreePath, "package.json")));

    fs.rmSync(liveWorktreePath, { recursive: true, force: true });
    fs.rmSync(axisPath, { recursive: true, force: true });
    db.updateProject("projSwlSvc", { repos: [] });
  }
} finally {
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — renamed-aside stale worktree dirs are enumerated cheaply (byte-free, registry-driven, never matching a live worktree), reclaimed one-by-path with gcWorktreeDir's own guards (fresh re-derivation, case/separator-insensitive matching, a defensive no-live-claimant check, exact-path process-reap), and served_status carries a count-only signal."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
