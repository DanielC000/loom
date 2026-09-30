import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// MERGE QUARANTINE — BOOT-TIME HARDENING (round 6, card 24c0bdba, Code Review BLOCKER 2 + NC2 + item #8).
//
// THE BUGS (round 5 review of round 4's `reenterMergeQuarantinesAtBoot`):
//  - A corrupt/unparsable durable latch FAILED OPEN at boot (a bare `catch { skip }`) — a 0-byte latch
//    re-armed NOTHING, silently reopening the exact "a restart lifts the quarantine" bypass round 4 closed.
//  - Scenario C in merge-quarantine-batch.mjs was VACUOUS: neutralising the boot re-entry stayed green,
//    because `enterMergeQuarantine` had already populated the SAME in-process map re-entry would read from
//    — the test never actually exercised a genuinely FRESH map the way a real restart would.
//  - `reenterMergeQuarantinesAtBoot()` used to run AFTER `startGatewayListeners` in index.ts, leaving a
//    real window where the gateway was already accepting REST/MCP requests before a restart-surviving
//    quarantine was re-armed to refuse them.
//
// THIS FILE:
//  SCENARIO NC2 — spawns a GENUINELY SEPARATE node process (its own fresh in-memory map, same LOOM_HOME)
//    that calls ONLY `reenterMergeQuarantinesAtBoot` and reports what it found — proving the DURABLE FILE,
//    not a residual in-memory entry, is what re-arms a quarantine after a real restart.
//  SCENARIO BLOCKER-2a — a corrupt/unparsable latch whose FILENAME HASH matches a registered repo
//    quarantines THAT repo specifically (never silently skipped).
//  SCENARIO BLOCKER-2b — a corrupt/unparsable latch matching NO registered repo (or a readdir failure)
//    quarantines EVERY registered repo, fail-closed.
//  SCENARIO ITEM-8 — a real AST-shape check (mirroring boot-listen-not-blocked.mjs's own technique) that
//    `packages/daemon/src/index.ts` calls `reenterMergeQuarantinesAtBoot(` BEFORE it binds the port
//    (`app.listen(`/`startGatewayListeners(`) — the position that actually closes the request-window race.
//  SCENARIO TORN-WRITE (card bde5d1fe item 5) — `writeMergeQuarantineLatch` fsyncs BEFORE it renames, so a
//    crash in that ms-scale window leaves a `.json.tmp-<pid>` file whose CONTENT is durable and complete,
//    under a name the old filter silently dropped at boot (losing a genuine quarantine). Covers: a
//    recovered tmp's real content is used (never a generic corrupt placeholder) and promoted/cleaned up;
//    a STALE tmp beside an already-valid final latch never clobbers the real data; a genuinely corrupt tmp
//    gets the same fail-closed (matched-repo) treatment a corrupt `.json` already gets.
//  SCENARIO WRITE-FAILURE-RESIDUE — round 1 (Code Review of b4315b52, item 1) found a failed write/rename
//    in a LIVE process left its OWN `.json.tmp-<pid>` behind forever (neither clear path swept it), so a
//    stray tmp outlived a CLEAR and re-quarantined an already-cleared repo at the next boot; the clear-
//    path sweep fix is correct and kept. Round 1's OTHER half — also unlinking the tmp in the WRITE's own
//    catch — was WRONG and got reverted in round 2: that tmp is the only durable record of a genuinely
//    ACTIVE quarantine, and unlinking it let a restart silently LIFT one instead of re-arming it. This
//    scenario now asserts BOTH: the failed write's tmp survives and a fresh boot re-arms from it, AND
//    both clear paths still sweep residue once the quarantine is genuinely resolved.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-boot-hardening.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-mqbh-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const {
  enterMergeQuarantine, clearMergeQuarantine, clearMergeQuarantineByToken, activeMergeQuarantineFor, reenterMergeQuarantinesAtBoot, MERGE_QUARANTINE_DIR,
} = await import(pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqbh@loom -c user.name=mqbh";
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const tmpDirs = [];

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqbh-${tag}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# merge-quarantine-boot-hardening\n");
  execSync(`git init -q && git config user.email mqbh@loom && git config user.name mqbh`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO NC2 — a GENUINELY SEPARATE process re-enters from the durable file alone
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("nc2");
    enterMergeQuarantine(repo, "nc2-branch", "manufactured for NC2 (real child-process re-entry)");
    check("(NC2) precondition: this (parent) process's in-memory map has the entry", !!activeMergeQuarantineFor(repo));
    const latchFiles = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.endsWith(".json"));
    check("(NC2) precondition: a durable latch file exists on disk", latchFiles.length > 0);

    // The child process below has its OWN, genuinely empty `activeQuarantines` Map (a fresh V8 heap, a
    // fresh module instance) — nothing from this parent process's calls above is visible to it except
    // through LOOM_HOME's shared filesystem. This is the thing scenario C in merge-quarantine-batch.mjs
    // could NOT prove on its own.
    const childScript = `
      const { reenterMergeQuarantinesAtBoot, activeMergeQuarantineFor } = await import(${JSON.stringify(pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href)});
      const found = reenterMergeQuarantinesAtBoot([${JSON.stringify(repo)}]);
      const active = activeMergeQuarantineFor(${JSON.stringify(repo)});
      process.stdout.write(JSON.stringify({ foundCount: found.length, foundThisRepo: found.some((q) => q.repoPath === ${JSON.stringify(repo)}), activeAfter: !!active, activeReason: active?.reason ?? null }));
    `;
    const childOut = execFileSync(process.execPath, ["--input-type=module", "-e", childScript], {
      env: { ...process.env, LOOM_HOME: loomHome },
    }).toString();
    const childResult = JSON.parse(childOut);
    check("(NC2) the CHILD process's re-entry call reports finding this repo's latch", childResult.foundThisRepo === true);
    check("(NC2) the CHILD process's OWN (freshly-empty) map now shows it active", childResult.activeAfter === true);
    check("(NC2) the CHILD process's active entry carries the real reason (from the FILE, not memory it never had)", childResult.activeReason === "manufactured for NC2 (real child-process re-entry)");

    clearMergeQuarantine(repo);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO BLOCKER-2a — a corrupt latch whose filename hash MATCHES a registered repo quarantines THAT
  // repo specifically (never silently discarded).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("2a");
    // Raise a real quarantine (writes a well-formed latch), then CORRUPT the file on disk — the shape a
    // torn/partial write (crash mid-fsync, disk full) would actually produce.
    enterMergeQuarantine(repo, "2a-branch", "manufactured for BLOCKER-2a, will be corrupted");
    const latchPath = fs.readdirSync(MERGE_QUARANTINE_DIR)
      .map((f) => path.join(MERGE_QUARANTINE_DIR, f))
      .find((p) => {
        try { return JSON.parse(fs.readFileSync(p, "utf8")).repoPath === repo; } catch { return false; }
      });
    check("(2a) precondition: the well-formed latch file exists before corruption", !!latchPath && fs.existsSync(latchPath));
    fs.writeFileSync(latchPath, ""); // 0-byte — the EXACT shape the round-5 review named ("a 0-byte latch re-armed nothing")
    // In-memory map still has the GOOD entry from enterMergeQuarantine above — reset it so this repo starts
    // this scenario from a clean slate, exactly like a real restart's fresh map would.
    clearMergeQuarantine(repo);
    // clearMergeQuarantine also deletes the latch file — re-corrupt it AFTER clearing, so the on-disk state
    // for re-entry is "a 0-byte file, in-memory map empty" (the true post-restart-with-a-torn-file shape).
    fs.writeFileSync(latchPath, "");
    check("(2a) precondition: in-memory map is clean, but the CORRUPT file is on disk", !activeMergeQuarantineFor(repo) && fs.existsSync(latchPath) && fs.readFileSync(latchPath, "utf8") === "");

    const found = reenterMergeQuarantinesAtBoot([repo]);
    check("(2a) BLOCKER-2 BUG: a 0-byte latch used to re-arm NOTHING — now it quarantines the MATCHED repo", !!activeMergeQuarantineFor(repo));
    check("(2a) the re-entry result reports this repo", found.some((q) => q.repoPath === repo));
    check("(2a) the fail-closed reason names the corruption (not a fabricated normal reason)", /corrupt|unparsable/i.test(activeMergeQuarantineFor(repo)?.reason ?? ""));

    clearMergeQuarantine(repo);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO BLOCKER-2b — a corrupt latch matching NO registered repo quarantines EVERY registered repo,
  // fail-closed (never "this one file is unreadable, so treat it as nothing").
  //
  // Round 7 (Code Review M2): the ORIGINAL round-6 fix left a fail-closed TRAP with no working escape — the
  // orphan file itself was never deleted by anything, so a human clearing every repo it wrongly quarantined
  // did NOT stop the NEXT boot from re-quarantining everything all over again (the orphan file was still
  // there to trip the same fail-closed path). This scenario drives the EXACT repro the review specified:
  // boot with an unmatched corrupt latch ⇒ all quarantined; human-clear EACH (never touching the orphan
  // file by hand — that would defeat the point of testing whether the CLEAR ROUTE itself removes it) ⇒
  // reboot (a fresh reenterMergeQuarantinesAtBoot call) ⇒ nothing re-quarantined, because the clear route
  // itself deleted the orphan once nothing referenced it any more.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repoX = makeRepo("2b-x");
    const repoY = makeRepo("2b-y");
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const orphanLatchPath = path.join(MERGE_QUARANTINE_DIR, `orphan-corrupt-${sfx}.json`);
    fs.writeFileSync(orphanLatchPath, "{not valid json");
    check("(2b) precondition: an orphan corrupt latch (matching neither registered repo) exists", fs.existsSync(orphanLatchPath));
    check("(2b) precondition: neither repo reads as quarantined yet", !activeMergeQuarantineFor(repoX) && !activeMergeQuarantineFor(repoY));

    const found = reenterMergeQuarantinesAtBoot([repoX, repoY]);
    check("(2b) BLOCKER-2 BUG: an unmatched corrupt latch used to be silently skipped — now EVERY registered repo is quarantined", !!activeMergeQuarantineFor(repoX) && !!activeMergeQuarantineFor(repoY));
    check("(2b) the re-entry result reports both registered repos", found.some((q) => q.repoPath === repoX) && found.some((q) => q.repoPath === repoY));
    check("(2b) each fail-closed entry records the orphan's OWN filename (M2)", activeMergeQuarantineFor(repoX)?.orphanLatchFiles?.includes(path.basename(orphanLatchPath)) && activeMergeQuarantineFor(repoY)?.orphanLatchFiles?.includes(path.basename(orphanLatchPath)));

    // Human-clear the FIRST repo only — the orphan is STILL referenced by repoY's own still-active entry,
    // so it must NOT be deleted yet (round 7, M2: "once no fail-closed repo still references an orphan").
    clearMergeQuarantine(repoX);
    check("(M2) clearing ONE of two repos referencing the orphan does NOT yet delete it (repoY still references it)", fs.existsSync(orphanLatchPath));

    // Human-clear the SECOND (last) repo — round 7, M2: this is what must now delete the orphan file
    // itself, WITHOUT this test ever touching the filesystem by hand (the round-6 test manually unlinked
    // it here, which is precisely how the M2 trap stayed hidden — the human-clear route never got exercised).
    clearMergeQuarantine(repoY);
    check("(M2) BLOCKER: the orphan file used to survive every human clear forever — the clear route now deletes it once NOTHING references it any more", !fs.existsSync(orphanLatchPath));

    // THE ACTUAL M2 REPRO — REBOOT: a fresh re-entry sweep (simulating the next daemon restart) must NOT
    // re-quarantine anything, because the orphan that used to keep tripping the fail-closed path is GONE.
    const foundAfterCleanup = reenterMergeQuarantinesAtBoot([repoX, repoY]);
    check("(2b) reboot: once the orphan is gone, re-entry finds nothing for either repo", !foundAfterCleanup.some((q) => q.repoPath === repoX || q.repoPath === repoY));
    check("(2b) reboot: neither repo is quarantined after the clean re-entry", !activeMergeQuarantineFor(repoX) && !activeMergeQuarantineFor(repoY));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO BLOCKER-2c (round 7, M2 RESIDUAL — found by review of cf7b66da) — an unmatched orphan latch
  // found ALONGSIDE registered repos that ALREADY have their OWN valid (non-corrupt) latch. The first
  // round-7 cut's PASS 2 `continue`d past any repo that already had valid data from PASS 1 — so if EVERY
  // registered repo already carried its own valid latch when an orphan was found, NONE of them ever
  // recorded the orphan's filename, no clear could ever delete it, and the next boot re-quarantined
  // everything all over again — the EXACT SAME trap M2 already fixed, reachable through a different door.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repoX = makeRepo("2c-x");
    const repoY = makeRepo("2c-y");
    // Both repos ALREADY carry their OWN real, unrelated quarantine BEFORE the orphan is ever found.
    const txReal = enterMergeQuarantine(repoX, "real-branch-x", "a genuine unrelated raise on repoX, unrelated to any orphan latch");
    const tyReal = enterMergeQuarantine(repoY, "real-branch-y", "a genuine unrelated raise on repoY, unrelated to any orphan latch");
    check("(2c) precondition: both repos already carry their OWN real quarantine", !!activeMergeQuarantineFor(repoX) && !!activeMergeQuarantineFor(repoY));

    const orphanLatchPath = path.join(MERGE_QUARANTINE_DIR, `orphan-corrupt-2c-${sfx}.json`);
    fs.writeFileSync(orphanLatchPath, "{not valid json");
    check("(2c) precondition: an orphan corrupt latch exists alongside two ALREADY-valid latches", fs.existsSync(orphanLatchPath));

    reenterMergeQuarantinesAtBoot([repoX, repoY]);
    check(
      "(2c) M2 RESIDUAL BUG: each repo's REAL data (branch/reason/tokens) must be KEPT, not clobbered",
      activeMergeQuarantineFor(repoX)?.branch === "real-branch-x" && activeMergeQuarantineFor(repoX)?.tokens?.includes(txReal)
      && activeMergeQuarantineFor(repoY)?.branch === "real-branch-y" && activeMergeQuarantineFor(repoY)?.tokens?.includes(tyReal),
    );
    check(
      "(2c) M2 RESIDUAL BUG: a repo with its OWN valid latch must STILL end up referencing the orphan file",
      activeMergeQuarantineFor(repoX)?.orphanLatchFiles?.includes(path.basename(orphanLatchPath))
      && activeMergeQuarantineFor(repoY)?.orphanLatchFiles?.includes(path.basename(orphanLatchPath)),
    );

    // Clear repoX first — repoY's entry STILL references the orphan, so it must survive.
    clearMergeQuarantine(repoX);
    check("(2c) clearing ONE of two repos referencing the orphan (via a pre-existing valid latch) does NOT yet delete it", fs.existsSync(orphanLatchPath));
    // Clear repoY (the last reference) — the orphan must now finally be deleted.
    clearMergeQuarantine(repoY);
    check(
      "(2c) M2 RESIDUAL BUG: the orphan used to survive FOREVER when every registered repo already had its own valid latch — now deleted once nothing references it any more",
      !fs.existsSync(orphanLatchPath),
    );

    // Reboot: nothing left to re-quarantine or re-reference.
    const foundAfterCleanup = reenterMergeQuarantinesAtBoot([repoX, repoY]);
    check("(2c) reboot: once the orphan is gone, re-entry finds nothing for either repo", !foundAfterCleanup.some((q) => q.repoPath === repoX || q.repoPath === repoY));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO TORN-WRITE (card bde5d1fe item 5) — a leftover `.json.tmp-<pid>` must be RECOVERED, never
  // silently dropped the way the old `.filter((f) => f.endsWith(".json") && !f.includes(".tmp-"))` did.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    // (a) VALID content, crash landed between fsync and rename ⇒ recovered under its real content, then
    // self-healed (promoted to its final name, tmp cleaned up).
    const repo = makeRepo("tw");
    enterMergeQuarantine(repo, "tw-branch", "manufactured for TORN-WRITE (item 5)");
    const findLatchPathFor = (r) => fs.readdirSync(MERGE_QUARANTINE_DIR)
      .map((f) => path.join(MERGE_QUARANTINE_DIR, f))
      .find((p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")).repoPath === r; } catch { return false; } });
    const latchPath = findLatchPathFor(repo);
    check("(TW) precondition: the well-formed latch file exists", !!latchPath && fs.existsSync(latchPath));
    const tmpPath = `${latchPath}.tmp-999999`;
    fs.renameSync(latchPath, tmpPath); // simulates: fsync completed, the rename to the final name never ran
    // Code Review round 2, item 4 — clearMergeQuarantine now ALSO sweeps `.json.tmp-<pid>` residue (round
    // 2's own fix), which would delete the very tmp this precondition needs if called directly. Relocate
    // the tmp OUTSIDE MERGE_QUARANTINE_DIR first, clear (a genuinely clean in-memory slate — the earlier
    // cut of this scenario skipped this and left a STALE in-memory entry that made the checks below pass
    // VACUOUSLY even with PASS 1b disabled), then move it back.
    const parkedTmpPath = path.join(os.tmpdir(), `loom-mqbh-parked-${path.basename(tmpPath)}`);
    fs.renameSync(tmpPath, parkedTmpPath);
    clearMergeQuarantine(repo);
    check("(TW) precondition: in-memory is genuinely clean before the parked tmp returns", !activeMergeQuarantineFor(repo));
    fs.renameSync(parkedTmpPath, tmpPath);
    check("(TW) precondition: only a .tmp-<pid> file is on disk (no final .json), in-memory genuinely clean",
      fs.existsSync(tmpPath) && !fs.existsSync(latchPath) && !activeMergeQuarantineFor(repo));

    const found = reenterMergeQuarantinesAtBoot([repo]);
    check("(TW) the old filter silently DROPPED a .tmp-<pid> file — now it's recovered: the repo IS quarantined", !!activeMergeQuarantineFor(repo));
    check("(TW) the re-entry result reports this repo", found.some((q) => q.repoPath === repo));
    check("(TW) the RECOVERED entry carries the REAL reason (durable content, never a generic corrupt-latch placeholder)", activeMergeQuarantineFor(repo)?.reason === "manufactured for TORN-WRITE (item 5)");
    check("(TW) SELF-HEALING: the content was promoted to its proper final name", fs.existsSync(latchPath));
    check("(TW) SELF-HEALING: the tmp file was cleaned up", !fs.existsSync(tmpPath));

    // A FURTHER re-entry (another restart) reads cleanly from the now-proper final file — no tmp involved.
    const secondFound = reenterMergeQuarantinesAtBoot([repo]);
    check("(TW) a further re-entry still reports this repo from the promoted final file", secondFound.some((q) => q.repoPath === repo) && activeMergeQuarantineFor(repo)?.reason === "manufactured for TORN-WRITE (item 5)");

    clearMergeQuarantine(repo);

    // (b) a STALE tmp beside an ALREADY-VALID final latch (an earlier interrupted write; a LATER write
    // then succeeded normally) must be cleaned up as harmless residue — never clobber the real entry.
    const repo2 = makeRepo("tw-stale");
    enterMergeQuarantine(repo2, "tw-stale-branch", "the REAL current reason");
    const latchPath2 = findLatchPathFor(repo2);
    const staleTmpPath = `${latchPath2}.tmp-111111`;
    fs.writeFileSync(staleTmpPath, JSON.stringify({ repoPath: repo2, branch: "STALE-EARLIER-ATTEMPT", reason: "an earlier, now-superseded attempt", enteredAt: 1, tokens: ["stale-token"] }));
    check("(TW-stale) precondition: both a real final latch and a stale tmp exist", fs.existsSync(latchPath2) && fs.existsSync(staleTmpPath));

    const foundStale = reenterMergeQuarantinesAtBoot([repo2]);
    check("(TW-stale) re-entry reports this repo exactly once, with the REAL data (never the stale tmp's)",
      foundStale.filter((q) => q.repoPath === repo2).length === 1 && activeMergeQuarantineFor(repo2)?.reason === "the REAL current reason");
    check("(TW-stale) the stale tmp is cleaned up as harmless residue", !fs.existsSync(staleTmpPath));
    check("(TW-stale) the real final latch is untouched", fs.existsSync(latchPath2));
    clearMergeQuarantine(repo2);

    // (c) a genuinely CORRUPT tmp (unreadable content, no final latch at all) whose filename hash MATCHES
    // a registered repo gets the SAME fail-closed (matched-repo) treatment a corrupt `.json` already gets.
    const repo3 = makeRepo("tw-corrupt");
    enterMergeQuarantine(repo3, "tw-corrupt-branch", "will be corrupted as a tmp");
    const latchPath3 = findLatchPathFor(repo3);
    const corruptTmpPath = `${latchPath3}.tmp-222222`;
    fs.writeFileSync(corruptTmpPath, "{not valid json");
    fs.rmSync(latchPath3, { force: true }); // no final latch survives — only the corrupt tmp remains
    // Same reasoning as SCENARIO TORN-WRITE (a) above — relocate before clearing so the sweep can't touch
    // it, leaving a genuinely clean in-memory slate (never a vacuously-surviving stale entry).
    const parkedCorruptTmpPath = path.join(os.tmpdir(), `loom-mqbh-parked-${path.basename(corruptTmpPath)}`);
    fs.renameSync(corruptTmpPath, parkedCorruptTmpPath);
    clearMergeQuarantine(repo3);
    check("(TW-corrupt) precondition: in-memory is genuinely clean before the parked tmp returns", !activeMergeQuarantineFor(repo3));
    fs.renameSync(parkedCorruptTmpPath, corruptTmpPath);
    check("(TW-corrupt) precondition: only a CORRUPT tmp is on disk (no final .json), in-memory genuinely clean",
      fs.existsSync(corruptTmpPath) && !fs.existsSync(latchPath3) && !activeMergeQuarantineFor(repo3));

    const foundCorrupt = reenterMergeQuarantinesAtBoot([repo3]);
    check("(TW-corrupt) a corrupt tmp matching a registered repo fails CLOSED (quarantines THAT repo)", !!activeMergeQuarantineFor(repo3));
    check("(TW-corrupt) the re-entry result reports this repo", foundCorrupt.some((q) => q.repoPath === repo3));
    check("(TW-corrupt) the fail-closed reason names the corruption", /corrupt|unparsable/i.test(activeMergeQuarantineFor(repo3)?.reason ?? ""));
    clearMergeQuarantine(repo3);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO WRITE-FAILURE-RESIDUE (Code Review of b4315b52, item 1; INVERTED in round 2) — round 1's own
  // fix (CLEAR paths sweeping `.json.tmp-<pid>` residue) was correct; its OTHER half (unlinking the tmp in
  // `writeMergeQuarantineLatch`'s own catch) was WRONG and got reverted. Once fsync has succeeded, that
  // tmp is the ONLY durable record of an ACTIVE quarantine for this process — deleting it on a failed
  // rename (e.g. Windows EPERM) let a restart silently LIFT a real unconfirmed-kill quarantine instead of
  // re-arming it, reopening the exact bypass `24c0bdba` closed (reproduced: b4315b52 re-armed at a fresh
  // boot after a failed write, 9831522c did not).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("wfr");
    // Resolve this repo's own real latch path + hash via a real, successful write first — never re-derive
    // the hash algorithm by hand.
    enterMergeQuarantine(repo, "wfr-branch", "resolve the real latch path");
    const latchPath = fs.readdirSync(MERGE_QUARANTINE_DIR)
      .map((f) => path.join(MERGE_QUARANTINE_DIR, f))
      .find((p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")).repoPath === repo; } catch { return false; } });
    check("(WFR) precondition: resolved this repo's real latch path", !!latchPath && fs.existsSync(latchPath));
    const hash = path.basename(latchPath, ".json");
    clearMergeQuarantine(repo);
    check("(WFR) precondition: cleared — no active entry, no latch file", !activeMergeQuarantineFor(repo) && !fs.existsSync(latchPath));

    // --- (1) a failed write/rename must LEAVE its tmp behind, and a fresh boot must RE-ARM from it ---
    // Force the rename to fail: pre-create the FINAL path as a non-empty directory — a real, deterministic,
    // cross-platform rename failure (EPERM on Windows, EISDIR/ENOTEMPTY on POSIX), never a mocked fs call.
    fs.mkdirSync(latchPath, { recursive: true });
    fs.writeFileSync(path.join(latchPath, "blocker.txt"), "x");
    check("(WFR-1) precondition: the final path is now a directory (the rename WILL fail)", fs.statSync(latchPath).isDirectory());
    enterMergeQuarantine(repo, "wfr-branch-2", "manufactured failed write");
    const tmpAfterFailure = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.startsWith(`${hash}.json.tmp-`));
    check("(WFR-1) THE ROUND-2 INVERSION: a failed write's tmp is the ONLY durable record of an ACTIVE quarantine — it MUST survive", tmpAfterFailure.length === 1);
    fs.rmSync(latchPath, { recursive: true, force: true }); // drop the directory blocker — the tmp itself is untouched

    // Genuinely clear the in-memory entry THIS process's own enterMergeQuarantine call above already set —
    // otherwise the checks below could pass VACUOUSLY off that stale entry alone, never actually proving
    // the boot recovery worked (the same trap SCENARIO TORN-WRITE's own (a)/(c) cases had — see there).
    // Park the surviving tmp OUTSIDE MERGE_QUARANTINE_DIR first, so the clear's own residue sweep can't
    // touch it, then move it back. Guarded: if the precondition above ALREADY failed (no tmp survived —
    // the regression this scenario checks for), there's nothing to park; still clear in-memory honestly
    // and let the recovery checks below fail for real, rather than crashing on a missing file.
    if (tmpAfterFailure.length === 1) {
      const tmpPathForWfr1 = path.join(MERGE_QUARANTINE_DIR, tmpAfterFailure[0]);
      const parkedWfr1Path = path.join(os.tmpdir(), `loom-mqbh-parked-${tmpAfterFailure[0]}`);
      fs.renameSync(tmpPathForWfr1, parkedWfr1Path);
      clearMergeQuarantine(repo);
      check("(WFR-1) precondition: in-memory is genuinely clean before the parked tmp returns", !activeMergeQuarantineFor(repo));
      fs.renameSync(parkedWfr1Path, tmpPathForWfr1);
    } else {
      clearMergeQuarantine(repo); // still clear in-memory even with nothing to park
      check("(WFR-1) precondition: in-memory is genuinely clean before the parked tmp returns", !activeMergeQuarantineFor(repo));
    }

    // THE ACTUAL BUG this inversion proves closed: a fresh boot (simulating a restart after the failed-
    // write process died, blocker now gone, in-memory genuinely clean) must RE-ARM the quarantine from the
    // surviving tmp — never silently lift a real, still-unconfirmed one.
    const foundAfterFailedWrite = reenterMergeQuarantinesAtBoot([repo]);
    check("(WFR-1) a fresh boot RE-ARMS from the surviving tmp (never silently lifts a real quarantine)",
      foundAfterFailedWrite.some((q) => q.repoPath === repo) && !!activeMergeQuarantineFor(repo));
    check("(WFR-1) the recovered entry carries the REAL reason from the failed-write attempt",
      activeMergeQuarantineFor(repo)?.reason === "manufactured failed write");

    clearMergeQuarantine(repo); // genuinely resolve it now (human-equivalent) — sweeps any residue either way
    check("(WFR-1) back to a clean slate", !activeMergeQuarantineFor(repo) && !fs.existsSync(latchPath) &&
      fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.startsWith(`${hash}.json.tmp-`)).length === 0);

    // --- (2) clearMergeQuarantine (the unconditional/human path) sweeps a PRE-EXISTING stray tmp ---
    const strayTmpPath = path.join(MERGE_QUARANTINE_DIR, `${hash}.json.tmp-999999`);
    fs.writeFileSync(strayTmpPath, JSON.stringify({ repoPath: repo, branch: "stray", reason: "stray tmp", enteredAt: Date.now(), tokens: ["stray-token"] }));
    check("(WFR-2) precondition: a stray tmp exists on disk", fs.existsSync(strayTmpPath));
    clearMergeQuarantine(repo);
    check("(WFR-2) clearMergeQuarantine removes the stray tmp residue", !fs.existsSync(strayTmpPath));

    // --- (3) THE ACTUAL BUG: with the stray tmp gone, a fresh boot re-entry must NOT re-quarantine ---
    const found = reenterMergeQuarantinesAtBoot([repo]);
    check("(WFR-3) THE REGRESSION: boot after the clear used to re-quarantine via the leftover tmp — now it does not",
      !found.some((q) => q.repoPath === repo) && !activeMergeQuarantineFor(repo));

    // --- (4) clearMergeQuarantineByToken's own PARTIAL-clear branch also sweeps stray residue ---
    const tokenA = enterMergeQuarantine(repo, "wfr-a", "token A");
    enterMergeQuarantine(repo, "wfr-b", "token B"); // appended to the SAME entry (round 7, M1 SET semantics)
    const strayTmpPath2 = path.join(MERGE_QUARANTINE_DIR, `${hash}.json.tmp-888888`);
    fs.writeFileSync(strayTmpPath2, JSON.stringify({ repoPath: repo, branch: "stray2", reason: "stray tmp 2", enteredAt: Date.now(), tokens: ["stray-token-2"] }));
    check("(WFR-4) precondition: a second stray tmp exists; repo quarantined by TWO tokens", fs.existsSync(strayTmpPath2) && activeMergeQuarantineFor(repo)?.tokens?.length === 2);
    clearMergeQuarantineByToken(repo, tokenA);
    check("(WFR-4) repo STILL quarantined (one token remains) — this is a PARTIAL clear, not a full one", !!activeMergeQuarantineFor(repo));
    check("(WFR-4) the PARTIAL-clear path ALSO swept the stray tmp", !fs.existsSync(strayTmpPath2));

    clearMergeQuarantine(repo); // full cleanup for this scenario
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO PARTIAL-CLEAR-WRITE-FAILURE (Code Review of eae23ebe, item 1) — the partial-clear path used
  // to sweep tmp residue BEFORE its own rewrite succeeded. If the final was already absent (an earlier
  // failed write left ONLY a tmp — deliberately kept since round 2) and this rewrite ALSO fails, nothing
  // durable would be left for a repo whose remaining token is still genuinely unconfirmed.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("pcwf");
    enterMergeQuarantine(repo, "discover", "discover path"); // resolve this repo's real latch path/hash
    const finalPath = fs.readdirSync(MERGE_QUARANTINE_DIR)
      .map((f) => path.join(MERGE_QUARANTINE_DIR, f))
      .find((p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")).repoPath === repo; } catch { return false; } });
    const hash = path.basename(finalPath, ".json");
    clearMergeQuarantine(repo);

    fs.mkdirSync(finalPath, { recursive: true }); // block EVERY rename for this repo
    fs.writeFileSync(path.join(finalPath, "blocker.txt"), "x");
    const tokenA = enterMergeQuarantine(repo, "branch-a", "reason a");
    enterMergeQuarantine(repo, "branch-b", "reason a"); // appends tokenB to the SAME entry (round 7, M1)
    const tmpPath = fs.readdirSync(MERGE_QUARANTINE_DIR).map((f) => path.join(MERGE_QUARANTINE_DIR, f)).find((p) => p.startsWith(`${finalPath}.tmp-`));
    const tokenB = activeMergeQuarantineFor(repo)?.tokens?.find((t) => t !== tokenA);
    check("(PCWF) precondition: only a tmp exists (finalPath is still just the directory blocker), holding BOTH tokens",
      !!tmpPath && fs.statSync(finalPath).isDirectory() && activeMergeQuarantineFor(repo)?.tokens?.length === 2);

    // Patch fs.openSync to fail ONLY this repo's own tmp writes (EMFILE-shaped) — simulates the
    // partial-clear's OWN rewrite failing for an unrelated reason, never the rename blocker above.
    const realOpenSync = fs.openSync;
    fs.openSync = (p, ...rest) => {
      if (typeof p === "string" && p.includes(hash) && p.includes(".tmp-")) throw Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" });
      return realOpenSync(p, ...rest);
    };
    try { clearMergeQuarantineByToken(repo, tokenA); } finally { fs.openSync = realOpenSync; }
    check("(PCWF) THE REGRESSION: the sweep must NOT delete the pre-existing tmp when the rewrite fails", fs.existsSync(tmpPath));

    // Genuinely clear the in-memory entry THIS process's own calls above already set — otherwise the
    // "fresh boot" checks below could pass VACUOUSLY off that stale entry alone (same trap as SCENARIO
    // TORN-WRITE's own (a)/(c) cases). Park the tmp first if it's still there, so the clear's own sweep
    // can't touch it; if the bug already deleted it, there's nothing to park.
    if (fs.existsSync(tmpPath)) {
      const parked = path.join(os.tmpdir(), `loom-mqbh-parked-pcwf-${path.basename(tmpPath)}`);
      fs.renameSync(tmpPath, parked);
      clearMergeQuarantine(repo);
      fs.renameSync(parked, tmpPath);
    } else {
      clearMergeQuarantine(repo);
    }
    check("(PCWF) precondition: in-memory is genuinely clean before the fresh boot", !activeMergeQuarantineFor(repo));

    fs.rmSync(finalPath, { recursive: true, force: true }); // blocker/env issue resolved
    const found = reenterMergeQuarantinesAtBoot([repo]);
    check("(PCWF) a fresh boot still quarantines this repo", found.some((q) => q.repoPath === repo) && !!activeMergeQuarantineFor(repo));
    check("(PCWF) tokenB's own protection survived (never silently lost)", activeMergeQuarantineFor(repo)?.tokens?.includes(tokenB));
    clearMergeQuarantine(repo);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO PASS1B-PROMOTE-FAILURE (Code Review of eae23ebe, item 2) — PASS 1b used to unlink the
  // recovered tmp even when its own re-persist (the self-healing promote) FAILED, losing the only durable
  // copy. Only unlink once the promote actually succeeds.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("p1bpf");
    enterMergeQuarantine(repo, "p1bpf-branch", "p1bpf reason");
    const latchPath = fs.readdirSync(MERGE_QUARANTINE_DIR)
      .map((f) => path.join(MERGE_QUARANTINE_DIR, f))
      .find((p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")).repoPath === repo; } catch { return false; } });
    const hash = path.basename(latchPath, ".json");
    const tmpPath = `${latchPath}.tmp-999999`;
    fs.renameSync(latchPath, tmpPath); // simulate a torn write: tmp only, no final
    const parked = path.join(os.tmpdir(), `loom-mqbh-parked-${path.basename(tmpPath)}`);
    fs.renameSync(tmpPath, parked);
    clearMergeQuarantine(repo); // genuinely clear the stale in-memory entry first
    fs.renameSync(parked, tmpPath);

    // Patch fs.openSync to fail ONLY the promote's own NEW tmp write (a different pid-suffix than the
    // surviving `tmpPath` above), never a read of the surviving tmp itself.
    const realOpenSync = fs.openSync;
    fs.openSync = (p, ...rest) => {
      if (typeof p === "string" && p.includes(hash) && p.includes(".tmp-") && p !== tmpPath) throw Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" });
      return realOpenSync(p, ...rest);
    };
    let found;
    try { found = reenterMergeQuarantinesAtBoot([repo]); } finally { fs.openSync = realOpenSync; }
    check("(P1BPF) this boot still recovers the quarantine in-process despite the promote failing", found.some((q) => q.repoPath === repo) && !!activeMergeQuarantineFor(repo));
    check("(P1BPF) THE REGRESSION: the recovered tmp must SURVIVE on disk since the promote failed", fs.existsSync(tmpPath));
    check("(P1BPF) no final latch was created (the promote genuinely failed)", !fs.existsSync(latchPath));

    const found2 = reenterMergeQuarantinesAtBoot([repo]); // a further boot, promote now unblocked
    check("(P1BPF) the NEXT boot recovers from the surviving tmp and self-heals", found2.some((q) => q.repoPath === repo) && fs.existsSync(latchPath) && !fs.existsSync(tmpPath));
    clearMergeQuarantine(repo);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO ITEM-8 — real AST-shape check: index.ts calls reenterMergeQuarantinesAtBoot( BEFORE it binds
  // the port. Mirrors boot-listen-not-blocked.mjs's own technique (position in the AST, never a fixed
  // character-offset slice).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const indexPath = path.join(__dirname, "..", "src", "index.ts");
    const source = fs.readFileSync(indexPath, "utf8");
    const sourceFile = ts.createSourceFile(indexPath, source, ts.ScriptTarget.Latest, true);

    function findCalls(name) {
      const out = [];
      const visit = (node) => {
        if (ts.isCallExpression(node)) {
          const expr = node.expression;
          const calleeName = ts.isIdentifier(expr) ? expr.text
            : ts.isPropertyAccessExpression(expr) ? expr.name.text
              : undefined;
          if (calleeName === name) out.push(node);
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
      return out;
    }

    const reentryCalls = findCalls("reenterMergeQuarantinesAtBoot");
    const buildServerCalls = findCalls("buildServer");
    const listenCalls = [...findCalls("listen"), ...findCalls("startGatewayListeners")];
    check("(item-8) src/index.ts calls reenterMergeQuarantinesAtBoot( exactly once", reentryCalls.length === 1);
    // Round 7 (Code Review, item #8 re-check): `buildServer(` itself, not just the (later) port-bind calls
    // — buildServer wires the gateway's REQUEST HANDLERS; a request could in principle reach one of those
    // handlers (a route registered directly on `app` before `startGatewayListeners` binds the socket, e.g.
    // via an internal call) before the socket is even bound, so re-entry must precede buildServer too, not
    // merely the later listen/startGatewayListeners call this file already checked in round 6.
    check("(item-8) src/index.ts calls buildServer( exactly once", buildServerCalls.length === 1);
    check("(item-8) src/index.ts binds the port (app.listen( or startGatewayListeners()", listenCalls.length > 0);

    const reentryPos = reentryCalls[0]?.getStart(sourceFile) ?? -1;
    const buildServerPos = buildServerCalls[0]?.getStart(sourceFile) ?? -1;
    const listenPos = listenCalls.length > 0 ? Math.min(...listenCalls.map((c) => c.getStart(sourceFile))) : -1;
    check(
      "(item-8) reenterMergeQuarantinesAtBoot( runs BEFORE buildServer( (not just before the later port-bind — round 7 re-check)",
      reentryPos >= 0 && buildServerPos >= 0 && reentryPos < buildServerPos,
    );
    check(
      "(item-8) reenterMergeQuarantinesAtBoot( runs BEFORE the port is bound (closes the request-window race — was AFTER, round 4)",
      reentryPos >= 0 && listenPos >= 0 && reentryPos < listenPos,
    );

    // Round 7 (Code Review, item #8 re-check): the call must pass a REAL, non-empty repo list — a bare
    // `reenterMergeQuarantinesAtBoot()` or a literal `reenterMergeQuarantinesAtBoot([])` would compile,
    // pass every check above, and still silently regress to "nothing is ever fail-closed-matchable"
    // (BLOCKER 2's whole fix depends on a real list reaching this call). Assert the call has exactly one
    // argument, and that argument is not a literal empty array — the real call site is
    // `reenterMergeQuarantinesAtBoot([...canonicalRepoPaths])`, a non-empty ArrayLiteralExpression.
    const reentryArgs = reentryCalls[0]?.arguments ?? [];
    check("(item-8) reenterMergeQuarantinesAtBoot( is called with exactly one argument (a repo list, not zero args)", reentryArgs.length === 1);
    const arg = reentryArgs[0];
    const argIsNonEmptyArrayLiteral = !!arg && ts.isArrayLiteralExpression(arg) && arg.elements.length > 0;
    check("(item-8) that argument is a NON-EMPTY array literal (not a literal [] regression)", argIsNonEmptyArrayLiteral);
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a durable quarantine latch re-arms in a genuinely FRESH process (NC2), a corrupt latch " +
    "fails CLOSED (matched-repo-specific or every-registered-repo, never silently skipped — BLOCKER 2), a " +
    "torn .tmp-<pid> write is recovered rather than silently dropped (card bde5d1fe item 5), a failed " +
    "write's tmp SURVIVES and a fresh boot re-arms from it (round 2, reverting round 1's own regression), " +
    "both clear paths still sweep residue once a quarantine is genuinely resolved, and index.ts re-enters " +
    "quarantines BEFORE binding the port (item #8)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
