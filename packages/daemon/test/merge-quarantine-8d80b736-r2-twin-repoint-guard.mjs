import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 8d80b736, Round 2 (lead triage, gen 463, item 1) — a triple fault at any of the 3 raise-side
// "keep the stranded tmp" branches (mergeTokenIntoPendingEntries, mintPendingDivert, divertRaiseEntry)
// pushed a NEW `kept` object into pendingUnresolvedQuarantines while `activeQuarantines` still pointed at
// the pre-tmp `merged`/`toWrite` object -- splitting a dual-tracked twin into two same-identity objects
// (the stale-copy shape d4b25feb round 3 forbids). Fixed by adding a `replaceEntryEverywhere` call at
// each site, mirroring the sibling double-fault `secured` branch's own call.
//
// This file proves "exactly ONE object after the triple fault" at ALL THREE sites, using the module's
// own structural invariant (`assertQuarantineIdentityInvariantTestOnly`) rather than a resolve-aware
// query (`activeMergeQuarantineFor` self-heals a split -- decision 59e758e5's own "Do not"), plus
// `stillBlockedEntryFor` (a pure peek) to confirm the SAME object is discoverable from both sides.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-8d80b736-r2-twin-repoint-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-mq8d80b736r2-", { fresh: true });
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  MERGE_QUARANTINE_DIR, enterMergeQuarantine, clearMergeQuarantineByToken,
  setActiveQuarantineTestOnly, pushPendingQuarantineTestOnly, markLatchFileUnreadableTestOnly,
  assertQuarantineIdentityInvariantTestOnly, stillBlockedEntryFor,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mq8d80b736r2@loom -c user.name=mq8d80b736r2";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeToplevelRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mq8d80b736r2-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-8d80b736-r2 (${tag})\n`);
  execSync(`git init -q && git config user.email mq8d80b736r2@loom && git config user.name mq8d80b736r2`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

function quarantineHashForKeyTest(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

// Fails EVERY read of `targetPath` with `code` (used to force resolveRaiseOverwrite's own read into its
// non-ENOENT "divert" branch).
function injectPersistentReadFailure(targetPath, code = "EACCES") {
  const real = fs.readFileSync;
  fs.readFileSync = (p, ...rest) => {
    if (typeof p === "string" && p === targetPath) throw Object.assign(new Error(`${code}: simulated read failure`), { code });
    return real(p, ...rest);
  };
  return { restore: () => { fs.readFileSync = real; } };
}

// Fails EVERY `fs.openSync` call targeting a path inside MERGE_QUARANTINE_DIR -- a genuine triple fault:
// the primary pending-divert write's own tmp AND the safety-tmp fallback's own write both live there.
function injectBlanketQuarantineDirOpenFailure(code = "ENOSPC") {
  const real = fs.openSync;
  fs.openSync = (p, ...rest) => {
    if (typeof p === "string" && path.dirname(p) === MERGE_QUARANTINE_DIR) {
      throw Object.assign(new Error(`${code}: simulated disk-full`), { code });
    }
    return real(p, ...rest);
  };
  return { restore: () => { fs.openSync = real; } };
}

function violationsFor(repoPath) {
  const { violations } = assertQuarantineIdentityInvariantTestOnly();
  return violations.filter((v) => v.includes(`'${repoPath}'`));
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// SITE 1 -- mergeTokenIntoPendingEntries: reached via enterMergeQuarantine's own `!verified` pending-
// match branch. `d` is never resolvable, so a dual-tracked twin here is armed under an arbitrary key AND
// referenced from pendingUnresolvedQuarantines, by the SAME object.
// ════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const d = path.join(os.tmpdir(), `loom-mq8d80b736r2-site1-d-nonexistent-${freshSfx()}`);
  const Ks = `site1-arbitrary-key-${freshSfx()}`;
  const twin = { repoPath: d, branch: "d-branch-0", reason: "site1 precondition", enteredAt: Date.now(), tokens: ["tok0-site1"], resolvedKey: Ks, armedKeys: [Ks] };
  setActiveQuarantineTestOnly(Ks, twin);
  pushPendingQuarantineTestOnly(twin, "pending-site1-fixture.json");

  const openGuard = injectBlanketQuarantineDirOpenFailure();
  let extraToken;
  try {
    extraToken = enterMergeQuarantine(d, "d-branch-1", "site1 triple-fault raise");
  } finally {
    openGuard.restore();
  }

  check("(site1) no structural violation after the triple-fault raise (exactly one object for d)",
    violationsFor(d).length === 0);
  const blocked = stillBlockedEntryFor(d);
  check("(site1) stillBlockedEntryFor(d) is defined and carries BOTH the original and extra tokens",
    !!blocked && new Set(blocked.tokens).has("tok0-site1") && new Set(blocked.tokens).has(extraToken));

  clearMergeQuarantineByToken(d, "tok0-site1");
  clearMergeQuarantineByToken(d, extraToken);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// SITE 2 -- mintPendingDivert: reached via enterMergeQuarantine's own `existing` branch when
// `resolveRaiseOverwrite` forces a divert (`mustDivert`) and `divertRaiseEntry` finds NO pre-existing
// pending match (`indices.length === 0`) -- the "already armed, about to be minted into pending for the
// first time" shape `mintPendingDivert`'s own doc comment names.
// ════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const v = makeToplevelRepo("site2");
  const Kv = canonicalRepoLockKey(v);
  const finalForKv = path.join(MERGE_QUARANTINE_DIR, `${quarantineHashForKeyTest(Kv)}.json`);
  const entry0 = { repoPath: v, branch: "b0", reason: "site2 precondition", enteredAt: Date.now(), tokens: ["tok0-site2"], resolvedKey: Kv, armedKeys: [Kv] };
  setActiveQuarantineTestOnly(Kv, entry0);
  markLatchFileUnreadableTestOnly(path.basename(finalForKv));

  const readGuard = injectPersistentReadFailure(finalForKv, "EACCES");
  const openGuard = injectBlanketQuarantineDirOpenFailure();
  let extraToken;
  try {
    extraToken = enterMergeQuarantine(v, "b1", "site2 triple-fault raise");
  } finally {
    openGuard.restore();
    readGuard.restore();
  }

  check("(site2) no structural violation after the triple-fault raise (exactly one object for v)",
    violationsFor(v).length === 0);
  const blocked = stillBlockedEntryFor(v);
  check("(site2) stillBlockedEntryFor(v) is defined and carries BOTH the original and extra tokens",
    !!blocked && new Set(blocked.tokens).has("tok0-site2") && new Set(blocked.tokens).has(extraToken));

  clearMergeQuarantineByToken(v, "tok0-site2");
  clearMergeQuarantineByToken(v, extraToken);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// SITE 3 -- divertRaiseEntry's OWN `indices.length > 0` branch: the SAME `mustDivert` trigger as site 2,
// but with a pre-existing pending match sharing the SAME object as the active side -- a genuine
// dual-tracked twin reached through the VERIFIED `existing` path.
// ════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const v = makeToplevelRepo("site3");
  const Kv = canonicalRepoLockKey(v);
  const finalForKv = path.join(MERGE_QUARANTINE_DIR, `${quarantineHashForKeyTest(Kv)}.json`);
  const twin = { repoPath: v, branch: "b0", reason: "site3 precondition", enteredAt: Date.now(), tokens: ["tok0-site3"], resolvedKey: Kv, armedKeys: [Kv] };
  setActiveQuarantineTestOnly(Kv, twin);
  pushPendingQuarantineTestOnly(twin, "pending-site3-fixture.json");
  markLatchFileUnreadableTestOnly(path.basename(finalForKv));

  const readGuard = injectPersistentReadFailure(finalForKv, "EACCES");
  const openGuard = injectBlanketQuarantineDirOpenFailure();
  let extraToken;
  try {
    extraToken = enterMergeQuarantine(v, "b1", "site3 triple-fault raise");
  } finally {
    openGuard.restore();
    readGuard.restore();
  }

  check("(site3) no structural violation after the triple-fault raise (exactly one object for v)",
    violationsFor(v).length === 0);
  const blocked = stillBlockedEntryFor(v);
  check("(site3) stillBlockedEntryFor(v) is defined and carries BOTH the original and extra tokens",
    !!blocked && new Set(blocked.tokens).has("tok0-site3") && new Set(blocked.tokens).has(extraToken));

  clearMergeQuarantineByToken(v, "tok0-site3");
  clearMergeQuarantineByToken(v, extraToken);
}

for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }

if (failures > 0) {
  console.log(`\n❌ ${failures} FAILURE(S).`);
  process.exit(1);
} else {
  console.log("\n✅ all checks passed.");
}
