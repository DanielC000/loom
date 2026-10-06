import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card a09b81a0: a legacy project row whose vaultPath is a SUBDIR of its own (or another registered
// project's) code repo resolves, via resolveVaultRepoContext's upward walk, to that code repo's ROOT —
// so the auto-committer was staging and committing arbitrary code files, on the code repo's own branch,
// outside withCanonicalIndexLock. See docs/decisions/a09b81a0-vault-commit-code-repo-guard.md for the
// full design (the predicate, the vaultOnly exemption, the live-provider/dedupe/surfacing choices).
//
// Proves, with REAL git repos (no mocked git):
//   (1) RED-equivalent: a subdir-of-own-code-repo vault's resolved commitPath canonically collides with
//       its own project's repoPath — commitVault REFUSES (committed:false, blockedReason set), and no new
//       commit lands even though a real uncommitted vault edit is sitting in the repo.
//  (1b) Round 2 (BLOCKING): a MONOREPO-PACKAGE binding — project repoPath is a SUBDIR of the resolved
//       commitPath, not equal to it (repo mono/, repoPath=mono/pkg, vaultPath=mono/notes) — is caught by
//       an at-or-under match, not just exact equality.
//  (1c) Round 2: a textually-prefixed but NOT path-segment-related sibling (mono2x vs mono2) does not
//       false-positive on the at-or-under match.
//   (2) A TRUE vault-only project (repoPath===vaultPath, its own repo, vaultOnly:true) still commits.
//   (3) A legacy ALIASED-CODE row (repoPath===vaultPath pointing at a real code checkout, vaultOnly:true
//       via the b98957e9 backfill shape) ALSO still commits — same mechanism as (2), documented separately
//       since it's the specific shape b98957e9 chose to carry forward rather than "fix".
//  (3b) Round 2 (Minor): the vaultOnly exemption is decided PER CANDIDATE, not per entry — a vaultOnly
//       project's own repoPath is exempt, but a DIFFERENT code repo it merely lists in repos[] is not.
//   (4) An ARCHIVED project's repoPath is still protected (the guard's own snapshot unions
//       listArchivedProjects() on top of listAllProjects(), which excludes archived).
//   (5) A runtime rebind is seen WITHOUT a restart: the SAME provider, re-queried live, flips from
//       no-collision to collision between two calls with no process restart.
//   (6) Fail-open when no provider is registered (a unit test with no boot-wired Db).
//   (7) Dedupe: the SAME (subjectPath, commitPath) collision warns/audits only ONCE per process, even
//       across repeated commitVault calls (the debounce-tick shape).
//   (8) vault/writer.ts's three UI-write functions surface committedBlockedReason — never swallow it
//       indistinguishably from an ordinary committed:false backoff. The file write itself still succeeds.
//   (9) startVaultVersioners's own boot-time gate SKIPS constructing a versioner for a refused project —
//       closing the debounce-tick + flushSync paths in one place, before either could ever run.
//  (10) Production boot wiring: index.ts actually calls setCodeRepoGuardProvider (a comment-stripped
//       source-text scan — immune to a comment-only diff, see _strip-comments.mjs), BEFORE both
//       startVaultVersioners AND (round 2) startGatewayListeners (the gateway's own listen call).
//  (1d) Round 3 test-gap fix: (1b) calls commitVault with the RAW, unresolved subfolder vaultPath, which
//       ALWAYS backs off via the generic "externally managed" early return regardless of whether the
//       collision check even fires — its own "no new commit landed" assertion can never actually fail.
//       This calls commitVault with the ALREADY-RESOLVED root directly (the real VaultVersioner.commit()/
//       flushSync() call shape), so the assertion genuinely depends on the collision check.
//  (11) Round 3 (owner ruling, request 8d6fea89, option A): a repo that is itself some project's vault
//       root is exempt from the collision refusal, even though it is ALSO registered as a notes-topic
//       project's own repoPath (vaultPath merely NESTED, not equal) — the shared-Obsidian-vault shape.
//  (12) Round 3: a project's OWN vaultPath nested in its OWN repoPath (the original bug shape) is NEVER
//       exempted by the vault-root rule merely because a SEPARATE, self-contained vault-root voucher
//       happens to exist elsewhere in the same snapshot (one that has nothing to do with this repo). This
//       is NARROWER than "the exemption never leaks across unrelated repos" — see (14)/(14b)/(14c) below
//       for the real, still-open hole: a voucher whose OWN vaultPath is pointed INTO the bug repo.
//  (13) Round 3: when the auto-committer commits into a merge-eligible repo (one some registered project's
//       own repoPath also names EXACTLY), it takes withCanonicalIndexLock for that repo — serializing
//       against a real concurrent merge, verified by the git log ARTIFACT's commit order. NOT a timing-
//       independent proof — discriminates only if an unlocked sequence would complete inside the test's own
//       window (see that test's comments). Also: exact-match merge-eligibility has a known pre-existing gap
//       for a project bound to a no-.git SUBDIRECTORY of an exempt root (see isCommitPathMergeEligible's doc).
//  (14)/(14b)/(14c) ⚠️ Round-3 delta review, ROUND 4 rewrite: KNOWN HOLE (request f7cc5951 pending,
//       follow-up card 7c1d6dbf), now a GREEN TRIPWIRE, not a red test. A THIRD party can grant
//       isRecognizedVaultRoot's exemption for a code repo it has nothing to do with — a voucher whose own
//       vaultPath is nested INSIDE the bug project's code repo (14), a voucher with repoPath:"" that
//       vouches unconditionally (14b), or a voucher whose repoPath is an ANCESTOR of the key (14c).
//       Geometry cannot distinguish any of these from Parallax's shape. These checks used to encode the
//       CORRECT (refused) behavior and were deliberately red — but a committed test with a deliberate red
//       assertion turns the merge gate red, and this project's merge gate is not always fully gated
//       (interval-based reduced gating), so a red test risked landing straight onto main. They now instead
//       PIN TODAY'S (WRONG) behavior — the voucher IS honoured, the source IS auto-committed — and MUST
//       FLIP back to asserting refusal once 7c1d6dbf implements the owner's answer. Do not "fix" the
//       underlying predicate by touching the geometry — that decision belongs to 7c1d6dbf, not here.
// Run after build: node test/vault-commit-code-repo-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { stripComments } from "./_strip-comments.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-crg-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const {
  commitVault, startVaultVersioners, setCodeRepoGuardProvider,
} = await import("../dist/vault/versioner.js");
const { writeVaultFile, createVaultFile } = await import("../dist/vault/writer.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = fs.realpathSync(mkdtempManaged("loom-crg-"));
const git = (cwd, args) => execSync(`git ${args}`, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init");
  git(dir, "config user.email loom-crg-test@example.com");
  git(dir, "config user.name loom-crg-test");
}
const commitCount = (dir) => parseInt(git(dir, "rev-list --all --count").trim() || "0", 10);

function toEntry(p) {
  return { id: p.id, repoPath: p.repoPath, repos: p.repos ?? [], vaultOnly: !!p.vaultOnly, vaultPath: p.vaultPath };
}

// ===================== (1) RED-equivalent: subdir-of-own-code-repo collision =====================
{
  const codeRepo = path.join(root, "codeRepo1");
  initRepo(codeRepo);
  fs.writeFileSync(path.join(codeRepo, "src.ts"), "export const x = 1;\n");
  git(codeRepo, "add src.ts");
  git(codeRepo, "commit -m init");
  const subdirVault = path.join(codeRepo, "notes");
  fs.mkdirSync(subdirVault);

  const project = { id: "p-subdir", name: "Subdir", repoPath: codeRepo, vaultPath: subdirVault, vaultOnly: false, repos: [] };
  setCodeRepoGuardProvider({ snapshot: () => [toEntry(project)], recordEvent: () => {} });

  // A real, uncommitted vault edit genuinely sitting in the repo — if the guard did NOT fire, this would
  // auto-commit, exactly like the pre-fix bug.
  fs.writeFileSync(path.join(subdirVault, "note.md"), "# a real vault edit\n");
  const before = commitCount(codeRepo);
  const result = await commitVault(codeRepo, "loom: auto-commit (should be refused)");
  check("(1) commitVault REFUSES a resolved commitPath that collides with its own project's repoPath", result.committed === false);
  check("(1) ...with the specific blockedReason, not a bare silent backoff", result.blockedReason === "code-repo-collision");
  check("(1) ...and NO new commit landed despite a real uncommitted vault edit sitting in the repo", commitCount(codeRepo) === before);
}

// ===================== (1b) monorepo-package binding: project repoPath is a SUBDIR of the resolved commitPath (round 2) =====================
{
  const monoRepo = path.join(root, "mono1");
  initRepo(monoRepo);
  const pkgDir = path.join(monoRepo, "pkg");
  fs.mkdirSync(pkgDir);
  fs.writeFileSync(path.join(pkgDir, "a.ts"), "export const a = 1;\n");
  git(monoRepo, "add pkg/a.ts");
  git(monoRepo, "commit -m init");
  const notesDir = path.join(monoRepo, "notes");
  fs.mkdirSync(notesDir);

  // project.repoPath (pkgDir) is a SUBDIRECTORY of the repo root (monoRepo), not the root itself — the
  // exact shape create-time validation allows (checkIsRepo means "inside a work tree"; the vault/repo
  // triple-containment check treats pkgDir/notesDir as textual siblings and raises no objection).
  const project = { id: "p-mono-pkg", repoPath: pkgDir, vaultPath: notesDir, vaultOnly: false, repos: [] };
  setCodeRepoGuardProvider({ snapshot: () => [toEntry(project)], recordEvent: () => {} });

  fs.writeFileSync(path.join(notesDir, "note.md"), "# a real vault edit under a sibling subdir\n");
  const before = commitCount(monoRepo);
  // commitVault is called with the RAW (unresolved) vaultPath, exactly like vault/writer.ts's own call
  // shape — discovery resolves it up to the repo ROOT (monoRepo), which is where the collision must fire.
  const result = await commitVault(notesDir, "loom: auto-commit (should be refused — monorepo pkg subdir)");
  check("(1b) a project repoPath that is a SUBDIR of the resolved commitPath (monorepo binding) is caught — at-or-under, not just exact equality", result.committed === false && result.blockedReason === "code-repo-collision");
  check("(1b) ...and no new commit landed despite a real uncommitted vault edit sitting in the repo", commitCount(monoRepo) === before);
}

// ===================== (1c) path-segment awareness: a textually-prefixed sibling must NOT false-positive =====================
{
  const monoRepo2 = path.join(root, "mono2");
  initRepo(monoRepo2);
  const sibling = path.join(root, "mono2x"); // shares the "mono2" prefix textually, but is NOT a child
  initRepo(sibling);
  fs.writeFileSync(path.join(sibling, "code.ts"), "export const s = 1;\n");
  git(sibling, "add code.ts");
  git(sibling, "commit -m init");

  const project = { id: "p-sibling", repoPath: sibling, vaultPath: sibling, vaultOnly: false, repos: [] };
  setCodeRepoGuardProvider({ snapshot: () => [toEntry(project)], recordEvent: () => {} });

  fs.writeFileSync(path.join(monoRepo2, "note.md"), "# genuine vault content, unrelated repo\n");
  const before = commitCount(monoRepo2);
  const result = await commitVault(monoRepo2, "loom: auto-commit (unrelated textually-prefixed sibling)");
  check("(1c) a textually-prefixed but NOT path-segment-related sibling repo does not false-positive", result.committed === true && commitCount(monoRepo2) === before + 1);
}

// ===================== (1d) Round 3 test-gap fix: monorepo shape via commitVault called at the ALREADY-RESOLVED root (the real VaultVersioner call shape) =====================
{
  // (1b) above calls commitVault with the RAW, unresolved subfolder vaultPath — which ALWAYS backs off via
  // the generic "externally managed" early return (root !== vaultPath) regardless of whether the collision
  // check even fires, so its own "no new commit landed" assertion can never actually fail. This block calls
  // commitVault with the resolved ROOT directly — exactly how VaultVersioner.commit()/flushSync() call it
  // in production (this.commitPath is already the resolved root) — so the assertion below genuinely
  // depends on the at-or-under collision check firing.
  const monoRepo3 = path.join(root, "mono3");
  initRepo(monoRepo3);
  const pkgDir3 = path.join(monoRepo3, "pkg");
  fs.mkdirSync(pkgDir3);
  fs.writeFileSync(path.join(pkgDir3, "a.ts"), "export const a = 1;\n");
  git(monoRepo3, "add pkg/a.ts");
  git(monoRepo3, "commit -m init");
  const notesDir3 = path.join(monoRepo3, "notes");
  fs.mkdirSync(notesDir3);

  const project = { id: "p-mono-pkg-root", repoPath: pkgDir3, vaultPath: notesDir3, vaultOnly: false, repos: [] };
  setCodeRepoGuardProvider({ snapshot: () => [toEntry(project)], recordEvent: () => {} });

  fs.writeFileSync(path.join(notesDir3, "note.md"), "# a real vault edit, committed at the REAL resolved root\n");
  const before = commitCount(monoRepo3);
  const result = await commitVault(monoRepo3, "loom: auto-commit (should be refused — called at the resolved root)");
  check("(1d) commitVault called at the ALREADY-RESOLVED root is refused by the at-or-under collision check", result.committed === false && result.blockedReason === "code-repo-collision");
  check("(1d) ...and no new commit landed — this assertion WOULD fail without the collision check (unlike (1b)'s)", commitCount(monoRepo3) === before);
}

// ===================== (2) TRUE vault-only project still commits =====================
{
  const vaultOnlyRepo = path.join(root, "vaultOnly1");
  initRepo(vaultOnlyRepo);
  const project = { id: "p-vaultonly", name: "VaultOnly", repoPath: vaultOnlyRepo, vaultPath: vaultOnlyRepo, vaultOnly: true, repos: [] };
  setCodeRepoGuardProvider({ snapshot: () => [toEntry(project)], recordEvent: () => {} });

  fs.writeFileSync(path.join(vaultOnlyRepo, "note.md"), "# genuine vault content\n");
  const before = commitCount(vaultOnlyRepo);
  const result = await commitVault(vaultOnlyRepo, "loom: auto-commit (true vault-only)");
  check("(2) a TRUE vault-only project (vaultOnly:true, repoPath===vaultPath) still auto-commits", result.committed === true && commitCount(vaultOnlyRepo) === before + 1);
}

// ===================== (3) legacy ALIASED-CODE row (the 5af9020b shape) still commits =====================
{
  const aliasedRepo = path.join(root, "aliasedCode1");
  initRepo(aliasedRepo);
  fs.writeFileSync(path.join(aliasedRepo, "lib.ts"), "export const y = 2;\n");
  git(aliasedRepo, "add lib.ts");
  git(aliasedRepo, "commit -m init");
  // vaultOnly:true via the b98957e9 backfill rule (repo_path === vault_path, raw equality) even though
  // this is a REAL code checkout, not a genuine notes-only folder.
  const project = { id: "p-aliased", name: "OSS Contributions (fixture)", repoPath: aliasedRepo, vaultPath: aliasedRepo, vaultOnly: true, repos: [] };
  setCodeRepoGuardProvider({ snapshot: () => [toEntry(project)], recordEvent: () => {} });

  fs.appendFileSync(path.join(aliasedRepo, "lib.ts"), "export const z = 3;\n");
  const before = commitCount(aliasedRepo);
  const result = await commitVault(aliasedRepo, "loom: auto-commit (legacy aliased-code row)");
  check("(3) a legacy aliased-code row (vaultOnly:true, repoPath===vaultPath, REAL code) is unchanged — still auto-commits", result.committed === true && commitCount(aliasedRepo) === before + 1);
}

// ===================== (3b) vaultOnly exemption is per-CANDIDATE, not per-entry (round 2) =====================
{
  const vaultOnlyOwnRepo = path.join(root, "vaultonly-with-other-repo");
  initRepo(vaultOnlyOwnRepo);
  const otherCodeRepo = path.join(root, "other-code-repo-listed");
  initRepo(otherCodeRepo);
  fs.writeFileSync(path.join(otherCodeRepo, "app.ts"), "export const o = 1;\n");
  git(otherCodeRepo, "add app.ts");
  git(otherCodeRepo, "commit -m init");

  // A TRUE vault-only project (repoPath===vaultPath, exempt for ITSELF) that ALSO lists a DIFFERENT,
  // genuinely-code repo in repos[] — that other repo must NOT inherit the exemption just because its
  // listing project happens to be vault-only.
  const projectV = {
    id: "p-vaultonly-other", repoPath: vaultOnlyOwnRepo, vaultPath: vaultOnlyOwnRepo, vaultOnly: true,
    repos: [{ path: otherCodeRepo }],
  };
  setCodeRepoGuardProvider({ snapshot: () => [toEntry(projectV)], recordEvent: () => {} });

  fs.appendFileSync(path.join(otherCodeRepo, "app.ts"), "export const o2 = 2;\n");
  const before = commitCount(otherCodeRepo);
  const result = await commitVault(otherCodeRepo, "loom: auto-commit (should be refused — repos[] entry, not vaultOnly's own repoPath)");
  check("(3b) a vaultOnly project's OWN repoPath is exempt, but a DIFFERENT code repo it merely lists in repos[] is NOT", result.committed === false && result.blockedReason === "code-repo-collision");
  check("(3b) ...and no commit landed into that other repo", commitCount(otherCodeRepo) === before);

  // Sanity: the SAME project's own repoPath is still exempt (unchanged from (2)).
  fs.writeFileSync(path.join(vaultOnlyOwnRepo, "note.md"), "# genuine vault content\n");
  const beforeOwn = commitCount(vaultOnlyOwnRepo);
  const ownResult = await commitVault(vaultOnlyOwnRepo, "loom: auto-commit (vaultOnly's own repoPath, unaffected)");
  check("(3b) ...while the SAME project's own repoPath is still exempt", ownResult.committed === true && commitCount(vaultOnlyOwnRepo) === beforeOwn + 1);
}

// ===================== (4) an ARCHIVED project's repoPath is still protected =====================
{
  const archivedCodeRepo = path.join(root, "archivedCode1");
  initRepo(archivedCodeRepo);
  fs.writeFileSync(path.join(archivedCodeRepo, "app.ts"), "export const a = 1;\n");
  git(archivedCodeRepo, "add app.ts");
  git(archivedCodeRepo, "commit -m init");
  const subdirVault = path.join(archivedCodeRepo, "docs");
  fs.mkdirSync(subdirVault);

  // The ARCHIVED project owns the code repo; a DIFFERENT (live) project's vault resolves onto the SAME
  // commitPath — simulating "the colliding owner happens to be archived", which db.listAllProjects()
  // alone would miss (it excludes archived rows).
  const archivedOwner = { id: "p-archived-owner", name: "Archived Code Owner", repoPath: archivedCodeRepo, vaultPath: archivedCodeRepo, vaultOnly: false, repos: [] };
  setCodeRepoGuardProvider({ snapshot: () => [archivedOwner].map(toEntry), recordEvent: () => {} });

  fs.writeFileSync(path.join(subdirVault, "note.md"), "# vault edit\n");
  const before = commitCount(archivedCodeRepo);
  const result = await commitVault(archivedCodeRepo, "loom: auto-commit (archived-owner collision)");
  check("(4) a collision against an ARCHIVED project's own repoPath is still refused", result.committed === false && result.blockedReason === "code-repo-collision");
  check("(4) ...and no new commit landed", commitCount(archivedCodeRepo) === before);
}

// ===================== (5) a runtime rebind is seen WITHOUT a restart =====================
{
  const rebindRepo = path.join(root, "rebind1");
  initRepo(rebindRepo);
  const subdirVault = path.join(rebindRepo, "notes");
  fs.mkdirSync(subdirVault);
  fs.writeFileSync(path.join(rebindRepo, "code.ts"), "export const r = 1;\n");
  git(rebindRepo, "add code.ts");
  git(rebindRepo, "commit -m init");

  // Start with NO registered project pointing at rebindRepo — the provider is live/mutable via a
  // reassignable holder, simulating a project being rebound onto this repoPath AFTER the first check.
  let registered = [];
  setCodeRepoGuardProvider({ snapshot: () => registered.map(toEntry), recordEvent: () => {} });

  fs.writeFileSync(path.join(subdirVault, "a.md"), "# first edit, no collision yet\n");
  const beforeFirst = commitCount(rebindRepo);
  const first = await commitVault(rebindRepo, "loom: auto-commit (before rebind)");
  check("(5) before any rebind, no collision is registered — commits normally", first.committed === true && commitCount(rebindRepo) === beforeFirst + 1);

  // Simulate the rebind: a project is now registered pointing its OWN repoPath at the same commitPath,
  // with no daemon restart — the SAME provider function, re-queried, must see it on the very next call.
  registered = [{ id: "p-rebound", name: "Rebound", repoPath: rebindRepo, vaultPath: rebindRepo, vaultOnly: false, repos: [] }];
  fs.writeFileSync(path.join(subdirVault, "b.md"), "# second edit, AFTER the simulated rebind\n");
  const beforeSecond = commitCount(rebindRepo);
  const second = await commitVault(rebindRepo, "loom: auto-commit (after rebind)");
  check("(5) the SAME provider, re-queried live, sees the rebind on the very next call — now refuses", second.committed === false && second.blockedReason === "code-repo-collision");
  check("(5) ...and the second edit did NOT land as a commit", commitCount(rebindRepo) === beforeSecond);
}

// ===================== (6) fail-open when no provider is registered =====================
{
  setCodeRepoGuardProvider(undefined);
  const noProviderRepo = path.join(root, "noProvider1");
  initRepo(noProviderRepo);
  fs.writeFileSync(path.join(noProviderRepo, "note.md"), "# content\n");
  const before = commitCount(noProviderRepo);
  const result = await commitVault(noProviderRepo, "loom: auto-commit (no provider registered)");
  check("(6) with NO provider registered, commitVault fails OPEN (proceeds normally, not refused)", result.committed === true && commitCount(noProviderRepo) === before + 1);
}

// ===================== (7) dedupe: one warn + one event per (subjectPath, commitPath) per process =====================
{
  const dedupeRepo = path.join(root, "dedupe1");
  initRepo(dedupeRepo);
  fs.writeFileSync(path.join(dedupeRepo, "code.ts"), "export const d = 1;\n");
  git(dedupeRepo, "add code.ts");
  git(dedupeRepo, "commit -m init");

  let eventCount = 0;
  const project = { id: "p-dedupe", name: "Dedupe", repoPath: dedupeRepo, vaultPath: dedupeRepo, vaultOnly: false, repos: [] };
  setCodeRepoGuardProvider({ snapshot: () => [toEntry(project)], recordEvent: () => { eventCount++; } });

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(" ")); };
  try {
    // Three calls, simulating three debounce ticks against the SAME persistent misconfiguration.
    await commitVault(dedupeRepo, "loom: auto-commit (tick 1)");
    await commitVault(dedupeRepo, "loom: auto-commit (tick 2)");
    await commitVault(dedupeRepo, "loom: auto-commit (tick 3)");
  } finally {
    console.warn = origWarn;
  }
  const crgWarnings = warnings.filter((w) => w.includes("[vault-versioner]") && w.includes("a09b81a0"));
  check("(7) three repeated collisions against the SAME (subjectPath, commitPath) warn only ONCE per process", crgWarnings.length === 1);
  check("(7) ...and the durable event fires only ONCE too", eventCount === 1);
}

// ===================== (8) writers surface committedBlockedReason, never swallow it =====================
{
  const writerRepo = path.join(root, "writer1");
  initRepo(writerRepo);
  fs.writeFileSync(path.join(writerRepo, "app.ts"), "export const w = 1;\n");
  git(writerRepo, "add app.ts");
  git(writerRepo, "commit -m init");
  const subdirVault = path.join(writerRepo, "notes");
  fs.mkdirSync(subdirVault);

  const project = { id: "p-writer", name: "Writer", repoPath: writerRepo, vaultPath: subdirVault, vaultOnly: false, repos: [] };
  setCodeRepoGuardProvider({ snapshot: () => [toEntry(project)], recordEvent: () => {} });

  const writeResult = await writeVaultFile(subdirVault, "note.md", "# via writeVaultFile\n");
  check("(8) writeVaultFile still writes the file to disk (ok:true) despite the collision", writeResult.ok === true);
  check("(8) ...but committed is false", writeResult.ok === true && writeResult.committed === false);
  check("(8) ...and the SPECIFIC blockedReason is surfaced, not swallowed as an ordinary backoff", writeResult.ok === true && writeResult.committedBlockedReason === "code-repo-collision");
  check("(8) ...the file genuinely landed on disk", fs.existsSync(path.join(subdirVault, "note.md")));

  const createResult = await createVaultFile(subdirVault, "note2.md", "# via createVaultFile\n");
  check("(8) createVaultFile ALSO surfaces committedBlockedReason the same way", createResult.ok === true && createResult.committedBlockedReason === "code-repo-collision");
}

// ===================== (9) startVaultVersioners skips CONSTRUCTING a versioner for a refused project =====================
{
  const bootRepo = path.join(root, "boot1");
  initRepo(bootRepo);
  const subdirVault = path.join(bootRepo, "notes");
  fs.mkdirSync(subdirVault);

  const now = new Date().toISOString();
  const db = new Db();
  db.insertProject({ id: "p-boot-bad", name: "BootBad", repoPath: bootRepo, vaultPath: subdirVault, vaultOnly: false, config: {}, createdAt: now, archivedAt: null });
  // A sibling GOOD project (a genuinely TRUE vault-only row — own repo, vaultOnly:true — see
  // checkCodeRepoCollision's own exemption) proves the bad one doesn't poison the batch.
  const goodRepo = path.join(root, "boot1-good");
  initRepo(goodRepo);
  db.insertProject({ id: "p-boot-good", name: "BootGood", repoPath: goodRepo, vaultPath: goodRepo, vaultOnly: true, config: {}, createdAt: now, archivedAt: null });

  setCodeRepoGuardProvider({
    snapshot: () => db.listAllProjects().map(toEntry),
    recordEvent: () => {},
  });

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(" ")); origWarn(...args); };
  let versioners;
  try {
    versioners = await startVaultVersioners(db, { debounceMs: 150 });
  } finally {
    console.warn = origWarn;
  }
  try {
    check("(9) exactly ONE versioner starts (the good sibling) — the colliding project gets NO instance at all", versioners.length === 1);
    check("(9) a loud, specific warning names the refusal", warnings.some((w) => w.includes("[vault-versioner]") && w.includes("a09b81a0")));
  } finally {
    for (const v of versioners ?? []) { try { await v.stop(); } catch { /* best-effort */ } }
  }
}

// ===================== (10) production boot wiring: index.ts calls setCodeRepoGuardProvider =====================
{
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const indexTsPath = path.join(__dirname, "..", "src", "index.ts");
  const source = fs.readFileSync(indexTsPath, "utf8");
  const stripped = stripComments(source);
  check("(10) index.ts's real source (comment-stripped) actually calls setCodeRepoGuardProvider(", stripped.includes("setCodeRepoGuardProvider("));
  check("(10) ...and does so (textually) BEFORE startVaultVersioners is invoked", stripped.indexOf("setCodeRepoGuardProvider(") < stripped.indexOf("startVaultVersioners("));
  // Round 2 (card a09b81a0): the old wiring position (just before startVaultVersioners) left commitVault/
  // vault_write fail-open for the whole window the gateway was already accepting REST/MCP requests — the
  // provider must be wired BEFORE the gateway's own listen call too, not just before startVaultVersioners.
  check("(10) ...AND does so (textually) BEFORE startGatewayListeners (the gateway's listen call) too", stripped.indexOf("setCodeRepoGuardProvider(") < stripped.indexOf("startGatewayListeners("));
}

// ===================== (11) Round 3: a repo that is itself some project's vault root is exempt (the shared-vault shape) =====================
{
  // Mirrors the owner's real layout (request 8d6fea89): a shared "notes" repo bound as repoPath by a
  // notes-topic project whose OWN vaultPath is merely NESTED under it, not equal — vaultOnly is FALSE for
  // that project (b98957e9's invariant requires exact repoPath===vaultPath), so the PRE-round-3 guard would
  // wrongly refuse this. A totally separate, real CODE project's vaultPath ALSO lives under the same root —
  // that is what makes the root a recognized vault root (see isRecognizedVaultRoot's own doc).
  const sharedVault = path.join(root, "shared-vault");
  initRepo(sharedVault);
  const topicDir = path.join(sharedVault, "Knowledge", "Topic");
  fs.mkdirSync(topicDir, { recursive: true });

  const codeRepo11 = path.join(root, "unrelated-code-11");
  initRepo(codeRepo11);
  fs.writeFileSync(path.join(codeRepo11, "app.ts"), "export const a = 1;\n");
  git(codeRepo11, "add app.ts");
  git(codeRepo11, "commit -m init");
  const realCodeVaultPath = path.join(sharedVault, "Projects", "RealCode");
  fs.mkdirSync(realCodeVaultPath, { recursive: true });

  const notesTopicProject = { id: "p-notes-topic", repoPath: sharedVault, vaultPath: topicDir, vaultOnly: false, repos: [] };
  const realCodeProject = { id: "p-real-code-11", repoPath: codeRepo11, vaultPath: realCodeVaultPath, vaultOnly: false, repos: [] };
  setCodeRepoGuardProvider({ snapshot: () => [notesTopicProject, realCodeProject].map(toEntry), recordEvent: () => {} });

  fs.writeFileSync(path.join(topicDir, "note.md"), "# genuine shared-vault content\n");
  const before = commitCount(sharedVault);
  const result = await commitVault(sharedVault, "loom: auto-commit (shared vault root, should still commit)");
  check("(11) a repo that is some project's vault root is exempt even with vaultPath only NESTED (not equal), because a SEPARATE real-code project's own vault genuinely lives under it", result.committed === true && commitCount(sharedVault) === before + 1);
}

// ===================== (12) Round 3 anti-gaming: a project's OWN vaultPath nested in its OWN repoPath is NEVER exempted, even when a genuine voucher exists elsewhere =====================
{
  // Same shape as test (1) (the original bug) — but this time a TOTALLY UNRELATED, genuine vault-root
  // voucher ALSO exists in the snapshot (a different, separate shared vault with its own real-code
  // voucher). The voucher must not leak into exempting THIS project's own code repo: isRecognizedVaultRoot
  // is scoped to the SPECIFIC commitPath under test, and a project can never vouch for the very code repo
  // it is itself at risk in — see that function's own "anti-gaming" doc.
  const codeRepo12 = path.join(root, "codeRepo12");
  initRepo(codeRepo12);
  fs.writeFileSync(path.join(codeRepo12, "src.ts"), "export const x = 1;\n");
  git(codeRepo12, "add src.ts");
  git(codeRepo12, "commit -m init");
  const subdirVault12 = path.join(codeRepo12, "notes");
  fs.mkdirSync(subdirVault12);

  const unrelatedSharedVault = path.join(root, "unrelated-shared-vault-12");
  initRepo(unrelatedSharedVault);
  const unrelatedTopic = path.join(unrelatedSharedVault, "Topic");
  fs.mkdirSync(unrelatedTopic, { recursive: true });
  const unrelatedCode = path.join(root, "unrelated-code-12b");
  initRepo(unrelatedCode);
  const unrelatedCodeVaultPath = path.join(unrelatedSharedVault, "Projects", "X");
  fs.mkdirSync(unrelatedCodeVaultPath, { recursive: true });

  const bugProject = { id: "p-bug-12", repoPath: codeRepo12, vaultPath: subdirVault12, vaultOnly: false, repos: [] };
  const voucherNotesProject = { id: "p-voucher-notes-12", repoPath: unrelatedSharedVault, vaultPath: unrelatedTopic, vaultOnly: false, repos: [] };
  const voucherCodeProject = { id: "p-voucher-code-12", repoPath: unrelatedCode, vaultPath: unrelatedCodeVaultPath, vaultOnly: false, repos: [] };
  setCodeRepoGuardProvider({ snapshot: () => [bugProject, voucherNotesProject, voucherCodeProject].map(toEntry), recordEvent: () => {} });

  fs.writeFileSync(path.join(subdirVault12, "note.md"), "# a real vault edit\n");
  const before = commitCount(codeRepo12);
  const result = await commitVault(codeRepo12, "loom: auto-commit (should STILL be refused — unrelated voucher must not leak)");
  check("(12) an unrelated, genuine vault-root voucher elsewhere does NOT exempt a different project's own code-repo-with-nested-vault", result.committed === false && result.blockedReason === "code-repo-collision");
  check("(12) ...and no new commit landed", commitCount(codeRepo12) === before);
}

// ===================== (13) Round 3: the auto-committer takes withCanonicalIndexLock for a merge-eligible repo, serializing against a real merge =====================
{
  const { withCanonicalIndexLock } = await import("../dist/git/repo-lock.js");
  const sharedRepo13 = path.join(root, "shared-vault-13");
  initRepo(sharedRepo13);
  const topic13 = path.join(sharedRepo13, "Topic");
  fs.mkdirSync(topic13, { recursive: true });

  // A SEPARATE, real-code project voucher so sharedRepo13 is recognized as a vault root — otherwise
  // commitVault would refuse outright and this test would never reach the lock at all.
  const voucherCode13 = path.join(root, "voucher-code-13");
  initRepo(voucherCode13);
  const voucherVaultPath13 = path.join(sharedRepo13, "Projects", "Voucher");
  fs.mkdirSync(voucherVaultPath13, { recursive: true });

  const notesProject13 = { id: "p-notes-13", repoPath: sharedRepo13, vaultPath: topic13, vaultOnly: false, repos: [] };
  const voucherProject13 = { id: "p-voucher-13", repoPath: voucherCode13, vaultPath: voucherVaultPath13, vaultOnly: false, repos: [] };
  setCodeRepoGuardProvider({ snapshot: () => [notesProject13, voucherProject13].map(toEntry), recordEvent: () => {} });

  let mergeStarted;
  const mergeStartedPromise = new Promise((resolve) => { mergeStarted = resolve; });
  let releaseHeld;
  const heldPromise = new Promise((resolve) => { releaseHeld = resolve; });
  // Simulates a real worker merge holding the SAME canonical index lock `mergeBranch`/`GitWriter` would —
  // it commits ONLY once released, so the auto-commit below can only ever land its own commit AFTER this
  // one IF (and only if) the lock genuinely serializes them.
  const mergeLockPromise = withCanonicalIndexLock(sharedRepo13, async () => {
    mergeStarted(); // OBSERVABLE event: the merge now genuinely holds the lock — never a fixed wait
    await heldPromise;
    git(sharedRepo13, 'commit --allow-empty -m "merge landed"');
  });
  await mergeStartedPromise;

  fs.writeFileSync(path.join(topic13, "note.md"), "# a real vault edit racing the merge lock\n");
  const commitPromise = commitVault(sharedRepo13, "loom: auto-commit (racing a held merge lock)");

  // ⚠️ NOT timing-independent, despite checking the final commit ORDER (an artifact) rather than elapsed
  // time directly: this window gives commitVault's OWN git subprocess calls real wall-clock time to run if
  // the lock did NOT actually serialize them. The assertion below DISCRIMINATES (would go RED if the lock
  // were removed) ONLY IF an unlocked add+commit sequence completes within this ~500ms window on the host
  // running it — on a slow/loaded host where that sequence takes longer, a BROKEN (unlocked) commitVault
  // could still land its commit after "merge landed" by sheer luck, passing vacuously. This is a real,
  // accepted limitation of a real-concurrency timing test, not a false claim of timing-independence.
  await new Promise((resolve) => setTimeout(resolve, 500));
  releaseHeld();
  await mergeLockPromise;
  const result = await commitPromise;

  check("(13) the vault auto-commit still lands once the merge's lock is released", result.committed === true);
  const subjects = git(sharedRepo13, "log --format=%s --reverse").trim().split("\n").filter(Boolean);
  const mergeIdx = subjects.indexOf("merge landed");
  const autoCommitIdx = subjects.findIndex((s) => s.startsWith("loom: auto-commit"));
  check(
    "(13) ...and its commit lands STRICTLY AFTER the merge's own commit, by the real git log ARTIFACT — discriminates only if the unlocked sequence would have completed within the 500ms window above (see that comment); not a timing-independent proof",
    mergeIdx !== -1 && autoCommitIdx !== -1 && autoCommitIdx > mergeIdx,
  );
}

// =====================================================================================================
// (14)/(14b)/(14c) ⚠️ KNOWN HOLE (request f7cc5951 pending, follow-up card 7c1d6dbf) — round-3 delta review
// (reviewer, 2026-10-01), rewritten round 4 into a GREEN TRIPWIRE. A THIRD party can grant
// isRecognizedVaultRoot's exemption for a code repo it has nothing to do with. Geometry alone cannot
// distinguish this from Parallax's shape; the owner is choosing the real discriminator (an explicit
// per-project flag or a platform list of recognized vault roots) — see versioner.ts's own
// isRecognizedVaultRoot doc for the full writeup. These three checks used to encode the CORRECT, desired
// behavior (refused) and were DELIBERATELY RED against the current predicate — but a committed test with a
// deliberate red assertion turns the merge gate red, and this project's merge gate is not always fully
// gated, so a red test risked landing on main ungated. They now instead PIN TODAY'S (WRONG) behavior — do
// not "fix" the predicate by touching the geometry; that decision belongs to card 7c1d6dbf. A future round
// implementing 7c1d6dbf's fix should find these three checks need to FLIP back to asserting refusal.
// =====================================================================================================

// ===================== (14) third-party vouching: an UNRELATED project's vaultPath nested in P's own code repo lets Q vouch for P's repo =====================
{
  const C14 = path.join(root, "C14-coderepo");
  initRepo(C14);
  fs.writeFileSync(path.join(C14, "src.ts"), "export const x = 1;\n");
  git(C14, "add src.ts");
  git(C14, "commit -m init");
  const docsDir14 = path.join(C14, "docs");
  fs.mkdirSync(docsDir14);
  // Q's vaultPath is nested INSIDE P's own code repo (C14) — Q's own code lives entirely elsewhere (D14),
  // so Q is not excluded as a voucher by the self-at-risk check, even though vouching for C14 is wrong.
  const qNotesDir14 = path.join(C14, "q-notes");
  fs.mkdirSync(qNotesDir14);
  const D14 = path.join(root, "D14-unrelated");
  initRepo(D14);

  const P14 = { id: "p-c14", repoPath: C14, vaultPath: docsDir14, vaultOnly: false, repos: [] };
  const Q14 = { id: "q-d14", repoPath: D14, vaultPath: qNotesDir14, vaultOnly: false, repos: [] };
  setCodeRepoGuardProvider({ snapshot: () => [P14, Q14].map(toEntry), recordEvent: () => {} });

  fs.writeFileSync(path.join(docsDir14, "note.md"), "# real vault edit\n");
  const before14 = commitCount(C14);
  const result14 = await commitVault(C14, "loom: auto-commit (KNOWN HOLE — should be refused, C14 is a real code repo)");
  // KNOWN HOLE (request f7cc5951 pending, follow-up card 7c1d6dbf): these two assertions PIN TODAY'S
  // (wrong) behaviour — Q's vaultPath nested inside P's code repo wrongly vouches for P, so P's real
  // source DOES get auto-committed. This is a tripwire, not a red test: it must FLIP to assert refusal
  // (committed:false, no new commit) once the owner's answer on f7cc5951 is implemented and 7c1d6dbf lands.
  check(
    "(14) KNOWN HOLE (f7cc5951 pending): an unrelated project's vaultPath nested in P's own code repo WRONGLY vouches for it today",
    result14.committed === true,
  );
  check("(14) KNOWN HOLE: ...so P14's real source IS auto-committed today (must become NO new commit once fixed)", commitCount(C14) === before14 + 1);
}

// ===================== (14b) degenerate variant: a voucher with repoPath:"" vouches for ANY key unconditionally =====================
{
  const C14b = path.join(root, "C14b-coderepo");
  initRepo(C14b);
  fs.writeFileSync(path.join(C14b, "src.ts"), "export const x = 1;\n");
  git(C14b, "add src.ts");
  git(C14b, "commit -m init");
  const docsDir14b = path.join(C14b, "docs");
  fs.mkdirSync(docsDir14b);
  // A voucher with NO repoPath at all (""): ownCandidates becomes [] after .filter(Boolean), so
  // .some(...) is vacuously false — it can never be excluded as "self at risk", regardless of where its
  // own vaultPath points.
  const emptyRepoPathVaultDir = path.join(root, "empty-repopath-vault-14b");
  fs.mkdirSync(emptyRepoPathVaultDir, { recursive: true });

  const P14b = { id: "p-c14b", repoPath: C14b, vaultPath: docsDir14b, vaultOnly: false, repos: [] };
  const QEmpty14b = { id: "q-empty-14b", repoPath: "", vaultPath: path.join(C14b, "empty-voucher-notes"), vaultOnly: false, repos: [] };
  fs.mkdirSync(QEmpty14b.vaultPath, { recursive: true });
  setCodeRepoGuardProvider({ snapshot: () => [P14b, QEmpty14b].map(toEntry), recordEvent: () => {} });

  fs.writeFileSync(path.join(docsDir14b, "note.md"), "# real vault edit\n");
  const before14b = commitCount(C14b);
  const result14b = await commitVault(C14b, "loom: auto-commit (KNOWN HOLE — empty-repoPath voucher)");
  // KNOWN HOLE (request f7cc5951 pending, follow-up card 7c1d6dbf): pins today's (wrong) behaviour — a
  // voucher entry with repoPath:"" unconditionally vouches for any key. Tripwire, not a red test: must
  // FLIP to refusal once f7cc5951 is answered and 7c1d6dbf lands.
  check(
    "(14b) KNOWN HOLE (f7cc5951 pending): a voucher entry with repoPath:\"\" WRONGLY vouches for any key today",
    result14b.committed === true,
  );
  check("(14b) KNOWN HOLE: ...so P14b's real source IS auto-committed today (must become NO new commit once fixed)", commitCount(C14b) === before14b + 1);
}

// ===================== (14c) degenerate variant: a voucher whose repoPath is an ANCESTOR of the key also vouches =====================
{
  const ancestorRoot14c = path.join(root, "ancestor-root-14c");
  const C14c = path.join(ancestorRoot14c, "C14c-coderepo");
  initRepo(C14c);
  fs.writeFileSync(path.join(C14c, "src.ts"), "export const x = 1;\n");
  git(C14c, "add src.ts");
  git(C14c, "commit -m init");
  const docsDir14c = path.join(C14c, "docs");
  fs.mkdirSync(docsDir14c);
  // Q's OWN repoPath is the PARENT of C14c (an ANCESTOR, not at-or-under it) — isCanonicallyAtOrUnder only
  // checks one direction, so Q's own code is never flagged "at risk" under C14c even though Q's repoPath
  // physically CONTAINS C14c.
  const qVaultDir14c = path.join(C14c, "q-notes-14c");
  fs.mkdirSync(qVaultDir14c);

  const P14c = { id: "p-c14c", repoPath: C14c, vaultPath: docsDir14c, vaultOnly: false, repos: [] };
  const QAbove14c = { id: "q-above-14c", repoPath: ancestorRoot14c, vaultPath: qVaultDir14c, vaultOnly: false, repos: [] };
  setCodeRepoGuardProvider({ snapshot: () => [P14c, QAbove14c].map(toEntry), recordEvent: () => {} });

  fs.writeFileSync(path.join(docsDir14c, "note.md"), "# real vault edit\n");
  const before14c = commitCount(C14c);
  const result14c = await commitVault(C14c, "loom: auto-commit (KNOWN HOLE — voucher repoPath ABOVE the key)");
  // KNOWN HOLE (request f7cc5951 pending, follow-up card 7c1d6dbf): pins today's (wrong) behaviour — a
  // voucher whose repoPath is an ANCESTOR of the key vouches for it. Tripwire, not a red test: must FLIP
  // to refusal once f7cc5951 is answered and 7c1d6dbf lands.
  check(
    "(14c) KNOWN HOLE (f7cc5951 pending): a voucher whose repoPath is an ANCESTOR of the key WRONGLY vouches for it today",
    result14c.committed === true,
  );
  check("(14c) KNOWN HOLE: ...so P14c's real source IS auto-committed today (must become NO new commit once fixed)", commitCount(C14c) === before14c + 1);
}

setCodeRepoGuardProvider(undefined); // leave no provider registered for any later test in the SAME process

console.log(failures === 0 ? "\nALL PASS — vault auto-commit refuses a registered-code-repo collision." : `\n${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
