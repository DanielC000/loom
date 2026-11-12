import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card f098fbd9 — the vault auto-committer refuses to stage/commit when the vault's resolved git toplevel is an
// ANCESTOR repo that is neither the vault dir itself nor a recognized shared vault root (the 7c1d6dbf
// `sharedVaultRoots` predicate). REAL git, no mocks. Observable anchors (no fixed waits): the refusal's own
// recordEvent callback, and git's commit count.
//   (1) RED on main: a dotfiles-style repo ABOVE an unregistered vault — commit() and flushSync() refuse, no new
//       commit lands despite a real uncommitted edit; startVaultVersioners starts NO watcher for it; one durable
//       event per (vault, root, source) carries reason "unrecognized-ancestor-root".
//   (2) a vault under a repo LISTED in sharedVaultRoots still commits (commit() and flushSync()).
//   (3) a vault that IS its own toplevel still commits, listed or not.
//   (4) the list is read LIVE: removing the entry flips the next commit() to refused.
//   (5) ordering: index.ts registers the provider, then seeds sharedVaultRoots, BEFORE startVaultVersioners
//       (comment-stripped source scan, with a positive control that the scan can see the call order).
// Run after build: node test/vault-commit-ancestor-root-refusal.mjs
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempManaged, finishAndExit, useOwnLoomHome } from "./_tmp-fixture.mjs";
import { stripComments } from "./_strip-comments.mjs";

useOwnLoomHome("loom-ar-home-");
const { Db } = await import("../dist/db.js");
const { VaultVersioner, startVaultVersioners, setCodeRepoGuardProvider } = await import("../dist/vault/versioner.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const root = fs.realpathSync(mkdtempManaged("loom-ar-"));
const git = (cwd, args) => execSync(`git ${args}`, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init");
  git(dir, "config user.email loom-ar@example.com");
  git(dir, "config user.name loom-ar");
}
const commitCount = (dir) => parseInt(git(dir, "rev-list --all --count").trim() || "0", 10);

let sharedRoots = [];
let events = [];
setCodeRepoGuardProvider({ snapshot: () => [], sharedVaultRoots: () => sharedRoots, recordEvent: (d) => events.push(d) });
const ancestorEvents = (src) => events.filter((e) => e.reason === "unrecognized-ancestor-root" && (!src || e.source === src));

// Builds <root>/<name>/ (a repo with one commit, like a dotfiles repo) containing a vault subfolder.
function ancestorLayout(name) {
  const home = path.join(root, name);
  initRepo(home);
  fs.writeFileSync(path.join(home, ".bashrc"), "export A=1\n");
  git(home, "add .bashrc");
  git(home, "commit -m init");
  const vault = path.join(home, "notes");
  fs.mkdirSync(vault);
  fs.writeFileSync(path.join(vault, "n.md"), "# note\n");
  return { home, vault };
}
async function startedVersioner(vault) {
  const v = new VaultVersioner(vault, 60_000);
  await v.start();
  await v.stop(); // watcher not needed: commit()/flushSync() are driven directly
  return v;
}

// ===================== (1) RED: unregistered ancestor =====================
{
  const { home, vault } = ancestorLayout("dotfiles1");
  sharedRoots = [];
  events = [];
  const v = await startedVersioner(vault);
  const before = commitCount(home);
  await v.commit();
  check("(1) commit() REFUSES an unrecognized ancestor toplevel: no new commit despite a real uncommitted edit", commitCount(home) === before);
  check("(1) ...and the untracked vault file was never staged (git status still shows it untracked)", git(home, "status --porcelain").includes("?? notes/"));
  check("(1) ...with one durable event naming the reason + both paths", ancestorEvents("auto_commit").length === 1 && ancestorEvents("auto_commit")[0].commitPath === home && ancestorEvents("auto_commit")[0].vaultPath === vault);
  await v.commit();
  check("(1) ...deduped: a second tick does not file a second event", ancestorEvents("auto_commit").length === 1);
  check("(1) flushSync() ALSO refuses (its own raw `git add -A`)", v.flushSync() === false && commitCount(home) === before);
  check("(1) ...with its own flush_sync event", ancestorEvents("flush_sync").length === 1);

  // Boot path: startVaultVersioners starts no watcher for the refused vault.
  const db = new Db(path.join(root, "boot1.db"));
  const now = new Date().toISOString();
  db.insertProject({ id: "pb1", name: "pb1", repoPath: "", vaultPath: vault, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [], vaultOnly: false });
  events = [];
  const started = await startVaultVersioners(db, { debounceMs: 60_000 });
  check("(1) startVaultVersioners starts NO versioner for the refused vault", started.length === 0);
  check("(1) ...and files a boot-source event carrying the project id", ancestorEvents("boot").length === 1 && ancestorEvents("boot")[0].projectId === "pb1");
  // Positive control for the boot assertion: the SAME project with the root listed DOES start one.
  sharedRoots = [home];
  const started2 = await startVaultVersioners(db, { debounceMs: 60_000 });
  check("(1) (positive control) the same project starts a versioner once the ancestor is listed", started2.length === 1);
  for (const s of started2) await s.stop();
  db.close();
}

// ===================== (2) listed shared root still commits =====================
{
  const { home, vault } = ancestorLayout("shared1");
  sharedRoots = [home];
  events = [];
  const v = await startedVersioner(vault);
  const before = commitCount(home);
  await v.commit();
  check("(2) a vault under a LISTED shared root still auto-commits", commitCount(home) === before + 1);
  fs.writeFileSync(path.join(vault, "n2.md"), "# more\n");
  check("(2) ...and flushSync() commits too", v.flushSync() === true && commitCount(home) === before + 2);
  check("(2) ...with no refusal event", ancestorEvents().length === 0);

  // ===================== (4) live list =====================
  fs.writeFileSync(path.join(vault, "n3.md"), "# live\n");
  sharedRoots = [];
  const b2 = commitCount(home);
  await v.commit();
  check("(4) removing the list entry flips the NEXT commit() to refused (list read live)", commitCount(home) === b2 && ancestorEvents("auto_commit").length === 1);
}

// ===================== (3) vault is its own toplevel =====================
{
  const own = path.join(root, "own-vault");
  initRepo(own);
  fs.writeFileSync(path.join(own, "n.md"), "# own\n");
  sharedRoots = [];
  events = [];
  const v = await startedVersioner(own);
  const before = commitCount(own);
  await v.commit();
  check("(3) a vault that IS its own toplevel commits with an EMPTY list", commitCount(own) === before + 1 && ancestorEvents().length === 0);
}

// ===================== (3b) own toplevel spelled non-canonically still commits =====================
{
  const own = path.join(root, "own-vault-spelled");
  initRepo(own);
  fs.writeFileSync(path.join(own, "n.md"), "# own\n");
  const link = path.join(root, "own-vault-link");
  fs.symlinkSync(own, link, "junction");
  sharedRoots = [];
  events = [];
  const v = await startedVersioner(link);
  const before = commitCount(own);
  await v.commit();
  check("(3b) a vault spelled through a junction to its own toplevel commits (no false ancestor refusal)", commitCount(own) === before + 1 && ancestorEvents().length === 0);
  if (process.platform === "win32") {
    const own2 = path.join(root, "own-vault-case");
    initRepo(own2);
    fs.writeFileSync(path.join(own2, "n.md"), "# own\n");
    const v2 = await startedVersioner(own2.toUpperCase());
    const b2 = commitCount(own2);
    await v2.commit();
    check("(3b) ...and a case-variant spelling commits too (win32)", commitCount(own2) === b2 + 1 && ancestorEvents().length === 0);
  }
}

// ===================== (6) fail-open when no provider is wired =====================
{
  const { home, vault } = ancestorLayout("unwired1");
  setCodeRepoGuardProvider(undefined);
  const v = await startedVersioner(vault);
  const before = commitCount(home);
  await v.commit();
  check("(6) with NO provider wired the ancestor check fails open (a unit test with no boot-wired Db still commits)", commitCount(home) === before + 1);
  setCodeRepoGuardProvider({ snapshot: () => [], sharedVaultRoots: () => sharedRoots, recordEvent: (d) => events.push(d) });
}

// ===================== (7) boot-loop ordering / carve-outs / clear event =====================
{
  const now = new Date().toISOString();
  const proj = (id, vaultPath) => ({ id, name: id, repoPath: "", vaultPath, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [], vaultOnly: false });

  // (7a) an Obsidian-Git-managed ancestor is backed off, NEVER refused (no event).
  {
    const { home, vault } = ancestorLayout("obsgit1");
    fs.mkdirSync(path.join(home, ".obsidian", "plugins", "obsidian-git"), { recursive: true });
    sharedRoots = [];
    events = [];
    const db = new Db(path.join(root, "boot7a.db"));
    db.insertProject(proj("p7a", vault));
    const started = await startVaultVersioners(db, { debounceMs: 60_000 });
    check("(7a) an externally-managed (Obsidian-Git) ancestor starts nothing AND files no refusal event", started.length === 0 && ancestorEvents().length === 0);
    db.close();
  }
  // (7b) the unlisted root is ANOTHER live project's own vault: no event for the subfolder project; the
  // root-vault project's own watcher starts. Negative control: without that other project, the event IS filed.
  {
    const { home, vault } = ancestorLayout("rootvault1");
    sharedRoots = [];
    events = [];
    const db = new Db(path.join(root, "boot7b.db"));
    db.insertProject(proj("p7b-sub", vault));
    db.insertProject(proj("p7b-root", home));
    const started = await startVaultVersioners(db, { debounceMs: 60_000 });
    check("(7b) the root's own project starts its watcher; the subfolder project files NO refusal event", started.length === 1 && ancestorEvents().length === 0);
    for (const s of started) await s.stop();
    db.close();
    const db2 = new Db(path.join(root, "boot7b2.db"));
    db2.insertProject(proj("p7b-sub", vault));
    events = [];
    const started2 = await startVaultVersioners(db2, { debounceMs: 60_000 });
    check("(7b) (negative control) the same subfolder project WITHOUT a root-vault sibling does file the event", started2.length === 0 && ancestorEvents("boot").length === 1);
    db2.close();
  }
  // (7c) a durable refusal is superseded by a durable -cleared event at the first boot where the vault passes.
  {
    const { home, vault } = ancestorLayout("clear1");
    const db = new Db(path.join(root, "boot7c.db"));
    setCodeRepoGuardProvider({
      snapshot: () => [], sharedVaultRoots: () => sharedRoots,
      recordEvent: (detail) => db.appendEvent({ id: `e-${Math.random().toString(36).slice(2)}`, ts: new Date().toISOString(), managerSessionId: "", kind: "vault_autocommit_refused_code_repo", detail }),
    });
    db.insertProject(proj("p7c", vault));
    sharedRoots = [];
    await startVaultVersioners(db, { debounceMs: 60_000 });
    const reasons = () => db.listRecentEventsByKinds(["vault_autocommit_refused_code_repo"]).map((e) => e.detail?.reason);
    check("(7c) the boot refusal is durable", reasons().includes("unrecognized-ancestor-root") && !reasons().includes("unrecognized-ancestor-root-cleared"));
    sharedRoots = [home];
    const started = await startVaultVersioners(db, { debounceMs: 60_000 });
    check("(7c) after the owner lists the root, the next boot starts the vault AND files the -cleared event", started.length === 1 && reasons().includes("unrecognized-ancestor-root-cleared"));
    await startVaultVersioners(db, { debounceMs: 60_000 }).then((s) => Promise.all(s.map((x) => x.stop())));
    check("(7c) ...exactly once (a further boot files no second clear)", reasons().filter((r) => r === "unrecognized-ancestor-root-cleared").length === 1);
    for (const s of started) await s.stop();
    db.close();
    setCodeRepoGuardProvider({ snapshot: () => [], sharedVaultRoots: () => sharedRoots, recordEvent: (d) => events.push(d) });
  }
}

// ===================== (8) the refusal text tells the owner to restart =====================
{
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => { warns.push(a.join(" ")); origWarn(...a); };
  const { vault } = ancestorLayout("text1");
  sharedRoots = [];
  const v = await startedVersioner(vault);
  await v.commit();
  console.warn = origWarn;
  check("(8) the refusal warning names the list and says a DAEMON RESTART is needed", warns.some((w) => w.includes("sharedVaultRoots") && w.includes("RESTART the daemon")));
}

// ===================== (5) boot ordering =====================
{
  const src = stripComments(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts"), "utf8"));
  const at = (needle) => src.indexOf(needle);
  const provider = at("setCodeRepoGuardProvider({");
  const seed = at("seedSharedVaultRootsOnce(db)");
  const start = at("startVaultVersioners(db)");
  check("(5) (positive control) the scan finds all three call sites", provider > 0 && seed > 0 && start > 0);
  check("(5) the shared-roots seed runs BEFORE startVaultVersioners", seed > 0 && start > 0 && seed < start);
  check("(5) the guard provider (which exposes the list) is registered BEFORE the seed", provider > 0 && provider < seed);
  const noneEv = at('"shared-roots-seed-none"');
  const ambEv = at('"shared-roots-seed-ambiguous"');
  check("(5) a seed none/ambiguous outcome files a durable event, right after the seed and before the versioners start", noneEv > seed && ambEv > seed && noneEv < start && ambEv < start);
}

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
await finishAndExit(failures === 0 ? 0 : 1);
