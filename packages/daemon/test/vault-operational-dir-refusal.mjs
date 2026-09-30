// Card 68cc29db: `vault/versioner.ts`'s `commitVault` used to `git init` + `git add .` on a NON-repo
// vault path unconditionally — including an OPERATIONAL vault dir (a reserved home whose `vaultPath` is
// bound to LOOM_HOME, e.g. the Platform/setup homes — see `platform/seed.ts`/`setup/seed.ts`). The only
// existing guard, `isOperationalVaultDir`, was wired into `startVaultVersioners`'s boot loop ONLY — never
// on the WRITE path (`vault/writer.ts`'s writeVaultFile/createVaultFile/deleteVaultFile call `commitVault`
// directly, no versioner in between). A vault write reaching a reserved home would stage the live
// loom.db/-wal/-shm, backups/, logs/, worker worktrees/ (node_modules), the Python venv, and any
// secrets-bearing file living in LOOM_HOME. See docs/decisions/68cc29db-refuse-operational-vault-dir-writes.md.
//
// HERMETIC: a fresh, temp LOOM_HOME (own mkdtemp, no `ensureDirs()` call — so deliberately NO
// `.gitignore`, matching the card's DoD: "a temp LOOM_HOME and no .gitignore"). Proves:
//   (a) commitVault refuses to git-init/commit LOOM_HOME itself — the chokepoint every caller reaches;
//   (b) writeVaultFile/createVaultFile/deleteVaultFile refuse BEFORE touching disk — no file lands in
//       LOOM_HOME at all, not just "no commit";
//   (c) NO `.git` directory is ever created inside LOOM_HOME by any of the above;
//   (d) the OTHER two isOperationalVaultDir signals (a `loom.db` file, a `worktrees/` dir) are refused too,
//       not just exact LOOM_HOME equality;
//   (e) NEGATIVE CONTROL: an ordinary, non-operational vault is completely unaffected — still writes,
//       still commits, still creates `.git` — so a broken predicate that refuses EVERYTHING can't hide
//       behind (a)-(d) passing;
//   (f) Code Review follow-up finding: a vaultPath that is an ANCESTOR of LOOM_HOME/WORKTREES_DIR (e.g.
//       the user's home dir bound as vaultPath by mistake, or via manager `project_update` / setup
//       `project_create`) is ALSO operational — it would still stage loom.db/secrets/worktrees into
//       `git add .`. See docs/decisions/68cc29db-refuse-operational-vault-dir-writes.md's ancestor addendum;
//   (g) NEGATIVE CONTROL for (f): a plain SIBLING of LOOM_HOME under the same parent (not an ancestor of
//       either LOOM_HOME or WORKTREES_DIR) still writes/commits normally.
// Run after build: node test/vault-operational-dir-refusal.mjs
import { requireHermeticEnv } from "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

// Own, fresh, FULLY-CONTROLLED LOOM_HOME, nested under a `home` dir we also control — deliberately NOT
// `useOwnLoomHome` (which may just reuse whatever the runner already assigned): the ancestor-dir tests (f)
// below need to know the exact parent of LOOM_HOME so they can bind IT as a vaultPath, and need
// LOOM_HOME/WORKTREES_DIR to be real SIBLINGS under that SAME parent — exactly the shape a real user's
// home dir has (`~/.loom` + `~/.loom-worktrees`). `fixtureRoot` is registered for guaranteed cleanup (card
// 995be21f); `home`/`loomHomePath` live inside it, so cleaning up the root cleans up everything. Deliberately
// NEVER call ensureDirs()/write a .gitignore, so this is exactly the "temp LOOM_HOME with no .gitignore"
// shape the card's DoD names.
const fixtureRoot = mkdtempManaged("loom-op-dir-refusal-");
const home = path.join(fixtureRoot, "home"); // mimics a real user's home dir (parent of .loom/.loom-worktrees)
const loomHomePath = path.join(home, ".loom");
fs.mkdirSync(loomHomePath, { recursive: true });
process.env.LOOM_HOME = loomHomePath;
requireHermeticEnv(); // confirms LOOM_HOME is the temp dir just established above, never the real ~/.loom
const loomHome = fs.realpathSync(loomHomePath);

const { writeVaultFile, createVaultFile, deleteVaultFile } = await import("../dist/vault/writer.js");
const { commitVault, isOperationalVaultDir } = await import("../dist/vault/versioner.js");
const { WORKTREES_DIR } = await import("../dist/paths.js");
// Fixture sanity: WORKTREES_DIR really is a SIBLING of LOOM_HOME under `home` (paths.ts derives it as
// `dirname(LOOM_HOME)/${basename(LOOM_HOME)}-worktrees`) — the real shape the ancestor tests below rely on.
if (path.resolve(path.dirname(WORKTREES_DIR)) !== path.resolve(home)) {
  throw new Error(`fixture precondition failed: WORKTREES_DIR (${WORKTREES_DIR}) is not a sibling of LOOM_HOME under ${home}`);
}

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const git = (cwd, args) => execSync(`git ${args}`, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
function initVault(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init");
  git(dir, "config user.email loom-test@example.com");
  git(dir, "config user.name loom-test");
}

// Sanity: this test's fixture actually IS what isOperationalVaultDir detects — not a broken assumption.
check("fixture precondition: LOOM_HOME has no .gitignore yet", !fs.existsSync(path.join(loomHome, ".gitignore")));
check("fixture precondition: isOperationalVaultDir(LOOM_HOME) is true", isOperationalVaultDir(loomHome));
check("fixture precondition: LOOM_HOME has no .git yet", !fs.existsSync(path.join(loomHome, ".git")));

// (a) commitVault itself refuses — the chokepoint every caller reaches.
{
  const committed = await commitVault(loomHome, "loom: should never land");
  check("commitVault(LOOM_HOME, ...) returns false (refused)", committed === false);
  check("commitVault did not git-init LOOM_HOME", !fs.existsSync(path.join(loomHome, ".git")));
}

// (b)+(c) the writer path refuses BEFORE touching disk — the actual defect (RED on old code: old
// writeVaultFile had no such check and would have written the file + git-inited LOOM_HOME).
{
  const w = await writeVaultFile(loomHome, "notes/pwned.md", "should never be written");
  check("writeVaultFile to LOOM_HOME is refused", w.ok === false && w.reason === "operational-dir");
  check("writeVaultFile did not create the file on disk", !fs.existsSync(path.join(loomHome, "notes", "pwned.md")));
  check("writeVaultFile did not git-init LOOM_HOME", !fs.existsSync(path.join(loomHome, ".git")));

  const c = await createVaultFile(loomHome, "notes/pwned2.md", "should never be written");
  check("createVaultFile to LOOM_HOME is refused", c.ok === false && c.reason === "operational-dir");
  check("createVaultFile did not create the file on disk", !fs.existsSync(path.join(loomHome, "notes", "pwned2.md")));
  check("createVaultFile did not git-init LOOM_HOME", !fs.existsSync(path.join(loomHome, ".git")));

  const d = await deleteVaultFile(loomHome, "notes/pwned.md");
  check("deleteVaultFile against LOOM_HOME is refused (not a bare 'not-found')", d.ok === false && d.reason === "operational-dir");
  check("deleteVaultFile did not git-init LOOM_HOME", !fs.existsSync(path.join(loomHome, ".git")));
}

// (d) the other two isOperationalVaultDir signals — content markers, not just exact LOOM_HOME equality —
// are refused too, via a SEPARATE dir (not LOOM_HOME) so this genuinely exercises the content-signal path.
const scratchRoot = fs.realpathSync(mkdtempManaged("loom-op-dir-refusal-scratch-"));
{
  const opDb = path.join(scratchRoot, "opDb");
  fs.mkdirSync(opDb, { recursive: true });
  fs.writeFileSync(path.join(opDb, "loom.db"), "");
  check("isOperationalVaultDir detects a loom.db-marked dir", isOperationalVaultDir(opDb));
  const w = await writeVaultFile(opDb, "notes/pwned.md", "should never be written");
  check("writeVaultFile refuses a loom.db-marked dir", w.ok === false && w.reason === "operational-dir");
  check("no file landed under the loom.db-marked dir", !fs.existsSync(path.join(opDb, "notes", "pwned.md")));
  check("no .git created under the loom.db-marked dir", !fs.existsSync(path.join(opDb, ".git")));

  const opWt = path.join(scratchRoot, "opWt");
  fs.mkdirSync(path.join(opWt, "worktrees"), { recursive: true });
  check("isOperationalVaultDir detects a worktrees/-marked dir", isOperationalVaultDir(opWt));
  const w2 = await writeVaultFile(opWt, "notes/pwned.md", "should never be written");
  check("writeVaultFile refuses a worktrees/-marked dir", w2.ok === false && w2.reason === "operational-dir");
  check("no .git created under the worktrees/-marked dir", !fs.existsSync(path.join(opWt, ".git")));
}

// (f) ANCESTOR-OF-LOOM_HOME CHECK (Code Review follow-up on card 68cc29db): a vaultPath that is an
// ANCESTOR of LOOM_HOME (e.g. the user's home dir itself, bound by mistake — reachable via manager
// `project_update` or setup `project_create`) must ALSO be refused; `startVaultVersioners` would otherwise
// watch + commit the whole home dir. Reproduces the exact reviewer repro: LOOM_HOME populated with
// loom.db/worktrees/secret.env, vaultPath = its parent.
{
  fs.writeFileSync(path.join(loomHome, "loom.db"), "");
  fs.mkdirSync(path.join(loomHome, "worktrees"), { recursive: true });
  fs.writeFileSync(path.join(loomHome, "secret.env"), "SECRET=should-never-be-committed\n");
  fs.mkdirSync(WORKTREES_DIR, { recursive: true }); // real sibling of LOOM_HOME — see fixture sanity check above

  check("isOperationalVaultDir detects the ANCESTOR of LOOM_HOME (the home dir itself)", isOperationalVaultDir(home));

  const wAncestor = await writeVaultFile(home, "notes/x.md", "should never be written");
  check("writeVaultFile against an ANCESTOR of LOOM_HOME is refused (RED on the pre-ancestor-check code)", wAncestor.ok === false && wAncestor.reason === "operational-dir");
  check("no file landed under the ancestor (home) dir", !fs.existsSync(path.join(home, "notes", "x.md")));
  check("no .git created under the ancestor (home) dir", !fs.existsSync(path.join(home, ".git")));
  // The exact reviewer repro's failure shape on old code: `git ls-files` from inside `home` would have
  // shown `.loom/loom.db` and `.loom/secret.env` staged — proven impossible here since no .git ever exists.
  check("secret.env was never staged (no repo exists to stage it into)", !fs.existsSync(path.join(home, ".git", "index")));

  const cAncestor = await createVaultFile(home, "notes/y.md", "should never be written");
  check("createVaultFile against an ANCESTOR of LOOM_HOME is refused", cAncestor.ok === false && cAncestor.reason === "operational-dir");
  const dAncestor = await deleteVaultFile(home, "notes/y.md");
  check("deleteVaultFile against an ANCESTOR of LOOM_HOME is refused", dAncestor.ok === false && dAncestor.reason === "operational-dir");

  // commitVault itself (the versioner's own tick, and the chokepoint every writer reaches) also refuses —
  // not just the writer-level pre-disk guard.
  const committedAncestor = await commitVault(home, "loom: should never land");
  check("commitVault(ancestor-of-LOOM_HOME, ...) returns false (refused)", committedAncestor === false);
  check("commitVault did not git-init the ancestor (home) dir either", !fs.existsSync(path.join(home, ".git")));
}

// (g) NEGATIVE CONTROL for (f): a plain SIBLING of LOOM_HOME under the SAME parent (`home`) — NOT an
// ancestor of LOOM_HOME or WORKTREES_DIR — must be completely unaffected by the new ancestor check.
{
  const siblingVault = path.join(home, "notes-vault");
  initVault(siblingVault);
  check("isOperationalVaultDir does NOT flag a sibling dir of LOOM_HOME", !isOperationalVaultDir(siblingVault));
  const wSibling = await writeVaultFile(siblingVault, "notes/hello.md", "# hello\n");
  check("negative control: a sibling-of-LOOM_HOME vault write still succeeds", wSibling.ok === true && wSibling.committed === true);
  check("negative control: the file actually landed on disk", fs.readFileSync(path.join(siblingVault, "notes", "hello.md"), "utf8").includes("hello"));
  check("negative control: .git WAS created for the sibling vault", fs.existsSync(path.join(siblingVault, ".git")));
}

// (e) NEGATIVE CONTROL: an ordinary, non-operational vault is completely unaffected by this guard — proves
// the refusal is discriminating, not a blanket "everything fails now" regression hiding behind (a)-(d).
{
  const normalVault = path.join(scratchRoot, "normalVault");
  initVault(normalVault);
  const w = await writeVaultFile(normalVault, "notes/hello.md", "# hello\n");
  check("negative control: an ordinary vault write still succeeds", w.ok === true && w.committed === true);
  check("negative control: the file actually landed on disk", fs.readFileSync(path.join(normalVault, "notes", "hello.md"), "utf8").includes("hello"));
  check("negative control: .git WAS created for an ordinary vault", fs.existsSync(path.join(normalVault, ".git")));
  check("negative control: the write actually committed", git(normalVault, "log --pretty=%s").includes("loom: write notes/hello.md (via UI)"));
}

console.log(failures === 0 ? "\nALL PASS — operational vault dirs refuse init/commit/write; ordinary vaults unaffected." : `\n${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
