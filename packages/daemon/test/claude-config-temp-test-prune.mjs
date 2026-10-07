// Hermetic unit test for card d4580e19 — pruning ~/.claude.json entries LEAKED BY LOOM TESTS that reached
// ensureTrusted without redirecting CLAUDE_CONFIG_DIR (cards 849acf9b, 042a4312, c75006c2). Covers the
// new export in pty/claude-config.ts:
//   - pruneDeadTempTestClaudeConfigEntries (dry-run + real one-time/re-runnable bulk prune)
//
// ⛔ OWNER-FACING FILE — this suite NEVER reads, writes, or counts the real ~/.claude.json, and never
// passes the real os.tmpdir() into pruneDeadTempTestClaudeConfigEntries. It redirects CLAUDE_CONFIG_DIR
// (claudeJsonPath() honors it) AND passes its own synthetic `tmpdir` override to that function — like
// every test in this suite, this file's OWN fixture root is necessarily created somewhere under the real
// system temp directory (mkdtempManaged below), but that root is never the value this suite hands to the
// function under test; `tmpRoot`, a dedicated subdirectory of it, is. The real file's prune is OWNER-RUN
// only, via the CLI script's --temp-test-entries mode — request 576b4442, PENDING as of this test's
// writing; --apply against the real file must never run from here or from the script's own author
// outside that approval.
//
// Run after build: node test/claude-config-temp-test-prune.mjs
import fs from "node:fs";
import path from "node:path";
import { mkdtempManaged } from "./_tmp-fixture.mjs";
import {
  pruneDeadTempTestClaudeConfigEntries,
  __setReadFileSyncForTest,
} from "../dist/pty/claude-config.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = mkdtempManaged("loom-claude-config-temp-test-prune-");

const saved = { cfg: process.env.CLAUDE_CONFIG_DIR };
const restoreEnv = () => {
  if (saved.cfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved.cfg;
};

const configDir = path.join(root, "config");
fs.mkdirSync(configDir, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = configDir;
const claudeJson = path.join(configDir, ".claude.json");

// The synthetic tmp root this suite's own candidates are scoped to — NEVER the real os.tmpdir().
const tmpRoot = path.join(root, "tmp");
fs.mkdirSync(tmpRoot, { recursive: true });

const writeCfg = (projects) => fs.writeFileSync(claudeJson, JSON.stringify({ projects }, null, 2));
const readCfgRaw = () => JSON.parse(fs.readFileSync(claudeJson, "utf8"));
const keyFor = (dir) => path.resolve(dir).replace(/\\/g, "/");

try {
  // === 1. Classification + dry run: exact count, capped sample, NEVER writes. Covers all four required
  //        negatives plus the positive (dead loom temp dir). ===
  const liveLoomTemp = path.join(tmpRoot, "loom-live-abc123");
  fs.mkdirSync(liveLoomTemp, { recursive: true }); // live — a direct child, loom-prefixed, but NOT dead
  const deadLoomTemp1 = path.join(tmpRoot, "loom-prest-970"); // never created — dead, direct child, loom-prefixed
  const deadLoomTemp2 = path.join(tmpRoot, "loom-abcd1234"); // never created — dead, direct child, loom-prefixed
  const nonLoomTempKey = path.join(tmpRoot, "notloom-xyz"); // never created — dead, direct child, but NOT loom-prefixed
  const outsideTmpdirKey = path.join(root, "loom-outside"); // never created — loom-prefixed, dead, but NOT under tmpRoot at all
  const nestedUnderTmpdirKey = path.join(tmpRoot, "nested", "loom-deep"); // never created — loom-prefixed, dead, but NESTED (not a direct child)

  writeCfg({
    [keyFor(liveLoomTemp)]: { hasTrustDialogAccepted: true },
    [keyFor(deadLoomTemp1)]: { hasTrustDialogAccepted: true },
    [keyFor(deadLoomTemp2)]: { hasTrustDialogAccepted: true, disabledMcpjsonServers: ["x"] },
    [keyFor(nonLoomTempKey)]: { hasTrustDialogAccepted: true },
    [keyFor(outsideTmpdirKey)]: { hasTrustDialogAccepted: true },
    [keyFor(nestedUnderTmpdirKey)]: { hasTrustDialogAccepted: true },
  });

  const dry = pruneDeadTempTestClaudeConfigEntries({ dryRun: true, tmpdir: tmpRoot });
  check("dry run: exact dead count is 2 (only the two direct-child loom- dead keys)", dry.deadCount === 2);
  check("dry run: dryRun flag echoed true", dry.dryRun === true);
  check("dry run: sample contains both dead keys",
    dry.deadKeysSample.includes(keyFor(deadLoomTemp1)) && dry.deadKeysSample.includes(keyFor(deadLoomTemp2)));
  check("dry run: removedKeys always empty", dry.removedKeys.length === 0);
  check("dry run: no write happened (file still has all 6 entries)", Object.keys(readCfgRaw().projects).length === 6);
  check("dry run: no abort, no parse error", dry.aborted === null && dry.parseError === null);
  check("dry run: unknownKeys empty (no stat errors here)", dry.unknownKeys.length === 0);
  check("negative: live loom temp dir never in the dead sample", !dry.deadKeysSample.includes(keyFor(liveLoomTemp)));
  check("negative: non-loom temp key never in the dead sample", !dry.deadKeysSample.includes(keyFor(nonLoomTempKey)));
  check("negative: a key outside tmpdir never in the dead sample", !dry.deadKeysSample.includes(keyFor(outsideTmpdirKey)));
  check("negative: a key nested (not a direct child) under tmpdir never in the dead sample",
    !dry.deadKeysSample.includes(keyFor(nestedUnderTmpdirKey)));

  // === 2. Real apply: prunes ONLY the two dead direct-child loom- keys; every negative survives. ===
  const applied = pruneDeadTempTestClaudeConfigEntries({ dryRun: false, tmpdir: tmpRoot });
  check("apply: removed exactly the 2 dead keys", applied.removedKeys.length === 2
    && applied.removedKeys.includes(keyFor(deadLoomTemp1)) && applied.removedKeys.includes(keyFor(deadLoomTemp2)));
  check("apply: recreatedKeys empty (nothing recreated)", applied.recreatedKeys.length === 0);
  check("apply: no abort, no parse error", applied.aborted === null && applied.parseError === null);
  const afterApply = readCfgRaw().projects;
  check("apply: live loom temp dir kept", keyFor(liveLoomTemp) in afterApply);
  check("apply: dead keys actually gone from the file",
    !(keyFor(deadLoomTemp1) in afterApply) && !(keyFor(deadLoomTemp2) in afterApply));
  check("apply: non-loom temp key kept untouched", keyFor(nonLoomTempKey) in afterApply);
  check("apply: key outside tmpdir kept untouched", keyFor(outsideTmpdirKey) in afterApply);
  check("apply: nested (non-direct-child) key kept untouched", keyFor(nestedUnderTmpdirKey) in afterApply);
  check("apply: exactly 4 entries remain (6 - 2 dead)", Object.keys(afterApply).length === 4);

  // === 3. A path that only LOOKS like tmpdir: a different drive (win32) does NOT match, and a
  //        differently-cased spelling of the SAME real tmpdir (win32) DOES match (case-fold, not a
  //        false "looks like" decoy) — both exercised against the dirname-equality check directly. ===
  if (process.platform === "win32") {
    const driveMatch = /^([A-Za-z]):(.*)$/.exec(path.resolve(tmpRoot));
    if (driveMatch) {
      const otherDrive = driveMatch[1].toUpperCase() === "C" ? "D" : "C";
      const decoyDifferentDrive = path.join(`${otherDrive}:${driveMatch[2]}`, "loom-decoy-drive");
      writeCfg({ [keyFor(decoyDifferentDrive)]: { hasTrustDialogAccepted: true } });
      const dryDecoy = pruneDeadTempTestClaudeConfigEntries({ dryRun: true, tmpdir: tmpRoot });
      check("decoy: a different-drive lookalike of tmpdir is never classified as a direct-child candidate",
        dryDecoy.deadCount === 0 && !dryDecoy.deadKeysSample.includes(keyFor(decoyDifferentDrive)));
    } else {
      console.log("SKIP  different-drive decoy — synthetic tmpRoot has no drive-letter prefix to swap");
    }

    const caseVariantDead = path.join(tmpRoot.toUpperCase(), "LOOM-case-variant"); // never created — dead
    writeCfg({ [keyFor(caseVariantDead)]: { hasTrustDialogAccepted: true } });
    const dryCaseVariant = pruneDeadTempTestClaudeConfigEntries({ dryRun: true, tmpdir: tmpRoot });
    check("case-variant key (SAME real directory, different case): still classified as a dead candidate (win32 case-fold)",
      dryCaseVariant.deadCount === 1 && dryCaseVariant.deadKeysSample.includes(keyFor(caseVariantDead)));
  } else {
    console.log("SKIP  drive/case-variant classification — win32-only (no case-fold elsewhere)");
  }

  // === 4. Malformed/unreadable config: no write, parseError set. ===
  {
    const survivorKey = keyFor(path.join(tmpRoot, "loom-survivor")); // a real dead candidate, at stake
    const wellFormed = JSON.stringify({ projects: { [survivorKey]: { hasTrustDialogAccepted: true } } });
    const malformed = wellFormed.slice(0, Math.floor(wellFormed.length * 0.6)); // truncate mid-object — still invalid JSON
    fs.writeFileSync(claudeJson, malformed);

    const dryMalformed = pruneDeadTempTestClaudeConfigEntries({ dryRun: true, tmpdir: tmpRoot });
    check("malformed JSON (dry run): parseError set, deadCount 0",
      dryMalformed.parseError !== null && dryMalformed.deadCount === 0);
    const applyMalformed = pruneDeadTempTestClaudeConfigEntries({ dryRun: false, tmpdir: tmpRoot });
    check("malformed JSON (apply): parseError set, no write (file still malformed verbatim)",
      applyMalformed.parseError !== null && fs.readFileSync(claudeJson, "utf8") === malformed);

    fs.writeFileSync(claudeJson, wellFormed);
    check("malformed JSON: once restored, the entry that was at risk during corruption is intact",
      survivorKey in readCfgRaw().projects);
  }

  // === 5. Count-drop sanity guard — reused unmodified from the worktree mode (@decision 498452c0),
  //        exercised here for the temp-test classify function. ===
  {
    const dropDead = keyFor(path.join(tmpRoot, "loom-drop")); // never created — 1 dead candidate
    const dropLivePath = path.join(tmpRoot, "loom-drop-live");
    fs.mkdirSync(dropLivePath, { recursive: true });
    const dropLive = keyFor(dropLivePath);

    writeCfg({
      [dropDead]: { hasTrustDialogAccepted: true },
      [dropLive]: { hasTrustDialogAccepted: true },
    });
    const originalContent = fs.readFileSync(claudeJson, "utf8");

    let readCalls = 0;
    const realReadFileSync = fs.readFileSync;
    const clobberedContent = JSON.stringify({ projects: {} }); // both entries vanish — only 1 was classified dead
    __setReadFileSyncForTest((p, enc) => {
      readCalls++;
      if (readCalls === 2) return clobberedContent;
      return realReadFileSync(p, enc);
    });
    const dropResult = pruneDeadTempTestClaudeConfigEntries({ dryRun: false, tmpdir: tmpRoot });
    __setReadFileSyncForTest();

    check("count-drop guard: aborted with 'count-drop'", dropResult.aborted === "count-drop");
    check("count-drop guard: removedKeys empty (no write performed)", dropResult.removedKeys.length === 0);
    check("count-drop guard: file on disk UNCHANGED", fs.readFileSync(claudeJson, "utf8") === originalContent);
  }

  // === 6. Lock-unavailable: the real (requireLock) write refuses with no write when the lock is busy —
  //        proves this mode goes through the SAME lock the worktree mode uses, not a second write path. ===
  {
    const key6 = keyFor(path.join(tmpRoot, "loom-lock-busy"));
    writeCfg({ [key6]: { hasTrustDialogAccepted: true } });
    const before6 = fs.readFileSync(claudeJson, "utf8");

    process.env.LOOM_TRUST_LOCK_MS = "150";
    const lockPath = `${claudeJson}.loom-lock`;
    fs.writeFileSync(lockPath, "");
    const farFuture = new Date(Date.now() + 86_400_000);
    fs.utimesSync(lockPath, farFuture, farFuture);
    try {
      const result6 = pruneDeadTempTestClaudeConfigEntries({ dryRun: false, tmpdir: tmpRoot });
      check("lock-unavailable: aborted with 'lock-unavailable'", result6.aborted === "lock-unavailable");
      check("lock-unavailable: no write performed", fs.readFileSync(claudeJson, "utf8") === before6);
    } finally {
      try { fs.rmSync(lockPath); } catch { /* best-effort */ }
      delete process.env.LOOM_TRUST_LOCK_MS;
    }
  }
} finally {
  __setReadFileSyncForTest();
  restoreEnv();
}

console.log(failures === 0
  ? "\nALL PASS — pruneDeadTempTestClaudeConfigEntries behaves hermetically; the real ~/.claude.json and the real os.tmpdir() were never touched."
  : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
