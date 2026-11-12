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

// ===================== (8) the refusal text no longer tells the owner to restart =====================
{
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => { warns.push(a.join(" ")); origWarn(...a); };
  const { vault } = ancestorLayout("text1");
  sharedRoots = [];
  const v = await startedVersioner(vault);
  await v.commit();
  console.warn = origWarn;
  check("(8) the refusal warning names the list and does NOT demand a daemon restart", warns.some((w) => w.includes("sharedVaultRoots") && w.includes("no restart needed")) && !warns.some((w) => /RESTART the daemon/i.test(w)));
}

// ===================== (9) daa5d02f: a PATCH listing a boot-refused root starts it live =====================
{
  const { buildServer } = await import("../dist/gateway/server.js");
  const now = new Date().toISOString();
  const proj = (id, vaultPath) => ({ id, name: id, repoPath: "", vaultPath, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [], vaultOnly: false });
  const a = ancestorLayout("resc-a");
  const b = ancestorLayout("resc-b");
  const db = new Db(path.join(root, "resc.db"));
  const evs = () => db.listRecentEventsByKinds(["vault_autocommit_refused_code_repo"]).map((e) => e.detail);
  const reasonsFor = (vaultPath, reason) => evs().filter((d) => d.vaultPath === vaultPath && d.reason === reason).length;
  setCodeRepoGuardProvider({
    snapshot: () => [], sharedVaultRoots: () => db.getPlatformConfig().sharedVaultRoots ?? [],
    recordEvent: (detail) => db.appendEvent({ id: `e-${Math.random().toString(36).slice(2)}`, ts: new Date().toISOString(), managerSessionId: "", kind: "vault_autocommit_refused_code_repo", detail }),
  });
  db.insertProject(proj("rescA", a.vault));
  db.insertProject(proj("rescB", b.vault));
  const versioners = await startVaultVersioners(db, { debounceMs: 60_000 });
  check("(9) both unlisted ancestor vaults are refused at boot (no watcher, one durable refusal each)", versioners.length === 0 && reasonsFor(a.vault, "unrecognized-ancestor-root") === 1 && reasonsFor(b.vault, "unrecognized-ancestor-root") === 1);

  let rescans = 0;
  let chain = Promise.resolve();
  const stub = {};
  const app = await buildServer({
    db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, control: stub, usageStatus: stub,
    // Same shape as index.ts's wiring: serialized, rescan against the live watched list.
    onSharedVaultRootsChanged: async () => {
      rescans++;
      chain = chain.then(async () => { versioners.push(...await startVaultVersioners(db, { debounceMs: 60_000, rescan: { watched: versioners } })); }, () => undefined);
      await chain;
    },
  });
  try {
    // An unrelated PATCH (sharedVaultRoots unchanged) must not trigger a rescan.
    const noop = await app.inject({ method: "PATCH", url: "/api/platform/config", payload: { watchers: { wakeMs: 120000 } } });
    check("(9) a PATCH that leaves sharedVaultRoots alone does not rescan", noop.statusCode === 200 && rescans === 0 && versioners.length === 0);

    // Listing only A's root: A starts, B (still unlisted) stays refused.
    const before = commitCount(a.home);
    const res = await app.inject({ method: "PATCH", url: "/api/platform/config", payload: { sharedVaultRoots: [a.home] } });
    check("(9) the PATCH listing A's root succeeds and rescans exactly once", res.statusCode === 200 && rescans === 1);
    check("(9) A's boot-refused vault now has a versioner on A's root (no restart); B's is NOT started", versioners.length === 1 && path.resolve(versioners[0].commitRoot) === path.resolve(a.home));
    check("(9) the -cleared event is filed for A exactly once and never for B", reasonsFor(a.vault, "unrecognized-ancestor-root-cleared") === 1 && reasonsFor(b.vault, "unrecognized-ancestor-root-cleared") === 0);
    check("(9) B's still-unlisted refusal is NOT re-filed by the rescan", reasonsFor(b.vault, "unrecognized-ancestor-root") === 1);
    await versioners[0].commit();
    check("(9) A's vault actually COMMITS after the PATCH (real git commit landed, vault note tracked)", commitCount(a.home) === before + 1 && git(a.home, "ls-files").includes("notes/n.md"));
    check("(9) B's repo was never staged or committed", git(b.home, "status --porcelain").includes("?? notes/") && commitCount(b.home) === 1);

    // No double start: a second PATCH re-listing A (plus B) starts only B, never A again.
    const res2 = await app.inject({ method: "PATCH", url: "/api/platform/config", payload: { sharedVaultRoots: [a.home, b.home] } });
    check("(9) a later PATCH listing B starts B only — A is not double-started", res2.statusCode === 200 && versioners.length === 2 && new Set(versioners.map((v) => path.resolve(v.commitRoot))).size === 2);
    // Re-running the rescan with everything watched starts nothing and files no second clear.
    const again = await startVaultVersioners(db, { debounceMs: 60_000, rescan: { watched: versioners } });
    check("(9) a rescan with every root already watched starts nothing and files no second clear", again.length === 0 && reasonsFor(a.vault, "unrecognized-ancestor-root-cleared") === 1 && reasonsFor(b.vault, "unrecognized-ancestor-root-cleared") === 1);

    // Removing a root does NOT stop the running watcher; its per-tick commit() refuses instead.
    await app.inject({ method: "PATCH", url: "/api/platform/config", payload: { sharedVaultRoots: [b.home] } });
    fs.writeFileSync(path.join(a.vault, "after-removal.md"), "# x\n");
    const cA = commitCount(a.home);
    await versioners.find((v) => path.resolve(v.commitRoot) === path.resolve(a.home)).commit();
    check("(9) removing A's root leaves its watcher running but its next commit() REFUSES", versioners.length === 2 && commitCount(a.home) === cA);
  } finally {
    await app.close();
    for (const v of versioners) await v.stop();
    db.close();
    setCodeRepoGuardProvider({ snapshot: () => [], sharedVaultRoots: () => sharedRoots, recordEvent: (d) => events.push(d) });
  }
}

// ===================== (10) daa5d02f review round: re-refusal cycle, throwing start, boot interleave, flush budget =====================
{
  const now = new Date().toISOString();
  const proj = (id, vaultPath) => ({ id, name: id, repoPath: "", vaultPath, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [], vaultOnly: false });
  const db = new Db(path.join(root, "round2.db"));
  const dbRoots = [];
  setCodeRepoGuardProvider({
    snapshot: () => [], sharedVaultRoots: () => dbRoots,
    recordEvent: (detail) => db.appendEvent({ id: `e-${Math.random().toString(36).slice(2)}`, ts: new Date().toISOString(), managerSessionId: "", kind: "vault_autocommit_refused_code_repo", detail }),
  });
  const count = (vaultPath, reason, source) => db.listRecentEventsByKinds(["vault_autocommit_refused_code_repo"]).filter((e) => e.detail?.vaultPath === vaultPath && e.detail?.reason === reason && (!source || e.detail?.source === source)).length;
  const L = ancestorLayout("round2-a");
  db.insertProject(proj("r2", L.vault));
  const watched = [];

  // (10a) a start() that THROWS must not file the -cleared event (the alert stays); a later good start does.
  await startVaultVersioners(db, { debounceMs: 60_000 });
  check("(10a) boot refusal filed", count(L.vault, "unrecognized-ancestor-root", "boot") === 1);
  dbRoots.push(L.home);
  const realStart = VaultVersioner.prototype.start;
  VaultVersioner.prototype.start = async function () { throw new Error("injected start failure"); };
  const origWarn10 = console.warn; console.warn = () => {};
  const failed = await startVaultVersioners(db, { debounceMs: 60_000, rescan: { watched } });
  console.warn = origWarn10;
  VaultVersioner.prototype.start = realStart;
  check("(10a) a throwing start() starts nothing AND files NO -cleared event", failed.length === 0 && count(L.vault, "unrecognized-ancestor-root-cleared") === 0);
  watched.push(...await startVaultVersioners(db, { debounceMs: 60_000, rescan: { watched } }));
  check("(10a) (positive control) the retry after a good start files the -cleared event once", watched.length === 1 && count(L.vault, "unrecognized-ancestor-root-cleared") === 1);

  // (10b) remove -> re-add -> remove: the SECOND removal files the refusal again (dedupe re-armed by the clear).
  dbRoots.length = 0;
  await watched[0].commit();
  check("(10b) first removal: the running watcher's commit() files an auto_commit refusal", count(L.vault, "unrecognized-ancestor-root", "auto_commit") === 1);
  dbRoots.push(L.home);
  await startVaultVersioners(db, { debounceMs: 60_000, rescan: { watched } }); // re-add: clears the open refusal
  check("(10b) re-add files a second -cleared", count(L.vault, "unrecognized-ancestor-root-cleared") === 2);
  dbRoots.length = 0;
  await watched[0].commit();
  check("(10b) second removal files the auto_commit refusal AGAIN (not silenced by the stale dedupe key)", count(L.vault, "unrecognized-ancestor-root", "auto_commit") === 2);
  // Negative control: without a clear in between, a repeat refusal stays deduped.
  await watched[0].commit();
  check("(10b) (negative control) a repeat tick with no clear in between stays deduped", count(L.vault, "unrecognized-ancestor-root", "auto_commit") === 2);
  for (const v of watched) await v.stop();
  db.close();
  setCodeRepoGuardProvider({ snapshot: () => [], sharedVaultRoots: () => sharedRoots, recordEvent: (d) => events.push(d) });

  // (10c) index.ts source order: vaultVersioners + chain gate hoisted ABOVE buildServer; the boot start opens the gate
  // after pushing; the rescan hook chains on the gate. (comment-stripped; positive control: the scan sees each token)
  const src = stripComments(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts"), "utf8"));
  const at = (n) => src.indexOf(n);
  const decl = at("const vaultVersioners: VaultVersioner[] = []");
  const gateDecl = at("let vaultRescanChain");
  const build = at("await buildServer({");
  const bootStart = at("vaultVersioners.push(...await startVaultVersioners(db))");
  const gateOpen = at("openVaultBootGate();", bootStart);
  const hook = at("vaultRescanChain = vaultRescanChain.then(");
  check("(10c) (positive control) the scan finds every anchor", [decl, gateDecl, build, bootStart, gateOpen, hook].every((i) => i > 0));
  check("(10c) vaultVersioners and the chain gate are declared BEFORE buildServer", decl < build && gateDecl < build);
  check("(10c) the rescan hook chains on the gate, which the boot start opens only after it ran", hook > build && gateOpen > bootStart && bootStart > build);
  check("(10c) (negative control) the pre-fix shape (`let vaultVersioners ... = await startVaultVersioners(db)` after buildServer) is gone", at("vaultVersioners = await startVaultVersioners(db)") < 0 && at("let vaultVersioners") < 0);

  // (10d) flush budget is read LIVE: setShutdownCleanup accepts a getter, and a vault added later raises the budget.
  const { SessionService } = await import("../dist/sessions/service.js");
  const { computeFlushVaultsStepBudgetMs } = await import("../dist/graceful-teardown.js");
  const fakeThis = {};
  const live = [];
  SessionService.prototype.setShutdownCleanup.call(fakeThis, () => {}, () => computeFlushVaultsStepBudgetMs(live.length));
  const b0 = fakeThis.shutdownCleanup.flushVaultsStepBudgetMs;
  live.push({}, {});
  const b2 = fakeThis.shutdownCleanup.flushVaultsStepBudgetMs;
  check("(10d) a vault started after registration raises the shutdown flush budget", b0 === computeFlushVaultsStepBudgetMs(0) && b2 === computeFlushVaultsStepBudgetMs(2) && b2 > b0);
  const fake2 = {};
  SessionService.prototype.setShutdownCleanup.call(fake2, () => {}, 1234);
  check("(10d) a plain number budget still works unchanged", fake2.shutdownCleanup.flushVaultsStepBudgetMs === 1234);
  check("(10d) index.ts passes a getter and reads it live at the graceful step", src.includes("const flushVaultsStepBudgetMs = (): number =>") && src.includes('step("flushVaultsAndStopCodescape", flushVaultsStepBudgetMs())'));
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
