import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 24ed371f — a settled contributor's own clear must never re-open 3b1944b6's own scenario-B
// ancestor-collapse lift against its (still-quarantined) host. See the decision record in full.
//
// Card 24ed371f asked whether a settling contributor token (clearMergeQuarantineByToken) should drop the
// settled identity out of its host union's `contributorRepoPaths` (so a LATER `/clear(identity)` would
// reach `clearMergeQuarantine`'s scenario-B ancestor-collapse clear again), or whether the existing sticky
// refuse (routing back to the idempotent `reduceForeignUnionContributor` arm via `reducedContributorRepoPaths`,
// never scenario B) is the intended behavior. Lead ruling: (b) — the sticky refuse is intended. Proof: the
// moment an entry's own `tokens` array empties, `clearActiveEntryTokenAtKey` deletes the WHOLE entry (see
// merge-quarantine.ts ~:4134-4160) — so a union that still EXISTS after one contributor's own token settles
// always holds someone ELSE's live token (the host's own, or another contributor's). "This contributor now
// holds zero remaining tokens" can therefore never by itself prove scenario B's unconditional full lift is
// safe for that union — re-enabling it would recreate 3b1944b6's own wrong release the next time anyone
// calls `/clear(identity)`, just reached via a settle instead of a stale key. This file PINS that: it
// never touches src, it only proves the current (sticky) behavior is correct. The negative-control RED
// proof for this invariant was done manually (mutate dist, run, restore, verify by sha256) and is NOT part
// of this committed suite — a gate runs several lanes against ONE worktree's shared `dist/`, so mutating a
// shared compiled file mid-run would make a sibling lane's own import of that file run broken code. See
// the decision record's own "RED proof" line for the before/after output and shas.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-mq24ed371f-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleUrl = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  enterMergeQuarantine, activeMergeQuarantineFor, listActiveMergeQuarantines, clearMergeQuarantineReporting,
  clearMergeQuarantineByToken, assertRepoNotQuarantined, directPathIdentity, MERGE_QUARANTINE_DIR,
} = await import(mergeQuarantineModuleUrl);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
function freshDir(tag) {
  const d = path.join(os.tmpdir(), `loom-mq24ed371f-${tag}-${sfx}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function markAsGitRoot(dir) { fs.mkdirSync(path.join(dir, ".git"), { recursive: true }); }
function hashKey(key) { return createHash("sha256").update(key).digest("hex").slice(0, 24); }
function finalPathFor(repoPath) { return path.join(MERGE_QUARANTINE_DIR, `${hashKey(canonicalRepoLockKey(repoPath))}.json`); }
function readLatchFileIfExists(repoPath) {
  try { return JSON.parse(fs.readFileSync(finalPathFor(repoPath), "utf8")); } catch { return null; }
}
function contributorsOf(snapshot) { return snapshot?.contributorRepoPaths ?? []; }
function reducedContributorsOf(snapshot) { return snapshot?.reducedContributorRepoPaths ?? []; }

// ===================== (i) a settled contributor's OWN clear must never lift its still-quarantined host =====================
let chainedR, chainedRToken;
{
  const R = freshDir("i-R");
  markAsGitRoot(R);
  const rToken = enterMergeQuarantine(R, "branch-R", "R's own real raise (i-contrib-settle-refuses)");

  const S = path.join(R, "sub"); // no .git of its own — collapses onto R's key, folds in as a contributor
  fs.mkdirSync(S, { recursive: true });
  const sToken = enterMergeQuarantine(S, "branch-S", "S's own contributor raise, no .git ever (i-contrib-settle-refuses)");

  check("(i precondition) S is folded into R's union as a contributor", contributorsOf(activeMergeQuarantineFor(R)).some((c) => directPathIdentity(c) === directPathIdentity(S)));
  check("(i precondition) S has NO independent record of its own anywhere", listActiveMergeQuarantines().filter((e) => e.repoPath === S).length === 0);
  check("(i precondition) R's own token is present before any settle", activeMergeQuarantineFor(R).tokens.includes(rToken));
  check("(i precondition) R's union holds both tokens before any settle", activeMergeQuarantineFor(R).tokens.length === 2);

  clearMergeQuarantineByToken(S, sToken); // S's merge settles — tokens 2 -> 1, per the card's own framing

  const postSettle = activeMergeQuarantineFor(R);
  check("(i postcondition) R's union SURVIVES the settle (its own token is still outstanding)", !!postSettle && postSettle.tokens.includes(rToken));
  check("(i postcondition) R's union now holds exactly ONE token (S's contributor token is gone)", postSettle?.tokens.length === 1);
  check("(i postcondition) S STAYS listed in R's contributorRepoPaths — clearMergeQuarantineByToken never touches membership", contributorsOf(postSettle).some((c) => directPathIdentity(c) === directPathIdentity(S)));
  check("(i postcondition) S still reads as quarantined (via its host)", assertRepoNotQuarantined(S).ok === false);

  const result = clearMergeQuarantineReporting(S); // the real /clear(S) entry point — never the inner function directly (lesson 249)
  console.log(`(i) clearMergeQuarantineReporting(S) after settle -> ${JSON.stringify(result)}`);
  const liftedIdentities = new Set(result.liftedRepoPaths.map((rp) => directPathIdentity(rp)));
  check("*** THE PIN (i) *** /clear(S) NEVER lifts R — no scenario-B ancestor-collapse", !liftedIdentities.has(directPathIdentity(R)));
  check("*** THE PIN (i) *** R's own, still-outstanding quarantine survives", !!activeMergeQuarantineFor(R));
  check("*** THE PIN (i) *** assertRepoNotQuarantined(R).ok stays FALSE", assertRepoNotQuarantined(R).ok === false);
  check("(i) the clear reports SOMETHING happened — never a silent no-op", result.wasQuarantined === true);
  check("(i) S is durably moved to reducedContributorRepoPaths (the idempotent reduce arm, not scenario B)", reducedContributorsOf(readLatchFileIfExists(R)).includes(directPathIdentity(S)));

  chainedR = R;
  chainedRToken = rToken;
}

// ===================== (ii) CONTROL — once R's OWN token also settles, both S and R read genuinely clear =====================
{
  const R = chainedR;
  clearMergeQuarantineByToken(R, chainedRToken); // R's own, last remaining token settles -> tokens empty -> whole entry destroyed

  check("*** CONTROL (ii) *** the whole union is gone once its last token settles", !activeMergeQuarantineFor(R));
  check("*** CONTROL (ii) *** assertRepoNotQuarantined(R).ok is now TRUE", assertRepoNotQuarantined(R).ok === true);
  check("*** CONTROL (ii) *** assertRepoNotQuarantined(S's own path).ok is now TRUE too", assertRepoNotQuarantined(path.join(R, "sub")).ok === true);
  check("(ii) no latch file remains for R's own key", !fs.existsSync(finalPathFor(R)));
}

// ===================== (iii) CONTROL — a genuine never-contributor still reaches scenario B, as designed =====================
{
  const R2 = freshDir("iii-R2");
  markAsGitRoot(R2);
  enterMergeQuarantine(R2, "branch-R2", "R2's own real raise (iii-never-contributor)");

  const plain = path.join(R2, "plain"); // never raised, no .git, no fold — a genuinely bare ancestor-collapse subdir
  fs.mkdirSync(plain, { recursive: true });
  check("(iii precondition) plain was never a contributor of R2's union", !contributorsOf(activeMergeQuarantineFor(R2)).some((c) => directPathIdentity(c) === directPathIdentity(plain)));
  check("(iii precondition) plain's fresh key collapses onto R2's own", canonicalRepoLockKey(plain) === canonicalRepoLockKey(R2));

  const result = clearMergeQuarantineReporting(plain);
  const liftedIdentities = new Set(result.liftedRepoPaths.map((rp) => directPathIdentity(rp)));
  check("*** CONTROL (iii) *** /clear(plain) DOES reach scenario B and fully lifts R2 — this is the legitimate, deliberate ancestor-collapse abccee85 documents", liftedIdentities.has(directPathIdentity(R2)));
  check("(iii) R2 reads genuinely clear afterward", assertRepoNotQuarantined(R2).ok === true);
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
