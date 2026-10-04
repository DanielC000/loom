import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 5dff8d08 — the SECURITY-highest-priority call site: index.ts's `getPlatformHomePaths` feeds
// LOOM_HOME_INSTRUCTION_WRITE_DENY_REGISTRY (pty/loom-home-deny.ts), the per-spawn deny list that blocks a
// worker from overwriting CLAUDE.local.md/.claude/rules/AGENTS.md etc. at the reserved Platform home's own
// root. Before this card, the function (then inline in index.ts) resolved the home via
// `db.getReservedProjectByName(PLATFORM_PROJECT_NAME)` — a human rename of the home via
// PATCH /api/projects/:id (allowed — only repoPath rebind/archive/delete are refused for p.reserved) made
// that lookup return undefined, silently emptying `repoPaths`/`vaultPath` and turning the deny registry
// into a no-op for that home, with no error anywhere.
//
// The fix extracts the exact function body (now `getPlatformHomePaths` in platform/seed.ts, card 5dff8d08)
// so it is unit-testable without booting the whole daemon, and resolves the home via `resolvePlatformHome`
// (the stable app_meta id marker, card a47dd144) instead of a raw name lookup.
//
// Proves:
//   (1) before any rename: repoPaths/vaultPath cover the home's repoPath + any live platform-role cwd.
//   (2) AFTER a human rename of the reserved home: getPlatformHomePaths STILL resolves it — repoPaths and
//       vaultPath are UNCHANGED from before the rename (not emptied).
//   (3) FIXTURE SANITY CHECK: a raw `db.getReservedProjectByName(PLATFORM_PROJECT_NAME)` call — the exact
//       pre-fix mechanism, called directly here (not via any production code path) — returns undefined
//       after the SAME rename, confirming the fixture genuinely reproduces the bug this card fixes (the
//       old mechanism would have turned the deny registry into a silent no-op for the renamed home).
//   (4) no reserved platform home at all → {repoPaths:[], vaultPath:null} (unchanged no-op shape).
//   (5) card 5dff8d08 CR round 2 — THE RENAME-COLLISION HOLE: renaming the "Loom Platform" home to EITHER
//       of the setup home's own names ("Platform" or "Getting Started") used to make
//       resolveReservedHomeByMarker's name-collision check reject the platform home's own VALID,
//       non-id-colliding marker, falling through to a name search that can no longer find it (it was just
//       renamed away from PLATFORM_PROJECT_NAME) — emptying the deny registry exactly like the original
//       bug, just via a different trigger. RED on commit edd44849 (the previous round of this card).
//   (6) card 5dff8d08 CR round 2 — ARCHIVE EXCLUSION PIN: archiving the (correctly marked, unrenamed)
//       platform home must make getPlatformHomePaths (which is LIVE-only, resolveLivePlatformHome) treat
//       it as absent. (The OTHER half — the raw, archive-INCLUSIVE marker resolver still resolving the
//       same archived row, needed by the seeder's own idempotency gate — is already pinned by
//       setup-home.mjs's (13b); resolvePlatformHome is module-private again, so it isn't re-proven here.)
//   (7) card 5dff8d08 CR round 3 — THE BLOCKING BUG: on a LOOM_DEV-OFF install (every loomctl user, the
//       default), the platform marker is NEVER stamped. Renaming the SETUP home to "Loom Platform" used
//       to (a) break setup resolution (the old name-collision check rejected setup's own valid marker)
//       AND (b) make resolvePlatformHome's name fallback find the renamed SETUP home and WRONGLY STAMP
//       platform.homeProjectId onto it — so both markers ended up on one id, the next boot minted a
//       DUPLICATE setup home, and enabling LOOM_DEV later could never seed the real platform home. RED on
//       commit 0937e3cc.
//   (8) the LOOM_DEV-ON mirror of (7) — both homes already seeded/marked before the rename, confirming
//       the SAME rename causes no cross-contamination when both markers are already stamped.
//   (9) P5 (round 4) — round 3's fix (reject on a bare distinct-candidate match) was ITSELF too broad: a
//       LIVE stale duplicate/orphan row happening to carry one of setup's own candidate names made the
//       resolver abandon a correctly-marked, merely-renamed setup home and flip onto the orphan instead.
//       Now requires BOTH the marked row looking like the other home's name AND a distinct LIVE candidate.
//   (10) P5b — the archived-orphan mirror of (9): an archived orphan must never count as "distinct"
//        evidence either, or the setup home appears to "vanish" (resolves to the archived orphan, which
//        resolveLiveSetupHome then correctly filters out, reading as absent).
//
// Run: 1) build (turbo builds shared first), 2) node test/platform-home-paths-rename.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-plat-paths-rename-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_DEV = "1"; // the platform home is dev-gated; this test exercises it directly via the db
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { seedDefaultProfiles } = await import("../dist/profiles/seed.js");
const { seedPlatformHome, getPlatformHomePaths, PLATFORM_PROJECT_NAME } = await import("../dist/platform/seed.js");
const { seedSetupHome, resolveLiveSetupHome, SETUP_PROJECT_NAME, LEGACY_SETUP_PROJECT_NAME } = await import("../dist/setup/seed.js");
const { PLATFORM_HOME_PROJECT_ID_KEY, SETUP_HOME_PROJECT_ID_KEY } = await import("../dist/projects/reserved-home-markers.js");

try {
  // ===== (1) baseline: repoPaths/vaultPath resolve correctly before any rename =====
  const db = new Db(path.join(tmpHome, "loom.db"));
  seedDefaultProfiles(db);
  seedPlatformHome(db);
  const home = db.listAllProjects().find((p) => p.reserved && p.name === PLATFORM_PROJECT_NAME);
  check("(1) the platform home seeded", !!home);

  const before = getPlatformHomePaths(db);
  check("(1) baseline repoPaths includes the home's own repoPath", before.repoPaths.includes(home.repoPath));
  check("(1) baseline vaultPath is the home's own vaultPath", before.vaultPath === home.vaultPath);

  // A live platform-role session with a DIFFERENT cwd (a rebound home scenario) must also be unioned in —
  // proves the fix didn't drop the liveCwds union when it extracted the function.
  const now = new Date().toISOString();
  db.insertAgent({ id: "leadAgent", projectId: home.id, name: "Extra Lead", startupPrompt: "x", position: 9, profileId: null });
  const otherCwd = path.join(tmpHome, "rebound-cwd");
  db.insertSession({
    id: "leadSess", projectId: home.id, agentId: "leadAgent", engineSessionId: null, title: null, cwd: otherCwd,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: "platform", parentSessionId: null,
  });
  const withLiveCwd = getPlatformHomePaths(db);
  check("(1) a live platform-role session's cwd is unioned into repoPaths", withLiveCwd.repoPaths.includes(otherCwd));
  check("(1) the home's own repoPath is still present alongside the live cwd", withLiveCwd.repoPaths.includes(home.repoPath));

  // ===== (2) THE FIX: rename the reserved home via the same write path PATCH /api/projects/:id uses =====
  const RENAMED = "My Renamed Platform Home";
  db.updateProject(home.id, { name: RENAMED });
  check("(2) the home is genuinely renamed in the db", db.getProject(home.id)?.name === RENAMED);

  const after = getPlatformHomePaths(db);
  check("(2) AFTER the rename, getPlatformHomePaths STILL resolves the SAME home (repoPaths unchanged)",
    after.repoPaths.includes(home.repoPath) && after.repoPaths.includes(otherCwd));
  check("(2) AFTER the rename, vaultPath is STILL the home's own vaultPath (not emptied)",
    after.vaultPath === home.vaultPath);
  check("(2) repoPaths is byte-identical before vs after the rename (nothing silently dropped)",
    JSON.stringify([...withLiveCwd.repoPaths].sort()) === JSON.stringify([...after.repoPaths].sort()));

  // ===== (3) FIXTURE SANITY CHECK: the raw pre-fix mechanism, called directly (never via production code),
  //      genuinely goes blind after the SAME rename — confirms the fixture reproduces the real bug =====
  const oldMechanismResult = db.getReservedProjectByName(PLATFORM_PROJECT_NAME);
  check("(3) fixture sanity: the raw pre-fix name lookup (called directly here) returns undefined after " +
    "the rename — confirms this fixture genuinely reproduces the bug the fix addresses",
    oldMechanismResult === undefined);

  db.close();

  // ===== (4) no reserved platform home at all → safe no-op shape =====
  const db2 = new Db(path.join(tmpHome, "loom-empty.db"));
  const empty = getPlatformHomePaths(db2);
  check("(4) no platform home → {repoPaths:[], vaultPath:null}",
    Array.isArray(empty.repoPaths) && empty.repoPaths.length === 0 && empty.vaultPath === null);
  db2.close();

  // ===== (5) THE RENAME-COLLISION HOLE (CR round 2) — rename "Loom Platform" to one of the SETUP home's
  //      OWN names. Both homes are seeded+marked first (mirrors real boot order) so this isolates the
  //      collision check itself, not a missing-marker fallback. =====
  for (const collisionName of [SETUP_PROJECT_NAME, LEGACY_SETUP_PROJECT_NAME]) {
    const db5 = new Db(path.join(tmpHome, `loom-collision-${collisionName.replace(/\s+/g, "_")}.db`));
    seedDefaultProfiles(db5);
    seedSetupHome(db5);    // stamps the SETUP marker first
    seedPlatformHome(db5); // stamps the PLATFORM marker — both now marked, mirroring real boot
    const plat5 = db5.listAllProjects().find((p) => p.reserved && p.name === PLATFORM_PROJECT_NAME);
    check(`(5 setup "${collisionName}") the platform marker is stamped to its own home`,
      db5.getMeta(PLATFORM_HOME_PROJECT_ID_KEY) === plat5.id);

    // A live platform-role session with a DISTINCT cwd (mirrors §1) — so the post-rename assertion below
    // can tell the PLATFORM home's own result apart from the setup home's (which has no such session),
    // rather than a coincidentally-matching shape that could pass even if resolution landed on the wrong
    // home entirely.
    const now5 = new Date().toISOString();
    db5.insertAgent({ id: `leadAgent5-${collisionName.replace(/\s+/g, "_")}`, projectId: plat5.id, name: "Extra Lead", startupPrompt: "x", position: 9, profileId: null });
    const otherCwd5 = path.join(tmpHome, `rebound-cwd-5-${collisionName.replace(/\s+/g, "_")}`);
    db5.insertSession({
      id: `leadSess5-${collisionName.replace(/\s+/g, "_")}`, projectId: plat5.id, agentId: `leadAgent5-${collisionName.replace(/\s+/g, "_")}`,
      engineSessionId: null, title: null, cwd: otherCwd5, processState: "live", resumability: "unknown",
      busy: false, createdAt: now5, lastActivity: now5, lastError: null, role: "platform", parentSessionId: null,
    });

    const before5 = getPlatformHomePaths(db5);
    check(`(5 setup "${collisionName}") baseline repoPaths cover the platform home before the rename`,
      before5.repoPaths.includes(plat5.repoPath));
    check(`(5 setup "${collisionName}") baseline repoPaths also cover the live platform-role session's distinct cwd`,
      before5.repoPaths.includes(otherCwd5));

    // The human rename — overlap the platform home's name with the setup home's OWN name/legacy name.
    db5.updateProject(plat5.id, { name: collisionName });
    check(`(5 "${collisionName}") the platform home is genuinely renamed to the setup home's own name`,
      db5.getProject(plat5.id)?.name === collisionName);

    const after5 = getPlatformHomePaths(db5);
    check(`(5 "${collisionName}") getPlatformHomePaths STILL covers the SAME platform home after the ` +
      "name-collision rename (the marker's own id doesn't collide with the setup marker's id)",
      after5.repoPaths.includes(plat5.repoPath) && after5.vaultPath === plat5.vaultPath);
    check(`(5 "${collisionName}") repoPaths STILL carries the platform home's OWN distinct live-session ` +
      "cwd — proves this resolved the platform home itself, not the (also-reserved, now-same-named) setup home",
      after5.repoPaths.includes(otherCwd5));
    check(`(5 "${collisionName}") the marker is UNCHANGED — still the platform home's own id, never ` +
      "re-derived to the setup home just because the name now matches it",
      db5.getMeta(PLATFORM_HOME_PROJECT_ID_KEY) === plat5.id);
    db5.close();
  }

  // ===== (6) ARCHIVE EXCLUSION PIN (CR round 2) — archiving the (correctly marked, unrenamed) platform
  //      home: the LIVE-only resolver/feed must treat it as absent. (The archive-INCLUSIVE half — the raw
  //      marker resolver, needed by the seeder's own idempotency gate, still resolving the same archived
  //      row — is already pinned by setup-home.mjs's (13b), via seedPlatformHome's own no-op-on-archived
  //      behavior; not re-proven here since resolvePlatformHome is module-private again.) =====
  const db6 = new Db(path.join(tmpHome, "loom-archive-pin.db"));
  seedDefaultProfiles(db6);
  seedPlatformHome(db6);
  const plat6 = db6.listAllProjects().find((p) => p.reserved && p.name === PLATFORM_PROJECT_NAME);
  check("(6 setup) the platform marker is stamped to its own home", db6.getMeta(PLATFORM_HOME_PROJECT_ID_KEY) === plat6.id);

  db6.archiveProject(plat6.id); // not reachable via any real write surface today — a direct db manipulation
  check("(6 setup) the home is genuinely archived", !!db6.getProject(plat6.id)?.archivedAt);

  const archivedViaLive = getPlatformHomePaths(db6);
  check("(6) getPlatformHomePaths (LIVE-only, via resolveLivePlatformHome) treats the archived home as " +
    "ABSENT — {repoPaths:[], vaultPath:null}, exactly like the pre-fix archive-exclusive name lookup did",
    archivedViaLive.repoPaths.length === 0 && archivedViaLive.vaultPath === null);
  db6.close();

  // ===== (7) card 5dff8d08 round 3 — THE BLOCKING BUG, LOOM_DEV OFF (the default for every loomctl user):
  //      the platform marker is NEVER stamped. Renaming the SETUP home to "Loom Platform" must NOT break
  //      setup resolution, must NOT stamp the platform marker onto the setup home's id, and a reboot's
  //      seedSetupHome must still correctly no-op (never mint a duplicate). RED on commit 0937e3cc. =====
  delete process.env.LOOM_DEV;
  const db7 = new Db(path.join(tmpHome, "loom-devoff-rename.db"));
  seedDefaultProfiles(db7);
  const seeded7 = seedSetupHome(db7);
  check("(7 setup) LOOM_DEV off: the setup home seeds", seeded7.length > 0);
  check("(7 setup) LOOM_DEV off: exactly ONE reserved project exists", db7.listAllProjects().filter((p) => p.reserved).length === 1);
  const setup7 = db7.listAllProjects().find((p) => p.reserved);
  check("(7 setup) the setup marker is stamped to its own home", db7.getMeta(SETUP_HOME_PROJECT_ID_KEY) === setup7.id);
  check("(7 setup) the platform marker is NOT stamped (LOOM_DEV off — seedPlatformHome never ran)",
    db7.getMeta(PLATFORM_HOME_PROJECT_ID_KEY) === undefined);

  db7.updateProject(setup7.id, { name: PLATFORM_PROJECT_NAME }); // the human rename that triggers the bug
  check("(7) the setup home is genuinely renamed to 'Loom Platform'", db7.getProject(setup7.id)?.name === PLATFORM_PROJECT_NAME);

  check("(7) resolveLiveSetupHome STILL resolves the renamed setup home (setup resolution is not broken)",
    resolveLiveSetupHome(db7)?.id === setup7.id);
  const paths7 = getPlatformHomePaths(db7);
  check("(7) getPlatformHomePaths stays {[],null} — the platform marker must NOT get stamped onto the renamed setup home",
    paths7.repoPaths.length === 0 && paths7.vaultPath === null);
  check("(7) the platform marker is STILL unset after the above calls (never backfilled onto the setup home's id)",
    db7.getMeta(PLATFORM_HOME_PROJECT_ID_KEY) === undefined);

  // A reboot: seedSetupHome must still correctly recognize the (renamed) home exists and no-op.
  const reseed7 = seedSetupHome(db7);
  check("(7) a reboot's seedSetupHome returns [] (no duplicate minted)", reseed7.length === 0);
  check("(7) still exactly ONE reserved project after the reboot re-seed", db7.listAllProjects().filter((p) => p.reserved).length === 1);
  db7.close();

  // ===== (8) the LOOM_DEV-ON mirror of (7) — both homes already seeded/marked before the SAME rename =====
  process.env.LOOM_DEV = "1";
  const db8 = new Db(path.join(tmpHome, "loom-devon-rename.db"));
  seedDefaultProfiles(db8);
  seedSetupHome(db8);
  seedPlatformHome(db8);
  const setup8 = db8.listAllProjects().find((p) => p.reserved && p.name === SETUP_PROJECT_NAME);
  const plat8 = db8.listAllProjects().find((p) => p.reserved && p.name === PLATFORM_PROJECT_NAME);
  check("(8 setup) both homes seeded, each with its OWN stamped marker",
    db8.getMeta(SETUP_HOME_PROJECT_ID_KEY) === setup8.id && db8.getMeta(PLATFORM_HOME_PROJECT_ID_KEY) === plat8.id);

  db8.updateProject(setup8.id, { name: PLATFORM_PROJECT_NAME }); // the SAME rename, but now otherId is defined
  check("(8) the setup home is genuinely renamed to 'Loom Platform'", db8.getProject(setup8.id)?.name === PLATFORM_PROJECT_NAME);

  check("(8) resolveLiveSetupHome STILL resolves the renamed setup home", resolveLiveSetupHome(db8)?.id === setup8.id);
  const paths8 = getPlatformHomePaths(db8);
  check("(8) getPlatformHomePaths STILL covers the REAL platform home (unaffected by setup's rename)",
    paths8.repoPaths.includes(plat8.repoPath) && paths8.vaultPath === plat8.vaultPath);
  check("(8) the platform marker is UNCHANGED — still plat8's own id, never re-derived to the renamed setup home",
    db8.getMeta(PLATFORM_HOME_PROJECT_ID_KEY) === plat8.id);

  const reseed8setup = seedSetupHome(db8);
  const reseed8plat = seedPlatformHome(db8);
  check("(8) reboot: both seeders still no-op (no duplicates minted)", reseed8setup.length === 0 && reseed8plat.length === 0);
  check("(8) still exactly TWO reserved projects after the reboot re-seed", db8.listAllProjects().filter((p) => p.reserved).length === 2);
  db8.close();

  // ===== (9) P5 — card 5dff8d08 round 4: a single name-overlap signal alone is not enough. A LIVE stale
  //      duplicate/orphan reserved row happening to carry one of setup's OWN candidate names must NOT make
  //      the resolver abandon a correctly-marked, merely-renamed setup home and flip onto the orphan
  //      instead. RED on commit e10122b5 (round 3's fix — single-signal distinct-candidate check). =====
  delete process.env.LOOM_DEV;
  const db9 = new Db(path.join(tmpHome, "loom-p5-live-orphan.db"));
  seedDefaultProfiles(db9);
  seedSetupHome(db9);
  const setup9 = db9.listAllProjects().find((p) => p.reserved);
  check("(9 setup) the setup home seeded + marked", db9.getMeta(SETUP_HOME_PROJECT_ID_KEY) === setup9.id);
  const now9 = new Date().toISOString();
  const orphan9 = "p5-live-orphan";
  db9.insertProject({ id: orphan9, name: LEGACY_SETUP_PROJECT_NAME, repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now9, archivedAt: null, reserved: true });
  check("(9 setup) a LIVE stale orphan reserved row exists, named setup's OWN legacy candidate",
    db9.getProject(orphan9)?.reserved === true && !db9.getProject(orphan9)?.archivedAt);

  db9.updateProject(setup9.id, { name: PLATFORM_PROJECT_NAME }); // the §7 trigger: rename to overlap platform's name
  check("(9) the setup home is genuinely renamed to 'Loom Platform'", db9.getProject(setup9.id)?.name === PLATFORM_PROJECT_NAME);

  check("(9) P5: resolveLiveSetupHome STILL resolves the SAME marked (renamed) home, NOT the live orphan",
    resolveLiveSetupHome(db9)?.id === setup9.id);
  check("(9) P5: the setup marker is UNCHANGED — never re-stamped onto the live orphan's id",
    db9.getMeta(SETUP_HOME_PROJECT_ID_KEY) === setup9.id);
  check("(9) P5: the live orphan gets NO marker of its own (never adopted as a reserved home)",
    db9.getMeta(SETUP_HOME_PROJECT_ID_KEY) !== orphan9);
  db9.close();

  // ===== (10) P5b — the archived-orphan mirror: an ARCHIVED orphan matching one of setup's own candidate
  //       names must NEVER count as "distinct real evidence" either — it must never make the setup home
  //       "vanish" (resolve to the archived orphan, which resolveLiveSetupHome then filters out as archived,
  //       reading as absent). RED on commit e10122b5. =====
  const db10 = new Db(path.join(tmpHome, "loom-p5b-archived-orphan.db"));
  seedDefaultProfiles(db10);
  seedSetupHome(db10);
  const setup10 = db10.listAllProjects().find((p) => p.reserved);
  check("(10 setup) the setup home seeded + marked", db10.getMeta(SETUP_HOME_PROJECT_ID_KEY) === setup10.id);
  const now10 = new Date().toISOString();
  const orphan10 = "p5b-archived-orphan";
  db10.insertProject({ id: orphan10, name: SETUP_PROJECT_NAME, repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now10, archivedAt: now10, reserved: true });
  check("(10 setup) an ARCHIVED orphan reserved row exists, named setup's OWN current candidate",
    db10.getProject(orphan10)?.reserved === true && !!db10.getProject(orphan10)?.archivedAt);

  db10.updateProject(setup10.id, { name: PLATFORM_PROJECT_NAME }); // the §7 trigger again
  check("(10) the setup home is genuinely renamed to 'Loom Platform'", db10.getProject(setup10.id)?.name === PLATFORM_PROJECT_NAME);

  check("(10) P5b: resolveLiveSetupHome STILL resolves the SAME marked (renamed) home — it does NOT vanish",
    resolveLiveSetupHome(db10)?.id === setup10.id);
  check("(10) P5b: the setup marker is UNCHANGED — never re-stamped onto the archived orphan's id",
    db10.getMeta(SETUP_HOME_PROJECT_ID_KEY) === setup10.id);
  db10.close();
} finally {
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — getPlatformHomePaths (the LOOM_HOME_INSTRUCTION_WRITE_DENY_REGISTRY feed) resolves the " +
    "reserved platform home via the stable marker (resolveLivePlatformHome), so a human rename of the home " +
    "never silently empties the deny registry's repoPaths/vaultPath the way the pre-fix raw name lookup did — " +
    "including the CR round 2 rename-collision hole (renaming the platform home to the SETUP home's own " +
    "name/legacy name no longer un-trusts its valid, non-id-colliding marker, told apart from the setup home " +
    "by its own live-session cwd) — the archive-exclusion contract is pinned explicitly (LIVE-only resolution " +
    "treats an archived home as absent; the raw, seeder-facing resolver still finds it) — (CR round 3) on " +
    "a LOOM_DEV-off install, renaming the SETUP home to 'Loom Platform' no longer breaks setup resolution nor " +
    "wrongly backfills the platform marker onto the setup home's id (the dev-on mirror confirms no regression " +
    "when both homes are already marked) — and (CR round 4, P5/P5b) a bare name-overlap OR a bare distinct-" +
    "candidate signal is not enough on its own: a live or archived stale orphan sharing one of a home's own " +
    "candidate names can never flip resolution away from a correctly-marked, merely-renamed home."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
