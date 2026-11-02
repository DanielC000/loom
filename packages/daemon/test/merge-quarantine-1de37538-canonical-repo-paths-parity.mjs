import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 1de37538 — round 2, S1: the provider must share PASS 1's own registeredRepoPaths definition
// (computeCanonicalRepoPaths) — never db.listAllRegisteredRepoPaths() (also counts reserved/archived).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";
import { stripComments } from "./_strip-comments.mjs";

useOwnLoomHome("loom-mq1de375crp-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, "..", "dist");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distDir, "git", "merge-quarantine.js")).href;
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distDir, "git", "repo-lock.js")).href);
const { Db } = await import(pathToFileURL(path.join(distDir, "db.js")).href);
const { computeCanonicalRepoPaths } = await import(pathToFileURL(path.join(distDir, "projects", "canonical-repo-paths.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mq1de375crp@loom -c user.name=mq1de375crp";
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mq1de375crp-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-1de37538-canonical-repo-paths-parity (${tag})\n`);
  execSync(`git init -q && git config user.email mq1de375crp@loom && git config user.name mq1de375crp`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

function foldOrphanRefIntoOwnFinal(repoPath, againstModule) {
  const files = fs.readdirSync(againstModule.MERGE_QUARANTINE_DIR).filter((f) => f.endsWith(".json") && (() => {
    try { return JSON.parse(fs.readFileSync(path.join(againstModule.MERGE_QUARANTINE_DIR, f), "utf8")).repoPath === repoPath; } catch { return false; }
  })());
  const finalPath = path.join(againstModule.MERGE_QUARANTINE_DIR, files[0]);
  const orphanBasename = `${createHash("sha256").update(`${repoPath}-${freshSfx()}`).digest("hex").slice(0, 24)}.json`;
  const record = JSON.parse(fs.readFileSync(finalPath, "utf8"));
  record.orphanLatchFiles = [orphanBasename];
  fs.writeFileSync(finalPath, JSON.stringify(record));
  return orphanBasename;
}

function writeOrphanContent(orphanBasename, repoPath, branch, reason, tokens, againstModule, extra = {}) {
  fs.mkdirSync(againstModule.MERGE_QUARANTINE_DIR, { recursive: true });
  const orphanPath = path.join(againstModule.MERGE_QUARANTINE_DIR, orphanBasename);
  fs.writeFileSync(orphanPath, JSON.stringify({ repoPath, branch, reason, enteredAt: Date.now(), tokens, ...extra }));
  return orphanPath;
}

function setResolvedKeyOnOwnFinal(repoPath, resolvedKey, againstModule) {
  const files = fs.readdirSync(againstModule.MERGE_QUARANTINE_DIR).filter((f) => f.endsWith(".json") && (() => {
    try { return JSON.parse(fs.readFileSync(path.join(againstModule.MERGE_QUARANTINE_DIR, f), "utf8")).repoPath === repoPath; } catch { return false; }
  })());
  const finalPath = path.join(againstModule.MERGE_QUARANTINE_DIR, files[0]);
  const record = JSON.parse(fs.readFileSync(finalPath, "utf8"));
  record.resolvedKey = resolvedKey;
  fs.writeFileSync(finalPath, JSON.stringify(record));
}

try {
  const db = new Db();
  const now = new Date().toISOString();
  const V = makeRepo("v-archived");

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  // (A) UNIT LEVEL — the raw difference this card's S1 fix depends on: an ARCHIVED project's repo is
  // excluded from computeCanonicalRepoPaths (PASS 1's own list) but INCLUDED in
  // db.listAllRegisteredRepoPaths() (deliberately broader — live+reserved+archived, per that method's
  // own doc). The pre-S1 bug wired the provider to the latter.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  db.insertProject({ id: "pArchived", name: "Archived", repoPath: V, vaultPath: V, config: {}, createdAt: now, archivedAt: now, reserved: false });
  const canonical = computeCanonicalRepoPaths(db);
  const allRegistered = db.listAllRegisteredRepoPaths();
  check("(A) computeCanonicalRepoPaths EXCLUDES the archived project's repo", !canonical.includes(V));
  check("(A) db.listAllRegisteredRepoPaths INCLUDES the archived project's repo (deliberately broader — the OLD, wrong list for this purpose)", allRegistered.includes(V));

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  // (B) WIRING PIN — index.ts's own SOURCE TEXT: both the `canonicalRepoPaths` computation AND the
  // `setRegisteredRepoPathsProvider` call must reference `computeCanonicalRepoPaths`, never
  // `db.listAllRegisteredRepoPaths()` for the provider. Read SOURCE directly (never dist) and
  // COMMENT-STRIPPED first (via the shared `_strip-comments.mjs` helper, card `36afbbdd`) — an
  // unrelated comment near either call site mentioning `listAllRegisteredRepoPaths` (this file's OWN
  // real comment there does, by design — see the positive control right below) must never flip this
  // check either direction. Registered in `CHANGED_TS_TEXT_SCANNER_REPO_PATHS` (git/worktrees.ts) all
  // the same — stripping makes THIS check comment-robust, but a reduced gate must still re-run it
  // whenever `index.ts` changes at all, since the list's job is inclusion, not this check's robustness.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════

  // POSITIVE CONTROL for the stripping itself — prove it's doing real work, not a no-op. A synthetic
  // snippet shaped exactly like the hazard: a comment naming the forbidden call sitting INSIDE the
  // regex's own capture window, immediately before the closing `;`. Unstripped, this WOULD false-fail
  // (read "listAllRegisteredRepoPaths" and wrongly conclude the provider calls it); stripped, it must
  // read clean.
  const hazardSnippet = "setRegisteredRepoPathsProvider(() => computeCanonicalRepoPaths(db) /* never listAllRegisteredRepoPaths() */);";
  const unstrippedHazardMatch = hazardSnippet.match(/setRegisteredRepoPathsProvider\(([^;]+)\);/);
  check("(B, positive control) UNSTRIPPED, the hazard snippet's comment DOES leak into the match (proves the hazard is real, not hypothetical)", !!unstrippedHazardMatch?.[1]?.includes("listAllRegisteredRepoPaths"));
  const strippedHazardMatch = stripComments(hazardSnippet).match(/setRegisteredRepoPathsProvider\(([^;]+)\);/);
  check("(B, positive control) STRIPPED, the SAME hazard snippet no longer shows the forbidden name — stripComments() is doing real work here, not a no-op", !strippedHazardMatch?.[1]?.includes("listAllRegisteredRepoPaths"));
  check("(B, positive control) STRIPPED, the real call is still found and intact", !!strippedHazardMatch?.[1]?.includes("computeCanonicalRepoPaths(db)"));

  const indexSrc = stripComments(fs.readFileSync(path.join(__dirname, "..", "src", "index.ts"), "utf8"));
  const canonicalAssignMatch = indexSrc.match(/const canonicalRepoPaths = ([^;]+);/);
  const providerCallMatch = indexSrc.match(/setRegisteredRepoPathsProvider\(([^;]+)\);/);
  check("(B) index.ts's own `canonicalRepoPaths` assignment is found", !!canonicalAssignMatch);
  check("(B) `canonicalRepoPaths` is computed via computeCanonicalRepoPaths(db)", !!canonicalAssignMatch?.[1]?.includes("computeCanonicalRepoPaths(db)"));
  check("(B) index.ts's own `setRegisteredRepoPathsProvider` call is found", !!providerCallMatch);
  check("(B) the provider calls computeCanonicalRepoPaths(db) — NEVER db.listAllRegisteredRepoPaths()", !!providerCallMatch?.[1]?.includes("computeCanonicalRepoPaths(db)") && !providerCallMatch?.[1]?.includes("listAllRegisteredRepoPaths"));

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  // (C) INTEGRATION LEVEL — the card's own named shape (U dual-armed [keyU,keyV], A the clearer, T an
  // unresolvable ghost colliding at keyV) with V the ARCHIVED project's repo from (A). Wiring the
  // provider to the REAL computeCanonicalRepoPaths(db) (the fix) must agree with a real reboot passed
  // the IDENTICAL real list — both FALSE, since V is excluded from both. State derived entirely from
  // real raises/boots/clears — never a hand-set derived field.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  const keyV = canonicalRepoLockKey(V);
  const U = makeRepo("u");
  const A = makeRepo("a");
  const providerFn = () => computeCanonicalRepoPaths(db);

  const mod = await freshBootModule();
  mod.setRegisteredRepoPathsProvider(providerFn);
  const tU = mod.enterMergeQuarantine(U, "loom/u-branch", "merge in progress for U (1de37538 canonical-repo-paths parity)");
  setResolvedKeyOnOwnFinal(U, keyV, mod);

  const booted = await freshBootModule();
  booted.setRegisteredRepoPathsProvider(providerFn);
  booted.reenterMergeQuarantinesAtBoot(computeCanonicalRepoPaths(db));
  check("(C) U's secondary arm at keyV landed at boot", booted.stillBlockedEntryFor(V)?.repoPath === U);

  const tA = booted.enterMergeQuarantine(A, "loom/a-branch", "merge in progress for A (1de37538 canonical-repo-paths parity clearer)");
  const orphanBasename = foldOrphanRefIntoOwnFinal(A, booted);

  const booted2 = await freshBootModule();
  booted2.setRegisteredRepoPathsProvider(providerFn);
  booted2.reenterMergeQuarantinesAtBoot(computeCanonicalRepoPaths(db));

  const T = path.join(os.tmpdir(), `loom-mq1de375crp-t-never-exists-UNRELATED-${freshSfx()}`);
  const tF = randomUUID();
  writeOrphanContent(orphanBasename, T, "loom/t-branch", "merge in progress for T (1de37538 canonical-repo-paths parity, ghost colliding with an ARCHIVED project's repo)", [tF], booted2, { resolvedKey: keyV });
  booted2.clearMergeQuarantineByToken(A, tA);

  const inProcessEntry = booted2.stillBlockedEntryFor(V);
  check("(C) occupant at keyV carries both tokens in-process (the union landed)", !!inProcessEntry && inProcessEntry.tokens.includes(tU) && inProcessEntry.tokens.includes(tF));
  const inProcessValue = !!inProcessEntry?.provenanceUnknown;

  const fresh = await freshBootModule();
  fresh.reenterMergeQuarantinesAtBoot(computeCanonicalRepoPaths(db));
  const rebootEntry = fresh.stillBlockedEntryFor(V);
  const rebootValue = !!rebootEntry?.provenanceUnknown;

  console.log(`(C) in-process=${inProcessValue} reboot=${rebootValue} (V is an ARCHIVED project's repo)`);
  check("(C) in-process provenanceUnknown is FALSE — V is excluded from the real canonical list (archived)", inProcessValue === false);
  check("(C) *** PARITY, ARCHIVED SHAPE *** in-process === reboot (both FALSE) using the REAL shared helper on both legs", inProcessValue === rebootValue && rebootValue === false);

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  // (D) ILLUSTRATIVE — the SAME construction, but the provider wired to the OLD, wrong list
  // (db.listAllRegisteredRepoPaths(), which includes archived V) instead of the fix. Shows the exact
  // mismatch the S1 finding named: in-process TRUE (archived V IS in this list) vs reboot FALSE
  // (reboot always uses the real, narrower canonicalRepoPaths — unaffected by this scenario's own
  // provider choice). Always green (illustrates WHY the choice matters) — not itself a RED/GREEN
  // discriminator against a reverted index.ts; (B) above is.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  // A SEPARATE V2/keyV2 — never reuse (C)'s own V/keyV here: by the time (C) finishes, its own final
  // reboot has durably persisted U's dual-arm to a REAL on-disk latch file at keyV's own hash (the
  // MERGE_QUARANTINE_DIR is shared across this whole file's one useOwnLoomHome() scope), so reusing
  // keyV here would have (D)'s own U2 collide with (C)'s already-written content instead of a free key.
  const V2 = makeRepo("v2-archived");
  db.insertProject({ id: "pArchived2", name: "Archived2", repoPath: V2, vaultPath: V2, config: {}, createdAt: now, archivedAt: now, reserved: false });
  const keyV2 = canonicalRepoLockKey(V2);
  const U2 = makeRepo("u2");
  const A2 = makeRepo("a2");
  const oldWrongProviderFn = () => db.listAllRegisteredRepoPaths();

  const modD = await freshBootModule();
  modD.setRegisteredRepoPathsProvider(oldWrongProviderFn);
  const tU2 = modD.enterMergeQuarantine(U2, "loom/u2-branch", "merge in progress for U2 (1de37538 illustrative old-wrong-list)");
  setResolvedKeyOnOwnFinal(U2, keyV2, modD);

  const bootedD = await freshBootModule();
  bootedD.setRegisteredRepoPathsProvider(oldWrongProviderFn);
  bootedD.reenterMergeQuarantinesAtBoot(computeCanonicalRepoPaths(db));
  check("(D) U2's secondary arm at keyV2 landed at boot", bootedD.stillBlockedEntryFor(V2)?.repoPath === U2);

  const tA2 = bootedD.enterMergeQuarantine(A2, "loom/a2-branch", "merge in progress for A2 (1de37538 illustrative clearer)");
  const orphanBasename2 = foldOrphanRefIntoOwnFinal(A2, bootedD);

  const booted2D = await freshBootModule();
  booted2D.setRegisteredRepoPathsProvider(oldWrongProviderFn);
  booted2D.reenterMergeQuarantinesAtBoot(computeCanonicalRepoPaths(db));

  const T2 = path.join(os.tmpdir(), `loom-mq1de375crp-t2-never-exists-UNRELATED-${freshSfx()}`);
  const tF2 = randomUUID();
  writeOrphanContent(orphanBasename2, T2, "loom/t2-branch", "merge in progress for T2 (1de37538 illustrative)", [tF2], booted2D, { resolvedKey: keyV2 });
  booted2D.clearMergeQuarantineByToken(A2, tA2);

  const inProcessEntryD = booted2D.stillBlockedEntryFor(V2);
  check("(D) occupant at keyV2 carries both tokens in-process", !!inProcessEntryD && inProcessEntryD.tokens.includes(tU2) && inProcessEntryD.tokens.includes(tF2));
  const inProcessValueD = !!inProcessEntryD?.provenanceUnknown;

  const freshD = await freshBootModule();
  freshD.reenterMergeQuarantinesAtBoot(computeCanonicalRepoPaths(db));
  const rebootValueD = !!freshD.stillBlockedEntryFor(V2)?.provenanceUnknown;

  console.log(`(D) in-process=${inProcessValueD} reboot=${rebootValueD} (illustrative: provider wired to the OLD, wrong db.listAllRegisteredRepoPaths())`);
  check("(D) ILLUSTRATIVE MISMATCH: wiring the provider to the old, wrong list reproduces the S1 divergence (in-process TRUE, reboot FALSE) — this is what S1 found, and what (C)'s real fix avoids", inProcessValueD === true && rebootValueD === false);

  db.close();
} finally {
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
}
process.exit(failures === 0 ? 0 : 1);
