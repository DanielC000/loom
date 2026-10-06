import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// MERGE QUARANTINE — PASS 1b must gate its "stale tmp, safe to delete" branch on a CLEAN PASS-1 parse,
// never on "byRepoKey has SOME entry for this key" (card 92c645cc, from the final delta review of
// bde5d1fe — see docs/decisions/bde5d1fe-*).
//
// THE BUG: PASS 1b's stale-tmp branch unlinked a repo's own `.json.tmp-<pid>` residue whenever
// `byRepoKey.has(matchedRepo)` was true. But `byRepoKey` is ALSO populated by PASS 1's
// corrupt-but-hash-matched branch (a fail-closed GENERIC placeholder entry), even when that branch's own
// self-heal write (`writeMergeQuarantineLatch`) FAILS — i.e. even though nothing durable actually got
// written under the real repo's name. In that shape, the tmp residue is NOT stale — it is the ONLY
// surviving durable copy of the REAL entry's branch/reason/opId (an earlier raise's fsync'd-but-never-
// renamed write). The old code deleted it anyway and kept only the generic corrupt-latch placeholder,
// permanently losing the real identity (neither raise nor restart can ever recover it after that).
//
// THE FIX verified here: PASS 1b must gate the "stale, delete it" branch on a repo having had a
// genuinely CLEAN parse in PASS 1 — never merely "some entry exists in byRepoKey for this key" — and
// when the final was corrupt, the tmp's own real content (once it itself parses) takes precedence over
// the generic placeholder.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-pass1b-clean-parse-gate.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-mqp1b-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  enterMergeQuarantine, clearMergeQuarantine, activeMergeQuarantineFor, reenterMergeQuarantinesAtBoot, MERGE_QUARANTINE_DIR,
  quarantineLatchIdFor,
} = await import(mergeQuarantineModuleHref);

// A genuinely fresh ESM module instance (its OWN empty `activeQuarantines` map, a real module-scope
// reset) for a "second boot" check that must not lean on anything this file's single top-level import
// already populated — Node's loader keys its module cache on the full URL including the query string, so
// each call here gets its own instance, same file, never reused (card cac93b4c item 3).
let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqp1b@loom -c user.name=mqp1b";
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const tmpDirs = [];

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqp1b-${tag}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# merge-quarantine-pass1b-clean-parse-gate\n");
  execSync(`git init -q && git config user.email mqp1b@loom && git config user.name mqp1b`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO CORRUPT-FINAL-REAL-TMP (card 92c645cc, item 1) — a registered repo whose FINAL latch is
  // corrupt, whose TMP residue holds the real fsync'd entry, and whose PASS-1 self-heal write fails
  // (EMFILE-shaped) must recover the REAL entry from the tmp — never settle for the generic placeholder
  // with the tmp silently deleted.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("cfrt");
    enterMergeQuarantine(repo, "real-branch", "the REAL reason — must survive", "real-op-id");
    const latchPath = fs.readdirSync(MERGE_QUARANTINE_DIR)
      .map((f) => path.join(MERGE_QUARANTINE_DIR, f))
      .find((p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")).repoPath === repo; } catch { return false; } });
    check("(CFRT) precondition: the well-formed latch file exists", !!latchPath && fs.existsSync(latchPath));
    const hash = path.basename(latchPath, ".json");

    // Manufacture the exact on-disk shape from the card: a durable tmp holding the REAL entry (an
    // earlier raise's fsync'd-but-never-renamed write), plus a SEPARATE, corrupt final (a later torn
    // write). Park the real content outside the quarantine dir first so a `clearMergeQuarantine` call can
    // genuinely wipe this process's in-memory state without also sweeping the very file we need to
    // reintroduce as a TMP (same technique as the TORN-WRITE/WFR scenarios in
    // merge-quarantine-boot-hardening.mjs).
    const parkedPath = path.join(os.tmpdir(), `loom-mqp1b-parked-${sfx}.json`);
    fs.renameSync(latchPath, parkedPath);
    clearMergeQuarantine(repo);
    check("(CFRT) precondition: in-memory is genuinely clean before the manufactured state is set up", !activeMergeQuarantineFor(repo));

    const tmpPath = `${latchPath}.tmp-777777`; // an arbitrary foreign pid — a DIFFERENT raise than this process's own
    fs.renameSync(parkedPath, tmpPath);
    fs.writeFileSync(latchPath, "{"); // the corrupt final — unparsable JSON
    check(
      "(CFRT) precondition: a corrupt final + a real-content tmp both exist, in-memory still clean",
      fs.readFileSync(latchPath, "utf8") === "{" && fs.existsSync(tmpPath) && !activeMergeQuarantineFor(repo),
    );

    // Simulate "EMFILE on new writes" (the card's own repro wording): fail the FIRST open of a NEW tmp
    // for this hash (PASS 1's own self-heal attempt), succeed on any later one (PASS 1b's own recovery
    // promote, if the fix attempts it) — a real EMFILE is transient, not permanent, and this lets the test
    // tell apart "the fix never even tries" from "the fix tries and a transient fault beats it once".
    const realOpenSync = fs.openSync;
    let interceptCount = 0;
    fs.openSync = (p, ...rest) => {
      if (typeof p === "string" && p.includes(hash) && p.includes(".tmp-") && p !== tmpPath) {
        interceptCount++;
        if (interceptCount === 1) throw Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" });
      }
      return realOpenSync(p, ...rest);
    };
    let found;
    try {
      found = reenterMergeQuarantinesAtBoot([repo]);
    } finally {
      fs.openSync = realOpenSync;
    }

    check("(CFRT) at least one new-tmp write was attempted (the self-heal write ran)", interceptCount >= 1);
    check("(CFRT) the re-entry result reports this repo", found.some((q) => q.repoPath === repo));
    const active = activeMergeQuarantineFor(repo);
    check(
      "(CFRT) THE BUG: a corrupt final + a failed self-heal write used to leave ONLY the generic placeholder reason — the fix recovers the REAL reason from the tmp",
      active?.reason === "the REAL reason — must survive",
    );
    check("(CFRT) the REAL branch/opId survive too (never just the reason)", active?.branch === "real-branch" && active?.opId === "real-op-id");
    // THE BUG: the old code unconditionally deleted the real tmp the instant byRepoKey had ANY entry for
    // this key, with NOTHING durable left behind — the fix never discards the only surviving durable copy
    // without either keeping it (promote failed) or having already promoted it to the final (promote
    // succeeded, once the transient fault cleared on retry). Either outcome is acceptable; losing BOTH is not.
    const survivedAsTmp = fs.existsSync(tmpPath);
    const promotedToFinal = fs.existsSync(latchPath) && (() => {
      try { return JSON.parse(fs.readFileSync(latchPath, "utf8")).reason === "the REAL reason — must survive"; } catch { return false; }
    })();
    check("(CFRT) THE BUG: data must survive EITHER as the surviving tmp OR promoted to the final — never neither", survivedAsTmp || promotedToFinal);

    clearMergeQuarantine(repo);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO R1 (card cac93b4c, item 3; REVISED by card 882d6cff) — boot 1's self-heal write succeeds
  // (interceptCount 1) and the LATER union-promote write for the tmp fails (EMFILE, interceptCount 2).
  //
  // card 882d6cff deferred PASS 1's own matched-corrupt self-heal into the SAME post-read write pass
  // 4480b077 introduced for migrated sources — which runs AFTER PASS 1b has already read and armed the
  // real tmp's content in-memory. So by the time THIS test's "self-heal" write (interceptCount 1) fires,
  // `byRepoKey` already holds the REAL union (not the bare placeholder) — the self-heal write durably
  // writes the RECOVERED identity on its own, and the later, separate tmp-promote write (interceptCount
  // 2, the one EMFILE actually hits) failing no longer matters: the data is already on disk. This is a
  // STRICTLY BETTER outcome than the old pin (which only survived a fault on the FIRST write, never the
  // second) — updated here rather than left asserting the now-superseded behavior. Boot 2 (a genuinely
  // fresh module instance, EMFILE no longer injected) remains a stable no-op on top of already-correct data.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("r1");
    enterMergeQuarantine(repo, "real-branch", "the REAL r1 reason — must survive", "real-r1-op-id");
    const latchPath = fs.readdirSync(MERGE_QUARANTINE_DIR)
      .map((f) => path.join(MERGE_QUARANTINE_DIR, f))
      .find((p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")).repoPath === repo; } catch { return false; } });
    const hash = path.basename(latchPath, ".json");

    // Same manufacture technique as CFRT: park the real content, clear in-memory state, then reintroduce
    // the real content as a TMP beside a freshly-corrupted final.
    const parkedPath = path.join(os.tmpdir(), `loom-mqp1b-r1-parked-${sfx}.json`);
    fs.renameSync(latchPath, parkedPath);
    clearMergeQuarantine(repo);
    const tmpPath = `${latchPath}.tmp-888888`; // an arbitrary foreign pid
    fs.renameSync(parkedPath, tmpPath);
    fs.writeFileSync(latchPath, "{"); // the corrupt final — unparsable JSON
    check("(R1) precondition: a corrupt final + a real-content tmp both exist, in-memory clean",
      fs.readFileSync(latchPath, "utf8") === "{" && fs.existsSync(tmpPath) && !activeMergeQuarantineFor(repo));

    // Let the FIRST matching new-tmp write (PASS 1's own self-heal of the corrupt final) succeed; fail
    // the SECOND (PASS 1b's later union-promote write for the SAME key) with an EMFILE-shaped error.
    const realOpenSync = fs.openSync;
    let interceptCount = 0;
    let emfileFired = false;
    fs.openSync = (p, ...rest) => {
      if (typeof p === "string" && p.includes(hash) && p.includes(".tmp-") && p !== tmpPath) {
        interceptCount++;
        if (interceptCount === 2) { emfileFired = true; throw Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" }); }
      }
      return realOpenSync(p, ...rest);
    };
    let found;
    try {
      found = reenterMergeQuarantinesAtBoot([repo]);
    } finally {
      fs.openSync = realOpenSync;
    }

    // Positive control: the injection must actually have fired on the promote write, not merely have been
    // armed — otherwise every assertion below could pass vacuously off an un-exercised code path.
    check("(R1) positive control: the self-heal write ran first, then the EMFILE injection fired on the promote write", interceptCount === 2 && emfileFired === true);
    check("(R1) boot 1 still recovers this repo", found.some((q) => q.repoPath === repo));
    check("(R1) boot 1 recovers the REAL entry IN-MEMORY despite the failed promote", activeMergeQuarantineFor(repo)?.reason === "the REAL r1 reason — must survive");
    check("(R1) the real tmp survives untouched (the promote failed, nothing was unlinked)", fs.existsSync(tmpPath));
    // THE REVISED PIN (card 882d6cff): the self-heal write (interceptCount 1, succeeded) now ALREADY
    // carries the union — PASS 1b armed the real tmp content in-memory BEFORE this deferred write ran —
    // so the final's own on-disk content is the RECOVERED REAL identity even though the separate,
    // later tmp-promote write (interceptCount 2) failed. Regressing the defer-and-union fix back to an
    // inline, pre-union self-heal write must flip this RED.
    const onDiskAfterBoot1 = (() => { try { return JSON.parse(fs.readFileSync(latchPath, "utf8")); } catch { return null; } })();
    check("(R1) THE REVISED PIN: the on-disk final after the failed promote already carries the REAL recovered identity (the deferred self-heal wrote the union, not a bare placeholder)",
      onDiskAfterBoot1?.reason === "the REAL r1 reason — must survive" && onDiskAfterBoot1?.branch === "real-branch" && !onDiskAfterBoot1?.placeholder);

    // Boot 2: a genuinely fresh module instance, EMFILE no longer injected. The on-disk final is ALREADY
    // the real recovered identity (the revised pin above) — boot 2's own job is just the now-unblocked
    // tmp-promote write succeeding this time, sweeping the real tmp boot 1 left behind only because ITS
    // tmp-promote write (not the self-heal) was the one that failed.
    const bootMod2 = await freshBootModule();
    const found2 = bootMod2.reenterMergeQuarantinesAtBoot([repo]);
    check("(R1) boot 2 (fresh module instance) still recovers the real entry",
      found2.some((q) => q.repoPath === repo) && bootMod2.activeMergeQuarantineFor(repo)?.reason === "the REAL r1 reason — must survive");
    const onDiskAfterBoot2 = (() => { try { return JSON.parse(fs.readFileSync(latchPath, "utf8")); } catch { return null; } })();
    check("(R1) boot 2's on-disk final still carries the real identity (unchanged from boot 1, never a placeholder)",
      onDiskAfterBoot2?.reason === "the REAL r1 reason — must survive" && onDiskAfterBoot2?.branch === "real-branch" && !onDiskAfterBoot2?.placeholder);
    check("(R1) boot 2 sweeps the now-superseded real tmp (its own tmp-promote write is no longer faulted)", !fs.existsSync(tmpPath));

    clearMergeQuarantine(repo);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO STALE-TMP-STILL-SWEPT (regression guard) — a GENUINELY stale tmp beside an already-CLEAN
  // final must still be swept as harmless residue; the fix must not regress this into a permanent leak.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("stale");
    enterMergeQuarantine(repo, "stale-branch", "the REAL current reason");
    const latchPath = fs.readdirSync(MERGE_QUARANTINE_DIR)
      .map((f) => path.join(MERGE_QUARANTINE_DIR, f))
      .find((p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")).repoPath === repo; } catch { return false; } });
    const staleTmpPath = `${latchPath}.tmp-111111`;
    fs.writeFileSync(staleTmpPath, JSON.stringify({ repoPath: repo, branch: "STALE-EARLIER-ATTEMPT", reason: "an earlier, now-superseded attempt", enteredAt: 1, tokens: ["stale-token"] }));
    check("(STALE) precondition: both a real final latch and a stale tmp exist", fs.existsSync(latchPath) && fs.existsSync(staleTmpPath));

    const found = reenterMergeQuarantinesAtBoot([repo]);
    check(
      "(STALE) a CLEAN final parse still means the stale tmp is swept, with the REAL data surviving",
      found.filter((q) => q.repoPath === repo).length === 1 && activeMergeQuarantineFor(repo)?.reason === "the REAL current reason",
    );
    check("(STALE) the stale tmp is cleaned up as harmless residue", !fs.existsSync(staleTmpPath));
    check("(STALE) the real final latch is untouched", fs.existsSync(latchPath));
    clearMergeQuarantine(repo);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO MULTI-TMP-UNION (card 92c645cc round 2, items 2/2b/4) — >=2 same-key tmps from ONE process
  // (no final + a real tmp + a 0-byte corrupt sibling), with names forced into BOTH sort orders, must
  // produce the SAME outcome regardless of which happens to sort first: the final's ON-DISK content (not
  // just in-memory) carries the REAL entry, and the corrupt sibling is swept too — but ONLY once that
  // union write durably succeeds (never speculatively, never before).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  for (const order of ["real-first", "corrupt-first"]) {
    const repo = makeRepo(`mtu-${order}`);
    enterMergeQuarantine(repo, "discover", "discover path"); // resolve this repo's own latch path/hash
    const finalPath = fs.readdirSync(MERGE_QUARANTINE_DIR)
      .map((f) => path.join(MERGE_QUARANTINE_DIR, f))
      .find((p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")).repoPath === repo; } catch { return false; } });
    clearMergeQuarantine(repo);
    check(`(MTU-${order}) precondition: no final latch exists`, !fs.existsSync(finalPath));

    const realContent = JSON.stringify({
      repoPath: repo, branch: "mtu-real-branch", reason: "the REAL mtu reason", enteredAt: Date.now(), tokens: ["mtu-real-token"],
    });
    // Keep the TWO PHYSICAL tmp filenames FIXED across both iterations of this loop, and only swap which
    // CONTENT (real vs. corrupt) goes into which — never assume a filename's text controls readdirSync's
    // actual enumeration order (docs/decisions/54054c01-*: that order is not guaranteed predictable from
    // names alone). Fixed names + swapped content means whichever way THIS filesystem really enumerates
    // the pair, exactly one of these two iterations exercises each processing order.
    // Suffixes must still match the real `.tmp-<pid>(-<hex>)?` shape `reenterMergeQuarantinesAtBoot`
    // actually scans for (digits, optionally `-` + lowercase hex) — an arbitrary string here would
    // silently fail to be recognized as tmp residue at all.
    const [pairA, pairB] = ["900001-aaaaaaaa", "900002-bbbbbbbb"];
    const realTmpPath = `${finalPath}.tmp-${order === "real-first" ? pairA : pairB}`;
    const corruptTmpPath = `${finalPath}.tmp-${order === "real-first" ? pairB : pairA}`;
    fs.writeFileSync(realTmpPath, realContent);
    fs.writeFileSync(corruptTmpPath, ""); // a 0-byte sibling — genuinely unparsable, not recoverable
    check(`(MTU-${order}) precondition: both tmps exist, no final, in-memory clean`,
      fs.existsSync(realTmpPath) && fs.existsSync(corruptTmpPath) && !fs.existsSync(finalPath) && !activeMergeQuarantineFor(repo));

    const found = reenterMergeQuarantinesAtBoot([repo]);
    check(`(MTU-${order}) a fresh boot recovers this repo from the real tmp despite order + a corrupt sibling`,
      found.some((q) => q.repoPath === repo) && activeMergeQuarantineFor(repo)?.reason === "the REAL mtu reason");
    check(`(MTU-${order}) THE REGRESSION: the FINAL'S OWN ON-DISK CONTENT (not just memory) carries the real entry`,
      fs.existsSync(finalPath) && (() => {
        try {
          const onDisk = JSON.parse(fs.readFileSync(finalPath, "utf8"));
          return onDisk.reason === "the REAL mtu reason" && onDisk.branch === "mtu-real-branch";
        } catch { return false; }
      })());
    check(`(MTU-${order}) the real tmp is unlinked once the union write durably succeeds`, !fs.existsSync(realTmpPath));
    check(`(MTU-${order}) the corrupt sibling tmp is ALSO swept once that same write succeeds (never left as permanent residue)`, !fs.existsSync(corruptTmpPath));

    // A genuinely fresh module instance — never this file's shared top-level import — so this check
    // proves the on-disk state alone is stable across a real restart, not merely that the FIRST boot's
    // own `activeQuarantines` entry is still sitting there unchanged.
    const bootMod2 = await freshBootModule();
    const found2 = bootMod2.reenterMergeQuarantinesAtBoot([repo]); // a further boot must stay stable, never duplicate
    check(`(MTU-${order}) a second boot is stable (reports once, same real content)`,
      found2.filter((q) => q.repoPath === repo).length === 1 && bootMod2.activeMergeQuarantineFor(repo)?.reason === "the REAL mtu reason");

    clearMergeQuarantine(repo);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO MULTI-TMP-UNION-WRITE-FAILURE — when the union write for a key FAILS, every tmp for that
  // key (the real one AND the corrupt sibling) must survive untouched — never swept on a failed write.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("mtuwf");
    enterMergeQuarantine(repo, "discover", "discover path");
    const finalPath = fs.readdirSync(MERGE_QUARANTINE_DIR)
      .map((f) => path.join(MERGE_QUARANTINE_DIR, f))
      .find((p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")).repoPath === repo; } catch { return false; } });
    const hash = path.basename(finalPath, ".json");
    clearMergeQuarantine(repo);

    const realContent = JSON.stringify({
      repoPath: repo, branch: "mtuwf-real-branch", reason: "the REAL mtuwf reason", enteredAt: Date.now(), tokens: ["mtuwf-real-token"],
    });
    const realTmpPath = `${finalPath}.tmp-100-aaaaaaaa`;
    const corruptTmpPath = `${finalPath}.tmp-200-bbbbbbbb`;
    fs.writeFileSync(realTmpPath, realContent);
    fs.writeFileSync(corruptTmpPath, "");

    // Patch fs.openSync to fail every new-tmp write for this hash — simulates the union write itself
    // failing (EMFILE-shaped), never a read of the surviving tmps above.
    const realOpenSync = fs.openSync;
    fs.openSync = (p, ...rest) => {
      if (typeof p === "string" && p.includes(hash) && p.includes(".tmp-")) throw Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" });
      return realOpenSync(p, ...rest);
    };
    let found;
    try { found = reenterMergeQuarantinesAtBoot([repo]); } finally { fs.openSync = realOpenSync; }
    check("(MTUWF) this boot still recovers the quarantine in-process despite the union write failing",
      found.some((q) => q.repoPath === repo) && activeMergeQuarantineFor(repo)?.reason === "the REAL mtuwf reason");
    check("(MTUWF) THE REGRESSION: a FAILED union write must leave the real tmp in place", fs.existsSync(realTmpPath));
    check("(MTUWF) THE REGRESSION: a FAILED union write must ALSO leave the corrupt sibling in place (never swept speculatively)", fs.existsSync(corruptTmpPath));
    check("(MTUWF) no final latch was created (the write genuinely failed)", !fs.existsSync(finalPath));

    const bootMod2 = await freshBootModule(); // genuinely fresh module instance, write unblocked now
    const found2 = bootMod2.reenterMergeQuarantinesAtBoot([repo]);
    check("(MTUWF) the NEXT boot recovers from the surviving tmps, writes the final, and sweeps both",
      found2.some((q) => q.repoPath === repo) && fs.existsSync(finalPath) && !fs.existsSync(realTmpPath) && !fs.existsSync(corruptTmpPath));
    clearMergeQuarantine(repo);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO DUAL-ARM-STALE-RESOLVEDKEY (card cac93b4c, item 1) — a recovered TMP that carries a STALE
  // `resolvedKey` (differing from its repo's actual current key) gets dual-armed in-memory under BOTH
  // keys, as designed. But the LATER per-key union-promote write (`byRepoKey.set(key, armedForWrite)`)
  // must write the SAME promoted object to EVERY key the entry is armed under — never just the one key
  // the tmp happened to be grouped by in `tmpsToUnlinkByKey` — or the two keys end up pointing at two
  // DIFFERENT objects for the same logical quarantine. `reenterMergeQuarantinesAtBoot`'s own de-dupe
  // (`new Set(byRepoKey.values())`, keyed by object IDENTITY, never content) then reports it TWICE — the
  // exact "2 entries vs 1" the reviewer reproduced, surfacing as a duplicate `[boot] canonical repo … is
  // QUARANTINED` boot warning (index.ts).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("dual-arm");
    // This repo's OWN current-key hash, with no `enterMergeQuarantine` call needed first (never persists
    // anything) — see quarantineLatchIdFor's own doc comment: it's exactly quarantineHashFor(repoPath).
    const hash = quarantineLatchIdFor(repo);
    const finalPath = path.join(MERGE_QUARANTINE_DIR, `${hash}.json`);
    const staleKey = "stale-dual-arm-key-for-cac93b4c-test"; // deliberately NOT this repo's real current key
    const tmpPath = `${finalPath}.tmp-444444`;
    fs.writeFileSync(tmpPath, JSON.stringify({
      repoPath: repo, branch: "dual-arm-branch", reason: "the REAL dual-arm reason", enteredAt: Date.now(),
      tokens: ["dual-arm-token"], resolvedKey: staleKey,
    }));
    check("(DUAL-ARM) precondition: no final latch exists, only the stale-resolvedKey tmp, in-memory clean",
      !fs.existsSync(finalPath) && fs.existsSync(tmpPath) && !activeMergeQuarantineFor(repo));

    const found = reenterMergeQuarantinesAtBoot([repo]);
    check("(DUAL-ARM) THE BUG: a dual-armed tmp with a stale resolvedKey must report ONCE, not twice",
      found.filter((q) => q.repoPath === repo).length === 1);
    check("(DUAL-ARM) the recovered in-memory entry carries the real content", activeMergeQuarantineFor(repo)?.reason === "the REAL dual-arm reason");
    check("(DUAL-ARM) the on-disk final's own content also carries the real reason (the promote succeeded)",
      (() => {
        try { return JSON.parse(fs.readFileSync(finalPath, "utf8")).reason === "the REAL dual-arm reason"; } catch { return false; }
      })());

    clearMergeQuarantine(repo);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO LEGACY-PLACEHOLDER-FIELDLESS (card 92c645cc round 2, item 2) — a placeholder final written
  // by round-1/main code, BEFORE the `placeholder` discriminator field existed, must still be recognized
  // as a placeholder by its branch text alone — and so must NOT count as a clean parse, or a real sibling
  // tmp gets wrongly swept as "stale residue beside an already-good final" (the exact two-boot loss the
  // card describes: boot 1 self-heals the placeholder successfully but the real tmp's own promote fails;
  // boot 2 then sees a cleanly-parsing placeholder final and deletes the real tmp).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("legacy-ph");
    enterMergeQuarantine(repo, "discover", "discover path");
    const finalPath = fs.readdirSync(MERGE_QUARANTINE_DIR)
      .map((f) => path.join(MERGE_QUARANTINE_DIR, f))
      .find((p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")).repoPath === repo; } catch { return false; } });
    clearMergeQuarantine(repo);

    // Manufacture the exact round-1-era on-disk shape: a FIELD-LESS placeholder final (no `placeholder`
    // key at all — the shape a pre-this-fix daemon actually wrote) sitting beside a REAL tmp holding the
    // genuine entry (as if an earlier boot's own promote of that tmp had failed).
    fs.writeFileSync(finalPath, JSON.stringify({
      repoPath: repo, branch: "(unknown — corrupt boot-time latch)",
      reason: "boot found a CORRUPT/unparsable quarantine latch matching this repo's hash",
      enteredAt: Date.now(), tokens: ["legacy-placeholder-token"],
    }));
    const realTmpPath = `${finalPath}.tmp-555555`;
    fs.writeFileSync(realTmpPath, JSON.stringify({
      repoPath: repo, branch: "legacy-real-branch", reason: "the REAL legacy reason — must survive",
      enteredAt: Date.now() - 60_000, tokens: ["legacy-real-token"],
    }));
    check("(LEGACY-PH) precondition: a field-less placeholder final + a real tmp both exist, in-memory clean",
      fs.existsSync(finalPath) && fs.existsSync(realTmpPath) && !activeMergeQuarantineFor(repo));

    const found = reenterMergeQuarantinesAtBoot([repo]);
    check("(LEGACY-PH) the boot recovers this repo", found.some((q) => q.repoPath === repo));
    check(
      "(LEGACY-PH) THE REGRESSION: the field-less placeholder must NOT count as a clean parse — the real tmp's content wins, not the placeholder's",
      activeMergeQuarantineFor(repo)?.reason === "the REAL legacy reason — must survive",
    );
    check("(LEGACY-PH) the final's OWN ON-DISK content now carries the real entry (promoted, not left as the stale placeholder)",
      (() => {
        try { return JSON.parse(fs.readFileSync(finalPath, "utf8")).reason === "the REAL legacy reason — must survive"; } catch { return false; }
      })());

    const bootMod2 = await freshBootModule(); // genuinely fresh module instance
    const found2 = bootMod2.reenterMergeQuarantinesAtBoot([repo]); // a further boot must stay stable
    check("(LEGACY-PH) a second boot remains stable on the now-real final",
      found2.some((q) => q.repoPath === repo) && bootMod2.activeMergeQuarantineFor(repo)?.reason === "the REAL legacy reason — must survive");

    clearMergeQuarantine(repo);
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — PASS 1b's stale-tmp sweep is gated on a CLEAN PASS-1 parse (never merely \"byRepoKey " +
    "has some entry\"), so a corrupt final + a failed self-heal write recovers the real tmp's content " +
    "instead of silently settling for the generic placeholder, while a genuinely stale tmp beside an " +
    "already-clean final is still swept as before."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
