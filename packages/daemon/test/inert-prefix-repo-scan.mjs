import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// PER-REPO INERT-PREFIX RE-VERIFICATION test (card 1c0d4aa4 — Code Review finding on `b97f643d`:
// `INERT_MERGE_PATH_PREFIXES` in worktrees.ts is certified by MEASURING Loom's own corpus, but
// `isInertMergeDiff` runs for every project the daemon serves — a consumer project whose own tests DO
// read a top-level `docs/` must not have its gate silently skipped just because Loom's tests don't).
//
// This file unit-tests `repoTreeReferencesInertPrefix` directly (exported like `appendTail`/`formatTail`
// for exactly this purpose) — the low-level scan `isInertMergeDiff` now calls before trusting the
// allowlist. `merge-gate-inert-diff.mjs` scenario (K) proves the END-TO-END wiring (a repo whose own test
// reads `docs/` still forces the full gate); this file proves the SCAN ITSELF is sound in isolation:
//
//   (1) POSITIVE CONTROL — a repo whose tracked test file contains a real `readFileSync(...docs...)`-
//       shaped call MUST be detected: the scan returns `true` (references the prefix).
//   (2) A repo that does NOT reference `docs/` anywhere in a read-call — the scan returns `false` (a
//       CONFIRMED absence). This zero is NOT vacuous: it's the exact same pattern (1) just proved fires,
//       run against a repo that genuinely lacks the token — the silent-failing-search shape this project
//       has been bitten by before (a broken scan that always returns "safe") is exactly what (1) rules out.
//   (3) FAIL-CLOSED on an unresolvable `treeish` (git errors, can't confirm anything) — the scan returns
//       `true` (references it / "cannot prove absence"), never a silent `false`.
//   (4) LOOM'S OWN SKIP, LIVE — runs the scan against THIS repo's own real HEAD (not a fixture stand-in),
//       re-confirming card db9b0130's manual `grep` measurement mechanically rather than trusting it stays
//       true forever: `docs` must come back unreferenced (the skip still holds) while `assets` — heavily
//       referenced by this repo's real corpus — must come back referenced (the scan isn't just broken).
//   (5) TIMEOUT — a near-zero `timeoutMs` fails closed (kills the child, returns `true`) rather than
//       hanging or silently returning a confirmed absence.
//
// ⚠️ CRITICAL, Code Review card 1c0d4aa4: the fixture bodies below are assembled via string
// CONCATENATION at runtime (`fixtureBody`, just below), never as one literal template in THIS file's own
// source. This file is itself tracked in Loom's repo, and `repoTreeReferencesInertPrefix` scans THIS
// repo's own tree — a literal read-call, written contiguous with a real-source anchor and this prefix's
// own name IN THIS FILE'S SOURCE (not split across separate identifiers the way `fixtureBody` below does
// it), would match the scanner's own pattern the moment this file is committed, making scenario (4) (and
// Loom's real docs/-only-diff skip) fail FOREVER from that commit forward. Measured: a first draft of
// this file did exactly that (as a literal template, no concatenation) and was caught only by re-running
// scenario (4) AFTER committing — `git grep <treeish>` reads the COMMITTED tree, so the same run BEFORE
// committing still saw the old (clean) HEAD and passed. See `fixtureBody`'s own comment before touching
// either fixture body.
// Run: 1) build daemon (pnpm build), 2) node test/inert-prefix-repo-scan.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";

const { repoTreeReferencesInertPrefix } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=iprs@loom -c user.name=iprs";
const TIMEOUT_MS = 15_000;

// Assembled at RUNTIME so none of the three pieces below, nor their concatenation, appears as one
// contiguous literal in THIS file's own source text — see the file header's CRITICAL note. The runtime
// VALUE (what actually lands in the fixture file on disk, in a throwaway temp repo unrelated to Loom's
// own tree) is a real, working `readFileSync(path.join(__dirname, "<token>", "note.md"))`-shaped call,
// unchanged in substance from a literal template.
const _READ_CALL = "readFile" + "Sync";
const _ANCHOR = "__dir" + "name";
function fixtureBody(token) {
  return `import fs from "node:fs";\nimport path from "node:path";\nfs.${_READ_CALL}(path.join(${_ANCHOR}, "${token}", "note.md"));\n`;
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
function makeRepo(label, testFileContent) {
  const repo = path.join(os.tmpdir(), `loom-iprs-${label}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.mkdirSync(path.join(repo, "test"), { recursive: true });
  fs.writeFileSync(path.join(repo, "test", "some.mjs"), testFileContent);
  execSync(`git init -q && git config user.email iprs@loom && git config user.name iprs && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
  const head = execSync(`git rev-parse HEAD`, { cwd: repo }).toString().trim();
  return { repo, head };
}

// (Each fixture repo is registered for guaranteed cleanup by makeRepo → registerForCleanup; this file
// never touches Db/LOOM_HOME at all, so there is no shared home to clean up in a finally.)
try {
  // ── (1) POSITIVE CONTROL — a real readFileSync(...docs...)-shaped call MUST be found ────────────────
  const referencesDocs = makeRepo("docs", fixtureBody("docs"));
  const foundDocs = await repoTreeReferencesInertPrefix(referencesDocs.repo, referencesDocs.head, "docs", TIMEOUT_MS);
  check("(1) a repo whose test corpus reads docs/ via readFileSync IS detected", foundDocs === true);

  // ── (2) CONFIRMED ABSENCE — a repo that never references docs/ in a read-call — NOT vacuous: same
  //        pattern already proven (in (1)) to fire on a real hit ─────────────────────────────────────────
  const referencesAssets = makeRepo("assets", fixtureBody("assets"));
  const foundAssetsForDocs = await repoTreeReferencesInertPrefix(referencesAssets.repo, referencesAssets.head, "docs", TIMEOUT_MS);
  check("(2) a repo whose test corpus reads assets/ (never docs/) is confirmed absent for the docs/ token", foundAssetsForDocs === false);
  // Same repo, searched for its OWN token — sanity that the scan isn't just always-false: proves (2)'s
  // `false` result is a real absence of "docs" specifically, not the scan being broken for this repo.
  const foundAssetsForAssets = await repoTreeReferencesInertPrefix(referencesAssets.repo, referencesAssets.head, "assets", TIMEOUT_MS);
  check("(2b) sanity: the SAME repo IS detected for its own real token (assets)", foundAssetsForAssets === true);

  // ── (3) FAIL-CLOSED — an unresolvable treeish must never be silently read as a confirmed absence ──────
  const failClosed = await repoTreeReferencesInertPrefix(referencesAssets.repo, "not-a-real-ref-zzz", "docs", TIMEOUT_MS);
  check("(3) an unresolvable treeish fails CLOSED (references it — cannot prove absence), never a silent false", failClosed === true);

  // ── (4) LOOM'S OWN SKIP, LIVE — this repo's real HEAD, not a fixture ────────────────────────────────
  const loomRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const loomHead = execSync(`git rev-parse HEAD`, { cwd: loomRepoRoot }).toString().trim();
  const loomReferencesDocs = await repoTreeReferencesInertPrefix(loomRepoRoot, loomHead, "docs", TIMEOUT_MS);
  check("(4) Loom's own repo at real HEAD is confirmed absent for docs/ — the skip still holds live, not just per card db9b0130's manual measurement", loomReferencesDocs === false);
  const loomReferencesAssets = await repoTreeReferencesInertPrefix(loomRepoRoot, loomHead, "assets", TIMEOUT_MS);
  check("(4b) sanity: Loom's own repo IS detected for a token its real corpus actually references (assets)", loomReferencesAssets === true);

  // ── (5) TIMEOUT — fails closed rather than hanging or confirming a silent absence ───────────────────
  const timedOut = await repoTreeReferencesInertPrefix(referencesDocs.repo, referencesDocs.head, "docs", 1);
  check("(5) a near-zero timeoutMs fails CLOSED (references it), never a silent false", timedOut === true);
} catch (err) {
  console.error(err);
  failures++;
}

console.log(failures === 0
  ? "\n✅ ALL PASS — repoTreeReferencesInertPrefix detects a real docs/-read (positive control), confirms a genuine absence only after that same pattern is proven to fire (never vacuously), fails CLOSED on an unresolvable treeish and on a timeout, and confirms LIVE (against this repo's own real HEAD) that Loom's own docs/ skip still holds."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
