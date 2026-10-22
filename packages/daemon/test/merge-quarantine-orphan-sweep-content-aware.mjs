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
import { randomUUID, randomBytes, createHash } from "node:crypto";
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

// Card 0a783fb2 — the unlink twin of the read-failure injector above: fails EVERY unlink of `targetPath`
// (persistent), simulating an EPERM/EBUSY-shaped delete failure rather than a corrupted/unreadable file —
// drives `unlinkLatchFileConfirmed`'s own `false` (unconfirmed) return, which is the ONLY way
// `sweepOwnLatchFileUnlessOwnedElsewhere` reports a kept-but-UNATTRIBUTED result (no physical owner, no
// `keptUnreadableLatchFiles` mark — just a failed delete of an otherwise-orphaned file).
function injectPersistentUnlinkFailure(targetPath, code = "EBUSY") {
  const real = fs.unlinkSync;
  fs.unlinkSync = (p, ...rest) => {
    if (typeof p === "string" && p === targetPath) {
      throw Object.assign(new Error(`${code}: simulated unlink failure`), { code });
    }
    return real(p, ...rest);
  };
  return { restore: () => { fs.unlinkSync = real; } };
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
  //
  // @decision 8db913e2 (Follow-up 0a783fb2) — MIGRATED: the parsed repoPath now reports via
  // `contentKeptRepoPaths`, never `referencingRepoPaths` (that field is TRUE in-memory referencers only).
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
    check("*** CARD 0a783fb2 *** (F) ...naming the parsed foreign repoPath via contentKeptRepoPaths", (clearResultF.contentKeptRepoPaths ?? []).includes(foreignRepoF));
    check("*** CARD 0a783fb2 *** (F) ...and NEVER folding it into referencingRepoPaths too", !(clearResultF.referencingRepoPaths ?? []).includes(foreignRepoF));
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

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (H) card 0a783fb2 — clearMergeQuarantineByKey's own orphan-sweep (reached via clearMergeQuarantine's
  // RESOLVABLE dispatch) used to discard a content-based keep entirely (console.error only, no response
  // field). It must now report it via `contentKeptRepoPaths`, and never fold it into `referencingRepoPaths`.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const H = makeToplevelRepo("h");
    const tH = enterMergeQuarantine(H, "loom/h-branch", "merge in progress for H (by-key content-keep)");
    const filesAfterH = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.endsWith(".json") && JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8")).repoPath === H);
    const hFinalPath = path.join(MERGE_QUARANTINE_DIR, filesAfterH[0]);
    const orphanBasenameH = `${randomBytes(12).toString("hex")}.json`;
    const hRecord = JSON.parse(fs.readFileSync(hFinalPath, "utf8"));
    hRecord.orphanLatchFiles = [orphanBasenameH];
    fs.writeFileSync(hFinalPath, JSON.stringify(hRecord));

    const bootedH = await freshBootModule();
    bootedH.reenterMergeQuarantinesAtBoot([H]);
    check("(H precondition) H is armed after boot, carrying the orphan reference", (bootedH.listActiveMergeQuarantines().find((e) => e.repoPath === H)?.orphanLatchFiles ?? []).includes(orphanBasenameH));

    const foreignRepoH = makeToplevelRepo("h-foreign");
    const tForeignH = randomUUID();
    const orphanPathH = path.join(MERGE_QUARANTINE_DIR, orphanBasenameH);
    fs.writeFileSync(orphanPathH, JSON.stringify({
      repoPath: foreignRepoH, branch: "loom/h-foreign-branch", reason: "foreign occupant, written AFTER boot",
      enteredAt: Date.now(), tokens: [tForeignH],
    }));
    check("(H precondition) the orphan exists before H's full clear", fs.existsSync(orphanPathH));

    const clearResultH = bootedH.clearMergeQuarantine(H);
    check("*** CARD 0a783fb2 *** (H) clearMergeQuarantineByKey reports the content-parsed keep via contentKeptRepoPaths", (clearResultH?.contentKeptRepoPaths ?? []).includes(foreignRepoH));
    check("*** CARD 0a783fb2 *** (H) ...and never folds it into referencingRepoPaths", !(clearResultH?.referencingRepoPaths ?? []).includes(foreignRepoH));
    check("(H) THE FIX: O (holding the foreign token) SURVIVES H's full clear", fs.existsSync(orphanPathH));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (I) card 0a783fb2 — clearMergeQuarantineByRecordedPath's own orphan-sweep (reached via
  // clearMergeQuarantine's UNRESOLVABLE dispatch, and directly) must report a content-based keep too.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const pI = path.join(os.tmpdir(), `loom-mqosca-pI-never-exists-${freshSfx()}`);
    const orphanBasenameI = `${randomBytes(12).toString("hex")}.json`;
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    // @decision 8db913e2 (Follow-up 0a783fb2, Code Review 47289f8d, NIT) — the production runtime-divert
    // shape (d4b25feb): `pending-<sha256(directPathIdentity(repoPath)).slice(0,24)>.json`, never an
    // arbitrary `pending-i-...` basename — pI never resolves, so directPathIdentity falls back to
    // `path.resolve(pI).toLowerCase()` (win32), mirroring the real function exactly.
    const identityI = path.resolve(pI).toLowerCase();
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `pending-${createHash("sha256").update(identityI).digest("hex").slice(0, 24)}.json`), JSON.stringify({
      repoPath: pI, branch: "p-i-branch", reason: "P — I, unresolvable, carries the orphan reference",
      enteredAt: Date.now(), tokens: [randomUUID()], orphanLatchFiles: [orphanBasenameI],
    }, null, 2) + "\n");

    const bootedI = await freshBootModule();
    bootedI.reenterMergeQuarantinesAtBoot([pI]);
    check("(I precondition) P is quarantined (pending, unresolvable) after boot", bootedI.listActiveMergeQuarantines().some((e) => e.repoPath === pI && (e.orphanLatchFiles ?? []).includes(orphanBasenameI)));

    const foreignRepoI = makeToplevelRepo("i-foreign");
    const tForeignI = randomUUID();
    const orphanPathI = path.join(MERGE_QUARANTINE_DIR, orphanBasenameI);
    fs.writeFileSync(orphanPathI, JSON.stringify({
      repoPath: foreignRepoI, branch: "loom/i-foreign-branch", reason: "foreign occupant, written AFTER boot",
      enteredAt: Date.now(), tokens: [tForeignI],
    }));
    check("(I precondition) the orphan exists before P's full clear", fs.existsSync(orphanPathI));

    const clearResultI = bootedI.clearMergeQuarantineByRecordedPath(pI);
    check("*** CARD 0a783fb2 *** (I) clearMergeQuarantineByRecordedPath reports the content-parsed keep via contentKeptRepoPaths", (clearResultI?.contentKeptRepoPaths ?? []).includes(foreignRepoI));
    check("*** CARD 0a783fb2 *** (I) ...and never folds it into referencingRepoPaths", !(clearResultI?.referencingRepoPaths ?? []).includes(foreignRepoI));
    check("(I) THE FIX: O (holding the foreign token) SURVIVES P's full clear", fs.existsSync(orphanPathI));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (J) card 0a783fb2 — clearMergeQuarantineLatchFile's PENDING-MATCH branch's own orphan-sweep
  // (orphanFilesToSweep, distinct from ownSweep/finalSweep/tmpSweep) used to discard a content-based keep
  // entirely too — the "one more" discard site this card's own investigation found.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const pJ = path.join(os.tmpdir(), `loom-mqosca-pJ-never-exists-${freshSfx()}`);
    const orphanBasenameJ = `${randomBytes(12).toString("hex")}.json`;
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    // @decision 8db913e2 (Follow-up 0a783fb2, test-construction fix) — a PASS-1-sourced pending entry's
    // own sourceFile must be `<24-hex>.json` — pendingLatchIdFor's fallback (no other naming pattern
    // matches) returns everything before `.json` VERBATIM as the id, never hashing it; a `pending-j-...`
    // basename derived an invalid, non-24-hex id and clearMergeQuarantineLatchFile refused it outright.
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${randomBytes(12).toString("hex")}.json`), JSON.stringify({
      repoPath: pJ, branch: "p-j-branch", reason: "P — J, unresolvable, carries the orphan reference",
      enteredAt: Date.now(), tokens: [randomUUID()], orphanLatchFiles: [orphanBasenameJ],
    }, null, 2) + "\n");

    const bootedJ = await freshBootModule();
    bootedJ.reenterMergeQuarantinesAtBoot([pJ]);
    const entryJ = bootedJ.listActiveMergeQuarantines().find((e) => e.repoPath === pJ);
    check("(J precondition) P is quarantined (pending, unresolvable) after boot, carrying the orphan reference", !!entryJ && (entryJ.orphanLatchFiles ?? []).includes(orphanBasenameJ));
    const idJ = bootedJ.quarantineLatchFileIdsFor(entryJ)[0];

    const foreignRepoJ = makeToplevelRepo("j-foreign");
    const tForeignJ = randomUUID();
    const orphanPathJ = path.join(MERGE_QUARANTINE_DIR, orphanBasenameJ);
    fs.writeFileSync(orphanPathJ, JSON.stringify({
      repoPath: foreignRepoJ, branch: "loom/j-foreign-branch", reason: "foreign occupant, written AFTER boot",
      enteredAt: Date.now(), tokens: [tForeignJ],
    }));
    check("(J precondition) the orphan exists before P's clear-by-id", fs.existsSync(orphanPathJ));

    const clearResultJ = bootedJ.clearMergeQuarantineLatchFile(idJ);
    check("(J) clear-by-id reports ok:true", clearResultJ.ok === true);
    check("*** CARD 0a783fb2 *** (J) the pending-match branch's own orphan-sweep reports the content-parsed keep via contentKeptRepoPaths", (clearResultJ.contentKeptRepoPaths ?? []).includes(foreignRepoJ));
    check("*** CARD 0a783fb2 *** (J) ...and never folds it into referencingRepoPaths", !(clearResultJ.referencingRepoPaths ?? []).includes(foreignRepoJ));
    check("(J) THE FIX: O (holding the foreign token) SURVIVES P's clear-by-id", fs.existsSync(orphanPathJ));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (K) card 0a783fb2 — clearMergeQuarantineLatchFile's PENDING-MATCH branch never tracked a
  // kept-but-UNATTRIBUTED result from its own ownSweep/finalSweep/tmpSweep calls before this card (issue
  // #2 of the card's own investigation) — reported via latchKept now, mirroring the RAW-FALLBACK branch's
  // own anyKeptUnattributed arm (scenario G above). Driven by an UNLINK failure (not a read failure) on
  // the pending entry's OWN sourceFile — the only way `sweepOwnLatchFileUnlessOwnedElsewhere` reports a
  // kept-but-unattributed result with no `keptUnreadableLatchFiles` mark involved at all.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const pK = path.join(os.tmpdir(), `loom-mqosca-pK-never-exists-${freshSfx()}`);
    // @decision 8db913e2 (Follow-up 0a783fb2, test-construction fix) — same reason as (J) above: must be
    // `<24-hex>.json`, not a `pending-k-...`-shaped basename, or pendingLatchIdFor derives an invalid id.
    const sourceFileK = `${randomBytes(12).toString("hex")}.json`;
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, sourceFileK), JSON.stringify({
      repoPath: pK, branch: "p-k-branch", reason: "P — K, unresolvable, own sourceFile unlink will fail",
      enteredAt: Date.now(), tokens: [randomUUID()],
    }, null, 2) + "\n");

    const bootedK = await freshBootModule();
    bootedK.reenterMergeQuarantinesAtBoot([pK]);
    const entryK = bootedK.listActiveMergeQuarantines().find((e) => e.repoPath === pK);
    check("(K precondition) P is quarantined (pending, unresolvable) after boot", !!entryK);
    const idK = bootedK.quarantineLatchFileIdsFor(entryK)[0];

    const sourceFilePathK = path.join(MERGE_QUARANTINE_DIR, sourceFileK);
    check("(K precondition) P's own sourceFile exists before the clear-by-id", fs.existsSync(sourceFilePathK));
    const injectK = injectPersistentUnlinkFailure(sourceFilePathK, "EBUSY");
    let clearResultK;
    try {
      clearResultK = bootedK.clearMergeQuarantineLatchFile(idK);
    } finally {
      injectK.restore();
    }
    check("(K) clear-by-id reports ok:true", clearResultK.ok === true);
    check("*** CARD 0a783fb2 *** (K) the pending-match branch reports latchKept via the unattributed arm, never silently", clearResultK.latchKept === true);
    check("*** CARD 0a783fb2 *** (K) ...with an EMPTY referencingRepoPaths — nothing could be attributed", Array.isArray(clearResultK.referencingRepoPaths) && clearResultK.referencingRepoPaths.length === 0);
    check("(K) P's own sourceFile genuinely survives (the unlink failed)", fs.existsSync(sourceFilePathK));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (L) card 0a783fb2, Code Review 47289f8d — clearMergeQuarantineByKey's own orphan-sweep must surface a
  // TRUE, DIFFERENT-identity referencer into stillBlockedCoOccupants (the extension this round added) —
  // distinct from (H)'s content-only proof.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const L1 = makeToplevelRepo("l1");
    enterMergeQuarantine(L1, "loom/l1-branch", "merge in progress for L1 (true referencer)");
    const filesAfterL1 = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.endsWith(".json") && JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8")).repoPath === L1);
    const l1FinalPath = path.join(MERGE_QUARANTINE_DIR, filesAfterL1[0]);
    const sharedOrphanL = `${randomBytes(12).toString("hex")}.json`;
    const l1Record = JSON.parse(fs.readFileSync(l1FinalPath, "utf8"));
    l1Record.orphanLatchFiles = [sharedOrphanL];
    fs.writeFileSync(l1FinalPath, JSON.stringify(l1Record));

    const L2 = makeToplevelRepo("l2"); // DIFFERENT identity, survives
    enterMergeQuarantine(L2, "loom/l2-branch", "merge in progress for L2 (survives, true referencer)");
    const filesAfterL2 = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.endsWith(".json") && JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8")).repoPath === L2);
    const l2FinalPath = path.join(MERGE_QUARANTINE_DIR, filesAfterL2[0]);
    const l2Record = JSON.parse(fs.readFileSync(l2FinalPath, "utf8"));
    l2Record.orphanLatchFiles = [sharedOrphanL];
    fs.writeFileSync(l2FinalPath, JSON.stringify(l2Record));

    // @decision 8db913e2 (Follow-up 0a783fb2, Code Review 47289f8d) — a WELL-FORMED record (repoPath/
    // branch/reason/tokens all present), never a bare placeholder: PASS 1 treats a record missing those
    // fields as CORRUPT debris needing its own fail-closed broad protection, which REWRITES every
    // currently-unresolvable entry's own orphanLatchFiles to point at it — exactly the kind of
    // cross-entry mutation this test must NOT trigger as a side effect of its own fixture.
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, sharedOrphanL), JSON.stringify({
      repoPath: path.join(os.tmpdir(), `loom-mqosca-sharedOrphan-owner-${freshSfx()}`), branch: "b", reason: "r",
      enteredAt: Date.now(), tokens: [randomUUID()],
    }));

    const bootedL = await freshBootModule();
    bootedL.reenterMergeQuarantinesAtBoot([L1, L2]);
    check("(L precondition) both L1 and L2 are armed, both carrying the shared orphan reference", bootedL.listActiveMergeQuarantines().filter((e) => (e.orphanLatchFiles ?? []).includes(sharedOrphanL)).length === 2);

    const clearResultL = bootedL.clearMergeQuarantine(L1);
    check("*** CARD 0a783fb2 *** (L) clearMergeQuarantineByKey surfaces a TRUE, different-identity referencer via referencingRepoPaths", (clearResultL?.referencingRepoPaths ?? []).includes(L2));
    check("*** CARD 0a783fb2 *** (L) ...and via stillBlockedCoOccupants (the extension this round added)", !!clearResultL?.stillBlockedCoOccupants?.some((c) => c.repoPath === L2));
    check("(L) L2 is genuinely untouched — the clear never cleared it", bootedL.listActiveMergeQuarantines().some((e) => e.repoPath === L2));
    check("(L) the shared orphan file survives (L2 still needs it)", fs.existsSync(path.join(MERGE_QUARANTINE_DIR, sharedOrphanL)));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (M) card 0a783fb2, Code Review 47289f8d — clearMergeQuarantineByRecordedPath's own orphan-sweep
  // (matchedPending block) must surface a TRUE, DIFFERENT-identity referencer too.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const pM1 = path.join(os.tmpdir(), `loom-mqosca-pM1-never-exists-${freshSfx()}`);
    const pM2 = path.join(os.tmpdir(), `loom-mqosca-pM2-never-exists-${freshSfx()}`);
    const sharedOrphanM = `${randomBytes(12).toString("hex")}.json`;
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const identityM1 = path.resolve(pM1).toLowerCase();
    const identityM2 = path.resolve(pM2).toLowerCase();
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `pending-${createHash("sha256").update(identityM1).digest("hex").slice(0, 24)}.json`), JSON.stringify({
      repoPath: pM1, branch: "p-m1-branch", reason: "P — M1, unresolvable, carries the shared orphan reference",
      enteredAt: Date.now(), tokens: [randomUUID()], orphanLatchFiles: [sharedOrphanM],
    }, null, 2) + "\n");
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `pending-${createHash("sha256").update(identityM2).digest("hex").slice(0, 24)}.json`), JSON.stringify({
      repoPath: pM2, branch: "p-m2-branch", reason: "P — M2, unresolvable, survives, carries the shared orphan reference",
      enteredAt: Date.now(), tokens: [randomUUID()], orphanLatchFiles: [sharedOrphanM],
    }, null, 2) + "\n");
    // @decision 8db913e2 (Follow-up 0a783fb2, Code Review 47289f8d) — see (L)'s own identical note: a
    // WELL-FORMED record, never a bare placeholder (avoids PASS 1's corrupt-debris fail-closed fold).
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, sharedOrphanM), JSON.stringify({
      repoPath: path.join(os.tmpdir(), `loom-mqosca-sharedOrphan-owner-${freshSfx()}`), branch: "b", reason: "r",
      enteredAt: Date.now(), tokens: [randomUUID()],
    }));

    const bootedM = await freshBootModule();
    bootedM.reenterMergeQuarantinesAtBoot([pM1, pM2]);
    check("(M precondition) both pM1 and pM2 are pending, both carrying the shared orphan reference", bootedM.listActiveMergeQuarantines().filter((e) => (e.orphanLatchFiles ?? []).includes(sharedOrphanM)).length === 2);

    const clearResultM = bootedM.clearMergeQuarantineByRecordedPath(pM1);
    check("*** CARD 0a783fb2 *** (M) clearMergeQuarantineByRecordedPath surfaces a TRUE, different-identity referencer via referencingRepoPaths", (clearResultM?.referencingRepoPaths ?? []).includes(pM2));
    check("*** CARD 0a783fb2 *** (M) ...and via stillBlockedCoOccupants", !!clearResultM?.stillBlockedCoOccupants?.some((c) => c.repoPath === pM2));
    check("(M) pM2 is genuinely untouched", bootedM.listActiveMergeQuarantines().some((e) => e.repoPath === pM2));
    check("(M) the shared orphan file survives (pM2 still needs it)", fs.existsSync(path.join(MERGE_QUARANTINE_DIR, sharedOrphanM)));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (N) card 0a783fb2, Code Review 47289f8d — clearMergeQuarantineLatchFile's own pending-match branch
  // orphan-sweep must surface a TRUE, DIFFERENT-identity referencer too — distinct from (J)'s content-only
  // proof.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const pN1 = path.join(os.tmpdir(), `loom-mqosca-pN1-never-exists-${freshSfx()}`);
    const pN2 = path.join(os.tmpdir(), `loom-mqosca-pN2-never-exists-${freshSfx()}`);
    const sharedOrphanN = `${randomBytes(12).toString("hex")}.json`;
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const identityN1 = path.resolve(pN1).toLowerCase();
    const identityN2 = path.resolve(pN2).toLowerCase();
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `pending-${createHash("sha256").update(identityN1).digest("hex").slice(0, 24)}.json`), JSON.stringify({
      repoPath: pN1, branch: "p-n1-branch", reason: "P — N1, unresolvable, carries the shared orphan reference",
      enteredAt: Date.now(), tokens: [randomUUID()], orphanLatchFiles: [sharedOrphanN],
    }, null, 2) + "\n");
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `pending-${createHash("sha256").update(identityN2).digest("hex").slice(0, 24)}.json`), JSON.stringify({
      repoPath: pN2, branch: "p-n2-branch", reason: "P — N2, unresolvable, survives, carries the shared orphan reference",
      enteredAt: Date.now(), tokens: [randomUUID()], orphanLatchFiles: [sharedOrphanN],
    }, null, 2) + "\n");
    // @decision 8db913e2 (Follow-up 0a783fb2, Code Review 47289f8d) — see (L)'s own identical note: a
    // WELL-FORMED record, never a bare placeholder (avoids PASS 1's corrupt-debris fail-closed fold).
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, sharedOrphanN), JSON.stringify({
      repoPath: path.join(os.tmpdir(), `loom-mqosca-sharedOrphan-owner-${freshSfx()}`), branch: "b", reason: "r",
      enteredAt: Date.now(), tokens: [randomUUID()],
    }));

    const bootedN = await freshBootModule();
    bootedN.reenterMergeQuarantinesAtBoot([pN1, pN2]);
    const entryN1 = bootedN.listActiveMergeQuarantines().find((e) => e.repoPath === pN1);
    check("(N precondition) P (N1) is pending, carrying the shared orphan reference", !!entryN1 && (entryN1.orphanLatchFiles ?? []).includes(sharedOrphanN));
    const idN1 = bootedN.quarantineLatchFileIdsFor(entryN1)[0];

    const clearResultN = bootedN.clearMergeQuarantineLatchFile(idN1);
    check("(N) clear-by-id reports ok:true", clearResultN.ok === true);
    check("*** CARD 0a783fb2 *** (N) the pending-match branch surfaces a TRUE, different-identity referencer via referencingRepoPaths", (clearResultN.referencingRepoPaths ?? []).includes(pN2));
    check("*** CARD 0a783fb2 *** (N) ...and via stillBlockedCoOccupants", !!clearResultN.stillBlockedCoOccupants?.some((c) => c.repoPath === pN2));
    check("(N) pN2 is genuinely untouched", bootedN.listActiveMergeQuarantines().some((e) => e.repoPath === pN2));
    check("(N) the shared orphan file survives (pN2 still needs it)", fs.existsSync(path.join(MERGE_QUARANTINE_DIR, sharedOrphanN)));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (O) card 0a783fb2, Code Review 47289f8d — clearTokenFromPendingIndices's own "remove" branch has NO
  // human-facing return (clearMergeQuarantineByToken is `void`); a TRUE, different-identity referencer
  // must still be disclosed via console.warn, never silently discarded.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const pO1 = path.join(os.tmpdir(), `loom-mqosca-pO1-never-exists-${freshSfx()}`);
    const pO2 = path.join(os.tmpdir(), `loom-mqosca-pO2-never-exists-${freshSfx()}`);
    const sharedOrphanO = `${randomBytes(12).toString("hex")}.json`;
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const identityO1 = path.resolve(pO1).toLowerCase();
    const identityO2 = path.resolve(pO2).toLowerCase();
    const tO1 = randomUUID();
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `pending-${createHash("sha256").update(identityO1).digest("hex").slice(0, 24)}.json`), JSON.stringify({
      repoPath: pO1, branch: "p-o1-branch", reason: "P — O1, unresolvable, sole token being lifted",
      enteredAt: Date.now(), tokens: [tO1], orphanLatchFiles: [sharedOrphanO],
    }, null, 2) + "\n");
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `pending-${createHash("sha256").update(identityO2).digest("hex").slice(0, 24)}.json`), JSON.stringify({
      repoPath: pO2, branch: "p-o2-branch", reason: "P — O2, unresolvable, survives, carries the shared orphan reference",
      enteredAt: Date.now(), tokens: [randomUUID()], orphanLatchFiles: [sharedOrphanO],
    }, null, 2) + "\n");
    // @decision 8db913e2 (Follow-up 0a783fb2, Code Review 47289f8d) — see (L)'s own identical note: a
    // WELL-FORMED record, never a bare placeholder (avoids PASS 1's corrupt-debris fail-closed fold).
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, sharedOrphanO), JSON.stringify({
      repoPath: path.join(os.tmpdir(), `loom-mqosca-sharedOrphan-owner-${freshSfx()}`), branch: "b", reason: "r",
      enteredAt: Date.now(), tokens: [randomUUID()],
    }));

    const bootedO = await freshBootModule();
    bootedO.reenterMergeQuarantinesAtBoot([pO1, pO2]);
    check("(O precondition) both pO1 and pO2 are pending, both carrying the shared orphan reference", bootedO.listActiveMergeQuarantines().filter((e) => (e.orphanLatchFiles ?? []).includes(sharedOrphanO)).length === 2);

    const capturedWarnings = [];
    const realWarn = console.warn;
    console.warn = (msg) => { capturedWarnings.push(msg); };
    try {
      bootedO.clearMergeQuarantineByToken(pO1, tO1);
    } finally {
      console.warn = realWarn;
    }
    check("*** CARD 0a783fb2 *** (O) clearTokenFromPendingIndices's own no-human-route warn names the TRUE, different-identity referencer", capturedWarnings.some((w) => w.includes(pO2)));
    check("(O) pO2 is genuinely untouched", bootedO.listActiveMergeQuarantines().some((e) => e.repoPath === pO2));
    check("(O) the shared orphan file survives (pO2 still needs it)", fs.existsSync(path.join(MERGE_QUARANTINE_DIR, sharedOrphanO)));
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
    "RAW-FALLBACK branch reports a content-based keep via contentKeptRepoPaths, naming the parsed repoPath " +
    "when one parses (F) or via anyKeptUnattributed when none does (G), never silently, and never folded " +
    "into referencingRepoPaths (card 0a783fb2). That same card's shared fold-in helper closes the four " +
    "other discard sites: clearMergeQuarantineByKey (H), clearMergeQuarantineByRecordedPath (I), and " +
    "clearMergeQuarantineLatchFile's own pending-match branch, both for its orphan-sweep (J) and its " +
    "previously-untracked ownSweep/finalSweep/tmpSweep unattributed case (K). Genuinely corrupt " +
    "debris (never a real record) stays deletable once unreferenced, unchanged — see " +
    "merge-quarantine-clear-by-path.mjs's own (J)/(Z1)/(Z1-route), run standalone in the full suite. " +
    "Code Review 47289f8d (round 2): a TRUE, DIFFERENT-identity referencer correctly reaches " +
    "stillBlockedCoOccupants (the extension this round added) at clearMergeQuarantineByKey (L), " +
    "clearMergeQuarantineByRecordedPath (M), clearMergeQuarantineLatchFile's pending-match branch (N), " +
    "and clearTokenFromPendingIndices's own no-human-route console.warn (O) — none of them ever confuses " +
    "a DIFFERENT identity's real blocker with the SAME identity's own, still-in-progress twin (see " +
    "merge-quarantine-clear-by-path.mjs's own (AM) for that MAJOR self-reference fix)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
