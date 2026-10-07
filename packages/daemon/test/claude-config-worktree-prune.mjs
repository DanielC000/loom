// Hermetic unit test for card 498452c0 — pruning ~/.claude.json entries for deleted Loom worktrees.
// Covers both new exports in pty/claude-config.ts:
//   - pruneDeadWorktreeClaudeConfigEntries (dry-run + real one-time/re-runnable bulk prune)
//   - removeClaudeConfigEntryForWorktree (the GC-time single-worktree removal hook — now DEFERRED via
//     setImmediate off gcWorktreeDir's synchronous call stack; see flushGcRemoval below)
//
// ⛔ OWNER-FACING FILE — this suite NEVER reads, writes, or counts the real ~/.claude.json. It redirects
// CLAUDE_CONFIG_DIR (claudeJsonPath() honors it) AND HOME/USERPROFILE (belt-and-suspenders), and passes
// its own synthetic `worktreesRoot` override to pruneDeadWorktreeClaudeConfigEntries so it never consults
// the real WORKTREES_DIR either. The real file's prune is OWNER-RUN only, via a separate script (not this
// test) — request e44d319e, still pending as of this writing.
//
// Run after build: node test/claude-config-worktree-prune.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  pruneDeadWorktreeClaudeConfigEntries,
  removeClaudeConfigEntryForWorktree,
  __setReadFileSyncForTest,
  __setStatSyncForTest,
} from "../dist/pty/claude-config.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// removeClaudeConfigEntryForWorktree's whole body now runs inside a setImmediate scheduled by the
// exported call itself. Node's immediate queue is strictly FIFO: a setImmediate registered by THIS
// test, right after calling the function, is guaranteed to run AFTER the function's own internal
// callback (which was registered first) — so awaiting one more setImmediate tick deterministically
// waits for that deferred body to have fully run (it does no further async work internally; everything
// inside it is synchronous fs calls). This is an ordering guarantee, not a fixed sleep/timeout.
const flushGcRemoval = () => new Promise((resolve) => setImmediate(resolve));

const root = path.join(os.tmpdir(), `loom-claude-config-worktree-prune-test-${Date.now()}-${process.pid}`);
fs.mkdirSync(root, { recursive: true });

const saved = { cfg: process.env.CLAUDE_CONFIG_DIR, up: process.env.USERPROFILE, home: process.env.HOME, lockMs: process.env.LOOM_TRUST_LOCK_MS };
const restoreEnv = () => {
  for (const [k, v] of [["CLAUDE_CONFIG_DIR", saved.cfg], ["USERPROFILE", saved.up], ["HOME", saved.home], ["LOOM_TRUST_LOCK_MS", saved.lockMs]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
};

const fakeHome = path.join(root, "home");
fs.mkdirSync(fakeHome, { recursive: true });
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;

const configDir = path.join(root, "config");
fs.mkdirSync(configDir, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = configDir;
const claudeJson = path.join(configDir, ".claude.json");

const worktreesRoot = path.join(root, "worktrees");
fs.mkdirSync(worktreesRoot, { recursive: true });

const writeCfg = (projects) => fs.writeFileSync(claudeJson, JSON.stringify({ projects }, null, 2));
const readCfgRaw = () => JSON.parse(fs.readFileSync(claudeJson, "utf8"));
const keyFor = (dir) => path.resolve(dir).replace(/\\/g, "/");

try {
  // === 1. Classification + dry run: exact count, capped sample, NEVER writes. ===
  const liveWorktree = path.join(worktreesRoot, "proj1", "taskA");
  fs.mkdirSync(liveWorktree, { recursive: true });
  const deadWorktree1 = path.join(worktreesRoot, "proj1", "taskB"); // never created on disk — dead
  const deadWorktree2 = path.join(worktreesRoot, "proj2", "taskC"); // never created on disk — dead
  const mainCheckout = path.join(root, "mainrepo"); // OUTSIDE worktreesRoot — the canonicalKey shape
  fs.mkdirSync(mainCheckout, { recursive: true });
  const nonWorktreeProject = path.join(root, "someOtherProject"); // outside worktreesRoot entirely

  writeCfg({
    [keyFor(liveWorktree)]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
    [keyFor(deadWorktree1)]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
    [keyFor(deadWorktree2)]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, disabledMcpjsonServers: ["x"] },
    [keyFor(mainCheckout)]: { hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: true },
    [keyFor(nonWorktreeProject)]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
  });

  const dry = pruneDeadWorktreeClaudeConfigEntries({ dryRun: true, worktreesRoot });
  check("dry run: exact dead count is 2", dry.deadCount === 2);
  check("dry run: dryRun flag echoed true", dry.dryRun === true);
  check("dry run: sample contains both dead keys",
    dry.deadKeysSample.includes(keyFor(deadWorktree1)) && dry.deadKeysSample.includes(keyFor(deadWorktree2)));
  check("dry run: removedKeys always empty", dry.removedKeys.length === 0);
  check("dry run: no write happened (file still has all 5 entries)", Object.keys(readCfgRaw().projects).length === 5);
  check("dry run: no abort, no parse error", dry.aborted === null && dry.parseError === null);
  check("dry run: unknownKeys empty (no stat errors here)", dry.unknownKeys.length === 0);

  // === 2. Real apply: prunes ONLY dead keys under the root; keeps live/canonical/non-worktree keys. ===
  const applied = pruneDeadWorktreeClaudeConfigEntries({ dryRun: false, worktreesRoot });
  check("apply: removed exactly the 2 dead keys", applied.removedKeys.length === 2
    && applied.removedKeys.includes(keyFor(deadWorktree1)) && applied.removedKeys.includes(keyFor(deadWorktree2)));
  check("apply: recreatedKeys empty (nothing recreated)", applied.recreatedKeys.length === 0);
  check("apply: no abort, no parse error", applied.aborted === null && applied.parseError === null);
  const afterApply = readCfgRaw().projects;
  check("apply: live worktree key kept", keyFor(liveWorktree) in afterApply);
  check("apply: dead keys actually gone from the file",
    !(keyFor(deadWorktree1) in afterApply) && !(keyFor(deadWorktree2) in afterApply));
  check("apply: canonical main-checkout key kept untouched",
    afterApply[keyFor(mainCheckout)]?.hasClaudeMdExternalIncludesWarningShown === true);
  check("apply: non-worktree-scoped key kept untouched",
    afterApply[keyFor(nonWorktreeProject)]?.hasTrustDialogAccepted === true);
  check("apply: exactly 3 entries remain (5 - 2 dead)", Object.keys(afterApply).length === 3);

  // === 3. Case-variant key: classified purely by win32 case-fold containment, no real dir needed. ===
  if (process.platform === "win32") {
    const caseVariantDead = path.join(worktreesRoot.toUpperCase(), "projX", "taskX"); // never created
    writeCfg({ [keyFor(caseVariantDead)]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } });
    const dryCaseVariant = pruneDeadWorktreeClaudeConfigEntries({ dryRun: true, worktreesRoot });
    check("case-variant key: still classified as a dead worktree-scoped candidate (win32 case-fold)",
      dryCaseVariant.deadCount === 1 && dryCaseVariant.deadKeysSample.includes(keyFor(caseVariantDead)));
  } else {
    console.log("SKIP  case-variant classification — win32-only (no case-fold elsewhere)");
  }

  // === 4. Junction-aliased worktree: classified by its OWN stored (nested) key; liveness follows
  //        whether the junction currently resolves, not whether it's a "plain" directory. ===
  const junctionTarget = path.join(root, "junction-target");
  const junctionPath = path.join(worktreesRoot, "projJ", "taskJ");
  let junctionWorks = false;
  try {
    fs.mkdirSync(junctionTarget, { recursive: true });
    fs.mkdirSync(path.dirname(junctionPath), { recursive: true });
    fs.symlinkSync(junctionTarget, junctionPath, "junction");
    junctionWorks = fs.existsSync(junctionPath);
  } catch { junctionWorks = false; }

  if (junctionWorks) {
    writeCfg({ [keyFor(junctionPath)]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } });
    const dryLiveJunction = pruneDeadWorktreeClaudeConfigEntries({ dryRun: true, worktreesRoot });
    check("junction: a LIVE junction-aliased worktree is classified ALIVE, not dead", dryLiveJunction.deadCount === 0);

    fs.rmdirSync(junctionPath); // removes the junction point itself, never junctionTarget
    const dryDeadJunction = pruneDeadWorktreeClaudeConfigEntries({ dryRun: true, worktreesRoot });
    check("junction: once the junction point itself is removed, it's classified dead",
      dryDeadJunction.deadCount === 1 && dryDeadJunction.deadKeysSample.includes(keyFor(junctionPath)));
    pruneDeadWorktreeClaudeConfigEntries({ dryRun: false, worktreesRoot }); // clean up before next section
  } else {
    console.log("SKIP  junction test — fs.symlinkSync('junction') unavailable in this environment");
  }

  // === 5. A worktree recreated BETWEEN classification and the fresh in-lock read is kept, not deleted,
  //        and reported in recreatedKeys — never silently dropped. ===
  {
    const recreateDirPath = path.join(worktreesRoot, "proj3", "taskRecreated");
    const recreateKey = keyFor(recreateDirPath);
    if (fs.existsSync(recreateDirPath)) fs.rmSync(recreateDirPath, { recursive: true, force: true });
    writeCfg({ [recreateKey]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } });

    let readCalls = 0;
    const realReadFileSync = fs.readFileSync;
    __setReadFileSyncForTest((p, enc) => {
      readCalls++;
      if (readCalls === 2) {
        // Fires right before the SECOND (fresh, in-lock) read returns — i.e. before that read's own
        // re-verify stat runs — simulating a respawn claiming this exact path in the window since
        // classification. There is no real await point between the two reads to inject this from outside.
        fs.mkdirSync(recreateDirPath, { recursive: true });
      }
      return realReadFileSync(p, enc);
    });
    const recreateResult = pruneDeadWorktreeClaudeConfigEntries({ dryRun: false, worktreesRoot });
    __setReadFileSyncForTest();

    check("recreated dir: exactly 2 reads occurred (classification + one fresh in-lock read)", readCalls === 2);
    check("recreated dir: reported in recreatedKeys, not removedKeys",
      recreateResult.recreatedKeys.includes(recreateKey) && !recreateResult.removedKeys.includes(recreateKey));
    check("recreated dir: entry still present in the file afterward", recreateKey in readCfgRaw().projects);
  }

  // === 6. Malformed/unreadable config: no write, parseError set — for dry run, apply, AND the GC-time
  //        removal. Non-vacuous (card 498452c0 review item 5): the "malformed" content here is a REAL
  //        config with real entries, corrupted (truncated) in place — so a hypothetical fail-open
  //        regression (readCfgFailClosed falling back to readCfg's `{}`) would have something real at
  //        stake (the entries below surviving untouched) rather than operating on an already-empty file. ===
  {
    const survivorKey = keyFor(path.join(worktreesRoot, "proj6", "taskSurvivor")); // a real dead candidate, at stake
    const gcTargetDir = path.join(worktreesRoot, "projGC", "taskMalformed");
    const gcTargetKey = keyFor(gcTargetDir);
    const wellFormed = JSON.stringify({ projects: { [survivorKey]: { hasTrustDialogAccepted: true }, [gcTargetKey]: { hasTrustDialogAccepted: true } } });
    const malformed = wellFormed.slice(0, Math.floor(wellFormed.length * 0.6)); // truncate mid-object — still invalid JSON, demonstrably derived from a file with real entries
    fs.writeFileSync(claudeJson, malformed);

    const dryMalformed = pruneDeadWorktreeClaudeConfigEntries({ dryRun: true, worktreesRoot });
    check("malformed JSON (dry run): parseError set, deadCount 0",
      dryMalformed.parseError !== null && dryMalformed.deadCount === 0);
    const applyMalformed = pruneDeadWorktreeClaudeConfigEntries({ dryRun: false, worktreesRoot });
    check("malformed JSON (apply): parseError set, no write (file still malformed verbatim)",
      applyMalformed.parseError !== null && fs.readFileSync(claudeJson, "utf8") === malformed);

    let threw = false;
    try { removeClaudeConfigEntryForWorktree(gcTargetDir); await flushGcRemoval(); }
    catch { threw = true; }
    check("malformed JSON: removeClaudeConfigEntryForWorktree never throws", !threw);
    check("malformed JSON: removeClaudeConfigEntryForWorktree performs no write (would-have-deleted entry never actually at risk, but the file is untouched either way)",
      fs.readFileSync(claudeJson, "utf8") === malformed);

    // Restore to the well-formed version and confirm the "survivor" entry really was never touched —
    // i.e. this scenario had real stakes, not an empty file that would pass trivially either way.
    fs.writeFileSync(claudeJson, wellFormed);
    check("malformed JSON: once restored, the entries that were at risk during corruption are intact",
      survivorKey in readCfgRaw().projects && gcTargetKey in readCfgRaw().projects);
  }

  // === 6b. A non-ENOENT READ error (not a parse error) — e.g. EISDIR — must ALSO fail closed: no write,
  //         parseError set, for BOTH pruneDeadWorktreeClaudeConfigEntries and the GC-time removal. This
  //         exercises readCfgFailClosed's OTHER catch branch (the fs.readFileSync throw), distinct from
  //         section 6's JSON.parse-failure branch. Guards against review mutation (a'): "non-ENOENT read
  //         error → {}" (a fail-open regression on this specific branch). ===
  {
    const realKey = keyFor(path.join(worktreesRoot, "proj6b", "taskReadError"));
    writeCfg({ [realKey]: { hasTrustDialogAccepted: true } });
    const before = fs.readFileSync(claudeJson, "utf8");

    const realReadFileSync = fs.readFileSync;
    __setReadFileSyncForTest((p, enc) => {
      const err = new Error("EISDIR: illegal operation on a directory");
      err.code = "EISDIR";
      throw err;
    });
    const dryReadError = pruneDeadWorktreeClaudeConfigEntries({ dryRun: true, worktreesRoot });
    check("non-ENOENT read error (dry run): parseError set, never {} (fail-open)",
      dryReadError.parseError !== null && dryReadError.deadCount === 0);
    const applyReadError = pruneDeadWorktreeClaudeConfigEntries({ dryRun: false, worktreesRoot });
    check("non-ENOENT read error (apply): parseError set, no write", applyReadError.parseError !== null);

    let threw = false;
    try { removeClaudeConfigEntryForWorktree(path.join(worktreesRoot, "proj6b", "taskReadError")); await flushGcRemoval(); }
    catch { threw = true; }
    check("non-ENOENT read error: GC-time removal never throws", !threw);
    __setReadFileSyncForTest();
    check("non-ENOENT read error: file on disk never written (still the real pre-error content)",
      fs.readFileSync(claudeJson, "utf8") === before);
  }

  // === 7. Count-drop sanity guard. ===
  {
    // 7a. The ORIGINAL repro shape: an unrelated ALIVE key vanishes alongside a dead one → abort.
    const dropDead = keyFor(path.join(worktreesRoot, "proj4", "taskDrop")); // never created — 1 dead candidate
    const dropLivePath = path.join(worktreesRoot, "proj4", "taskLive");
    fs.mkdirSync(dropLivePath, { recursive: true });
    const dropLive = keyFor(dropLivePath);
    const dropOtherPath = path.join(root, "unrelatedProject");
    fs.mkdirSync(dropOtherPath, { recursive: true });
    const dropOther = keyFor(dropOtherPath);

    writeCfg({
      [dropDead]: { hasTrustDialogAccepted: true },
      [dropLive]: { hasTrustDialogAccepted: true },
      [dropOther]: { hasTrustDialogAccepted: true },
    });
    const originalContent = fs.readFileSync(claudeJson, "utf8");

    let dropReadCalls = 0;
    const realReadFileSync = fs.readFileSync;
    const clobberedContent = JSON.stringify({ projects: { [dropOther]: { hasTrustDialogAccepted: true } } });
    __setReadFileSyncForTest((p, enc) => {
      dropReadCalls++;
      // Simulate an external writer truncating the file to just ONE entry (a drop of 2) on the SECOND
      // (fresh, in-lock) read, while this call only intends to remove 1 (dropDead) — must trip the guard.
      if (dropReadCalls === 2) return clobberedContent;
      return realReadFileSync(p, enc);
    });
    const dropResult = pruneDeadWorktreeClaudeConfigEntries({ dryRun: false, worktreesRoot });
    __setReadFileSyncForTest();

    check("count-drop guard (7a): aborted with 'count-drop'", dropResult.aborted === "count-drop");
    check("count-drop guard (7a): removedKeys empty (no write performed)", dropResult.removedKeys.length === 0);
    check("count-drop guard (7a): file on disk UNCHANGED (still the original 3-entry content)",
      fs.readFileSync(claudeJson, "utf8") === originalContent);
  }
  {
    // 7b. THE OLD BUG'S EXACT SHAPE (review item 4): the drop count COINCIDENTALLY matches this run's
    // own planned-removal count, even though the vanished key is UNRELATED (not one this run classified
    // dead). The OLD arithmetic (classifiedCount - freshCount > removed.length) would NOT have caught
    // this — drop(2) == removed.length(2) — and silently let the unrelated key's disappearance through.
    // The NEW per-key rule must still abort, because the unrelated key was never classified dead.
    const keyA = keyFor(path.join(worktreesRoot, "proj7b", "taskA")); // dead, survives to fresh read
    const keyB = keyFor(path.join(worktreesRoot, "proj7b", "taskB")); // dead, survives to fresh read
    const keyAGone = keyFor(path.join(worktreesRoot, "proj7b", "taskAGone")); // dead, ALSO vanishes (benign)
    const keyUnrelatedAlivePath = path.join(worktreesRoot, "proj7b", "taskUnrelatedAlive");
    fs.mkdirSync(keyUnrelatedAlivePath, { recursive: true });
    const keyUnrelatedAlive = keyFor(keyUnrelatedAlivePath); // ALIVE, vanishes from fresh read — unexplained

    writeCfg({
      [keyA]: { hasTrustDialogAccepted: true },
      [keyB]: { hasTrustDialogAccepted: true },
      [keyAGone]: { hasTrustDialogAccepted: true },
      [keyUnrelatedAlive]: { hasTrustDialogAccepted: true },
    });
    const originalContent7b = fs.readFileSync(claudeJson, "utf8");

    let calls7b = 0;
    const realReadFileSync = fs.readFileSync;
    // Fresh read: keyAGone and keyUnrelatedAlive are both gone (dropped by 2) — but this run only
    // classified 3 keys dead (keyA, keyB, keyAGone), of which 2 (keyA, keyB) remain in the fresh read,
    // so removed.length ends up 2 — matching the drop of 2 under the OLD (now-removed) arithmetic.
    const clobbered7b = JSON.stringify({ projects: { [keyA]: { hasTrustDialogAccepted: true }, [keyB]: { hasTrustDialogAccepted: true } } });
    __setReadFileSyncForTest((p, enc) => {
      calls7b++;
      if (calls7b === 2) return clobbered7b;
      return realReadFileSync(p, enc);
    });
    const result7b = pruneDeadWorktreeClaudeConfigEntries({ dryRun: false, worktreesRoot });
    __setReadFileSyncForTest();

    check("count-drop guard (7b, old-bug shape): aborted with 'count-drop' even though drop == planned removals",
      result7b.aborted === "count-drop");
    check("count-drop guard (7b): no write performed", result7b.removedKeys.length === 0);
    check("count-drop guard (7b): file on disk UNCHANGED", fs.readFileSync(claudeJson, "utf8") === originalContent7b);
  }
  {
    // 7c. A concurrent ADD must pass — a key present in the fresh read that was NOT in the classification
    // read is never examined by the missing-key check, so it never blocks the run.
    const deadKey = keyFor(path.join(worktreesRoot, "proj7c", "taskDead")); // never created — dead candidate
    const addedKey = keyFor(path.join(root, "proj7cAdded")); // added concurrently, not worktree-scoped anyway
    writeCfg({ [deadKey]: { hasTrustDialogAccepted: true } });

    let calls7c = 0;
    const realReadFileSync = fs.readFileSync;
    __setReadFileSyncForTest((p, enc) => {
      calls7c++;
      const raw = realReadFileSync(p, enc);
      if (calls7c === 2) {
        const parsed = JSON.parse(raw);
        parsed.projects[addedKey] = { hasTrustDialogAccepted: true }; // concurrent add, simulated
        return JSON.stringify(parsed);
      }
      return raw;
    });
    const result7c = pruneDeadWorktreeClaudeConfigEntries({ dryRun: false, worktreesRoot });
    __setReadFileSyncForTest();

    check("count-drop guard (7c): a concurrent ADD passes (no abort)", result7c.aborted === null);
    check("count-drop guard (7c): the dead key was still removed", result7c.removedKeys.includes(deadKey));
    const after7c = readCfgRaw().projects;
    check("count-drop guard (7c): the concurrently-added key survived the write", addedKey in after7c);
  }

  // === 8. Lock-unavailable: the real (requireLock) write refuses with no write when the lock is busy. ===
  {
    const key8 = keyFor(path.join(worktreesRoot, "proj8", "taskLockBusy"));
    writeCfg({ [key8]: { hasTrustDialogAccepted: true } });
    const before8 = fs.readFileSync(claudeJson, "utf8");

    process.env.LOOM_TRUST_LOCK_MS = "150"; // short-circuit the acquire loop's deadline quickly
    const lockPath = `${claudeJson}.loom-lock`;
    fs.writeFileSync(lockPath, ""); // simulate another writer holding the lock right now
    // withTrustLock's own staleness check uses the SAME `trustLockMs()` value as both the deadline AND
    // the staleness threshold — a lock file that's merely "old" would otherwise get broken (and then
    // re-acquired by THIS call) right around the same moment the deadline is reached, defeating this
    // test's purpose. Backdating the mtime is wrong (still looks stale); push it into the FUTURE instead
    // so `age = Date.now() - mtimeMs` is negative — never exceeds the threshold — for as long as this
    // test needs, deterministically simulating a lock a live external holder legitimately still owns.
    const farFuture = new Date(Date.now() + 86_400_000);
    fs.utimesSync(lockPath, farFuture, farFuture);
    try {
      const result8 = pruneDeadWorktreeClaudeConfigEntries({ dryRun: false, worktreesRoot });
      check("lock-unavailable: aborted with 'lock-unavailable'", result8.aborted === "lock-unavailable");
      check("lock-unavailable: no write performed", fs.readFileSync(claudeJson, "utf8") === before8);
    } finally {
      try { fs.rmSync(lockPath); } catch { /* best-effort */ }
      delete process.env.LOOM_TRUST_LOCK_MS;
    }
  }

  // === 9. worktreesRoot itself doesn't stat as an existing directory ⇒ the whole call refuses. ===
  {
    const nonExistentRoot = path.join(root, "does-not-exist", "nested", "root");
    const ancestorKey = keyFor(path.dirname(nonExistentRoot)); // an ancestor of the (non-existent) root
    writeCfg({ [ancestorKey]: { hasTrustDialogAccepted: true } });

    const dry9 = pruneDeadWorktreeClaudeConfigEntries({ dryRun: true, worktreesRoot: nonExistentRoot });
    check("non-existent worktreesRoot (dry run): aborted with 'worktrees-root-missing'", dry9.aborted === "worktrees-root-missing");
    check("non-existent worktreesRoot (dry run): deadCount 0, no sample", dry9.deadCount === 0 && dry9.deadKeysSample.length === 0);

    const apply9 = pruneDeadWorktreeClaudeConfigEntries({ dryRun: false, worktreesRoot: nonExistentRoot });
    check("non-existent worktreesRoot (apply): aborted with 'worktrees-root-missing', no write",
      apply9.aborted === "worktrees-root-missing" && apply9.removedKeys.length === 0);

    // A file that's a regular file, not a directory, must ALSO refuse (statSync succeeds but isDirectory() is false).
    const fileNotDir = path.join(root, "proj9-a-plain-file");
    fs.writeFileSync(fileNotDir, "not a directory");
    const apply9b = pruneDeadWorktreeClaudeConfigEntries({ dryRun: false, worktreesRoot: fileNotDir });
    check("worktreesRoot is a plain FILE, not a directory: refused", apply9b.aborted === "worktrees-root-missing");
  }

  // === 10. Classification is ONE-directional: the root itself, and an ANCESTOR of the root, are never
  //         worktree-scoped candidates — only a key STRICTLY UNDER the root is. Non-absolute/empty keys
  //         are skipped outright. Guards against review mutation (d): "nested→accept exact/null". ===
  {
    const rootKey = keyFor(worktreesRoot); // the root ITSELF — never a candidate
    const ancestorOfRootKey = keyFor(path.dirname(worktreesRoot)); // an ANCESTOR of the root — never a candidate
    const genuineChildPath = path.join(worktreesRoot, "proj10", "taskChild"); // never created — a genuine dead candidate
    const genuineChildKey = keyFor(genuineChildPath);

    writeCfg({
      [rootKey]: { hasTrustDialogAccepted: true },
      [ancestorOfRootKey]: { hasTrustDialogAccepted: true },
      "": { hasTrustDialogAccepted: true }, // empty-string key — must be skipped, never crash
      "relative/not/absolute": { hasTrustDialogAccepted: true }, // non-absolute key — must be skipped
      [genuineChildKey]: { hasTrustDialogAccepted: true },
    });

    const dry10 = pruneDeadWorktreeClaudeConfigEntries({ dryRun: true, worktreesRoot });
    check("one-directional classification: exactly the genuine child is classified dead (not root/ancestor/non-absolute)",
      dry10.deadCount === 1 && dry10.deadKeysSample.includes(genuineChildKey));
    check("one-directional classification: the root's own key is never a candidate",
      !dry10.deadKeysSample.includes(rootKey));
    check("one-directional classification: an ancestor-of-the-root key is never a candidate",
      !dry10.deadKeysSample.includes(ancestorOfRootKey));

    // The ancestor directory physically EXISTS (it's worktreesRoot's real parent), so a
    // bidirectional-containment regression (mutation (d): "nested→accept exact/null") would classify it
    // as a CANDIDATE that's merely "alive" — invisible to deadKeysSample/deadCount either way, since
    // PruneDeadWorktreeEntriesResult never exposes the alive bucket. Make the regression observable
    // through the public result instead: inject an unconfirmable (EACCES) stat error on exactly the
    // ancestor path (NOT worktreesRoot itself — that path is also statted by this call's OWN upfront
    // "does worktreesRoot exist" check (review item 2), tested separately in section 9; faulting it here
    // would trip THAT check instead and never reach classification at all). Correct (one-directional)
    // code never calls stat on a key it `continue`s past, so the ancestor can never reach `unknownKeys`;
    // a bidirectional regression WOULD stat it (classifying "unknown"), which the public result surfaces.
    const realStatSync10 = fs.statSync;
    __setStatSyncForTest((p, opts) => {
      if (path.resolve(p) === path.resolve(path.dirname(worktreesRoot))) {
        const err = new Error("EACCES: permission denied");
        err.code = "EACCES";
        throw err;
      }
      return realStatSync10(p, opts);
    });
    let dry10b;
    try {
      dry10b = pruneDeadWorktreeClaudeConfigEntries({ dryRun: true, worktreesRoot });
    } finally {
      __setStatSyncForTest();
    }
    check("one-directional classification: an ancestor-of-the-root key is never even STAT'd (never reaches unknownKeys under an injected stat error)",
      !dry10b.unknownKeys.includes(ancestorOfRootKey));

    const apply10 = pruneDeadWorktreeClaudeConfigEntries({ dryRun: false, worktreesRoot });
    const after10 = readCfgRaw().projects;
    check("one-directional classification (apply): root/ancestor/non-absolute keys all survive untouched",
      rootKey in after10 && ancestorOfRootKey in after10 && "" in after10 && "relative/not/absolute" in after10);
    check("one-directional classification (apply): the genuine child was actually removed",
      !(genuineChildKey in after10) && apply10.removedKeys.includes(genuineChildKey));
  }

  // === 11. Unknown liveness (a stat error that is NOT ENOENT/ENOTDIR) is never deleted and is reported
  //         separately in unknownKeys — for both the bulk classification AND the in-lock re-verify. ===
  {
    const unknownPath = path.join(worktreesRoot, "proj11", "taskUnknownStat");
    const unknownKey = keyFor(unknownPath);
    const normalDeadPath = path.join(worktreesRoot, "proj11", "taskNormalDead"); // never created — a plain dead key, control
    const normalDeadKey = keyFor(normalDeadPath);
    writeCfg({ [unknownKey]: { hasTrustDialogAccepted: true }, [normalDeadKey]: { hasTrustDialogAccepted: true } });

    const realStatSync = fs.statSync;
    __setStatSyncForTest((p, opts) => {
      if (path.resolve(p) === path.resolve(unknownPath)) {
        const err = new Error("EACCES: permission denied");
        err.code = "EACCES";
        throw err;
      }
      return realStatSync(p, opts);
    });
    try {
      const dry11 = pruneDeadWorktreeClaudeConfigEntries({ dryRun: true, worktreesRoot });
      check("unknown liveness (dry run): the EACCES key is in unknownKeys, not deadKeysSample",
        dry11.unknownKeys.includes(unknownKey) && !dry11.deadKeysSample.includes(unknownKey));
      check("unknown liveness (dry run): the normal dead key is still classified dead", dry11.deadKeysSample.includes(normalDeadKey));

      const apply11 = pruneDeadWorktreeClaudeConfigEntries({ dryRun: false, worktreesRoot });
      check("unknown liveness (apply): the EACCES key was NOT removed", !apply11.removedKeys.includes(unknownKey));
      check("unknown liveness (apply): the EACCES key is reported in unknownKeys", apply11.unknownKeys.includes(unknownKey));
      check("unknown liveness (apply): the normal dead key WAS removed", apply11.removedKeys.includes(normalDeadKey));
      const after11 = readCfgRaw().projects;
      check("unknown liveness (apply): the EACCES key still present in the file", unknownKey in after11);
    } finally {
      __setStatSyncForTest();
    }
  }

  // === 12. GC-time removal (removeClaudeConfigEntryForWorktree): exact key, case-variant key, respawn
  //         re-check, sibling-prefix/ancestor/child discrimination, and unknown-liveness-never-deleted. ===
  {
    writeCfg({});

    // Exact key, directory already gone (the ordinary case — gcWorktreeDir calls this AFTER removal).
    const gcWorktree = path.join(worktreesRoot, "projGC2", "taskGC");
    fs.mkdirSync(gcWorktree, { recursive: true });
    writeCfg({ [keyFor(gcWorktree)]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } });
    fs.rmSync(gcWorktree, { recursive: true, force: true });
    removeClaudeConfigEntryForWorktree(gcWorktree);
    await flushGcRemoval();
    check("GC-time removal: exact-key entry removed once the directory is gone",
      !(keyFor(gcWorktree) in readCfgRaw().projects));

    // Case-variant stored key for the SAME physical path (card 498452c0 review answer 5) — ensureTrusted's
    // own written key is case-naive, so an entry written under a differently-cased cwd spelling must still
    // be found and removed via normForCompare's win32 case-fold, not a bare string-equality lookup.
    if (process.platform === "win32") {
      const gcWorktree2 = path.join(worktreesRoot, "projGC3", "taskGC2");
      fs.mkdirSync(gcWorktree2, { recursive: true });
      const caseVariantKey = keyFor(gcWorktree2).toUpperCase();
      writeCfg({ [caseVariantKey]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } });
      fs.rmSync(gcWorktree2, { recursive: true, force: true });
      removeClaudeConfigEntryForWorktree(gcWorktree2);
      await flushGcRemoval();
      check("GC-time removal: a differently-cased stored key for the SAME path is still found and removed",
        !(caseVariantKey in readCfgRaw().projects));
    } else {
      console.log("SKIP  GC-time case-variant removal — win32-only (no case-fold elsewhere)");
    }

    // Respawn re-check: the directory exists AGAIN at call time (a brand-new spawn reclaimed this exact
    // path between the GC removal and this call) — the entry must be left completely untouched.
    const gcWorktree3 = path.join(worktreesRoot, "projGC4", "taskGC3");
    fs.mkdirSync(gcWorktree3, { recursive: true });
    writeCfg({ [keyFor(gcWorktree3)]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } });
    // NOTE: directory still exists here, deliberately — simulating "a respawn already reclaimed this path".
    removeClaudeConfigEntryForWorktree(gcWorktree3);
    await flushGcRemoval();
    check("GC-time removal: respawn re-check — a STILL-LIVE directory's entry is never touched",
      keyFor(gcWorktree3) in readCfgRaw().projects);

    // Sibling-prefix / ancestor / child discrimination (review item 5 + guards against mutation (f):
    // "GC exact→any overlap"). The exact target's directory is gone; a sibling whose name merely shares
    // a PREFIX, an ancestor directory, and a child subdirectory are all stored as separate keys and must
    // all SURVIVE — only the exact key is ever removed.
    const exactTargetDir = path.join(worktreesRoot, "projGC5", "taskGC"); // the removal target
    const siblingPrefixDir = path.join(worktreesRoot, "projGC5", "taskGC2"); // shares a textual prefix, NOT the same path
    const ancestorDir = path.join(worktreesRoot, "projGC5"); // strictly contains the target
    const childDir = path.join(exactTargetDir, "sub"); // strictly contained BY the target
    for (const d of [siblingPrefixDir, ancestorDir, childDir]) fs.mkdirSync(d, { recursive: true });
    writeCfg({
      [keyFor(exactTargetDir)]: { hasTrustDialogAccepted: true },
      [keyFor(siblingPrefixDir)]: { hasTrustDialogAccepted: true },
      [keyFor(ancestorDir)]: { hasTrustDialogAccepted: true },
      [keyFor(childDir)]: { hasTrustDialogAccepted: true },
    });
    fs.rmSync(exactTargetDir, { recursive: true, force: true }); // only the exact target's dir is gone (this also removes childDir's dir — its CONFIG KEY still exists though)
    removeClaudeConfigEntryForWorktree(exactTargetDir);
    await flushGcRemoval();
    const after12 = readCfgRaw().projects;
    check("GC-time removal: exact target removed", !(keyFor(exactTargetDir) in after12));
    check("GC-time removal: sibling-prefix key (taskGC2) survives untouched", keyFor(siblingPrefixDir) in after12);
    check("GC-time removal: ancestor key survives untouched", keyFor(ancestorDir) in after12);
    check("GC-time removal: child key survives untouched", keyFor(childDir) in after12);

    // Unknown liveness at the GC path: an EACCES-shaped stat error on the exact target must leave the
    // entry untouched (treated like "alive, don't touch" — never deleted on an unconfirmed absence).
    const gcUnknownDir = path.join(worktreesRoot, "projGC6", "taskUnknown");
    writeCfg({ [keyFor(gcUnknownDir)]: { hasTrustDialogAccepted: true } });
    const realStatSync2 = fs.statSync;
    __setStatSyncForTest((p, opts) => {
      if (path.resolve(p) === path.resolve(gcUnknownDir)) {
        const err = new Error("EACCES: permission denied");
        err.code = "EACCES";
        throw err;
      }
      return realStatSync2(p, opts);
    });
    try {
      removeClaudeConfigEntryForWorktree(gcUnknownDir);
      await flushGcRemoval();
    } finally {
      __setStatSyncForTest();
    }
    check("GC-time removal: an unconfirmable (EACCES) liveness never deletes the entry",
      keyFor(gcUnknownDir) in readCfgRaw().projects);
  }
  // === 13. Timing (card 498452c0 review items 1d + 3) — a synthetic 10k-entry file. Not a benchmark;
  //         a loose regression catch per-call so a future change that moves work back onto the hot path
  //         (or reintroduces the retry+sleepSync lock there) is caught. Measured with performance.now(). ===
  {
    const SYNTHETIC_ENTRY_COUNT = 10_000;
    const bigProjects = {};
    for (let i = 0; i < SYNTHETIC_ENTRY_COUNT; i++) {
      bigProjects[keyFor(path.join(worktreesRoot, "synthetic", `task${i}`))] = { hasTrustDialogAccepted: true };
    }
    const gcTimingTarget = path.join(worktreesRoot, "synthetic", "task0"); // a real entry, now "removed"
    delete bigProjects[keyFor(gcTimingTarget)];
    fs.writeFileSync(claudeJson, JSON.stringify({ projects: bigProjects }, null, 2));

    // 13a. removeClaudeConfigEntryForWorktree's SYNCHRONOUS portion (everything that runs before it
    // returns to its caller — i.e. before the setImmediate-deferred body even starts) must be ~instant
    // regardless of file size, since it now does nothing but schedule a callback. This is the direct
    // fix for the measured ~1.8s stall: gcWorktreeDir's own call stack must never be the one paying for
    // the file read/scan/write below.
    const t0 = performance.now();
    removeClaudeConfigEntryForWorktree(gcTimingTarget);
    const syncMs = performance.now() - t0;
    check(`GC removal: synchronous portion is fast regardless of file size (measured ${syncMs.toFixed(2)}ms against a ${SYNTHETIC_ENTRY_COUNT}-entry file, loose ceiling 50ms)`,
      syncMs < 50);
    await flushGcRemoval(); // let the deferred body actually run before reusing the file below
    check("GC removal: the deferred body still did its job on the 10k-entry file",
      !(keyFor(gcTimingTarget) in readCfgRaw().projects));

    // 13b. The bulk prune's real write holds the lock only for its IN-LOCK section (fresh read +
    // re-verify the dead set + count-drop check + write) — never for the classification scan, which
    // runs before the lock is even requested. Every one of the 10k synthetic entries has no real
    // directory on disk, so this run's dead set (and therefore its in-lock re-verify + write) is the
    // FULL 10k, not a sample — a worst-case-shaped measurement of that in-lock section's duration
    // (review item 3: "measure and report its duration... if it can exceed the stale bound
    // [LOOM_TRUST_LOCK_MS, default 5000ms], add more protection"). Loose ceiling, not a benchmark.
    fs.writeFileSync(claudeJson, JSON.stringify({ projects: bigProjects }, null, 2)); // restore (13a deleted one key)
    const t1 = performance.now();
    const bulkResult = pruneDeadWorktreeClaudeConfigEntries({ dryRun: false, worktreesRoot });
    const bulkMs = performance.now() - t1;
    check(`bulk prune (apply) removing all ${SYNTHETIC_ENTRY_COUNT} synthetic entries completes well under the stale-lock bound (measured ${bulkMs.toFixed(2)}ms, loose ceiling 3500ms vs the 5000ms default LOOM_TRUST_LOCK_MS)`,
      bulkMs < 3500);
    check("bulk prune on the 10k-entry file: no abort (this run never contends with anything)", bulkResult.aborted === null);
    check("bulk prune on the 10k-entry file: removed the full synthetic set", bulkResult.removedKeys.length === SYNTHETIC_ENTRY_COUNT - 1);
    console.log(`[timing] removeClaudeConfigEntryForWorktree sync portion: ${syncMs.toFixed(2)}ms | bulk prune (apply, ${SYNTHETIC_ENTRY_COUNT} entries): ${bulkMs.toFixed(2)}ms`);
  }
} finally {
  __setReadFileSyncForTest();
  __setStatSyncForTest();
  restoreEnv();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\nALL PASS — pruneDeadWorktreeClaudeConfigEntries and removeClaudeConfigEntryForWorktree behave hermetically; the real ~/.claude.json was never touched."
  : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
