import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card f2cc5f18 (discovered from Code Review 9d6dc6b8 of card 29fe2372) —
// `sweepOrphanLatchFileIfUnreferenced` (merge-quarantine.ts) decides whether to delete an orphan latch
// file based ONLY on whether some surviving entry still references/owns it — never on what the file's
// OWN content actually holds. The isolate-b shape: entry A's own `orphanLatchFiles` names file O; O is
// written AFTER boot with a FOREIGN token belonging to a repo T nothing in memory currently owns or
// references. 29fe2372's own fix (`orphanRewriteOwnershipConfirmed`) only protects the PARTIAL-clear
// REWRITE of O — it never runs on a FULL clear, which reaches this sweep directly and deleted O
// unconditionally, permanently losing T's own foreign token with no durable record anywhere.
//
// THE FIX: `sweepOrphanLatchFileIfUnreferenced` now takes `candidateTokens` (every token the CALLER's
// own clear is lifting right now) and gates its unlink on a new `orphanSweepSafeToDelete` predicate —
// every real on-disk token in the orphan file must already be accounted for (in `candidateTokens`, or
// already globally tombstoned) before it may be deleted. `orphanSweepSafeToDelete` deliberately
// DIVERGES from `markedFinalFullyCoveredByClear`'s polarity on a parse failure: genuinely corrupt debris
// (never a real, readable record) stays trivially safe to delete, exactly as before this fix — see
// merge-quarantine-clear-by-path.mjs's own (J)/(Z1)/(Z1-route), which depend on that and are NOT
// duplicated or re-run here (they already run standalone as part of the full test suite).
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-orphan-sweep-content-aware.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { execSync, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-mqosca-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const mod = await import(mergeQuarantineModuleHref);
const {
  enterMergeQuarantine, clearMergeQuarantineByToken, reenterMergeQuarantinesAtBoot,
  listActiveMergeQuarantines, MERGE_QUARANTINE_DIR,
} = mod;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqosca@loom -c user.name=mqosca";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeToplevelRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqosca-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-orphan-sweep-content-aware (${tag})\n`);
  execSync(`git init -q && git config user.email mqosca@loom && git config user.name mqosca`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

// Fails EVERY read of `targetPath` (persistent).
function injectPersistentReadFailure(targetPath, code = "EACCES") {
  const real = fs.readFileSync;
  fs.readFileSync = (p, ...rest) => {
    if (typeof p === "string" && p === targetPath) {
      throw Object.assign(new Error(`${code}: simulated read failure`), { code });
    }
    return real(p, ...rest);
  };
  return { restore: () => { fs.readFileSync = real; } };
}

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (A) isolate-b — a full clear must NOT destroy a foreign, unreferenced orphan's real token; a fresh
  // reboot afterward must still find it, re-armed straight from the surviving file's own content.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const A = makeToplevelRepo("a");
    const tA = enterMergeQuarantine(A, "loom/a-branch", "merge in progress for A (isolate-b)");

    const filesAfterA = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.endsWith(".json"));
    check("(A precondition) exactly one latch file exists after raising A", filesAfterA.length === 1);
    const aFinalBasename = filesAfterA[0];
    const aFinalPath = path.join(MERGE_QUARANTINE_DIR, aFinalBasename);

    // O's basename is picked now but the FILE is written only AFTER the reboot below — it genuinely does
    // not exist yet, so this boot's own PASS 1/PASS 2 orphan handling never reads or arms it at all.
    const orphanBasename = `${randomBytes(12).toString("hex")}.json`;

    // Hand-edit A's own final JSON to name O in its own orphanLatchFiles — standing in for a real
    // production fold whose own durable write of that reference landed before O itself ever existed
    // (same technique merge-quarantine-round2-pins.mjs SITE 1 documents).
    const aRecord = JSON.parse(fs.readFileSync(aFinalPath, "utf8"));
    aRecord.orphanLatchFiles = [orphanBasename];
    fs.writeFileSync(aFinalPath, JSON.stringify(aRecord));

    const booted = await freshBootModule();
    booted.reenterMergeQuarantinesAtBoot([A]);
    const aEntryAfterBoot = booted.listActiveMergeQuarantines().find((e) => e.repoPath === A);
    check("(A precondition) A is armed after boot, carrying O in its own orphanLatchFiles", !!aEntryAfterBoot && (aEntryAfterBoot.orphanLatchFiles ?? []).includes(orphanBasename));

    const T = makeToplevelRepo("t");
    const tForeign = randomUUID();
    const orphanPath = path.join(MERGE_QUARANTINE_DIR, orphanBasename);
    fs.writeFileSync(orphanPath, JSON.stringify({
      repoPath: T, branch: "loom/t-branch", reason: "merge in progress for T (isolate-b)",
      enteredAt: Date.now(), tokens: [tForeign], resolvedKey: T.toLowerCase(), provenanceTracked: true,
    }));
    check("(A precondition) O exists on disk before A's full clear", fs.existsSync(orphanPath));

    // THE FULL CLEAR — A's only token, so this reaches clearActiveEntryTokenAtKey's remaining.length===0
    // branch -> clearMergeQuarantineByKey -> orphanFilesToSweep={O} -> sweepOrphanLatchFileIfUnreferenced.
    booted.clearMergeQuarantineByToken(A, tA);
    check("(A) THE FIX: O (holding T's foreign token) SURVIVES A's full clear — RED on unfixed code", fs.existsSync(orphanPath));

    // THE CONSEQUENCE, PROVEN ACROSS A REAL RESTART (separate child process): PASS 1 scans every file in
    // the quarantine dir directly, so a genuinely fresh boot re-arms T straight from O's own surviving
    // content — the foreign token really is still enforced, not merely "a file happens to still exist".
    const childScriptA = `
      const { reenterMergeQuarantinesAtBoot, activeMergeQuarantineFor } = await import(${JSON.stringify(mergeQuarantineModuleHref)});
      reenterMergeQuarantinesAtBoot([${JSON.stringify(A)}, ${JSON.stringify(T)}]);
      const entry = activeMergeQuarantineFor(${JSON.stringify(T)});
      process.stdout.write(JSON.stringify({ stillQuarantined: !!entry, tokens: entry?.tokens ?? null }));
    `;
    const childOutA = execFileSync(process.execPath, ["--input-type=module", "-e", childScriptA], {
      env: { ...process.env, LOOM_HOME: loomHome },
    }).toString();
    const resultA = JSON.parse(childOutA.trim().split("\n").pop());
    check("(A) THE CONSEQUENCE: a genuinely fresh boot re-arms T, reading O's own surviving content", resultA.stillQuarantined === true);
    check("(A) and it carries T's own real foreign token, not a fail-closed placeholder", (resultA.tokens ?? []).includes(tForeign));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (B) POSITIVE CONTROL — an unreferenced orphan whose parseable on-disk tokens are ALL in
  // `candidateTokens` is still deleted; the fix narrows the sweep, it does not disable it.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const B = makeToplevelRepo("b");
    const tB = enterMergeQuarantine(B, "loom/b-branch", "merge in progress for B (positive control)");
    const filesAfterB = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.endsWith(".json") && JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8")).repoPath === B);
    const bFinalPath = path.join(MERGE_QUARANTINE_DIR, filesAfterB[0]);
    const orphanBasenameB = `${randomBytes(12).toString("hex")}.json`;
    const bRecord = JSON.parse(fs.readFileSync(bFinalPath, "utf8"));
    bRecord.orphanLatchFiles = [orphanBasenameB];
    fs.writeFileSync(bFinalPath, JSON.stringify(bRecord));

    const bootedB = await freshBootModule();
    bootedB.reenterMergeQuarantinesAtBoot([B]);
    check("(B precondition) B is armed after boot, carrying its own orphan reference", (bootedB.listActiveMergeQuarantines().find((e) => e.repoPath === B)?.orphanLatchFiles ?? []).includes(orphanBasenameB));

    // O's own on-disk tokens are EXACTLY tB — a stale duplicate of B's own already-superseded data, the
    // ordinary legitimate-cleanup case this sweep exists to handle.
    const orphanPathB = path.join(MERGE_QUARANTINE_DIR, orphanBasenameB);
    fs.writeFileSync(orphanPathB, JSON.stringify({
      repoPath: B, branch: "loom/b-branch-stale", reason: "stale duplicate of B's own data",
      enteredAt: Date.now(), tokens: [tB], resolvedKey: B.toLowerCase(), provenanceTracked: true,
    }));
    check("(B precondition) the orphan exists before B's full clear", fs.existsSync(orphanPathB));

    bootedB.clearMergeQuarantineByToken(B, tB);
    check("(B) THE POSITIVE CONTROL: the orphan is deleted — every on-disk token was already in candidateTokens", !fs.existsSync(orphanPathB));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (C) TOMBSTONE CASE — an on-disk token already globally tombstoned (cleared earlier, by an unrelated
  // identity) does not block deletion, even though it is NOT in THIS clear's own candidateTokens.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const C = makeToplevelRepo("c");
    const tC = enterMergeQuarantine(C, "loom/c-branch", "merge in progress for C (tombstone case)");
    const filesAfterC = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.endsWith(".json") && JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8")).repoPath === C);
    const cFinalPath = path.join(MERGE_QUARANTINE_DIR, filesAfterC[0]);
    const orphanBasenameC = `${randomBytes(12).toString("hex")}.json`;
    const cRecord = JSON.parse(fs.readFileSync(cFinalPath, "utf8"));
    cRecord.orphanLatchFiles = [orphanBasenameC];
    fs.writeFileSync(cFinalPath, JSON.stringify(cRecord));

    // Reboot (fresh module instance) so C's own in-memory entry actually carries the hand-edited
    // orphanLatchFiles reference, then tombstone X WITHIN this same booted instance — the global
    // `clearedTokens` set the predicate reads is module-level state, reset by a fresh import.
    const bootedC = await freshBootModule();
    bootedC.reenterMergeQuarantinesAtBoot([C]);
    check("(C precondition) C is armed after boot, carrying the orphan reference", (bootedC.listActiveMergeQuarantines().find((e) => e.repoPath === C)?.orphanLatchFiles ?? []).includes(orphanBasenameC));

    const X = makeToplevelRepo("x");
    const tX = bootedC.enterMergeQuarantine(X, "loom/x-branch", "throwaway, cleared immediately to tombstone tX");
    bootedC.clearMergeQuarantineByToken(X, tX); // tX is now in THIS booted instance's own global `clearedTokens` set

    // O's own on-disk token is tX — NOT in C's own candidateTokens (which will be just [tC]) — but it IS
    // already globally tombstoned from the throwaway clear above, in this same booted process.
    const orphanPathC = path.join(MERGE_QUARANTINE_DIR, orphanBasenameC);
    fs.writeFileSync(orphanPathC, JSON.stringify({
      repoPath: X, branch: "loom/x-branch", reason: "already-tombstoned token, stale reference",
      enteredAt: Date.now(), tokens: [tX], resolvedKey: X.toLowerCase(), provenanceTracked: true,
    }));
    check("(C precondition) the orphan exists before C's full clear", fs.existsSync(orphanPathC));

    bootedC.clearMergeQuarantineByToken(C, tC);
    check("(C) THE TOMBSTONE CASE: the orphan is deleted — its only on-disk token was already tombstoned", !fs.existsSync(orphanPathC));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (D) a non-ENOENT read failure at sweep time keeps the file — cannot prove coverage, so fail closed.
  // Rebooted (like B/C), and the EACCES is injected on the BOOTED instance's own clear — the fixture's
  // own orphanLatchFiles reference must actually reach the booted entry's in-memory record, or this
  // never reaches the sweep at all (Code Review 745c3736, MAJOR 1: the original version never rebooted,
  // so `orphanSweepSafeToDelete` was never even called — the test passed vacuously).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const D = makeToplevelRepo("d");
    const tD = enterMergeQuarantine(D, "loom/d-branch", "merge in progress for D (read-failure case)");
    const filesAfterD = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.endsWith(".json") && JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8")).repoPath === D);
    const dFinalPath = path.join(MERGE_QUARANTINE_DIR, filesAfterD[0]);
    const orphanBasenameD = `${randomBytes(12).toString("hex")}.json`;
    const dRecord = JSON.parse(fs.readFileSync(dFinalPath, "utf8"));
    dRecord.orphanLatchFiles = [orphanBasenameD];
    fs.writeFileSync(dFinalPath, JSON.stringify(dRecord));

    const bootedD = await freshBootModule();
    bootedD.reenterMergeQuarantinesAtBoot([D]);
    check("(D precondition) D is armed after boot, carrying the orphan reference", (bootedD.listActiveMergeQuarantines().find((e) => e.repoPath === D)?.orphanLatchFiles ?? []).includes(orphanBasenameD));

    const orphanPathD = path.join(MERGE_QUARANTINE_DIR, orphanBasenameD);
    fs.writeFileSync(orphanPathD, JSON.stringify({
      repoPath: makeToplevelRepo("d-foreign"), branch: "loom/foreign", reason: "foreign, would be readable but for the injected failure",
      enteredAt: Date.now(), tokens: [randomUUID()], provenanceTracked: true,
    }));
    check("(D precondition) the orphan exists before D's full clear", fs.existsSync(orphanPathD));

    const inject = injectPersistentReadFailure(orphanPathD, "EACCES");
    try {
      bootedD.clearMergeQuarantineByToken(D, tD);
    } finally {
      inject.restore();
    }
    check("(D) a non-ENOENT read failure KEEPS the orphan — cannot prove coverage, fail closed", fs.existsSync(orphanPathD));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (E) Code Review 745c3736, MINOR 3 — a readable, genuine record (repoPath/branch/reason all strings,
  // the exact shape PASS 1 arms as a REAL quarantine — see ~:4824) carrying ZERO tokens must be KEPT,
  // never deleted: `[].every(...)` is vacuously true, so the plain token-subset check alone would wrongly
  // treat a tokenless-but-genuine occupant as trivially "covered" and destroy it — a fail-open on a
  // quarantine PASS 1 would otherwise re-arm on the very next boot.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const E = makeToplevelRepo("e");
    const tE = enterMergeQuarantine(E, "loom/e-branch", "merge in progress for E (tokenless-genuine case)");
    const filesAfterE = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.endsWith(".json") && JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8")).repoPath === E);
    const eFinalPath = path.join(MERGE_QUARANTINE_DIR, filesAfterE[0]);
    const orphanBasenameE = `${randomBytes(12).toString("hex")}.json`;
    const eRecord = JSON.parse(fs.readFileSync(eFinalPath, "utf8"));
    eRecord.orphanLatchFiles = [orphanBasenameE];
    fs.writeFileSync(eFinalPath, JSON.stringify(eRecord));

    const bootedE = await freshBootModule();
    bootedE.reenterMergeQuarantinesAtBoot([E]);
    check("(E precondition) E is armed after boot, carrying the orphan reference", (bootedE.listActiveMergeQuarantines().find((e) => e.repoPath === E)?.orphanLatchFiles ?? []).includes(orphanBasenameE));

    const foreignRepoE = makeToplevelRepo("e-foreign");
    const orphanPathE = path.join(MERGE_QUARANTINE_DIR, orphanBasenameE);
    fs.writeFileSync(orphanPathE, JSON.stringify({
      repoPath: foreignRepoE, branch: "loom/e-foreign-branch", reason: "a genuine, tokenless occupant — the legacy shape PASS 1 still arms",
      enteredAt: Date.now(), tokens: [],
    }));
    check("(E precondition) the orphan exists, genuinely readable, with ZERO tokens", fs.existsSync(orphanPathE) && JSON.parse(fs.readFileSync(orphanPathE, "utf8")).tokens.length === 0);

    bootedE.clearMergeQuarantineByToken(E, tE);
    check("(E) THE FIX: a readable, genuine, TOKENLESS occupant is KEPT, never deleted as vacuously covered", fs.existsSync(orphanPathE));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (F) Code Review 745c3736, MAJOR 2 — `clearMergeQuarantineLatchFile`'s RAW-FALLBACK branch (reached
  // when NO in-memory entry anywhere matches the given id) must report a content-based keep via
  // `latchKept`, never silently — a kept file indistinguishable from "nothing was kept" is exactly the
  // shape 9cabd143's own doc warns against.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const foreignRepoF = makeToplevelRepo("f-foreign");
    const tForeignF = randomUUID();
    const orphanBasenameF = `${randomBytes(12).toString("hex")}.json`;
    const orphanPathF = path.join(MERGE_QUARANTINE_DIR, orphanBasenameF);
    fs.writeFileSync(orphanPathF, JSON.stringify({
      repoPath: foreignRepoF, branch: "loom/f-foreign-branch", reason: "a genuine foreign occupant nothing in memory matches by id",
      enteredAt: Date.now(), tokens: [tForeignF],
    }));
    const idF = orphanBasenameF.slice(0, -".json".length);
    check("(F precondition) nothing in memory matches idF at all", !listActiveMergeQuarantines().some((e) => e.repoPath === foreignRepoF));

    const clearResultF = mod.clearMergeQuarantineLatchFile(idF);
    check("(F) THE FIX: a by-id clear of a foreign-token orphan via the RAW-FALLBACK reports ok:true", clearResultF.ok === true);
    check("(F) THE FIX: ...and reports it KEPT via latchKept, never silently", clearResultF.latchKept === true);
    check("(F) THE FIX: ...naming the parsed foreign repoPath", (clearResultF.referencingRepoPaths ?? []).includes(foreignRepoF));
    check("(F) the orphan genuinely survives on disk", fs.existsSync(orphanPathF));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (G) Code Review e726e2ba, Minor 2 — the RAW-FALLBACK's own `anyKeptUnattributed` arm has no coverage
  // of its own: (F) above always has a parsable `repoPath`, so `keptRepoPaths.size > 0` alone already
  // satisfies it without ever exercising the `anyKeptUnattributed` branch. Here the read itself fails
  // (reusing (D)'s own persistent EACCES injection), so `orphanSweepSafeToDelete` returns `{safe:false}`
  // with NO `parsedRepoPath` at all — `ownSweep.referencingRepoPaths` is empty, and ONLY the unattributed
  // arm can still report this as `latchKept`.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const foreignRepoG = makeToplevelRepo("g-foreign");
    const orphanBasenameG = `${randomBytes(12).toString("hex")}.json`;
    const orphanPathG = path.join(MERGE_QUARANTINE_DIR, orphanBasenameG);
    fs.writeFileSync(orphanPathG, JSON.stringify({
      repoPath: foreignRepoG, branch: "loom/g-foreign-branch", reason: "would be readable but for the injected failure",
      enteredAt: Date.now(), tokens: [randomUUID()],
    }));
    const idG = orphanBasenameG.slice(0, -".json".length);
    check("(G precondition) nothing in memory matches idG at all", !listActiveMergeQuarantines().some((e) => e.repoPath === foreignRepoG));

    const injectG = injectPersistentReadFailure(orphanPathG, "EACCES");
    let clearResultG;
    try {
      clearResultG = mod.clearMergeQuarantineLatchFile(idG);
    } finally {
      injectG.restore();
    }
    check("(G) THE FIX: the RAW-FALLBACK reports ok:true even with no parsable repoPath", clearResultG.ok === true);
    check("(G) THE FIX: ...and reports it KEPT via latchKept (the anyKeptUnattributed arm), never silently", clearResultG.latchKept === true);
    check("(G) THE FIX: ...with an EMPTY referencingRepoPaths — nothing could be attributed", Array.isArray(clearResultG.referencingRepoPaths) && clearResultG.referencingRepoPaths.length === 0);
    check("(G) the orphan genuinely survives on disk (the read never even reached the unlink)", fs.existsSync(orphanPathG));
  }
} finally {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — sweepOrphanLatchFileIfUnreferenced is now content-aware: a full clear no longer " +
    "destroys an unreferenced orphan's real, foreign, uncovered token (A); the sweep still deletes an " +
    "unreferenced orphan once every real on-disk token is covered by this clear's own candidateTokens " +
    "(B) or already globally tombstoned (C); a non-ENOENT read failure fails closed (D); a readable, " +
    "genuine, TOKENLESS occupant is kept rather than vacuously covered (E); a by-id clear via the " +
    "RAW-FALLBACK branch reports a content-based keep via latchKept, naming the parsed repoPath when " +
    "one parses (F) or via anyKeptUnattributed when none does (G), never silently. Genuinely corrupt " +
    "debris (never a real record) stays deletable once unreferenced, unchanged — see " +
    "merge-quarantine-clear-by-path.mjs's own (J)/(Z1)/(Z1-route), run standalone in the full suite."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
