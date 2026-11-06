import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// A clear that keeps an UNARMABLE tmp residue (no `branch`/`reason`) naming repo X arms X's placeholder in
// memory, salvaging the file's own tokens, so in-process and a reboot agree.
//
// @decision 63569b55
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq6356-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);
const mod = await import(mergeQuarantineModuleHref);
const { enterMergeQuarantine } = mod;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mq6356-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-63569b55 (${tag})\n`);
  execSync(`git init -q && git config user.email mq6356@loom && git config user.name mq6356`, { cwd: repo });
  commitAll(repo, "init", "-c user.email=mq6356@loom -c user.name=mq6356");
  return repo;
}
let bootCounter = 0;
const freshBootModule = async () => import(`${mergeQuarantineModuleHref}?b=${++bootCounter}`);
const hashOf = (key) => createHash("sha256").update(key).digest("hex").slice(0, 24);
// Raw tmp residue at `hash` (a `.json.tmp-<pid>-<hex>` name boot's strict filter accepts).
function plantRaw(hash, content, suffix) {
  fs.mkdirSync(mod.MERGE_QUARANTINE_DIR, { recursive: true });
  const p = path.join(mod.MERGE_QUARANTINE_DIR, `${hash}.json.tmp-${suffix}`);
  fs.writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
  return p;
}
// Snapshot right after the clear (before any verdict query that could mutate), restore before a reboot leg.
const snapshotDir = (dir) => new Map(fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f))]));
function restoreDirSnapshot(dir, snap) {
  for (const f of fs.readdirSync(dir)) if (!snap.has(f)) fs.unlinkSync(path.join(dir, f));
  for (const [f, c] of snap) fs.writeFileSync(path.join(dir, f), c);
}

try {
  // ── (A) THE FIX: cross-hash residue, X a ghost subdir of Y. In-process == reboot; one more clear un-sticks.
  {
    const y = makeRepo("a-y");
    const r = makeRepo("a-r");
    const x = path.join(y, "ghost-a");
    fs.mkdirSync(x, { recursive: true });
    enterMergeQuarantine(y, "loom/y", "y's own raise");
    const xToken = randomUUID();
    const tmp = plantRaw(hashOf(canonicalRepoLockKey(r)), { repoPath: x, reason: "no branch", enteredAt: Date.now() - 1000, tokens: [xToken] }, "70001-aaaa0001");
    const res = mod.clearMergeQuarantine(y);
    check("(A) X is a routed still-blocked co-occupant, not content-kept", !!res.stillBlockedCoOccupants?.some((c) => c.repoPath === x) && !res.contentKeptRepoPaths?.includes(x));
    check("(A) the tmp is left untouched on disk (no unlink in the arm)", fs.existsSync(tmp));
    const snap = snapshotDir(mod.MERGE_QUARANTINE_DIR);
    const entry = mod.stillBlockedEntryFor(x);
    check("(A) X's in-memory entry is a placeholder carrying the FILE's own token (salvaged, not fresh)", entry?.placeholder === true && entry.tokens.length === 1 && entry.tokens[0] === xToken);
    check("*** (A) GOVERNING INVARIANT *** assertRepoNotQuarantined(X) is blocked in-process", mod.assertRepoNotQuarantined(x).ok === false);
    check("(A) the innocent filename claimant R stays open", mod.stillBlockedEntryFor(r) === undefined);
    restoreDirSnapshot(mod.MERGE_QUARANTINE_DIR, snap);
    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([y, r]);
    check("*** (A) in-process and reboot AGREE on X ***", fresh.assertRepoNotQuarantined(x).ok === false);
    check("(A) reboot leaves R open", fresh.stillBlockedEntryFor(r) === undefined);

    // Un-stick in-process: clear Y again lifts the shared key (X's placeholder) and deletes the tmp.
    restoreDirSnapshot(mod.MERGE_QUARANTINE_DIR, snap);
    const second = mod.clearMergeQuarantine(y);
    check("(A) a second clear(y) lifts Y and X", second.liftedRepoPaths?.includes(y) && second.liftedRepoPaths?.includes(x));
    check("(A) ...and the tmp is now deleted (its token was covered)", !fs.existsSync(tmp));
    check("(A) X and Y open in-process", mod.assertRepoNotQuarantined(x).ok === true && mod.assertRepoNotQuarantined(y).ok === true);
    const fresh2 = await freshBootModule();
    fresh2.reenterMergeQuarantinesAtBoot([y, r]);
    check("*** (A) a reboot after the un-stick stays clear (no cleared-in-process / blocked-after-reboot split) ***", fresh2.assertRepoNotQuarantined(x).ok === true && fresh2.assertRepoNotQuarantined(y).ok === true);
  }

  // ── (A2) the other un-stick route: clear X by its own path.
  {
    const y = makeRepo("a2-y");
    const r = makeRepo("a2-r");
    const x = path.join(y, "ghost-a2");
    fs.mkdirSync(x, { recursive: true });
    enterMergeQuarantine(y, "loom/y", "y's own raise");
    const tmp = plantRaw(hashOf(canonicalRepoLockKey(r)), { repoPath: x, reason: "no branch", enteredAt: Date.now() - 1000, tokens: [randomUUID()] }, "70002-aaaa0002");
    mod.clearMergeQuarantine(y);
    mod.clearMergeQuarantine(x);
    check("(A2) clear(x) lifts X in-process and deletes the tmp", mod.assertRepoNotQuarantined(x).ok === true && !fs.existsSync(tmp));
    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([y, r]);
    check("(A2) reboot after clear(x) stays clear", fresh.assertRepoNotQuarantined(x).ok === true && fresh.assertRepoNotQuarantined(y).ok === true);
  }

  // ── (B) a TOKENLESS unarmable residue holds nothing to enforce: the existing sweep deletes it (pre-existing,
  // unchanged), so there is no placeholder to arm and nothing for a reboot to re-derive.
  {
    const y = makeRepo("b-y");
    const r = makeRepo("b-r");
    const x = path.join(y, "ghost-b");
    fs.mkdirSync(x, { recursive: true });
    enterMergeQuarantine(y, "loom/y", "y's own raise");
    const tmp = plantRaw(hashOf(canonicalRepoLockKey(r)), { repoPath: x, reason: "no branch, no tokens", enteredAt: Date.now() - 1000 }, "70003-aaaa0003");
    const res = mod.clearMergeQuarantine(y);
    check("(B) tokenless unarmable residue is swept (nothing to enforce) and X is not armed", res.contentKeptRepoPaths?.includes(x) !== true && mod.stillBlockedEntryFor(x) === undefined && !fs.existsSync(tmp));
  }

  // ── (C) negative: a NON-ABSOLUTE repoPath is never an identity.
  {
    const y = makeRepo("c-y");
    enterMergeQuarantine(y, "loom/y", "y's own raise");
    plantRaw(hashOf(canonicalRepoLockKey(y)), { repoPath: "relative/dir", reason: "no branch", enteredAt: Date.now() - 1000, tokens: [randomUUID()] }, "70004-aaaa0004");
    mod.clearMergeQuarantine(y);
    check("(C) a relative repoPath is not armed", mod.stillBlockedEntryFor("relative/dir") === undefined && mod.stillBlockedEntryFor(y) === undefined);
  }

  // ── (D) negative: the clearer's OWN unarmable residue is never re-armed (excludeIdentities respected).
  {
    const y = makeRepo("d-y");
    enterMergeQuarantine(y, "loom/y", "y's own raise");
    plantRaw(hashOf(canonicalRepoLockKey(y)), { repoPath: y, reason: "no branch", enteredAt: Date.now() - 1000, tokens: [randomUUID()] }, "70005-aaaa0005");
    mod.clearMergeQuarantine(y);
    check("(D) the clearer's own unarmable residue does not re-block it", mod.stillBlockedEntryFor(y) === undefined && mod.assertRepoNotQuarantined(y).ok === true);
  }

  // ── (E) negative: T already enforced by its own real raise => plain skip, never a union.
  {
    const y = makeRepo("e-y");
    const t = makeRepo("e-t");
    enterMergeQuarantine(y, "loom/y", "y's own raise");
    const tTok = enterMergeQuarantine(t, "loom/t", "t's own, independent, still-live raise");
    plantRaw(hashOf(canonicalRepoLockKey(y)), { repoPath: t, reason: "no branch", enteredAt: Date.now() - 1000, tokens: [randomUUID()] }, "70006-aaaa0006");
    mod.clearMergeQuarantine(y);
    const te = mod.stillBlockedEntryFor(t);
    check("(E) T's entry is exactly its own raise: same single token, not a placeholder, nothing unioned", te?.tokens.length === 1 && te.tokens[0] === tTok && te.placeholder !== true);
    mod.clearMergeQuarantine(t);
  }

  // ── (F) the SAME-HASH arm site: U's branchless tmp sits at the CLEARED repo's OWN hash (covTmp's original
  // fixture). Reverting the same-hash site alone must turn this RED.
  {
    // Earlier scenarios (C's relative-path tmp) leave residue that a later boot would defensively broadcast.
    for (const f of fs.readdirSync(mod.MERGE_QUARANTINE_DIR)) fs.unlinkSync(path.join(mod.MERGE_QUARANTINE_DIR, f));
    const r = makeRepo("f-r");
    const u = path.join(r, "ghost-subdir-f"); // no own .git: shares r's canonical key
    fs.mkdirSync(u, { recursive: true });
    const uToken = randomUUID();
    const tmp = plantRaw(hashOf(canonicalRepoLockKey(r)), { repoPath: u, reason: "no branch", enteredAt: Date.now() - 1000, tokens: [uToken] }, "70007-aaaa0007");
    enterMergeQuarantine(r, "loom/r", "r's own raise");
    const res = mod.clearMergeQuarantine(r);
    check("(F) U is a still-blocked co-occupant (same-hash site), not content-kept", !!res.stillBlockedCoOccupants?.some((c) => c.repoPath === u) && !res.contentKeptRepoPaths?.includes(u));
    check("(F) U carries the file's own token and the tmp is untouched", mod.stillBlockedEntryFor(u)?.tokens?.[0] === uToken && fs.existsSync(tmp));
    check("(F) r is re-blocked via the shared key, in-process", mod.assertRepoNotQuarantined(r).ok === false);
    const snap = snapshotDir(mod.MERGE_QUARANTINE_DIR);
    restoreDirSnapshot(mod.MERGE_QUARANTINE_DIR, snap);
    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([r]);
    check("*** (F) the reboot AGREES: U and r both blocked ***", fresh.assertRepoNotQuarantined(u).ok === false && fresh.assertRepoNotQuarantined(r).ok === false);
    restoreDirSnapshot(mod.MERGE_QUARANTINE_DIR, snap);
    const second = mod.clearMergeQuarantine(r);
    check("(F) a second clear lifts r and U and deletes the tmp", second.liftedRepoPaths?.includes(r) && second.liftedRepoPaths?.includes(u) && !fs.existsSync(tmp));
    const fresh2 = await freshBootModule();
    fresh2.reenterMergeQuarantinesAtBoot([r]);
    check("(F) a reboot after the second clear stays clear", fresh2.assertRepoNotQuarantined(u).ok === true && fresh2.assertRepoNotQuarantined(r).ok === true);
  }

  // ── (G) the UNRESOLVABLE-X branch: X's ghost dir is absent => a PENDING entry, tmp kept, matching boot.
  {
    for (const f of fs.readdirSync(mod.MERGE_QUARANTINE_DIR)) fs.unlinkSync(path.join(mod.MERGE_QUARANTINE_DIR, f));
    const y = makeRepo("g-y");
    const rr = makeRepo("g-r");
    const x = path.join(y, "absent-ghost-g"); // never created
    enterMergeQuarantine(y, "loom/y", "y's own raise");
    const xToken = randomUUID();
    const tmp = plantRaw(hashOf(canonicalRepoLockKey(rr)), { repoPath: x, reason: "no branch", enteredAt: Date.now() - 1000, tokens: [xToken] }, "70008-aaaa0008");
    mod.clearMergeQuarantine(y);
    const pending = mod.listPendingMergeQuarantinesTestOnly().filter((p) => p.repoPath === x);
    check("(G) X lands in the PENDING tier, sourced from the kept tmp", pending.length === 1 && pending[0].sourceFile === path.basename(tmp));
    check("(G) the tmp is kept and X is blocked in-process", fs.existsSync(tmp) && mod.assertRepoNotQuarantined(x).ok === false);
    const snap = snapshotDir(mod.MERGE_QUARANTINE_DIR);
    restoreDirSnapshot(mod.MERGE_QUARANTINE_DIR, snap);
    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([y, rr]);
    check("*** (G) the reboot AGREES: X blocked (pending), R open ***", fresh.assertRepoNotQuarantined(x).ok === false && fresh.stillBlockedEntryFor(rr) === undefined);
  }
} finally {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
}

if (failures > 0) { console.error(`\n${failures} FAILURE(S)`); process.exit(1); }
console.log("\nALL PASS");
