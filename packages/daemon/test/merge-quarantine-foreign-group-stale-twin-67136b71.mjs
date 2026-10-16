import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 67136b71 (from the af948556 Code Review, session bfa97ca3). `consumeMatchedPendingsIntoArmedEntry`'s
// raise-divert branch (reached when `skipDegradedOccupantGuard` is true AND the fold-in read of the
// raiser's own fresh key returns "unreadable") has TWO sibling sub-branches after the top-of-function
// unconditional splice: `ownGroup` (the raiser's own identity, fixed by af948556 -- see that card's own
// test file) and `foreignGroups` (every OTHER identity canonically colliding at the raiser's key,
// ~L1526-1544). The `group.length > 1` arm of `foreignGroups` unions `others` into a NEW `foreignUnion`
// object and pushes/durably-writes it to pending -- but pre-fix, NEVER called `replaceEntryEverywhere`
// for that group. If a foreign-group member is ITSELF an 883e29bc/64283e06 boot twin (the SAME object
// reference also armed in `activeQuarantines` at its own stale/degraded key), that active slot was never
// re-pointed and was left holding the STALE, pre-raise object -- the identical stale-object shape
// af948556 fixed, one branch over.
//
// THE FIX: `for (const p of group) replaceEntryEverywhere(activeQuarantines, p.entry, foreignUnion);`,
// added right before the group's own pending push/write (merge-quarantine.ts ~L1534-1539), mirroring
// af948556's own `ownGroup` fix exactly (replacement only, never a union source, per c9114934).
//
// SCENARIO 1 -- reachability / the global identity invariant, checked strictly MID-WINDOW (before any
// query that could itself lazily graduate and self-heal a pre-fix duplicate). Confirmed REACHABLE on
// unmodified pre-fix HEAD (worker_report, session investigation) before this fix was written.
//
// SCENARIO 2 -- THE FAIL-OPEN. F's foreign group here has THREE matched pending members: the 883e29bc
// twin pair (tokens tag-tok-fb/tag-tok-fc, unioned together already at boot) PLUS a wholly separate third
// pending record (tag-tok-fd) injected via `reenterMergeQuarantinesAtBootTestOnly`'s own seam -- modelling
// a LATER, independent raise of F while it was still unresolvable, never unioned with the twin until THIS
// event. Pre-fix: clearing F's two ORIGINAL twin tokens (fb, fc) empties the STALE active-side object,
// whose own empty-sweep (per `clearMergeQuarantineByToken`'s own doc, mirroring af948556's own SCENARIO 2
// mechanism) also lifts the SEPARATE pending-side `foreignUnion` object by identity -- even though
// `foreignUnion` still carries `tag-tok-fd`, never cleared. Result pre-fix: F (and TOP, its cross-tier
// sibling) falsely reports OPEN while `tag-tok-fd` is still outstanding -- a genuine, in-process FAIL-OPEN.
// THE FIX closes it: post-fix, the active slot IS `foreignUnion` itself (no separate stale object), so
// clearing fb/fc only ever reduces the ONE real object -- it still holds `tag-tok-fd` and stays blocked.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-foreign-group-stale-twin-67136b71.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-mqfgst-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqfgst@loom -c user.name=mqfgst";
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeToplevelRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqfgst-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-foreign-group-stale-twin (${tag})\n`);
  execSync(`git init -q && git config user.email mqfgst@loom && git config user.name mqfgst`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

// Mirrors merge-quarantine.ts's own (unexported) `pendingDivertFilenameFor`.
function pendingDivertFilenameForTest(repoPath) {
  let real;
  try { real = fs.realpathSync.native(repoPath); } catch { real = path.resolve(repoPath); }
  const identity = process.platform === "win32" ? real.toLowerCase() : real;
  return `pending-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}.json`;
}

// Fails the read(s) of `targetPath` whose 1-based call-index is IN `indices`; every other call to that
// path succeeds normally; calls to any OTHER path are untouched.
function injectReadFailureAtCalls(targetPath, indices, code = "EACCES") {
  const real = fs.readFileSync;
  const idxSet = new Set(indices);
  let callCount = 0;
  fs.readFileSync = (p, ...rest) => {
    if (typeof p === "string" && p === targetPath) {
      callCount++;
      if (idxSet.has(callCount)) throw Object.assign(new Error(`${code}: simulated read failure (call #${callCount})`), { code });
    }
    return real(p, ...rest);
  };
  return { restore: () => { fs.readFileSync = real; }, count: () => callCount };
}

let moduleImportCounter = 0;
async function freshMergeQuarantineModule() {
  moduleImportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${moduleImportCounter}`);
}
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Shared setup: F's own boot twin (byte-identical mechanism to af948556's own "d" setup, applied to a
  // FOREIGN identity F instead of the raiser's own), with TOP made real afterward and F turned into a
  // SUBDIRECTORY of it so F becomes a cross-tier sibling of TOP at TOP's own canonical key (card 7673d096's
  // toplevel walk). `extraPendingToken`, when given, ALSO injects a third, wholly separate pending record
  // for F (never unioned with the twin until this event) via `reenterMergeQuarantinesAtBootTestOnly`'s own
  // seam -- SCENARIO 2's own setup.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  async function setupAndRaise(mod, tag, extraPendingToken) {
    const {
      activeMergeQuarantineFor, reenterMergeQuarantinesAtBoot, reenterMergeQuarantinesAtBootTestOnly,
      MERGE_QUARANTINE_DIR, enterMergeQuarantine,
    } = mod;
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

    const sF = makeToplevelRepo(`${tag}-sf`);
    const KsF = canonicalRepoLockKey(sF);
    const KsFhash = createHash("sha256").update(KsF).digest("hex").slice(0, 24);

    const top = path.join(os.tmpdir(), `loom-mqfgst-top-nonexistent-${tag}-${freshSfx()}`);
    const f = path.join(top, "subdir"); // F: will become a SUBDIRECTORY of TOP, no .git of its own

    const KsFFinalPath = path.join(MERGE_QUARANTINE_DIR, `${KsFhash}.json`);
    fs.writeFileSync(KsFFinalPath, JSON.stringify({
      repoPath: f, branch: "f-branch-boot-a", reason: `${tag}: F degraded, walked up to S_F's own key (A)`,
      enteredAt: Date.now(), tokens: [`${tag}-tok-fb`], resolvedKey: KsF,
    }, null, 2) + "\n");
    const fPendingPath = path.join(MERGE_QUARANTINE_DIR, pendingDivertFilenameForTest(f));
    fs.writeFileSync(fPendingPath, JSON.stringify({
      repoPath: f, branch: "f-branch-boot-b", reason: `${tag}: F's own earlier record, also resolvedKey=S_F's key (B)`,
      enteredAt: Date.now() - 100000, tokens: [`${tag}-tok-fc`], resolvedKey: KsF,
    }, null, 2) + "\n");

    let extraPending;
    if (extraPendingToken) {
      // A wholly separate, LATER raise of F while still unresolvable -- never unioned with the twin
      // above until THIS event. A distinct sourceFile (physically backed too, for realism) so it is
      // never mistaken for the twin's own pending slot.
      const extraSourceFile = `legacy-${createHash("sha256").update(`${tag}-extra`).digest("hex").slice(0, 24)}.json`;
      const extraEntry = {
        repoPath: f, branch: "f-branch-separate-later-raise", reason: `${tag}: F's own separate, later raise while still unresolvable (C)`,
        enteredAt: Date.now() - 50000, tokens: [extraPendingToken],
      };
      fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, extraSourceFile), JSON.stringify(extraEntry, null, 2) + "\n");
      extraPending = { entry: extraEntry, sourceFile: extraSourceFile };
    }

    if (extraPending) {
      reenterMergeQuarantinesAtBootTestOnly([], [extraPending]);
    } else {
      reenterMergeQuarantinesAtBoot([]);
    }

    check(`(${tag} precondition) F's own TWIN exists: armed at S_F's own key with both boot tokens unioned`,
      (() => {
        const direct = activeMergeQuarantineFor(sF);
        return !!direct && direct.repoPath === f && new Set(direct.tokens).has(`${tag}-tok-fb`) && new Set(direct.tokens).has(`${tag}-tok-fc`);
      })());

    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Make TOP real, and F a SUBDIRECTORY of it.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    fs.mkdirSync(top, { recursive: true });
    execSync(`git init -q && git config user.email mqfgst@loom && git config user.name mqfgst`, { cwd: top });
    fs.writeFileSync(path.join(top, "README.md"), `# ${tag} top (now real)\n`);
    commitAll(top, "init", GIT_ID);
    fs.mkdirSync(f, { recursive: true }); // F: plain subdirectory, no .git of its own

    const Kd = canonicalRepoLockKey(top);
    check(`(${tag} setup) F's own fresh canonical key now equals TOP's key (toplevel walk)`, canonicalRepoLockKey(f) === Kd);
    check(`(${tag} setup) TOP's key differs from S_F's key`, Kd !== KsF);
    const Kdhash = createHash("sha256").update(Kd).digest("hex").slice(0, 24);
    const KdFinalPath = path.join(MERGE_QUARANTINE_DIR, `${Kdhash}.json`);

    // Junk, SELF-identity content at Kd's own final -- plays the same structural role af948556's "E" did
    // (something real to read on the one read call that must succeed), but self-identity so
    // `resolveRaiseOverwrite` returns `false` (proceed) via its own same-identity short-circuit.
    const selfJunkBytes = JSON.stringify({
      repoPath: top, branch: "junk", reason: `${tag}: junk self-identity content at TOP's own fresh final`,
      enteredAt: Date.now(), tokens: [`${tag}-junk-tok-self`],
    }, null, 2) + "\n";
    fs.writeFileSync(KdFinalPath, selfJunkBytes);

    // Call #1: the raise's own early protect-before-write gate's detector read of Kd's final -- injected
    // to fail (non-ENOENT), marking `keptUnreadableLatchFiles` without ever determining the content's
    // identity. Call #2 (left to succeed): `resolveRaiseOverwrite`'s own independent re-read -- reads the
    // self-junk bytes, sees the SAME identity as the raiser, returns "proceed". Call #3: the fold-in read
    // inside `consumeMatchedPendingsIntoArmedEntry` itself -- injected to fail too, returning the literal
    // "unreadable" and landing in the raise-divert branch under test.
    const inject = injectReadFailureAtCalls(KdFinalPath, [1, 3]);
    const topToken = enterMergeQuarantine(top, "top-branch-raise", `${tag}: TOP raises for the first time, absorbing F as a cross-tier sibling`);
    inject.restore();
    check(`(${tag} precondition) exactly 3 reads of Kd's own final were observed (matches the injection plan)`,
      inject.count() === 3);

    // *** WITNESSES (prove the raise-divert branch was actually reached, not some other path). ***
    check(`*** WITNESS (${tag}) *** the self-junk bytes at Kd's final are byte-identical to what was written -- the raise never touched Kd's final at all (it diverted instead)`,
      (() => { try { return fs.readFileSync(KdFinalPath, "utf8") === selfJunkBytes; } catch { return false; } })());
    check(`*** WITNESS (${tag}) *** a pending record for TOP exists on disk at its own deterministic pending-divert filename, carrying TOP's own repoPath and fresh token`,
      (() => {
        const topPendingPath = path.join(MERGE_QUARANTINE_DIR, pendingDivertFilenameForTest(top));
        try {
          const parsed = JSON.parse(fs.readFileSync(topPendingPath, "utf8"));
          return parsed.repoPath === top && new Set(parsed.tokens ?? []).has(topToken);
        } catch { return false; }
      })());

    return { sF, top, f, Kd, KsF, topToken };
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 1 -- reachability / the global identity invariant, checked strictly MID-WINDOW: directly
  // after `inject.restore()`, before ANY query (even `activeMergeQuarantineFor`) that could itself
  // trigger ordinary lazy graduation and self-heal the pre-fix duplicate before these checks run.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const mod1 = await freshMergeQuarantineModule();
  const { sF, f } = await setupAndRaise(mod1, "s1", undefined);

  check("*** THE FIX (SCENARIO 1, mid-window) *** the GLOBAL identity invariant holds -- no stray duplicate object for F",
    mod1.assertQuarantineIdentityInvariantTestOnly().ok);
  check("*** THE FIX (SCENARIO 1, mid-window) *** exactly one F-repoPath object exists",
    mod1.listActiveMergeQuarantines().filter((en) => en.repoPath === f).length === 1);
  check("(SCENARIO 1, mid-window) S_F's own slot still reports F",
    (() => { const at = mod1.activeMergeQuarantineFor(sF); return !!at && at.repoPath === f; })());
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 2 -- THE FAIL-OPEN. See the file-header comment above for the full mechanism. Its own fresh
  // module instance, same reason as SCENARIO 1.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const mod2 = await freshMergeQuarantineModule();
  const { sF, top, f, topToken } = await setupAndRaise(mod2, "s2", "s2-tok-fd");

  mod2.clearMergeQuarantineByToken(f, "s2-tok-fb");
  mod2.clearMergeQuarantineByToken(f, "s2-tok-fc");

  check("*** THE FIX (SCENARIO 2, fail-open) *** S_F stays BLOCKED after clearing only F's two original twin tokens -- F's separate third token is still outstanding",
    !!mod2.activeMergeQuarantineFor(sF));
  check("*** THE FIX (SCENARIO 2, fail-open) *** TOP (F's cross-tier sibling) stays BLOCKED too",
    !!mod2.activeMergeQuarantineFor(top));
  check("(SCENARIO 2, fail-open) F's separate third token is still the one actually enforcing the block",
    (() => {
      const atS = mod2.activeMergeQuarantineFor(sF);
      const atTop = mod2.activeMergeQuarantineFor(top);
      return (!!atS && new Set(atS.tokens ?? []).has("s2-tok-fd")) || (!!atTop && new Set(atTop.tokens ?? []).has("s2-tok-fd"));
    })());

  // Sanity: clearing the third token AND TOP's own fresh raise token now genuinely lifts both. TOP's own
  // token is a SEPARATE, never-yet-cleared obligation -- the "TOP stays BLOCKED too" query just above
  // legitimately lazy-graduates F and TOP together (card 8a1bc2ef: they are genuine cross-tier siblings,
  // same physical repo, so a query absorbing them into one record is correct, not a bug this test should
  // paper over) and the union-cost of that correct absorption now includes TOP's own outstanding token.
  mod2.clearMergeQuarantineByToken(f, "s2-tok-fd");
  mod2.clearMergeQuarantineByToken(top, topToken);
  check("(SCENARIO 2, sanity) F/TOP are fully lifted once every outstanding token (including TOP's own fresh raise token) is released",
    !mod2.activeMergeQuarantineFor(sF) && !mod2.activeMergeQuarantineFor(top));
  }
} catch (e) {
  console.error("UNCAUGHT:", e);
  failures++;
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
