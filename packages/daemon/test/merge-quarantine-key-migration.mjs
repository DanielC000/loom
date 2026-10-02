import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 7673d096 — `canonicalRepoLockKey` now resolves a bound path's git TOPLEVEL (walking up to
// find the nearest `.git`), instead of hashing the bound path directly. A TOPLEVEL-bound project's key is
// unchanged; a SUBDIR-bound project's key changes. Durable quarantine latch filenames
// (`quarantineHashFor`, git/merge-quarantine.ts) are a hash of this key — a latch written under the OLD
// key for a subdir-bound repo would otherwise become unreachable by `clearMergeQuarantine` (which always
// computes the CURRENT key's path): the file still parses fine at boot (`reenterMergeQuarantinesAtBoot`'s
// PASS 1 reads it, re-keys it correctly IN-MEMORY off its own `repoPath` field), but nothing re-persists it
// under the NEW path — so a legitimately-cleared quarantine's stale old-key file survives on disk forever
// and silently RE-ENTERS the quarantine on every later boot.
//
// THE FIX: PASS 1 now compares a successfully-parsed latch's own filename-hash against a freshly-computed
// `quarantineHashFor(entry.repoPath)` and, on a mismatch, self-heals — writes the same content under the
// current-key path, deletes the stale one.
//
// This file manufactures a latch filed under an OLD (pre-toplevel-walk) key by hand — simulating a
// pre-upgrade latch surviving into a post-upgrade boot — and drives `reenterMergeQuarantinesAtBoot`
// against it directly (current, already-built code; this is not a RED/GREEN toggle of
// `canonicalRepoLockKey` itself, which test/repo-lock-subdir-toplevel.mjs already covers).
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-key-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-mqkm-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const {
  enterMergeQuarantine, clearMergeQuarantine, activeMergeQuarantineFor, reenterMergeQuarantinesAtBoot, MERGE_QUARANTINE_DIR,
} = await import(pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqkm@loom -c user.name=mqkm";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeRepoWithSubdir(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqkm-repo-${tag}`);
  const subdir = path.join(repo, "teamA"); // no .git of its own
  fs.mkdirSync(subdir, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# merge-quarantine-key-migration\n");
  execSync(`git init -q && git config user.email mqkm@loom && git config user.name mqkm`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return { repo, subdir };
}

// Reproduces the OLD (pre-7673d096) key algorithm by hand: realpath + lowercase-on-win32 of the BOUND
// path directly, with no toplevel walk — exactly what `canonicalRepoLockKey` used to compute.
function oldKeyFor(boundPath) {
  const real = fs.realpathSync.native(boundPath);
  return process.platform === "win32" ? real.toLowerCase() : real;
}
function oldHashFor(boundPath) {
  return createHash("sha256").update(oldKeyFor(boundPath)).digest("hex").slice(0, 24);
}

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // A latch filed under a STALE (subdir-keyed) hash must be MIGRATED to the current (toplevel-keyed) path
  // at boot, so a later clear can actually find and remove it.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const { repo, subdir } = makeRepoWithSubdir(freshSfx());
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

    // Manufacture a latch exactly as a PRE-UPGRADE daemon would have written one: keyed on the SUBDIR path
    // directly (today's `enterMergeQuarantine(subdir, ...)` would key it on the TOPLEVEL instead — that's
    // the fix under test — so this file writes the OLD-shaped file by hand).
    const staleHash = oldHashFor(subdir);
    const staleLatchPath = path.join(MERGE_QUARANTINE_DIR, `${staleHash}.json`);
    const entryContent = {
      repoPath: subdir, branch: "pre-upgrade-branch", reason: "manufactured pre-upgrade latch (OLD subdir-keyed hash)",
      enteredAt: Date.now(), tokens: ["pre-upgrade-token"],
    };
    fs.writeFileSync(staleLatchPath, JSON.stringify(entryContent, null, 2) + "\n");
    check("(migration) precondition: the stale old-key latch file exists on disk", fs.existsSync(staleLatchPath));
    check("(migration) precondition: in-memory map is empty (simulating a fresh boot)", !activeMergeQuarantineFor(subdir));

    const found = reenterMergeQuarantinesAtBoot([subdir]);
    check("(migration) boot re-entry still finds this repo's quarantine despite the stale filename", found.some((q) => q.repoPath === subdir));
    check("(migration) the repo reads as quarantined in-memory (keyed fresh off the entry's own repoPath)", !!activeMergeQuarantineFor(subdir));
    check("(migration) the real reason carried over from the stale file (not a fabricated corrupt-latch reason)", activeMergeQuarantineFor(subdir)?.reason === "manufactured pre-upgrade latch (OLD subdir-keyed hash)");

    // THE ACTUAL BUG this fix closes: a fresh (correct-key) latch file must now exist, and the stale
    // old-key one must be gone — not both surviving, and not only the stale one surviving.
    const freshFiles = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.endsWith(".json"));
    const freshLatchPath = freshFiles
      .map((f) => path.join(MERGE_QUARANTINE_DIR, f))
      .find((p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")).repoPath === subdir; } catch { return false; } });
    check("(migration) a latch file for this repo exists at a DIFFERENT (migrated) path than the stale one", !!freshLatchPath && freshLatchPath !== staleLatchPath);
    check("(migration) THE BUG: the stale old-key file is gone (not left behind forever)", !fs.existsSync(staleLatchPath));

    // THE REGRESSION THIS WOULD OTHERWISE CAUSE: a human clears the quarantine — pre-fix, clearMergeQuarantine
    // always computes the CURRENT key's path, so it could never have found the stale file; post-migration, the
    // latch now lives exactly where clearMergeQuarantine looks, so a genuine clear actually removes it.
    clearMergeQuarantine(subdir);
    check("(migration) clearMergeQuarantine actually finds and removes the (now-migrated) latch", !activeMergeQuarantineFor(subdir) && !fs.existsSync(freshLatchPath));

    // A FURTHER boot after a genuine clear must NOT resurrect the quarantine — the exact regression a
    // never-migrated stale file would otherwise reintroduce on every single later boot.
    const foundAfterClear = reenterMergeQuarantinesAtBoot([subdir]);
    check("(migration) THE REGRESSION THIS PREVENTS: a boot after a genuine clear does NOT re-quarantine", !foundAfterClear.some((q) => q.repoPath === subdir));
    check("(migration) in-memory stays clear after the post-clear boot", !activeMergeQuarantineFor(subdir));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // A TOPLEVEL-bound project's key is UNCHANGED by this card — a latch raised through the real
  // `enterMergeQuarantine` for a toplevel-bound repo must NOT be treated as stale/migrated (no spurious
  // file churn for the common, unaffected case).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = path.join(os.tmpdir(), `loom-mqkm-top-${freshSfx()}`);
    fs.mkdirSync(repo, { recursive: true });
    tmpDirs.push(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# toplevel-bound control\n");
    execSync(`git init -q && git config user.email mqkm@loom && git config user.name mqkm`, { cwd: repo });
    commitAll(repo, "init", GIT_ID);

    enterMergeQuarantine(repo, "toplevel-branch", "a genuine toplevel-bound raise — key unaffected by this card");
    const latchFiles = fs.readdirSync(MERGE_QUARANTINE_DIR)
      .map((f) => path.join(MERGE_QUARANTINE_DIR, f))
      .filter((p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")).repoPath === repo; } catch { return false; } });
    check("(control) exactly one latch file exists for the toplevel-bound repo", latchFiles.length === 1);
    const beforeMtime = fs.statSync(latchFiles[0]).mtimeMs;

    const found = reenterMergeQuarantinesAtBoot([repo]);
    check("(control) re-entry still finds the toplevel-bound repo's quarantine", found.some((q) => q.repoPath === repo));
    const afterFiles = fs.readdirSync(MERGE_QUARANTINE_DIR)
      .map((f) => path.join(MERGE_QUARANTINE_DIR, f))
      .filter((p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")).repoPath === repo; } catch { return false; } });
    check("(control) still exactly ONE latch file — no spurious migration churn for an unaffected (toplevel-bound) repo", afterFiles.length === 1 && afterFiles[0] === latchFiles[0]);

    clearMergeQuarantine(repo);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Code Review finding 2 — a CORRUPT latch filed under the LEGACY (pre-toplevel-walk) hash must narrow
  // to its OWN repo, not fall through to the broad every-registered-repo fail-closed sweep.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const { repo, subdir } = makeRepoWithSubdir(freshSfx());
    const repoY = path.join(os.tmpdir(), `loom-mqkm-repoY-${freshSfx()}`);
    fs.mkdirSync(repoY, { recursive: true });
    tmpDirs.push(repoY);
    fs.writeFileSync(path.join(repoY, "README.md"), "# unrelated healthy repo\n");
    execSync(`git init -q && git config user.email mqkm@loom && git config user.name mqkm`, { cwd: repoY });
    commitAll(repoY, "init", GIT_ID);

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const legacyHash = oldHashFor(subdir);
    const corruptLegacyPath = path.join(MERGE_QUARANTINE_DIR, `${legacyHash}.json`);
    fs.writeFileSync(corruptLegacyPath, "{not valid json");
    check("(legacy-corrupt) precondition: a corrupt latch exists under the LEGACY (subdir-direct) hash", fs.existsSync(corruptLegacyPath));
    check("(legacy-corrupt) precondition: neither repo reads as quarantined yet", !activeMergeQuarantineFor(subdir) && !activeMergeQuarantineFor(repoY));

    const found = reenterMergeQuarantinesAtBoot([subdir, repoY]);
    check("(legacy-corrupt) THE FIX: the corrupt legacy-hash latch narrows to ITS OWN repo (subdir)", !!activeMergeQuarantineFor(subdir));
    check("(legacy-corrupt) the reason names the corruption specifically (not a generic every-repo fail-closed reason)", /corrupt|unparsable/i.test(activeMergeQuarantineFor(subdir)?.reason ?? ""));
    check("(legacy-corrupt) BUG WOULD HAVE QUARANTINED THIS TOO: the UNRELATED healthy repo is NOT quarantined", !activeMergeQuarantineFor(repoY));
    check("(legacy-corrupt) the re-entry result reports the matched repo only, not every registered repo", found.some((q) => q.repoPath === subdir) && !found.some((q) => q.repoPath === repoY));

    clearMergeQuarantine(subdir);
    clearMergeQuarantine(repoY);
    // clearMergeQuarantine only ever deletes the CURRENT (fresh-hash) path — the self-healing write for a
    // LEGACY-hash-matched corrupt latch lands there too, but the ORIGINAL corrupt file (still sitting at
    // the legacy-hash path) is a separate file `clearMergeQuarantine` has no way to know about. Sweep it
    // by hand so it can never be mistaken for an unrelated orphan by a LATER scenario's own re-entry call.
    try { fs.unlinkSync(corruptLegacyPath); } catch { /* best-effort */ }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Code Review finding 2b — the SAME narrowing for a corrupt `.tmp` (PASS 1b) filed under the legacy hash.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const { repo, subdir } = makeRepoWithSubdir(freshSfx());
    const repoY = path.join(os.tmpdir(), `loom-mqkm-repoY2-${freshSfx()}`);
    fs.mkdirSync(repoY, { recursive: true });
    tmpDirs.push(repoY);
    fs.writeFileSync(path.join(repoY, "README.md"), "# unrelated healthy repo 2\n");
    execSync(`git init -q && git config user.email mqkm@loom && git config user.name mqkm`, { cwd: repoY });
    commitAll(repoY, "init", GIT_ID);

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const legacyHash = oldHashFor(subdir);
    const corruptLegacyTmpPath = path.join(MERGE_QUARANTINE_DIR, `${legacyHash}.json.tmp-999999`);
    fs.writeFileSync(corruptLegacyTmpPath, "{not valid json");
    check("(legacy-corrupt-tmp) precondition: a corrupt tmp exists under the LEGACY hash", fs.existsSync(corruptLegacyTmpPath));

    const found = reenterMergeQuarantinesAtBoot([subdir, repoY]);
    check("(legacy-corrupt-tmp) THE FIX: narrows to the matched repo only", !!activeMergeQuarantineFor(subdir) && !activeMergeQuarantineFor(repoY));
    check("(legacy-corrupt-tmp) the re-entry result reports only the matched repo", found.some((q) => q.repoPath === subdir) && !found.some((q) => q.repoPath === repoY));

    clearMergeQuarantine(subdir);
    clearMergeQuarantine(repoY);
    // Same residue-sweep reasoning as the (legacy-corrupt) scenario above — a matched-corrupt TMP latch is
    // never rewritten/removed at its OWN (legacy-hash) path, only self-healed at the fresh path; sweep by
    // hand so this scenario's own fixture can never poison a LATER scenario's re-entry call as an orphan.
    try { fs.unlinkSync(corruptLegacyTmpPath); } catch { /* best-effort */ }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Code Review finding 3 — two DISTINCT, validly-parsed latches that now collapse onto the SAME key (two
  // sibling subdir-bound projects of ONE physical repo) must UNION, not last-writer-wins.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const sfx = freshSfx();
    const repo = path.join(os.tmpdir(), `loom-mqkm-collapse-${sfx}`);
    const teamA = path.join(repo, "teamA");
    const teamB = path.join(repo, "teamB");
    fs.mkdirSync(teamA, { recursive: true });
    fs.mkdirSync(teamB, { recursive: true });
    tmpDirs.push(repo);
    fs.writeFileSync(path.join(teamA, "a.txt"), "team a\n");
    fs.writeFileSync(path.join(teamB, "b.txt"), "team b\n");
    execSync(`git init -q && git config user.email mqkm@loom && git config user.name mqkm`, { cwd: repo });
    commitAll(repo, "init", GIT_ID);

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const olderEntry = {
      repoPath: teamA, branch: "older-branch", reason: "the OLDER, longest-outstanding raise",
      enteredAt: Date.now() - 60_000, tokens: ["token-older"],
    };
    const newerEntry = {
      repoPath: teamB, branch: "newer-branch", reason: "a SECOND, newer raise on the sibling subdir",
      enteredAt: Date.now(), tokens: ["token-newer"],
    };
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `collapse-a-${sfx}.json`), JSON.stringify(olderEntry));
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `collapse-b-${sfx}.json`), JSON.stringify(newerEntry));
    check("(collapse) precondition: two separate latch files exist for two sibling subdirs of ONE repo", fs.existsSync(path.join(MERGE_QUARANTINE_DIR, `collapse-a-${sfx}.json`)) && fs.existsSync(path.join(MERGE_QUARANTINE_DIR, `collapse-b-${sfx}.json`)));

    reenterMergeQuarantinesAtBoot([teamA, teamB]);
    const a = activeMergeQuarantineFor(teamA);
    const b = activeMergeQuarantineFor(teamB);
    check("(collapse) both sibling paths now resolve to the SAME in-memory entry (same physical repo)", a && b && a === b);
    check("(collapse) THE BUG: the UNION keeps the EARLIER identity (branch/reason), never last-writer-wins", a?.branch === "older-branch" && a?.reason === "the OLDER, longest-outstanding raise");
    check("(collapse) THE BUG: tokens from BOTH latches survive (never silently dropping the first's)", a?.tokens?.includes("token-older") && a?.tokens?.includes("token-newer"));
    check("(collapse) enteredAt reflects the OLDER raise", a?.enteredAt === olderEntry.enteredAt);

    clearMergeQuarantine(teamA);
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a quarantine latch filed under a STALE (pre-toplevel-walk) key is migrated to its " +
    "current path at boot, so a later clear can actually find it and a stale file can never resurrect a " +
    "cleared quarantine; a toplevel-bound repo's unaffected key produces no spurious file churn."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
