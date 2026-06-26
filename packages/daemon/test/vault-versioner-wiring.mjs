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

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-vv-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { startVaultVersioners, VaultVersioner } = await import("../dist/vault/versioner.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// realpath so paths match `git rev-parse --show-toplevel` (symlinked tmp on macOS, drive-letter case on
// Windows) — otherwise the start()/flushSync externally-managed check could misfire.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "loom-vv-")));
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
async function waitFor(fn, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return false;
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

const versioners = [];
try {
  // Short debounce so the live chokidar path commits quickly for (b).
  versioners.push(...await startVaultVersioners(db, { debounceMs: 150 }));

  // (a)+(c)+(e): exactly 4 watchers — vaultA (deduped p1+p2) + vaultB + plainRepo ROOT (deduped p6+p7
  // subfolders) + vaultD (pGood, started DESPITE the earlier-iterating pBad throwing). Empty (p4),
  // archived (p5), Obsidian-Git-managed (p8), and the throwing pBad are skipped.
  check("one watcher per UNIQUE repo root (dedupe + skip empty/archived/obsidian-git)", versioners.length === 4);
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
} finally {
  for (const v of versioners) { try { await v.stop(); } catch { /* best-effort */ } }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
}

console.log(failures === 0 ? "\nALL PASS — VaultVersioner is wired + flushes on shutdown." : `\n${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
