import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// VaultVersioner WIRING test (P1 data-integrity gap): the auto-committer class was unit-tested in
// isolation but NEVER instantiated/started, so agent doc rewrites (plain Write/Edit, rewrite-in-place)
// accrued no git history and a destructive overwrite had no recovery path. This asserts the WIRING via
// the testable boot helper startVaultVersioners(db) — REAL git on temp vaults, NO claude, NO live daemon.
// Proves:
//   (a) a watcher IS constructed per project vault;
//   (b) a filesystem edit to a vault doc produces a git commit (the live chokidar→debounce→commit path);
//   (c) DEDUPE — two projects sharing one vaultPath get ONE watcher; empty/archived vaults are skipped;
//   (d) the SYNCHRONOUS flushSync (gracefulShutdown's path) commits a debounce-window edit; and respects
//       the externally-managed backoff (an Obsidian-Git-managed repo is NOT committed).
//   (e) ONE-REPO-MANY-SUBFOLDER layout: a project vault that is a SUBFOLDER of a PLAIN repo gets per-edit
//       auto-commit AT THE REPO ROOT, deduped across sibling project subfolders (two projects → subfolders
//       of one repo → ONE root watcher); and an Obsidian-Git-managed repo (marker present) backs off.
// Run after build: node test/vault-versioner-wiring.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { simpleGit } from "simple-git";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-vv-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const {
  startVaultVersioners, VaultVersioner,
  gitignoredTopLevelNames, safeToExcludeNames, buildIgnoredMatcher,
} = await import("../dist/vault/versioner.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// realpath so paths match `git rev-parse --show-toplevel` (symlinked tmp on macOS, drive-letter case on
// Windows) — otherwise the start()/flushSync externally-managed check could misfire.
const root = fs.realpathSync(mkdtempManaged("loom-vv-"));
const git = (cwd, args) => execSync(`git ${args}`, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
function initVault(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init");
  git(dir, "config user.email loom-test@example.com");
  git(dir, "config user.name loom-test");
}
// Plant the `.obsidian/plugins/obsidian-git` marker dir under a repo root — the deterministic signal that
// a real external auto-committer (the Obsidian Git plugin) owns this repo's history, so loom must back off.
function plantObsidianGitMarker(repoRoot) {
  fs.mkdirSync(path.join(repoRoot, ".obsidian", "plugins", "obsidian-git"), { recursive: true });
}
// `git rev-list --all --count` is 0 (clean exit) on a fresh repo with no commits — unlike `git log`.
const commitCount = (dir) => parseInt(git(dir, "rev-list --all --count").trim() || "0", 10);
// Retrofitted onto the shared _wait.mjs waitUntil (card 24d2e0ac): same timeoutMs/50ms-interval budget,
// still returns true/false — a thrown predicate is a real bug and should propagate, not fold into false.
async function waitFor(fn, timeoutMs = 5000) {
  try {
    return await sharedWaitUntil(fn, { timeoutMs, intervalMs: 50, label: "vault-versioner-wiring: fn" });
  } catch (err) {
    if (!/waitUntil: timed out/.test(err?.message ?? "")) throw err;
    return false;
  }
}

const vaultA = path.join(root, "vaultA");
const vaultB = path.join(root, "vaultB");
initVault(vaultA);
initVault(vaultB);

// ONE-REPO-MANY-SUBFOLDER (the owner's real layout): a single PLAIN git repo at the vault root, with each
// project's vaultPath a SUBFOLDER. plainProjA + plainProjB are sibling subfolders of `plainRepo` — they
// must collapse to ONE watcher keyed to the repo ROOT and auto-commit there.
const plainRepo = path.join(root, "plainRepo");
initVault(plainRepo);
const plainProjA = path.join(plainRepo, "ProjA");
const plainProjB = path.join(plainRepo, "ProjB");
fs.mkdirSync(plainProjA);
fs.mkdirSync(plainProjB);

// OBSIDIAN-GIT-MANAGED repo: a real external auto-committer owns history (marker present) → loom backs off
// (no watcher, no commit). obsVault is a subfolder of the marked repo root.
const obsRepo = path.join(root, "obsRepo");
initVault(obsRepo);
plantObsidianGitMarker(obsRepo);
const obsVault = path.join(obsRepo, "ObsProj");
fs.mkdirSync(obsVault);

// OPERATIONAL/daemon-home vaults: Loom's own state dir is NOT a docs vault — watching one would stage the
// LIVE SQLite DB (loom.db) and thrash chokidar over worktrees/node_modules. startVaultVersioners must SKIP
// a vault that (a) contains a `loom.db` file, (b) contains a `worktrees/` dir, or (c) IS the daemon home
// (LOOM_HOME). Three projects, one per signal — all must be skipped (no watcher).
const opDb = path.join(root, "opDb");        // (a) contains a loom.db file
fs.mkdirSync(opDb);
fs.writeFileSync(path.join(opDb, "loom.db"), "");
const opWt = path.join(root, "opWt");        // (b) contains a worktrees/ dir
fs.mkdirSync(path.join(opWt, "worktrees"), { recursive: true });
const opHome = process.env.LOOM_HOME;        // (c) IS the daemon home (LOOM_HOME)

const now = new Date().toISOString();
const db = new Db();
// p1 + p2 SHARE vaultA (dedupe target); p3 → vaultB; p4 has NO vaultPath (skip); p5 is archived (skip).
db.insertProject({ id: "p1", name: "P1", repoPath: vaultA, vaultPath: vaultA, config: {}, createdAt: now, archivedAt: null });
db.insertProject({ id: "p2", name: "P2", repoPath: vaultA, vaultPath: vaultA, config: {}, createdAt: now, archivedAt: null });
db.insertProject({ id: "p3", name: "P3", repoPath: vaultB, vaultPath: vaultB, config: {}, createdAt: now, archivedAt: null });
db.insertProject({ id: "p4", name: "P4", repoPath: root, vaultPath: "", config: {}, createdAt: now, archivedAt: null });
db.insertProject({ id: "p5", name: "P5", repoPath: vaultB, vaultPath: path.join(root, "vaultArchived"), config: {}, createdAt: now, archivedAt: now });
// p6 + p7 → sibling subfolders of plainRepo: dedupe to ONE root watcher. p8 → Obsidian-Git-managed: skip.
db.insertProject({ id: "p6", name: "P6", repoPath: plainProjA, vaultPath: plainProjA, config: {}, createdAt: now, archivedAt: null });
db.insertProject({ id: "p7", name: "P7", repoPath: plainProjB, vaultPath: plainProjB, config: {}, createdAt: now, archivedAt: null });
db.insertProject({ id: "p8", name: "P8", repoPath: obsVault, vaultPath: obsVault, config: {}, createdAt: now, archivedAt: null });
// op1/op2/op3 → operational/daemon-home vaults: must be SKIPPED (no watcher) by the operational-vault guard.
db.insertProject({ id: "op1", name: "Op1", repoPath: opDb, vaultPath: opDb, config: {}, createdAt: now, archivedAt: null });
db.insertProject({ id: "op2", name: "Op2", repoPath: opWt, vaultPath: opWt, config: {}, createdAt: now, archivedAt: null });
db.insertProject({ id: "op3", name: "Op3", repoPath: opHome, vaultPath: opHome, config: {}, createdAt: now, archivedAt: null });
// ISOLATION (per-project guard): pBad's vaultPath points at a NON-EXISTENT dir, which makes
// simpleGit() throw inside resolveVaultRepoContext — a deterministic throw on resolve. listAllProjects
// is ORDER BY name, so naming pBad "ZZbad" < pGood "ZZgood" iterates the throwing project FIRST; the
// guard must isolate it so pGood's good vault (vaultD) STILL gets a watcher (one bad project must not
// poison the batch). vaultD is a fresh good repo.
const vaultD = path.join(root, "vaultD");
initVault(vaultD);
const badPath = path.join(root, "does-not-exist-throws-on-resolve");
db.insertProject({ id: "pBad", name: "ZZbad", repoPath: root, vaultPath: badPath, config: {}, createdAt: now, archivedAt: null });
db.insertProject({ id: "pGood", name: "ZZgood", repoPath: vaultD, vaultPath: vaultD, config: {}, createdAt: now, archivedAt: null });
// card 78dc99e3: a RELATIVE vaultPath (a legacy row from before the write-time absolute-path guard,
// validateVaultPath/card 96c4b245, existed) must be diagnosed loudly and SKIPPED — never handed to
// resolveVaultRepoContext/git init, where it would resolve against the daemon PROCESS's own cwd and
// either throw an opaque error or (worse) silently succeed against the wrong directory.
const pRel = path.join(root, "ZZrel"); // a real, distinct project so a caught bug can't hide as "no watcher anyway"
fs.mkdirSync(pRel, { recursive: true });
db.insertProject({ id: "pRel", name: "ZZrel", repoPath: pRel, vaultPath: "relative/not-a-real-path", config: {}, archivedAt: null, createdAt: now });

const versioners = [];
try {
  // Short debounce so the live chokidar path commits quickly for (b).
  const warningsBoot = [];
  const origWarnBoot = console.warn;
  console.warn = (...args) => { warningsBoot.push(args.join(" ")); origWarnBoot(...args); };
  let booted;
  try {
    booted = await startVaultVersioners(db, { debounceMs: 150 });
  } finally {
    console.warn = origWarnBoot;
  }
  versioners.push(...booted);
  check(
    "a relative vaultPath is named loudly and specifically (not left to an opaque downstream throw)",
    warningsBoot.some((w) => w.includes("[vault-versioner]") && w.includes("pRel") && w.includes("vaultPath is not absolute") && w.includes("relative/not-a-real-path")),
  );

  // (a)+(c)+(e): exactly 4 watchers — vaultA (deduped p1+p2) + vaultB + plainRepo ROOT (deduped p6+p7
  // subfolders) + vaultD (pGood, started DESPITE the earlier-iterating pBad throwing). Empty (p4),
  // archived (p5), Obsidian-Git-managed (p8), the operational/daemon-home vaults (op1 loom.db / op2
  // worktrees/ / op3 == LOOM_HOME), the throwing pBad, and the relative-vaultPath pRel are all skipped.
  check("one watcher per UNIQUE repo root (dedupe + skip empty/archived/obsidian-git/operational)", versioners.length === 4);
  check("each started handle is a VaultVersioner", versioners.every((v) => v instanceof VaultVersioner));

  // (b): a filesystem edit to a vault doc auto-commits via the wired chokidar→debounce→commit path.
  const beforeA = commitCount(vaultA);
  fs.writeFileSync(path.join(vaultA, "doc.md"), "# edited by an agent (rewrite-in-place)\n");
  check("a vault doc edit auto-commits via the live watcher", await waitFor(() => commitCount(vaultA) > beforeA));

  // ISOLATION: pBad (a throwing vaultPath) iterates BEFORE pGood (names sort ZZbad < ZZgood) — the
  // per-project guard isolates the throw so pGood's good vault still gets a LIVE watcher. Prove it via
  // the live chokidar→commit path: an edit to vaultD auto-commits, which only happens if its watcher
  // started despite the earlier throw. (count === 4 above already proves construction+start; this proves
  // the watcher is live.)
  const beforeD = commitCount(vaultD);
  fs.writeFileSync(path.join(vaultD, "doc.md"), "# good sibling after a throwing project\n");
  check("a throwing project does NOT poison the batch — the good sibling's watcher still started", await waitFor(() => commitCount(vaultD) > beforeD));

  // (e): an edit inside a SUBFOLDER of the plain repo auto-commits AT THE REPO ROOT (not the subfolder),
  // proving the subfolder→root keying + dedupe of the one-repo-many-subfolder layout.
  const beforePlain = commitCount(plainRepo);
  fs.writeFileSync(path.join(plainProjA, "note.md"), "# edited inside a project subfolder of a plain repo\n");
  check("a subfolder edit auto-commits at the PLAIN REPO ROOT", await waitFor(() => commitCount(plainRepo) > beforePlain));
  check("plainRepo subfolder commit lands at the root, not a nested repo", !fs.existsSync(path.join(plainProjA, ".git")));

  // (d): SYNCHRONOUS flush on stop — an edit inside the debounce window (long debounce → the async timer
  // can't have fired) is still committed by flushSync, the path gracefulShutdown uses before process.exit.
  const vaultC = path.join(root, "vaultC");
  initVault(vaultC);
  const vc = new VaultVersioner(vaultC, 10_000);
  await vc.start();
  fs.writeFileSync(path.join(vaultC, "urgent.md"), "edited just before shutdown\n");
  const beforeC = commitCount(vaultC);
  check("flushSync commits a debounce-window edit synchronously", vc.flushSync() === true && commitCount(vaultC) === beforeC + 1);
  check("flushSync is a no-op when nothing is staged", vc.flushSync() === false && commitCount(vaultC) === beforeC + 1);
  await vc.stop();

  // (d/e, subfolder of a PLAIN repo): a vault nested inside a LARGER plain repo (no Obsidian-Git marker)
  // is NOT externally managed — flushSync commits it AT THE REPO ROOT (per-edit history for the
  // one-repo-many-subfolder layout), not the subfolder.
  const plainOuter = path.join(root, "plainOuter");
  initVault(plainOuter);
  const plainNested = path.join(plainOuter, "vault");
  fs.mkdirSync(plainNested);
  const vp = new VaultVersioner(plainNested, 10_000);
  await vp.start();
  fs.writeFileSync(path.join(plainNested, "note.md"), "committed at the plain repo root\n");
  const beforePlainOuter = commitCount(plainOuter);
  check("flushSync commits a plain-repo subfolder at the root", vp.flushSync() === true && commitCount(plainOuter) === beforePlainOuter + 1);
  await vp.stop();

  // (d, backoff): a vault inside an Obsidian-Git-managed repo (the `.obsidian/plugins/obsidian-git` marker
  // is present at the root) is externally managed — flushSync must NOT commit it (a real external
  // auto-committer owns history; no double-commit). Detected by the MARKER, not "subfolder ≠ root".
  const obsOuter = path.join(root, "obsOuter");
  initVault(obsOuter);
  plantObsidianGitMarker(obsOuter);
  const obsNested = path.join(obsOuter, "vault");
  fs.mkdirSync(obsNested);
  const vn = new VaultVersioner(obsNested, 10_000);
  await vn.start();
  fs.writeFileSync(path.join(obsNested, "note.md"), "must NOT be committed by loom\n");
  const beforeObsOuter = commitCount(obsOuter);
  check("flushSync skips an Obsidian-Git-managed vault", vn.flushSync() === false);
  check("Obsidian-Git-managed vault got no loom commit", commitCount(obsOuter) === beforeObsOuter);
  await vn.stop();

  // (d, backoff at root): an Obsidian-Git-managed vault that IS its own repo root (marker at the vault
  // folder itself) also backs off — the marker, not the subfolder relationship, is what gates it.
  const obsOwnRoot = path.join(root, "obsOwnRoot");
  initVault(obsOwnRoot);
  plantObsidianGitMarker(obsOwnRoot);
  const vor = new VaultVersioner(obsOwnRoot, 10_000);
  await vor.start();
  fs.writeFileSync(path.join(obsOwnRoot, "note.md"), "must NOT be committed by loom\n");
  const beforeObsOwn = commitCount(obsOwnRoot);
  check("flushSync skips an Obsidian-Git-managed own-root vault", vor.flushSync() === false);
  check("Obsidian-Git-managed own-root vault got no loom commit", commitCount(obsOwnRoot) === beforeObsOwn);
  await vor.stop();

  // FIX VERIFICATION (card 39ceb732, Lever 5 concretized): a repo's own root .gitignore excludes a
  // top-level scratch folder from the WATCHER too — the exact shape of the "OSS Contributions" project's
  // real _external/ (~19k entries, ~14% of the ~134k measured on card a0c62330): a directory git already
  // NEVER commits (git add . respects .gitignore), so watching it cost OS handles for zero benefit. Two
  // things must both hold: (1) the parser recognizes the right subset of gitignore syntax; (2) the LIVE
  // chokidar watcher actually stops tracking entries under the excluded folder, while STILL tracking a
  // sibling non-ignored file — a positive control so an "everything's excluded" bug can't hide as a pass.
  {
    const gi = [
      "scratch/",             // bare top-level dir — SHOULD be excluded (the oss-contrib _external/ shape)
      "# a comment",          // comment — ignored
      "",                     // blank line — ignored
      "!kept-anyway",         // negation — out of scope, left watched
      "*.log",                // glob — out of scope, left watched
      "nested/deep",          // multi-segment path — out of scope, left watched
      "/leading-slash-dir/",  // ROOT-ANCHORED — out of scope, left watched (see the MAJOR fix test below)
      " leading-space-dir/",  // LEADING WHITESPACE is significant to git (NOT ignored) — out of scope, left watched
    ].join("\n");
    const vaultF = path.join(root, "vaultF");
    initVault(vaultF);
    fs.writeFileSync(path.join(vaultF, ".gitignore"), gi);
    fs.mkdirSync(path.join(vaultF, "scratch"));
    fs.writeFileSync(path.join(vaultF, "scratch", "ignored.txt"), "should never be watched\n");
    fs.writeFileSync(path.join(vaultF, "keep.md"), "# should still be watched + committed\n");

    const names = gitignoredTopLevelNames(vaultF);
    check("gitignoredTopLevelNames picks up a bare top-level dir entry", names.includes("scratch"));
    check("gitignoredTopLevelNames excludes a ROOT-ANCHORED (leading-/) entry — CRITICAL/MAJOR fix", !names.includes("leading-slash-dir"));
    check("gitignoredTopLevelNames excludes a LEADING-WHITESPACE line (significant to git, not ignored) — round-3 fix", !names.includes("leading-space-dir"));
    check("gitignoredTopLevelNames excludes a negated pattern", !names.includes("kept-anyway"));
    check("gitignoredTopLevelNames excludes a glob pattern", !names.some((n) => n.includes("*")));
    check("gitignoredTopLevelNames excludes a nested multi-segment path", !names.includes("nested/deep") && !names.includes("deep"));

    const gitF = simpleGit(vaultF);
    const safeF = await safeToExcludeNames(vaultF, gitF);
    check("safeToExcludeNames keeps the untracked scratch/ candidate", safeF.includes("scratch"));

    // Driven through buildIgnoredMatcher (the ONLY exported form) rather than the un-exported
    // buildIgnoredPattern — Critical-2's fix lives in the RELATIVE-path matcher, so a check that fed an
    // absolute path straight to the bare pattern would be testing exactly the form that fix retired.
    const matcherF = buildIgnoredMatcher(vaultF, safeF);
    check(
      "buildIgnoredMatcher still matches all FOUR load-bearing hardcoded exclusions",
      matcherF(path.join(vaultF, ".git", "x"))
        && matcherF(path.join(vaultF, "node_modules", "x"))
        && matcherF(path.join(vaultF, "worktrees", "x"))
        && matcherF(path.join(vaultF, ".obsidian", "x")),
    );
    check("buildIgnoredMatcher also matches the newly-gitignored dir", matcherF(path.join(vaultF, "scratch", "ignored.txt")));

    const vf = new VaultVersioner(vaultF, 150);
    await vf.start();
    try {
      await vf.whenReady();
      const allTrackedNames = Object.values(vf.watchedSnapshot ?? {}).flat();
      check("gitignored scratch/ file is NOT tracked by the live watcher", !allTrackedNames.includes("ignored.txt"));
      check("gitignored scratch/ dir itself is NOT tracked by the live watcher", !allTrackedNames.includes("scratch"));
      check("a sibling non-ignored file IS still tracked (scan actually ran, not silently empty)", allTrackedNames.includes("keep.md"));

      // The exclusion has ZERO effect on what gets committed: `git add .` was NEVER going to stage a
      // gitignored, UNTRACKED path regardless of watcher state, so this doesn't need (and shouldn't try)
      // its own commit-behavior assertion — a fixed-wait "no commit happened" check can't distinguish
      // "correctly never fires" from "hasn't fired YET" in one trial. The `getWatched()` snapshot above is
      // the stronger, directly-observable proof: no chokidar "all" event can ever fire for an untracked
      // path, so `schedule()`/`commit()` mechanically can't be reached from an edit under scratch/ at all.
      const beforeF = commitCount(vaultF);
      fs.writeFileSync(path.join(vaultF, "keep.md"), "# edited — must still auto-commit\n");
      check("a real (non-excluded) edit still auto-commits", await waitFor(() => commitCount(vaultF) > beforeF));
    } finally {
      await vf.stop();
    }
  }

  // CRITICAL-1 REGRESSION TEST (review finding): `.gitignore` has NO effect on an already-TRACKED path.
  // A repo in the ordinary "committed first, ignored later" shape (commit a file, THEN add its directory
  // to .gitignore) must keep auto-committing edits to that tracked file — excluding it from the watcher
  // would silently stop version history for real content, which is the whole point of this feature.
  {
    const vaultI = path.join(root, "vaultI");
    initVault(vaultI);
    fs.mkdirSync(path.join(vaultI, "notes"));
    fs.writeFileSync(path.join(vaultI, "notes", "a.md"), "hello\n");
    git(vaultI, "add notes/a.md");
    git(vaultI, "commit -m init");
    // notes/ is added to .gitignore AFTER a.md is already tracked — the "committed first, ignored later"
    // shape. scratch/ is a genuinely-untracked sibling, included as a positive control (proves this vault's
    // exclusion mechanism still works normally, so a "nothing gets excluded" bug can't hide as a pass).
    fs.writeFileSync(path.join(vaultI, ".gitignore"), "notes/\nscratch/\n");
    fs.mkdirSync(path.join(vaultI, "scratch"));
    fs.writeFileSync(path.join(vaultI, "scratch", "untracked.md"), "never committed\n");

    const gitI = simpleGit(vaultI);
    const safeI = await safeToExcludeNames(vaultI, gitI);
    check("safeToExcludeNames does NOT offer a gitignored-but-TRACKED name for exclusion", !safeI.includes("notes"));
    check("safeToExcludeNames still offers the genuinely-untracked sibling", safeI.includes("scratch"));

    const vi = new VaultVersioner(vaultI, 150);
    await vi.start();
    try {
      await vi.whenReady();
      const allTrackedNames = Object.values(vi.watchedSnapshot ?? {}).flat();
      check("the gitignored-but-TRACKED notes/ dir IS still tracked by the live watcher", allTrackedNames.includes("notes"));
      check("the genuinely-untracked scratch/ dir is NOT tracked by the live watcher", !allTrackedNames.includes("scratch"));

      const beforeI = commitCount(vaultI);
      fs.appendFileSync(path.join(vaultI, "notes", "a.md"), "edited after notes/ was gitignored\n");
      check("editing a gitignored-but-TRACKED file still auto-commits (the actual regression)", await waitFor(() => commitCount(vaultI) > beforeI));
    } finally {
      await vi.stop();
    }
  }

  // CRITICAL-1b REGRESSION TEST (review Round 3): `core.quotePath` defaults TRUE, so a plain
  // `git ls-files` QUOTES a non-ASCII tracked path as backslash-escaped octal (e.g. `Café/note.md` prints
  // as `"Caf\303\251/note.md"`), which a naive newline+`/`-split shreds — wrongly reporting a REAL tracked
  // directory as untracked, exactly recreating Critical-1 with an ordinary personal-vault folder name
  // (`Café`, `文档`, `Notas`), not an exotic input. Identical shape to vaultI above, just with a non-ASCII
  // tracked name — this is the ASCII-only blind spot the reviewer flagged in that block.
  {
    const vaultL = path.join(root, "vaultL");
    initVault(vaultL);
    fs.mkdirSync(path.join(vaultL, "Café"));
    fs.writeFileSync(path.join(vaultL, "Café", "note.md"), "bonjour\n");
    git(vaultL, 'add "Café/note.md"');
    git(vaultL, "commit -m init");
    fs.writeFileSync(path.join(vaultL, ".gitignore"), "Café/\nscratch/\n");
    fs.mkdirSync(path.join(vaultL, "scratch"));
    fs.writeFileSync(path.join(vaultL, "scratch", "untracked.md"), "never committed\n");

    const gitL = simpleGit(vaultL);
    const safeL = await safeToExcludeNames(vaultL, gitL);
    check("safeToExcludeNames does NOT offer a gitignored-but-TRACKED non-ASCII name for exclusion", !safeL.includes("Café"));
    check("safeToExcludeNames still offers the genuinely-untracked ASCII sibling", safeL.includes("scratch"));

    const vl = new VaultVersioner(vaultL, 150);
    await vl.start();
    try {
      await vl.whenReady();
      const allTrackedNames = Object.values(vl.watchedSnapshot ?? {}).flat();
      check("the gitignored-but-TRACKED Café/ dir IS still tracked by the live watcher", allTrackedNames.includes("Café"));
      check("the genuinely-untracked scratch/ dir is NOT tracked by the live watcher", !allTrackedNames.includes("scratch"));

      const beforeL = commitCount(vaultL);
      fs.appendFileSync(path.join(vaultL, "Café", "note.md"), "edited after Café/ was gitignored\n");
      check("editing a gitignored-but-TRACKED non-ASCII-named file still auto-commits", await waitFor(() => commitCount(vaultL) > beforeL));
    } finally {
      await vl.stop();
    }
  }

  // CRITICAL-2 REGRESSION TEST (review finding): a repo whose OWN path contains a segment matching one of
  // its own gitignored top-level names must NOT go dark — an absolute-path pattern previously matched the
  // watch ROOT ITSELF (chokidar refuses to descend into an ignored root at all → getWatched() = {}, the
  // WHOLE repo silently unwatched, for the daemon's whole lifetime).
  {
    const vaultJOuter = path.join(root, "scratch"); // deliberately reuses the name the vault's own .gitignore excludes
    const vaultJ = path.join(vaultJOuter, "myvault");
    fs.mkdirSync(vaultJ, { recursive: true });
    initVault(vaultJ);
    fs.writeFileSync(path.join(vaultJ, ".gitignore"), "scratch/\n"); // matches a segment of vaultJ's OWN path
    fs.writeFileSync(path.join(vaultJ, "keep.md"), "# must still be watched\n");

    const vj = new VaultVersioner(vaultJ, 150);
    await vj.start();
    try {
      await vj.whenReady();
      check("a repo whose own path collides with its gitignored name is NOT a dead watcher", (vj.watchedEntryCount ?? 0) > 0);
      const allTrackedNames = Object.values(vj.watchedSnapshot ?? {}).flat();
      check("...and its real content is actually tracked", allTrackedNames.includes("keep.md"));

      const beforeJ = commitCount(vaultJ);
      fs.writeFileSync(path.join(vaultJ, "keep.md"), "# edited\n");
      check("...and still auto-commits", await waitFor(() => commitCount(vaultJ) > beforeJ));
    } finally {
      await vj.stop();
    }
  }

  // MAJOR REGRESSION TEST (review finding): a ROOT-ANCHORED gitignore entry (`/dist`, top-level-only in
  // real git semantics) must NOT broaden into excluding a NESTED same-named directory — the pre-fix parser
  // stripped the leading `/` and treated `/dist` exactly like a bare `dist`, matching at ANY depth.
  {
    const vaultK = path.join(root, "vaultK");
    initVault(vaultK);
    fs.writeFileSync(path.join(vaultK, ".gitignore"), "/dist\n");
    fs.mkdirSync(path.join(vaultK, "packages", "web", "dist"), { recursive: true });
    fs.writeFileSync(path.join(vaultK, "packages", "web", "dist", "keep.md"), "# nested dist — must stay watched\n");

    const namesK = gitignoredTopLevelNames(vaultK);
    check("a root-anchored entry contributes NO candidate (left watched at every depth)", namesK.length === 0);

    const vk = new VaultVersioner(vaultK, 150);
    await vk.start();
    try {
      await vk.whenReady();
      const allTrackedNames = Object.values(vk.watchedSnapshot ?? {}).flat();
      check("a NESTED dir sharing the root-anchored entry's name is still tracked", allTrackedNames.includes("dist") && allTrackedNames.includes("keep.md"));

      const beforeK = commitCount(vaultK);
      fs.writeFileSync(path.join(vaultK, "packages", "web", "dist", "keep.md"), "# edited\n");
      check("editing inside the nested same-named dir still auto-commits", await waitFor(() => commitCount(vaultK) > beforeK));
    } finally {
      await vk.stop();
    }
  }

  // FINDING-3 REGRESSION TEST (card 687d2a47, round-4 review): `.gitignore` matching honors
  // `core.ignorecase` (default TRUE on Windows — the owner's own platform — and macOS); `git ls-files`
  // PATHSPEC matching does not. A gitignore entry whose case differs from the actually-tracked name must
  // still be recognized as tracked (case-insensitively), or a genuinely tracked directory gets wrongly
  // offered for exclusion. Reproduced at the git-pathspec level directly — this is a property of git's
  // pathspec engine, not filesystem case-sensitivity, so it reproduces platform-independently (live-
  // verified on this host: `git ls-files -- notes` against a tracked `Notes/b.md` returns EMPTY).
  {
    const vaultS = path.join(root, "vaultS");
    initVault(vaultS);
    fs.mkdirSync(path.join(vaultS, "Notes"));
    fs.writeFileSync(path.join(vaultS, "Notes", "b.md"), "tracked, different case than the .gitignore entry\n");
    git(vaultS, "add Notes/b.md");
    git(vaultS, "commit -m init");
    fs.writeFileSync(path.join(vaultS, ".gitignore"), "notes\n"); // lowercase — the tracked dir is "Notes"

    const gitS = simpleGit(vaultS);
    const safeS = await safeToExcludeNames(vaultS, gitS);
    check("a case-differing gitignore entry for a TRACKED name is NOT offered for exclusion (case-insensitive compare)", !safeS.includes("notes"));

    const vs = new VaultVersioner(vaultS, 150);
    await vs.start();
    try {
      await vs.whenReady();
      const allTrackedNamesS = Object.values(vs.watchedSnapshot ?? {}).flat();
      check("the tracked 'Notes' directory is still watched despite the case-differing gitignore entry", allTrackedNamesS.includes("Notes"));
    } finally {
      await vs.stop();
    }
  }

  // FINDING-1 REGRESSION TEST (card 687d2a47, round-4 review): a `:`-leading gitignore line survives the
  // parser (unlike glob/negation lines, `:` is not filtered there — the fix lives at the git-query SINK,
  // see gitTrackedTopLevelNames' doc) and, fed to `git ls-files` as a bare pathspec, is git PATHSPEC MAGIC
  // (e.g. `:!` excludes everything), silently, exit 0 — not rejected as a bogus name. Batched into the SAME
  // ls-files call as other candidates, it can empty the whole tracked result and cause a genuinely-tracked
  // OTHER candidate to be misreported as untracked and excluded. This check only proves SOME wrapper at the
  // sink closes it (an OR-guard, not a which-magic-word-did-it proof) — per gitTrackedTopLevelNames' own
  // doc, live-verification there attributes the actual closure to `:(icase)`: each `:(...)`-wrapped
  // pathspec's magic is scoped to that one pathspec, so `:!` no longer corrupts its siblings in the batch.
  // `,literal` is additional, currently-unreachable belt-and-braces, not what closes this specific case.
  {
    const vaultP = path.join(root, "vaultP");
    initVault(vaultP);
    fs.mkdirSync(path.join(vaultP, "_external"));
    fs.writeFileSync(path.join(vaultP, "_external", "a.md"), "tracked\n");
    git(vaultP, "add _external/a.md");
    git(vaultP, "commit -m init");
    fs.writeFileSync(path.join(vaultP, ".gitignore"), "_external/\n:!\n");

    const namesP = gitignoredTopLevelNames(vaultP);
    check("gitignoredTopLevelNames DOES generate a ':'-leading candidate (the fix is at the git-query sink, not here)", namesP.includes(":!"));
    check("gitignoredTopLevelNames still generates the genuine _external candidate", namesP.includes("_external"));

    const gitP = simpleGit(vaultP);
    const safeP = await safeToExcludeNames(vaultP, gitP);
    check("a ':'-leading candidate does NOT corrupt the batched tracked-check for other candidates — TRACKED _external stays offered as NOT safe to exclude", !safeP.includes("_external"));
  }

  // FINDING-2 REGRESSION TEST (card 687d2a47, round-4 review): a `name/`-form gitignore line is git's
  // DIRECTORY-ONLY pattern, but the exclusion regex built from a bare candidate name matches a FILE of
  // that name too — a disk check is needed to tell the two apart. That check is a THREE-way discriminator
  // via lstatSync (real directory / plain file / link-like — a symlink or junction), not a two-way
  // directory-vs-file split: the link-like case deliberately resolves to "not a directory" even for a
  // Windows junction git itself WOULD ignore, an accepted under-generation cost (see versioner.ts's own
  // doc). This block only covers the plain-FILE case of that discriminator.
  {
    const vaultQ = path.join(root, "vaultQ");
    initVault(vaultQ);
    fs.writeFileSync(path.join(vaultQ, ".gitignore"), "thing/\n");
    fs.writeFileSync(path.join(vaultQ, "thing"), "an untracked top-level FILE named exactly like the entry\n");

    const namesQ = gitignoredTopLevelNames(vaultQ);
    check("a 'name/' entry contributes NO candidate when 'name' is currently a FILE, not a directory", !namesQ.includes("thing"));

    const vq = new VaultVersioner(vaultQ, 150);
    await vq.start();
    try {
      await vq.whenReady();
      const allTrackedNamesQ = Object.values(vq.watchedSnapshot ?? {}).flat();
      check("the top-level FILE 'thing' is still watched (not wrongly excluded by the dir-only pattern)", allTrackedNamesQ.includes("thing"));
    } finally {
      await vq.stop();
    }
  }
  {
    // Contrast case: when 'name' really IS a directory, the candidate is still (correctly) generated and
    // the live watcher still excludes it — proves the fix is a precise directory-vs-file discriminator,
    // not a blanket disabling of the 'name/'-form.
    const vaultR = path.join(root, "vaultR");
    initVault(vaultR);
    fs.writeFileSync(path.join(vaultR, ".gitignore"), "thing/\n");
    fs.mkdirSync(path.join(vaultR, "thing"));
    fs.writeFileSync(path.join(vaultR, "thing", "x.md"), "untracked, inside a real ignored dir\n");
    fs.writeFileSync(path.join(vaultR, "keep.md"), "# still watched\n");

    const namesR = gitignoredTopLevelNames(vaultR);
    check("a 'name/' entry DOES contribute a candidate when 'name' is currently a real directory", namesR.includes("thing"));

    const vr = new VaultVersioner(vaultR, 150);
    await vr.start();
    try {
      await vr.whenReady();
      const allTrackedNamesR = Object.values(vr.watchedSnapshot ?? {}).flat();
      check("the real, untracked 'thing/' directory is excluded from the live watcher", !allTrackedNamesR.includes("thing"));
      check("a sibling non-excluded file is still watched", allTrackedNamesR.includes("keep.md"));
    } finally {
      await vr.stop();
    }
  }

  // SYMLINK-TO-DIR OVER-GENERATION FIX, junction regression (round-4 review, BLOCKING): finding 2's
  // directory check must use fs.lstatSync, never fs.statSync — an UNTRACKED symlink to a directory is NOT
  // ignored by git's `name/` pattern (git check-ignore exits 1 for it) and `git add .` DOES stage it, but
  // fs.statSync FOLLOWS the link and reports it as a directory, which would over-exclude live, staged
  // content. fs.lstatSync correctly reports it as not-a-directory. The accepted, priced-out cost of that
  // fix is a WINDOWS JUNCTION: git's `name/` pattern DOES ignore a junction (it behaves like a real
  // directory to git — check-ignore exits 0), but fs.lstatSync ALSO reports a junction as not-a-directory
  // (live-verified on this host: `fs.lstatSync(junctionPath).isDirectory()` is false while
  // `fs.statSync(...).isDirectory()` is true) — so a junction's candidate is never generated either. That
  // is strictly under-generating (leaves it watched, a few extra handles), never the reverse, so it's safe
  // to pay. (A real symlink-to-dir fixture needs elevation/Developer Mode to create on Windows — confirmed
  // unavailable in this environment, `mklink /D` refused with an access-denied error — so only the
  // junction side of this fix is pinned here; the symlink side is covered by the reviewer's live-verified
  // transcript, not re-derived from documentation.) Windows-only: junctions have no POSIX analogue, and
  // fs.symlinkSync(..., "junction") needs no elevation (unlike a plain directory symlink).
  if (process.platform === "win32") {
    const vaultT = path.join(root, "vaultT");
    initVault(vaultT);
    const realDirT = path.join(root, "vaultT-junction-target"); // outside vaultT — just needs to exist
    fs.mkdirSync(realDirT, { recursive: true });
    fs.writeFileSync(path.join(realDirT, "x.md"), "real content reachable only through the junction\n");
    fs.writeFileSync(path.join(vaultT, ".gitignore"), "thingj/\n");
    fs.symlinkSync(realDirT, path.join(vaultT, "thingj"), "junction");

    const namesT = gitignoredTopLevelNames(vaultT);
    check("a 'name/' entry pointing at a WINDOWS JUNCTION contributes NO candidate (lstatSync sees it as not-a-directory) — the accepted under-generation cost", !namesT.includes("thingj"));

    const vt = new VaultVersioner(vaultT, 150);
    await vt.start();
    try {
      await vt.whenReady();
      const allTrackedNamesT = Object.values(vt.watchedSnapshot ?? {}).flat();
      check("the junction is left watched, not wrongly excluded", allTrackedNamesT.includes("thingj"));
    } finally {
      await vt.stop();
    }
  } else {
    console.log("SKIP  windows-junction lstatSync regression — junctions are a Windows-only concept (process.platform !== 'win32' here)");
  }

  // ABSENT-.gitignore regression (review finding): the four hardcoded exclusions must survive even when
  // there is no .gitignore at all — previously only ever asserted WITH one present.
  {
    check("gitignoredTopLevelNames returns [] when there is no .gitignore", gitignoredTopLevelNames(vaultA).length === 0);
    const matcherNoGitignore = buildIgnoredMatcher(vaultA, []);
    check(
      "buildIgnoredMatcher still matches all FOUR hardcoded exclusions with NO .gitignore present",
      matcherNoGitignore(path.join(vaultA, ".git", "x"))
        && matcherNoGitignore(path.join(vaultA, "node_modules", "x"))
        && matcherNoGitignore(path.join(vaultA, "worktrees", "x"))
        && matcherNoGitignore(path.join(vaultA, ".obsidian", "x")),
    );
  }

  // LEVER 4 (visibility warning): `start()` logs a one-time warning when the watched entry count exceeds
  // the threshold. Real threshold (20,000) would need a slow real fixture to exercise — override it (same
  // testability shape as commitVault's opts.maxFileBytes) so a handful of files can cross a tiny threshold.
  {
    const vaultG = path.join(root, "vaultG");
    initVault(vaultG);
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(vaultG, `f${i}.md`), `# file ${i}\n`);
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(" ")); };
    const vg = new VaultVersioner(vaultG, 150, 3); // threshold=3 — 5 files crosses it
    try {
      await vg.start();
      await vg.whenReady();
    } finally {
      console.warn = origWarn;
      await vg.stop();
    }
    check("crossing the watch-warn threshold logs a [vault-versioner] warning", warnings.some((w) => w.includes("[vault-versioner]") && w.includes("is watching") && w.includes("entries")));
  }
  {
    const vaultH = path.join(root, "vaultH");
    initVault(vaultH);
    fs.writeFileSync(path.join(vaultH, "f0.md"), "# file 0\n");
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(" ")); };
    const vh = new VaultVersioner(vaultH, 150, 3); // threshold=3 — 1 file (+.gitignore-less) stays under it
    try {
      await vh.start();
      await vh.whenReady();
    } finally {
      console.warn = origWarn;
      await vh.stop();
    }
    check("staying under the watch-warn threshold logs nothing", !warnings.some((w) => w.includes("[vault-versioner]") && w.includes("is watching")));
  }

  // ZERO-ENTRIES TRIPWIRE, false-positive direction (review Round 3): a legitimately brand-new, EMPTY vault
  // (no notes yet — nothing on disk but the repo's own .git) must NOT trigger the "dead watcher" warning.
  // The genuine-warning direction (a real dead watcher despite un-excluded content) is NOT independently
  // reproduced here: the discriminator deliberately reuses the SAME matcher as the exclusion decision (see
  // hasUnexcludedTopLevelEntry's doc), so triggering it would require a genuine chokidar-internal scan
  // failure unrelated to anything this fix controls — not something a hermetic test should fabricate.
  {
    const vaultM = path.join(root, "vaultM");
    initVault(vaultM); // no files beyond .git — genuinely empty, not a dead watcher
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(" ")); };
    const vm = new VaultVersioner(vaultM, 150);
    try {
      await vm.start();
      await vm.whenReady();
    } finally {
      console.warn = origWarn;
      await vm.stop();
    }
    check("a genuinely empty (brand-new) vault does NOT trigger the zero-entries dead-watcher warning", !warnings.some((w) => w.includes("[vault-versioner]") && w.includes("ZERO entries")));
  }

  // ZERO-ENTRIES TRIPWIRE, POSITIVE CONTROL (card 687d2a47 finding 5): the false-positive test above only
  // proves the branch stays silent on a legitimately empty vault — nothing in this suite previously proved
  // the warn branch can fire AT ALL, so a tripwire that can never fire would have passed identically.
  // Force the exact dead-watcher SHAPE directly (count===0 while real, non-excluded content exists): TS
  // `private` is compile-time only, so this .mjs suite (running the compiled JS) can read/write the field
  // like any ordinary property.
  {
    const vaultN = path.join(root, "vaultN");
    initVault(vaultN);
    fs.writeFileSync(path.join(vaultN, "keep.md"), "# real content — must trigger the zero-entries tripwire\n");
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(" ")); };
    const vn2 = new VaultVersioner(vaultN, 150);
    try {
      await vn2.start();
      await vn2.whenReady();
      const realWatcher = vn2.watcher;
      vn2.watcher = { getWatched: () => ({}) };
      vn2.warnIfLarge();
      vn2.watcher = realWatcher; // restore before stop() so the real chokidar handle actually gets closed
    } finally {
      console.warn = origWarn;
      await vn2.stop();
    }
    check("the zero-entries dead-watcher warning DOES fire when count===0 and real content exists (positive control)", warnings.some((w) => w.includes("[vault-versioner]") && w.includes("ZERO entries")));
  }

  // BOUNDED GIT (card 509716cc): every SimpleGit call in this module must be bounded — a hung child must
  // not hang the caller forever. Two of the three sites named on the card, each proven against a git
  // stand-in whose call NEVER resolves (simulating a wedged child on a busy/locked disk).
  {
    // Site 3 (safeToExcludeNames → gitTrackedTopLevelNames's `git ls-files`): a real .gitignore candidate
    // so the ls-files call actually happens (an empty-candidates vault would short-circuit before ever
    // touching git, proving nothing about the timeout).
    const vaultTO = path.join(root, "vaultTimeout");
    initVault(vaultTO);
    fs.writeFileSync(path.join(vaultTO, ".gitignore"), "scratch/\n");
    fs.mkdirSync(path.join(vaultTO, "scratch"));
    fs.writeFileSync(path.join(vaultTO, "scratch", "ignored.txt"), "untracked\n");
    check("timeout fixture actually produces a real gitignore candidate to bound against", gitignoredTopLevelNames(vaultTO).includes("scratch"));

    const neverGit = { raw: () => new Promise(() => {}) }; // never resolves — simulates a wedged `git ls-files`
    const tinyMs = 200;
    const t0 = performance.now(); // MONOTONIC
    const timedOut = await safeToExcludeNames(vaultTO, neverGit, tinyMs);
    const elapsed = performance.now() - t0;
    check("safeToExcludeNames RETURNS despite a never-resolving `git ls-files` (bounded, not an infinite hang)", Array.isArray(timedOut));
    check(`safeToExcludeNames bounded by timeoutMs — returned in ${Math.round(elapsed)}ms (cap ${tinyMs}ms)`, elapsed < tinyMs * 5 + 1500);
    check("a timed-out ls-files fails SAFE — treats the candidate as TRACKED, excludes NOTHING (same direction as any other git error)", timedOut.length === 0);

    // Negative control: the SAME candidate against REAL (non-hanging) git resolves normally and IS
    // offered — proves the fail-safe result above is the timeout firing, not safeToExcludeNames just
    // always returning [] regardless of what git says. Deliberately OMITS timeoutMs (falls back to
    // safeToExcludeNames' own production default, VAULT_GIT_OP_TIMEOUT_MS = 15s) rather than reusing
    // `tinyMs` — this control's job is "prove real git DOES offer the candidate", which needs headroom
    // for a slow-but-correct `git ls-files` under host load; `tinyMs` exists only to keep the sibling
    // hanging-git cases above fast, and sharing it here meant a saturated host could trip the SAME
    // 200ms bound on a real (non-hanging) call, fail safe, and read as this control failing (card
    // b3f7cd25 — cost a real 16.7-minute merge gate).
    const normal = await safeToExcludeNames(vaultTO, simpleGit(vaultTO));
    check("negative control: the same candidate against REAL (non-hanging) git IS offered for exclusion", normal.includes("scratch"));

    // Site 1 + 2 (resolveVaultRepoContext's checkIsRepo/revparse, start()'s checkIsRepo/init): drive
    // through the public VaultVersioner surface with an injected gitFactory whose checkIsRepo never
    // resolves — proves the boot-awaited start() path returns instead of hanging forever.
    const vaultTO2 = path.join(root, "vaultTimeout2");
    fs.mkdirSync(vaultTO2, { recursive: true }); // deliberately NOT git-inited
    let checkIsRepoCalls = 0;
    const hangingFactory = () => {
      checkIsRepoCalls++;
      return {
        checkIsRepo: () => new Promise(() => {}), // never resolves — simulates a wedged checkIsRepo/rev-parse
        revparse: async () => "",
        init: async () => {},
        raw: async () => "",
      };
    };
    const vto = new VaultVersioner(vaultTO2, 150, undefined, { gitFactory: hangingFactory, timeoutMs: tinyMs });
    const t1 = performance.now(); // MONOTONIC
    await vto.start();
    const elapsed2 = performance.now() - t1;
    check("checkIsRepo was actually invoked via the injected factory (not skipped)", checkIsRepoCalls >= 2); // resolveVaultRepoContext + start() each build their own bounded git
    check(`VaultVersioner.start() RETURNS despite a never-resolving checkIsRepo (bounded boot path) — took ${Math.round(elapsed2)}ms (cap ~${tinyMs * 2}ms across the two bounded call sites)`, elapsed2 < tinyMs * 8 + 2000);
    await vto.stop();
  }

  {
    // whenReady() (card 86b41129): before this card, a pre-ready chokidar error left the watcher's
    // readyPromise permanently unresolved (deliberately — see start()'s "error" listener doc), so a
    // caller that awaited whenReady() hung until the TEST HARNESS'S OWN blanket 120s TEST_TIMEOUT_MS
    // and reported an opaque, anonymous "timeout" — losing the real cause entirely. whenReady() now
    // owns its own bound and NAMES the failure. `vv.watcher` is reached directly here (TS `private` is
    // compile-time-only; the compiled field is a plain property) to inject a synthetic chokidar "error"
    // deterministically, without depending on real filesystem timing.
    const vaultWR1 = path.join(root, "vaultWhenReady1");
    fs.mkdirSync(vaultWR1, { recursive: true });
    const vv1 = new VaultVersioner(vaultWR1);
    await vv1.start();
    // Emitted synchronously, right after start() returns and before any timer/IO callback can run — the
    // real chokidar "ready" event needs at least one macrotask (fs.readdir I/O), so this is guaranteed to
    // land BEFORE ready, not racing it.
    vv1.watcher.emit("error", new Error("SIMULATED_PRE_READY_FAILURE"));
    let err1;
    try { await vv1.whenReady(); } catch (e) { err1 = e; }
    check("a pre-ready error already seen at call time rejects whenReady() (not silently pending)", err1 instanceof Error);
    check("...and the rejection NAMES the real cause, not an anonymous timeout", /SIMULATED_PRE_READY_FAILURE/.test(err1?.message ?? ""));
    await vv1.stop();

    // Same case, but the error arrives WHILE whenReady() is already waiting (not before) — proves the
    // in-flight racer path, not just the call-time fast path above.
    const vaultWR2 = path.join(root, "vaultWhenReady2");
    fs.mkdirSync(vaultWR2, { recursive: true });
    const vv2 = new VaultVersioner(vaultWR2);
    await vv2.start();
    const pending2 = vv2.whenReady().catch((e) => e);
    vv2.watcher.emit("error", new Error("SIMULATED_MID_WAIT_FAILURE"));
    const err2 = await pending2;
    check("an error arriving WHILE whenReady() is waiting also rejects (not just a pre-existing one)", err2 instanceof Error);
    check("...and also NAMES the real cause", /SIMULATED_MID_WAIT_FAILURE/.test(err2?.message ?? ""));
    await vv2.stop();

    // Neither "ready" nor "error" ever arrives (e.g. ignorePermissionErrors:true fully swallows the
    // failure) — whenReady()'s own bound must still produce a NAMED failure, not hang until some
    // external harness timeout. Force this deterministically (never wait out a real 60s default) via the
    // ctor's whenReadyTimeoutMs test override; readyPromise is overwritten with a promise that never
    // settles so this cannot flake on a real chokidar scan finishing first.
    const vaultWR3 = path.join(root, "vaultWhenReady3");
    fs.mkdirSync(vaultWR3, { recursive: true });
    const tinyReadyMs = 100;
    const vv3 = new VaultVersioner(vaultWR3, 5000, undefined, undefined, tinyReadyMs);
    await vv3.start();
    vv3.readyPromise = new Promise(() => {}); // simulate "scan never completes, no error either"
    const t3 = performance.now(); // MONOTONIC
    let err3;
    try { await vv3.whenReady(); } catch (e) { err3 = e; }
    const elapsed3 = performance.now() - t3;
    check(`whenReady() with no pre-ready error or ready event still rejects within its own bound (took ${Math.round(elapsed3)}ms, cap ${tinyReadyMs}ms)`, elapsed3 < tinyReadyMs + 2000);
    check("...and the timeout rejection is a NAMED Error (not undefined / an anonymous hang)", err3 instanceof Error && /did not become ready/.test(err3.message));
    await vv3.stop();
  }
} finally {
  for (const v of versioners) { try { await v.stop(); } catch { /* best-effort */ } }
  // root's own manual rmSync removed here: mkdtempManaged already registered it for guaranteed cleanup
  // at process exit (card 995be21f). versioner.stop() above is UNRELATED to root's cleanup and stays —
  // it releases each chokidar watcher's file handles, which matters regardless of who removes the dir.
}

console.log(failures === 0 ? "\nALL PASS — VaultVersioner is wired + flushes on shutdown." : `\n${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
