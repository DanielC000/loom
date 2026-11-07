import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// The SAME-hash tmp sweep recognises exactly the filename shapes boot's PASS 1b does
// (`.json.tmp-<pid>[-<hex>]`): a hand-placed `<hash>.json.tmp-foo` holding another repo's tokens is
// neither armed nor deleted by a clear, matching what a reboot does with it (card 008610d5).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq0086-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);
const mod = await import(mergeQuarantineModuleHref);
const { enterMergeQuarantine } = mod;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const tmpDirs = [];
function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mq0086-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-008610d5 (${tag})\n`);
  execSync(`git init -q && git config user.email mq0086@loom && git config user.name mq0086`, { cwd: repo });
  commitAll(repo, "init", "-c user.email=mq0086@loom -c user.name=mq0086");
  return repo;
}
let bootCounter = 0;
const freshBootModule = async () => import(`${mergeQuarantineModuleHref}?b=${++bootCounter}`);
const hashOf = (key) => createHash("sha256").update(key).digest("hex").slice(0, 24);
function plantRaw(hash, content, suffix) {
  fs.mkdirSync(mod.MERGE_QUARANTINE_DIR, { recursive: true });
  const p = path.join(mod.MERGE_QUARANTINE_DIR, `${hash}.json.tmp-${suffix}`);
  fs.writeFileSync(p, JSON.stringify(content));
  return p;
}
const clearDir = () => { for (const f of fs.readdirSync(mod.MERGE_QUARANTINE_DIR)) fs.unlinkSync(path.join(mod.MERGE_QUARANTINE_DIR, f)); };

try {
  // ── (A) NON-matching name at the cleared repo's OWN hash: neither armed nor deleted; a reboot agrees.
  {
    const r = makeRepo("a-r");
    const u = path.join(r, "ghost-a"); // no own .git: shares r's canonical key
    fs.mkdirSync(u, { recursive: true });
    const uToken = randomUUID();
    const tmp = plantRaw(hashOf(canonicalRepoLockKey(r)), { repoPath: u, reason: "no branch", enteredAt: Date.now() - 1000, tokens: [uToken] }, "foo");
    enterMergeQuarantine(r, "loom/r", "r's own raise");
    mod.clearMergeQuarantine(r);
    check("(A) the non-matching tmp is NOT armed (U not blocked in-process)", mod.stillBlockedEntryFor(u) === undefined && mod.assertRepoNotQuarantined(u).ok === true);
    check("(A) the non-matching tmp is NOT deleted by the clear sweep", fs.existsSync(tmp));
    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([r]);
    check("(A) a reboot also ignores it: U not blocked", fresh.assertRepoNotQuarantined(u).ok === true);
    check("(A) a reboot leaves it on disk", fs.existsSync(tmp));
  }

  // ── (B) POSITIVE control: the SAME content under a strict-shaped name IS armed (otherwise (A) proves nothing).
  {
    clearDir();
    const r = makeRepo("b-r");
    const u = path.join(r, "ghost-b");
    fs.mkdirSync(u, { recursive: true });
    const uToken = randomUUID();
    plantRaw(hashOf(canonicalRepoLockKey(r)), { repoPath: u, reason: "no branch", enteredAt: Date.now() - 1000, tokens: [uToken] }, "80001-bbbb0001");
    enterMergeQuarantine(r, "loom/r", "r's own raise");
    mod.clearMergeQuarantine(r);
    check("(B) control: a strict-shaped name IS armed with the file's own token", mod.stillBlockedEntryFor(u)?.tokens?.[0] === uToken);
  }

  // ── (C) protectForeignTmpResidueBeforeSweep's own scan: an UNRESOLVABLE (never-existing) foreign repoPath in a
  // NON-strict name at the cleared key's hash is not relocated, not touched, and not blocked after a reboot.
  // The strict-named twin (control) is protected (its content survives under a different name or is kept).
  {
    clearDir();
    const e = makeRepo("c-e");
    const z = path.join(os.tmpdir(), `loom-mq0086-c-z-never-exists-${freshSfx()}`);
    const zToken = "c-disjoint-token-0001";
    const tmp = plantRaw(hashOf(canonicalRepoLockKey(e)), { repoPath: z, branch: "zb", reason: "foreign, unresolvable", enteredAt: Date.now() - 1000, tokens: [zToken] }, "foo");
    const bytes = fs.readFileSync(tmp);
    const t = enterMergeQuarantine(e, "loom/e", "e's own raise");
    const before = new Set(fs.readdirSync(mod.MERGE_QUARANTINE_DIR));
    mod.clearMergeQuarantineByToken(e, t);
    const after = fs.readdirSync(mod.MERGE_QUARANTINE_DIR);
    check("(C) the non-strict foreign tmp is untouched (still there, same bytes)", fs.existsSync(tmp) && fs.readFileSync(tmp).equals(bytes));
    check("(C) no relocated record is written (no new file appears)", after.every((f) => before.has(f)));
    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([e, z]);
    check("(C) a reboot does not block the foreign path either", fresh.stillBlockedEntryFor(z) === undefined && fresh.assertRepoNotQuarantined(z).ok === true);

    // control: the same content under a strict name IS protected (relocated to a new file, or kept)
    clearDir();
    const e2 = makeRepo("c-e2");
    const tmp2 = plantRaw(hashOf(canonicalRepoLockKey(e2)), { repoPath: z, branch: "zb", reason: "foreign, unresolvable", enteredAt: Date.now() - 1000, tokens: [zToken] }, "80002-cccc0002");
    const t2 = enterMergeQuarantine(e2, "loom/e2", "e2's own raise");
    const before2 = new Set(fs.readdirSync(mod.MERGE_QUARANTINE_DIR));
    mod.clearMergeQuarantineByToken(e2, t2);
    const after2 = fs.readdirSync(mod.MERGE_QUARANTINE_DIR);
    check("(C) control: a strict-named foreign tmp IS protected (relocated to a new file)", after2.some((f) => !before2.has(f)) && !fs.existsSync(tmp2));
  }

  // ── (D) the includeSafetyTmp branch: a same-hash `.tmp-safety-<pid>-<hex>` residue holding a foreign token is
  // armed by a clear (as boot's safety pass arms it by content).
  {
    clearDir();
    const r = makeRepo("d-r");
    const u = path.join(r, "ghost-d"); // shares r's canonical key
    fs.mkdirSync(u, { recursive: true });
    const uToken = randomUUID();
    const tmp = plantRaw(hashOf(canonicalRepoLockKey(r)), { repoPath: u, reason: "no branch", enteredAt: Date.now() - 1000, tokens: [uToken] }, "safety-80003-dddd0003");
    enterMergeQuarantine(r, "loom/r", "r's own raise");
    mod.clearMergeQuarantine(r);
    check("(D) the safety-tmp's foreign token is armed in-process", mod.stillBlockedEntryFor(u)?.tokens?.includes(uToken) === true && fs.existsSync(tmp));
    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([r]);
    check("(D) a reboot agrees: U is blocked by the safety-tmp's token", fresh.assertRepoNotQuarantined(u).ok === false);
  }

  // ── (E) the physical-record re-verification ignores a lingering NON-strict file: it must not withhold the
  // durable tombstone (boot ignores that file). Control: the same file under a strict name still withholds it.
  {
    clearDir();
    const sidecar = () => { const p = path.join(process.env.LOOM_HOME, "merge-quarantine-cleared-tokens.dat"); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {}; };
    // Token-aware re-verification (partial-clear path): raise t1,t2; clear t1; plant a lingering file holding t2;
    // clear t2 (full lift). Returns whether t2 was durably tombstoned, plus the identity for a reboot leg.
    const run = (tag, suffix) => {
      const b = path.join(os.tmpdir(), `loom-mq0086-e-${tag}-never-exists-${freshSfx()}`);
      const t1 = enterMergeQuarantine(b, "loom/e1", `${tag} raise 1`);
      const t2 = enterMergeQuarantine(b, "loom/e2", `${tag} raise 2`);
      mod.clearMergeQuarantineByToken(b, t1);
      plantRaw("a".repeat(24), { repoPath: b, branch: "loom/e-lingering", reason: "lingering", enteredAt: Date.now(), tokens: [t2] }, suffix);
      mod.clearMergeQuarantineByToken(b, t2);
      return { b, t2, tombstoned: sidecar()[t2] !== undefined };
    };
    check("(E) a lingering NON-strict file (`.tmp-foo`) does not withhold the durable tombstone", run("lax", "foo").tombstoned === true);
    check("(E) a lingering NESTED-suffix file (`.tmp-1-ab.tmp-2-cd`) does not withhold it either", run("nested", "1-ab.tmp-2-cd").tombstoned === true);
    check("(E) control: the same file under a strict name still withholds it", run("strict", "80004-eeee0004").tombstoned === false);
    // Fail-open direction: a SAFETY-shaped residue is a real record boot arms by content, so it must withhold
    // the tombstone AND the block must survive a reboot (a tombstone would let boot drop the safety tmp).
    const safety = run("safety", "safety-80005-ffff0005");
    check("(E) a lingering SAFETY-shaped residue WITHHOLDS the durable tombstone", safety.tombstoned === false);
    const freshE = await freshBootModule();
    freshE.reenterMergeQuarantinesAtBoot([safety.b]);
    check("(E) ...and a reboot still blocks the path (the safety residue is not dropped)", freshE.stillBlockedEntryFor(safety.b)?.tokens?.includes(safety.t2) === true);

    // (F) the identity-wide PENDING-tier clear (identityHasAnyPhysicalRecordOnDisk): raise t1 on an unresolvable
    // path, plant a lingering file for that identity at an unrelated hash, clear by recorded path.
    const runF = (tag, suffix) => {
      const b = path.join(os.tmpdir(), `loom-mq0086-f-${tag}-never-exists-${freshSfx()}`);
      const t1 = enterMergeQuarantine(b, "loom/f1", `${tag} raise`);
      plantRaw("b".repeat(24), { repoPath: b, branch: "loom/f-lingering", reason: "lingering", enteredAt: Date.now(), tokens: [t1] }, suffix);
      mod.clearMergeQuarantineByRecordedPath(b);
      return sidecar()[t1] !== undefined;
    };
    check("(F) pending-tier identity-wide clear: a lingering NON-strict file does not withhold the tombstone", runF("lax", "foo") === true);
    check("(F) control: the same file under a strict name withholds it", runF("strict", "80006-aaaa0006") === false);
  }
} finally {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

if (failures > 0) { console.log(`\n${failures} FAILED`); process.exit(1); }
console.log("\nall passed");
