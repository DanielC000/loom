import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// MERGE QUARANTINE — a SECOND writeMergeQuarantineLatch call for the SAME repoPath must never truncate
// an EARLIER call's still-durable tmp before the new write is itself confirmed (card 92c645cc, item 2 —
// the card said "NOT REPRODUCED"; this file reproduces it, and proves the fix).
//
// THE BUG: `writeMergeQuarantineLatch` opened `<final>.tmp-<process.pid>` with `"w"`, a DETERMINISTIC
// name for a given repoPath within one process. Node's `"w"` flag TRUNCATES an existing file the instant
// `openSync` succeeds — before the new content's own `writeSync`/`fsyncSync` complete. So a SECOND call
// for the same repoPath (e.g. a later token appended via `enterMergeQuarantine`, or
// `clearMergeQuarantineByToken`'s own rewrite) reused the EXACT same tmp path as an EARLIER call whose
// own rename had failed (leaving that earlier call's fsync'd content as the ONLY durable record of an
// active quarantine, per bde5d1fe round 2). A fault strictly between the truncating `open()` and the new
// write's own completion destroyed that earlier record and left nothing in its place.
//
// THE FIX: every `writeMergeQuarantineLatch` call now mints a FRESH, unique tmp name
// (`<final>.tmp-<pid>-<8 hex chars>`), so a later call can never collide with — and therefore never
// truncate — an earlier call's own still-pending tmp. `reenterMergeQuarantinesAtBoot`'s tmp-residue
// regex is widened to recover BOTH this shape and the legacy bare-pid one.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-truncation-repro.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-mqtrunc-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const {
  enterMergeQuarantine, clearMergeQuarantine, clearMergeQuarantineByToken, activeMergeQuarantineFor, reenterMergeQuarantinesAtBoot, MERGE_QUARANTINE_DIR,
} = await import(pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqtrunc@loom -c user.name=mqtrunc";
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const tmpDirs = [];

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqtrunc-${tag}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# merge-quarantine-truncation-repro\n");
  execSync(`git init -q && git config user.email mqtrunc@loom && git config user.name mqtrunc`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

function findLatchPathFor(r) {
  return fs.readdirSync(MERGE_QUARANTINE_DIR)
    .map((f) => path.join(MERGE_QUARANTINE_DIR, f))
    .find((p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")).repoPath === r; } catch { return false; } });
}

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO TRUNCATION (card 92c645cc, item 2) — a later call's truncating open() must never destroy an
  // earlier call's still-durable tmp before the later write is itself confirmed.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("trunc");
    const tokenA = enterMergeQuarantine(repo, "branch-1", "FIRST real reason");
    const latchPath = findLatchPathFor(repo);
    check("(TRUNC) precondition: the first write succeeded (final exists)", !!latchPath && fs.existsSync(latchPath));
    const hash = path.basename(latchPath, ".json");

    // Force every subsequent rename for this repo to fail (directory blocker) — the first call above is
    // already durably written; this just prevents any LATER write from ever promoting over it.
    fs.rmSync(latchPath, { force: true });
    fs.mkdirSync(latchPath, { recursive: true });
    fs.writeFileSync(path.join(latchPath, "blocker.txt"), "x");

    // Call 2: append a second token — fails to rename (blocker), leaves ITS OWN tmp holding the real
    // 2-token content (the fix's unique naming means this is a DIFFERENT file than any earlier tmp would
    // have been — there is no earlier tmp yet in this scenario, this is simply the first failed write).
    enterMergeQuarantine(repo, "branch-1", "FIRST real reason");
    const tmpsAfterCall2 = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.startsWith(`${hash}.json.tmp-`));
    check("(TRUNC) precondition: call 2's failed write left exactly one tmp, holding BOTH tokens", tmpsAfterCall2.length === 1);
    const tmp2Content = tmpsAfterCall2[0] ? JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, tmpsAfterCall2[0]), "utf8")) : null;
    check("(TRUNC) precondition: that tmp's content carries both tokens", tmp2Content?.tokens?.length === 2);

    // Call 3: same repo (still blocked), but this time a fault strikes strictly between the truncating
    // open() and the write landing — the exact window the old deterministic naming exposed.
    const realWriteSync = fs.writeSync;
    let interceptedWrite = false;
    fs.writeSync = (fdArg, ...rest) => {
      if (!interceptedWrite) {
        interceptedWrite = true;
        throw Object.assign(new Error("SIMULATED crash between the truncating open() and writeSync()"), { code: "EIO" });
      }
      return realWriteSync(fdArg, ...rest);
    };
    try {
      enterMergeQuarantine(repo, "branch-1", "FIRST real reason");
    } finally {
      fs.writeSync = realWriteSync;
    }
    check("(TRUNC) a write attempt was actually intercepted", interceptedWrite);

    const tmpsAfterCall3 = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.startsWith(`${hash}.json.tmp-`));
    check(
      "(TRUNC) THE BUG: the old deterministic tmp name let call 3 truncate call 2's own still-durable tmp — the fix mints a FRESH name, so call 2's tmp survives UNTOUCHED",
      tmpsAfterCall3.some((f) => {
        try { return JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8")).tokens?.length === 2; } catch { return false; }
      }),
    );
    // Call 3's OWN fresh tmp (opened, then its write failed) may itself sit at 0 bytes — that is harmless
    // residue from call 3's own attempt, never a destroyed EARLIER record; the check above is what proves
    // no data was lost.

    // Resolve: remove the blocker, let a real re-raise succeed, clean up.
    fs.rmSync(latchPath, { recursive: true, force: true });
    clearMergeQuarantine(repo);
    void tokenA;
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO SWEEP-ON-SUCCESS (manager directive, round 2) — three failed renames (each minting its own
  // unique tmp) followed by one success must leave EXACTLY the final and ZERO tmp files — the accumulation
  // this card's fix would otherwise introduce is closed by `writeMergeQuarantineLatch`'s own conditional
  // sweep, enabled only at the one call site (append-to-existing) that can prove the superset property.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("sweep");
    enterMergeQuarantine(repo, "branch-1", "sweep scenario base"); // succeeds normally — no tmp left
    const latchPath = findLatchPathFor(repo);
    const hash = path.basename(latchPath, ".json");
    check("(SWEEP) precondition: the base write succeeded, no tmp residue yet", !!latchPath
      && fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.startsWith(`${hash}.json.tmp-`)).length === 0);

    fs.rmSync(latchPath, { force: true });
    fs.mkdirSync(latchPath, { recursive: true });
    fs.writeFileSync(path.join(latchPath, "blocker.txt"), "x");

    // Three failed renames — each appends a fresh token and fails to rename, leaving its OWN unique tmp.
    enterMergeQuarantine(repo, "branch-1", "sweep scenario base"); // fail 1
    enterMergeQuarantine(repo, "branch-1", "sweep scenario base"); // fail 2
    enterMergeQuarantine(repo, "branch-1", "sweep scenario base"); // fail 3
    const tmpsBeforeSuccess = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.startsWith(`${hash}.json.tmp-`));
    check("(SWEEP) precondition: three failed renames left exactly three distinct tmp files", tmpsBeforeSuccess.length === 3);

    fs.rmSync(latchPath, { recursive: true, force: true }); // drop the blocker — the NEXT write succeeds
    enterMergeQuarantine(repo, "branch-1", "sweep scenario base"); // the ONE success

    const tmpsAfterSuccess = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.startsWith(`${hash}.json.tmp-`));
    check("(SWEEP) THE DIRECTIVE: one success after three failures leaves ZERO tmp files for this key", tmpsAfterSuccess.length === 0);
    check("(SWEEP) exactly the final latch survives", fs.existsSync(latchPath));
    check("(SWEEP) the surviving final carries all FIVE accumulated tokens (base + 3 failed + 1 success)", activeMergeQuarantineFor(repo)?.tokens?.length === 5);

    clearMergeQuarantine(repo);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO LEGACY-BARE-PID-RECOVERY (regression guard) — a legacy bare-`.tmp-<pid>` leftover (a
  // pre-upgrade daemon's own tmp, or any foreign-pid residue) must still be recovered at boot under the
  // widened regex — never silently dropped because it lacks the new random suffix.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("legacy");
    enterMergeQuarantine(repo, "legacy-branch", "manufactured for LEGACY-BARE-PID-RECOVERY");
    const latchPath = findLatchPathFor(repo);
    check("(LEGACY) precondition: the well-formed latch file exists", !!latchPath && fs.existsSync(latchPath));

    const bareTmpPath = `${latchPath}.tmp-999999`; // the OLD, pre-fix shape — purely numeric, no random suffix
    fs.renameSync(latchPath, bareTmpPath); // simulates: fsync completed, the rename never ran
    const parkedPath = path.join(os.tmpdir(), `loom-mqtrunc-parked-legacy-${sfx}.json`);
    fs.renameSync(bareTmpPath, parkedPath);
    clearMergeQuarantine(repo);
    check("(LEGACY) precondition: in-memory is genuinely clean before the parked tmp returns", !activeMergeQuarantineFor(repo));
    fs.renameSync(parkedPath, bareTmpPath);
    check("(LEGACY) precondition: only a bare-pid tmp is on disk, in-memory genuinely clean",
      fs.existsSync(bareTmpPath) && !fs.existsSync(latchPath) && !activeMergeQuarantineFor(repo));

    const found = reenterMergeQuarantinesAtBoot([repo]);
    check("(LEGACY) a legacy bare-pid tmp (no random suffix) is still matched and recovered at boot", found.some((q) => q.repoPath === repo));
    check("(LEGACY) the recovered entry carries the REAL reason", activeMergeQuarantineFor(repo)?.reason === "manufactured for LEGACY-BARE-PID-RECOVERY");
    check("(LEGACY) self-healing: the content was promoted to its proper final name", fs.existsSync(latchPath));
    check("(LEGACY) self-healing: the bare-pid tmp was cleaned up", !fs.existsSync(bareTmpPath));

    clearMergeQuarantine(repo);
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — writeMergeQuarantineLatch mints a FRESH tmp name on every call (never truncating an " +
    "earlier call's still-durable tmp), a run of failed renames followed by one success sweeps every stale " +
    "tmp for the key down to zero, and a legacy bare-pid tmp is still recovered at boot under the widened " +
    "regex."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
