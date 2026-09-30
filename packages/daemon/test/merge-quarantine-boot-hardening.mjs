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
  enterMergeQuarantine, clearMergeQuarantine, activeMergeQuarantineFor, reenterMergeQuarantinesAtBoot, MERGE_QUARANTINE_DIR,
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
    clearMergeQuarantine(repo); // clears the in-memory map only — the final .json is already gone (renamed)
    check("(TW) precondition: in-memory map is clean, only a .tmp-<pid> file is on disk (no final .json)",
      !activeMergeQuarantineFor(repo) && fs.existsSync(tmpPath) && !fs.existsSync(latchPath));

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
    clearMergeQuarantine(repo3); // clears the in-memory map (disk final is already gone)
    check("(TW-corrupt) precondition: in-memory clean, only a CORRUPT tmp is on disk (no final .json)",
      !activeMergeQuarantineFor(repo3) && fs.existsSync(corruptTmpPath) && !fs.existsSync(latchPath3));

    const foundCorrupt = reenterMergeQuarantinesAtBoot([repo3]);
    check("(TW-corrupt) a corrupt tmp matching a registered repo fails CLOSED (quarantines THAT repo)", !!activeMergeQuarantineFor(repo3));
    check("(TW-corrupt) the re-entry result reports this repo", foundCorrupt.some((q) => q.repoPath === repo3));
    check("(TW-corrupt) the fail-closed reason names the corruption", /corrupt|unparsable/i.test(activeMergeQuarantineFor(repo3)?.reason ?? ""));
    clearMergeQuarantine(repo3);
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
    "torn .tmp-<pid> write is recovered rather than silently dropped (card bde5d1fe item 5), and index.ts " +
    "re-enters quarantines BEFORE binding the port (item #8)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
