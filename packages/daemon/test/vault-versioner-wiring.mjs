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
//       the externally-managed backoff (a vault nested in a larger repo is NOT committed).
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

const now = new Date().toISOString();
const db = new Db();
// p1 + p2 SHARE vaultA (dedupe target); p3 → vaultB; p4 has NO vaultPath (skip); p5 is archived (skip).
db.insertProject({ id: "p1", name: "P1", repoPath: vaultA, vaultPath: vaultA, config: {}, createdAt: now, archivedAt: null });
db.insertProject({ id: "p2", name: "P2", repoPath: vaultA, vaultPath: vaultA, config: {}, createdAt: now, archivedAt: null });
db.insertProject({ id: "p3", name: "P3", repoPath: vaultB, vaultPath: vaultB, config: {}, createdAt: now, archivedAt: null });
db.insertProject({ id: "p4", name: "P4", repoPath: root, vaultPath: "", config: {}, createdAt: now, archivedAt: null });
db.insertProject({ id: "p5", name: "P5", repoPath: vaultB, vaultPath: path.join(root, "vaultArchived"), config: {}, createdAt: now, archivedAt: now });

const versioners = [];
try {
  // Short debounce so the live chokidar path commits quickly for (b).
  versioners.push(...await startVaultVersioners(db, { debounceMs: 150 }));

  // (a)+(c): exactly 2 watchers — vaultA (deduped p1+p2) + vaultB; empty (p4) and archived (p5) skipped.
  check("one watcher per UNIQUE vault (dedupe + skip empty/archived)", versioners.length === 2);
  check("each started handle is a VaultVersioner", versioners.every((v) => v instanceof VaultVersioner));

  // (b): a filesystem edit to a vault doc auto-commits via the wired chokidar→debounce→commit path.
  const beforeA = commitCount(vaultA);
  fs.writeFileSync(path.join(vaultA, "doc.md"), "# edited by an agent (rewrite-in-place)\n");
  check("a vault doc edit auto-commits via the live watcher", await waitFor(() => commitCount(vaultA) > beforeA));

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

  // (d, backoff): a vault nested inside a LARGER repo (root ABOVE the vault folder) is externally managed
  // — flushSync must NOT commit it (no double-committing an Obsidian-Git-managed vault).
  const outer = path.join(root, "outer");
  initVault(outer);
  const nested = path.join(outer, "vault");
  fs.mkdirSync(nested);
  const vn = new VaultVersioner(nested, 10_000);
  await vn.start();
  fs.writeFileSync(path.join(nested, "note.md"), "must NOT be committed by loom\n");
  const beforeOuter = commitCount(outer);
  check("flushSync skips an externally-managed vault", vn.flushSync() === false);
  check("externally-managed vault got no loom commit", commitCount(outer) === beforeOuter);
  await vn.stop();
} finally {
  for (const v of versioners) { try { await v.stop(); } catch { /* best-effort */ } }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
}

console.log(failures === 0 ? "\nALL PASS — VaultVersioner is wired + flushes on shutdown." : `\n${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
