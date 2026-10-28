import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 0d3b64c6 (round-3 Code Review of 8bc779f0, reviewer a25e852d) found TWO fail-CLOSED regressions
// in 8bc779f0's own round-3 identity-scoped `clearedTokens` redesign — each leaves a repo quarantined
// after a human clears every one of its genuinely-outstanding tokens, where the pre-round-3 code (54e60408)
// correctly lifted it. See docs/decisions/0d3b64c6-cross-identity-tombstone-and-identity-drift.md.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-0d3b64c6-sf1-sf2-tombstone-scope.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome, registerForCleanup } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq0d3b64-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  MERGE_QUARANTINE_DIR, enterMergeQuarantine, clearMergeQuarantineByToken,
  setActiveQuarantineTestOnly, markLatchFileUnreadableTestOnly, listActiveMergeQuarantines,
  PLACEHOLDER_BRANCH_UNREADABLE, activeMergeQuarantineFor, directPathIdentity,
  clearMergeQuarantineReporting, clearMergeQuarantineByRecordedPath, clearMergeQuarantineByKey,
  clearMergeQuarantineLatchFile, pushPendingQuarantineTestOnly,
  classifyLiteralGateFromFs, LITERAL_GATE_WALK_MAX_STEPS,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const note = (label) => console.log(`NOTE  ${label}`);
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const hashForKey = (k) => createHash("sha256").update(k).digest("hex").slice(0, 24);

/**
 * Best-effort creates a real junction at `link` pointing at `target` via a `\\?\Volume{GUID}\...`-spelled
 * path (the shape Code Review `6ef22315` found invisible to libuv's own link detection) — `mklink /J`
 * accepts this spelling without admin rights. Returns `{ok:true}` on success, or `{ok:false, reason}` if
 * `mountvol`/`mklink` are unavailable or fail in this environment — callers MUST skip (never fail
 * vacuously) when `ok` is false, per the standing "prove a check can fail" discipline: a host where this
 * can't be constructed at all gives no signal either way.
 */
function tryVolumeGuidJunction(link, target) {
  try {
    const driveLetter = target.slice(0, 2); // e.g. "C:"
    const vol = execFileSync("mountvol", [driveLetter, "/L"], { encoding: "utf8" }).trim();
    if (!/^\\\\\?\\Volume\{/i.test(vol)) return { ok: false, reason: `unexpected mountvol output: ${vol}` };
    const volTarget = vol + target.slice(driveLetter.length + 1); // strip "C:\" (drive letter + its own backslash)
    execFileSync("cmd.exe", ["/c", "mklink", "/J", link, volTarget], { encoding: "utf8" });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || String(e) };
  }
}

fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

function freshRepo(tag) {
  const p = path.join(os.tmpdir(), `loom-mq0d3b64-${tag}-${freshSfx()}`);
  fs.mkdirSync(p, { recursive: true });
  registerForCleanup(p);
  return p;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 1 (SF1) — a token bled into TWO active identities' own records (398f476c/f575cebf): clearing
// it by token, across both holders in one call, must tombstone it under BOTH identities even though at
// the moment the FIRST holder's own in-memory removal happens the SECOND holder still (genuinely) holds
// it. Reproduced via a durable-write FAILURE (ENOSPC) on the first holder's own final, forcing its stale
// pre-clear bytes to survive until a later reconcile — the exact shape that exposed the bug (the scan in
// `tombstoneIfNotSurviving` saw the second holder still live and skipped tombstoning the first holder's
// own release entirely). RED on pre-fix code (X stays quarantined forever); GREEN after.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const x = freshRepo("s1-x");
  const kx = canonicalRepoLockKey(x);
  const finX = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kx)}.json`);
  const yy = freshRepo("s1-y");
  const ky = canonicalRepoLockKey(yy);

  const synth = `s1-synth-${freshSfx()}`;
  const t2 = `s1-t2-${freshSfx()}`;
  const xTok = `s1-xtok-${freshSfx()}`;
  const yTok = `s1-ytok-${freshSfx()}`;

  setActiveQuarantineTestOnly(kx, { repoPath: x, branch: "s1-xb", reason: "s1-x", enteredAt: Date.now() - 1e5, tokens: [synth, t2, xTok], armedKeys: [kx] });
  setActiveQuarantineTestOnly(ky, { repoPath: yy, branch: "s1-yb", reason: "s1-y", enteredAt: Date.now() - 1e5, tokens: [yTok, xTok], armedKeys: [ky] });
  fs.writeFileSync(finX, JSON.stringify({ repoPath: x, branch: "s1-xb", reason: "s1-x", enteredAt: Date.now() - 1e5, tokens: [synth, t2, xTok] }, null, 2) + "\n");
  check("(s1 precondition) Y still holds xTok (the bled token) before any clear", (listActiveMergeQuarantines().find((e) => e.repoPath === yy)?.tokens ?? []).includes(xTok));

  const realOpenSync = fs.openSync;
  let injectedFailures = 0;
  fs.openSync = (p, ...rest) => {
    if (typeof p === "string" && p.startsWith(finX)) { injectedFailures++; throw Object.assign(new Error("ENOSPC: simulated"), { code: "ENOSPC" }); }
    return realOpenSync(p, ...rest);
  };
  clearMergeQuarantineByToken(x, xTok);
  fs.openSync = realOpenSync;
  note(`(s1) injected ${injectedFailures} open failure(s) during X's own by-token clear of xTok`);
  check("(s1 precondition) the write failure fired at least once", injectedFailures > 0);
  check("(s1 precondition) X's final still shows xTok on disk (the durable write failed)", (JSON.parse(fs.readFileSync(finX, "utf8")).tokens ?? []).includes(xTok));

  // Mark X's final unreadable so the next write reaches the reconcile-over-stale-bytes branch.
  markLatchFileUnreadableTestOnly(path.basename(finX));

  clearMergeQuarantineByToken(x, t2);
  clearMergeQuarantineByToken(x, synth);
  const stillQuarantined = !!activeMergeQuarantineFor(x);
  const memX = listActiveMergeQuarantines().find((e) => directPathIdentity(e.repoPath) === directPathIdentity(x));
  note(`(s1) X after clearing xTok/t2/synth: quarantined=${stillQuarantined}; tokens=${JSON.stringify(memX?.tokens)}`);
  check("*** SF1 FIX *** X fully lifts once every one of its own genuinely-outstanding tokens (xTok, t2, synth) is cleared", !stillQuarantined);
  const yTokensAfter = listActiveMergeQuarantines().find((e) => e.repoPath === yy)?.tokens ?? [];
  check("(s1 sanity) Y's own, unrelated yTok is untouched by X's clear", !!activeMergeQuarantineFor(yy) && yTokensAfter.includes(yTok));
  check("(s1 sanity) Y's own copy of the bled xTok is ALSO genuinely gone (Y released it too, in the same sweep)", !yTokensAfter.includes(xTok));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 2 (SF2) — directPathIdentity drifts once a junction/symlink stops resolving (realpath falls
// back to path.resolve). A token tombstoned while the junction still resolved must still be recognized
// as tombstoned once the SAME identity is recomputed after the junction is removed (the stale-bytes
// reconcile reads the record's own repoPath verbatim, then recomputes directPathIdentity fresh — a
// DIFFERENT string than at tombstone time). RED on pre-fix code (the repo stays stuck on the already-
// cleared token); GREEN after (attributed under BOTH directPathIdentity and literalRepoPathKey).
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const pDir = freshRepo("s2-p");
  const real = path.join(pDir, "r" + freshSfx());
  fs.mkdirSync(real, { recursive: true });
  const y = path.join(pDir, "j" + freshSfx());
  fs.symlinkSync(real, y, "junction");

  const idBefore = directPathIdentity(y);
  const t1 = enterMergeQuarantine(y, "s2-b1", "s2-r1");
  clearMergeQuarantineByToken(y, t1); // t1 is the ONLY token -> fully LIFTS the entry (no leftover), tombstoned under realpath(y)'s identity while the junction is still live
  check("(s2 precondition) the sole-token clear fully lifted the entry (no leftover active record to collide with the placeholder below)", !activeMergeQuarantineFor(y));
  fs.rmdirSync(y); // the junction goes away; the target directory is untouched
  const idAfter = directPathIdentity(y);
  const kAfter = canonicalRepoLockKey(y);
  note(`(s2) idBefore=${idBefore}`);
  note(`(s2) idAfter =${idAfter}`);
  check("(s2 precondition) directPathIdentity genuinely drifts once the junction is removed", idBefore !== idAfter);

  // t2 stands in for a genuinely-outstanding token this process never raised for real (never cleared) —
  // placed directly on the engineered boot-placeholder/stale-disk end-state, at the SAME key a later
  // fresh raise of `y` resolves to (kAfter), exactly like `reenterMergeQuarantinesAtBootImpl` would mint
  // one at BOOT after a restart found this exact latch file genuinely unreadable.
  const t2 = `s2-t2-${freshSfx()}`;
  const fin = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kAfter)}.json`);
  fs.writeFileSync(fin, JSON.stringify({ repoPath: y, branch: "s2-stale", reason: "s2: stale pre-clear snapshot", enteredAt: Date.now() - 6e4, tokens: [t1, t2] }, null, 2) + "\n");
  const synth = `s2-synth-${freshSfx()}`;
  setActiveQuarantineTestOnly(kAfter, { repoPath: y, branch: PLACEHOLDER_BRANCH_UNREADABLE, reason: "s2-ph", enteredAt: Date.now() - 12e4, tokens: [synth, t2], placeholder: true, armedKeys: [kAfter] });
  markLatchFileUnreadableTestOnly(path.basename(fin));

  const t3 = enterMergeQuarantine(y, "s2-b3", "s2-r3");
  const mem = listActiveMergeQuarantines().find((e) => directPathIdentity(e.repoPath) === idAfter);
  note(`(s2) mem tokens after reingest: ${JSON.stringify(mem?.tokens)}; t1=${t1}`);
  // @decision 0d3b64c6 (N3) — a PRECONDITION, never a discriminator: t1 stays filtered here on pre-fix
  // code too (both X's final AND the in-memory entry are rewritten atomically by the SAME clear, so
  // nothing in this single-identity path ever needed the drifted-identity fix to get this far).
  check("(s2 precondition) t1 stays filtered (recognized as tombstoned) despite the identity drift", !!mem && !mem.tokens.includes(t1));
  check("(s2 sanity) synth/t2 survive the reingest (genuine survivors, never tombstoned)", !!mem && mem.tokens.includes(synth) && mem.tokens.includes(t2));
  check("(s2 sanity) t3's own fresh raise lands as its own record rather than corrupting the reconciled placeholder's own tokens", !mem.tokens.includes(t3) && listActiveMergeQuarantines().some((e) => directPathIdentity(e.repoPath) === idAfter && e.tokens.includes(t3)));

  for (const t of [t2, t3, synth]) clearMergeQuarantineByToken(y, t);
  const stillQuarantined = !!activeMergeQuarantineFor(y);
  note(`(s2) after clearing t2,t3,synth: quarantined=${stillQuarantined}`);
  check("*** SF2 FIX *** the repo fully lifts once every genuinely-outstanding (live) token is cleared, despite the identity drift", !stillQuarantined);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 3 (round-2 Code Review, B1) — a cross-FORM collision: J is a junction holding a bled xTok,
// cleared while it resolves; J is then replaced by a real dir and a NEW junction Q points AT it, so
// direct(Q) textually equals J's OLD literal attribution. X's own reconcile (repoPath=Q) must not treat
// that as a match. RED on the pre-round-2 (single shared-set) code; GREEN after.
// @decision 0d3b64c6 (round 2, B1) — see the decision record's own "Round 2" section for the full
// mechanism and why two separate namespaces (never one shared set) is what closes this.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const pDir3 = freshRepo("s3-p");
  const ty = path.join(pDir3, "ty");
  fs.mkdirSync(ty, { recursive: true });
  const j = path.join(pDir3, "j");
  fs.symlinkSync(ty, j, "junction");

  const kY3 = canonicalRepoLockKey(j);
  const yTok3 = `s3-ytok-${freshSfx()}`;
  const xTok3 = `s3-xtok-${freshSfx()}`;
  setActiveQuarantineTestOnly(kY3, { repoPath: j, branch: "s3-yb", reason: "s3-y: bled xTok3", enteredAt: Date.now(), tokens: [yTok3, xTok3], armedKeys: [kY3] });

  clearMergeQuarantineByToken(j, xTok3); // tombstones xTok3 under direct(j)=realpath(j)=ty AND literal(j)="j" (j still resolves)
  check("(s3 precondition) xTok3 is gone from Y's own record", !(listActiveMergeQuarantines().find((e) => e.repoPath === j)?.tokens ?? []).includes(xTok3));

  // J is replaced by a real dir; a NEW junction Q points at J (now real).
  fs.rmSync(j, { recursive: false });
  fs.mkdirSync(j, { recursive: true });
  const q = path.join(pDir3, "q");
  fs.symlinkSync(j, q, "junction");
  check("(s3 precondition) direct(Q) now textually equals J's own literal spelling (the cross-form setup)", directPathIdentity(q) === j.toLowerCase());

  const kX3 = canonicalRepoLockKey(q);
  const finX3 = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kX3)}.json`);
  const xSurvivor3 = `s3-xsurvivor-${freshSfx()}`;
  const xOther3 = `s3-xother-${freshSfx()}`;
  fs.writeFileSync(finX3, JSON.stringify({ repoPath: q, branch: "s3-xb", reason: "s3-x: stale final", enteredAt: Date.now(), tokens: [xTok3, xSurvivor3] }, null, 2) + "\n");
  setActiveQuarantineTestOnly(kX3, { repoPath: q, branch: "s3-xb", reason: "s3-x-active", enteredAt: Date.now(), tokens: [xSurvivor3, xOther3], armedKeys: [kX3] });
  markLatchFileUnreadableTestOnly(path.basename(finX3));

  // Clear X's OWN genuine (non-bled) token to trigger a reduce write over the marked final, reaching
  // reconcileMarkedBasenameBeforeWrite's GENERIC branch.
  clearMergeQuarantineByToken(q, xOther3);
  const memX3 = listActiveMergeQuarantines().find((e) => e.repoPath === q);
  note(`(s3) X after reconcile: ${JSON.stringify(memX3?.tokens)}`);
  check("*** B1 FIX *** xTok3 SURVIVES X's own reconcile (a cross-form collision must never drop it)", !!memX3 && memX3.tokens.includes(xTok3));
  check("(s3 sanity) xSurvivor3 also survives", !!memX3 && memX3.tokens.includes(xSurvivor3));

  clearMergeQuarantineByToken(q, xSurvivor3);
  clearMergeQuarantineByToken(q, xTok3);
  check("(s3 sanity) X fully lifts once its own genuinely-outstanding tokens (including xTok3, by ITS OWN clear) are released", !activeMergeQuarantineFor(q));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 4 (round-3 Code Review, case A) — a LITERAL-namespace collision: same path TEXT P is a
// junction to TY at t1 (Y, bled with xTok, cleared while P resolves); P is then removed and a NEW
// junction, same TEXT P, points at a DIFFERENT repo TX. X's own reconcile (repoPath=P) must not treat
// Y's old attribution as covering it. RED at HEAD before round 3 (SF-3); GREEN after.
// @decision 0d3b64c6 (round 3, SF-3) — see the decision record's own round-3 section.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const d4 = freshRepo("s4-d");
  const ty4 = path.join(d4, "ty"); fs.mkdirSync(ty4, { recursive: true });
  const tx4 = path.join(d4, "tx"); fs.mkdirSync(tx4, { recursive: true });
  const p4 = path.join(d4, "p");
  fs.symlinkSync(ty4, p4, "junction");
  const kY4 = canonicalRepoLockKey(p4);
  const yTok4 = `s4-ytok-${freshSfx()}`;
  const xTok4 = `s4-xtok-${freshSfx()}`;
  setActiveQuarantineTestOnly(kY4, { repoPath: p4, branch: "s4-yb", reason: "s4-y bled", enteredAt: Date.now(), tokens: [yTok4, xTok4], armedKeys: [kY4] });
  clearMergeQuarantineByToken(p4, xTok4);
  clearMergeQuarantineByToken(p4, yTok4);
  check("(s4 precondition) Y fully lifted at t1", !activeMergeQuarantineFor(p4));

  fs.rmdirSync(p4);
  fs.symlinkSync(tx4, p4, "junction");
  note(`(s4) direct(P)@t2=${directPathIdentity(p4)} (t1 was ${ty4.toLowerCase()})`);

  const kX4 = canonicalRepoLockKey(p4);
  const finX4 = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kX4)}.json`);
  const xSurv4 = `s4-xsurv-${freshSfx()}`;
  const xOther4 = `s4-xother-${freshSfx()}`;
  fs.writeFileSync(finX4, JSON.stringify({ repoPath: p4, branch: "s4-xb", reason: "s4-x stale", enteredAt: Date.now(), tokens: [xTok4, xSurv4] }, null, 2) + "\n");
  setActiveQuarantineTestOnly(kX4, { repoPath: p4, branch: "s4-xb", reason: "s4-x active", enteredAt: Date.now(), tokens: [xSurv4, xOther4], armedKeys: [kX4] });
  markLatchFileUnreadableTestOnly(path.basename(finX4));
  clearMergeQuarantineByToken(p4, xOther4);
  const memX4 = listActiveMergeQuarantines().find((e) => e.repoPath === p4 && e.branch === "s4-xb");
  note(`(s4) X tokens after reconcile: ${JSON.stringify(memX4?.tokens)}`);
  check("*** SF-3 FIX (case A) *** X's GENUINE xTok survives X's reconcile", !!memX4 && memX4.tokens.includes(xTok4));
  clearMergeQuarantineByToken(p4, xSurv4);
  check("*** SF-3 FIX (case A) *** X stays quarantined while its genuine xTok was never cleared", !!activeMergeQuarantineFor(p4));
  clearMergeQuarantineByToken(p4, xTok4);
  check("(s4 sanity) X fully lifts once xTok4 is cleared by its own real owner", !activeMergeQuarantineFor(p4));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 5 (round 3, M2 discriminator) — a case where ONLY the direct (realpath) namespace can
// recognize a legitimate tombstone, so a "literal-only matching" mutation (dropping `.direct` from
// tokenTombstonedForIdentity) must RED here. Clear a token while addressed via a junction Q -> T (both
// `direct(Q)` and `literal(Q)` recorded, Q still resolves); reconcile a DIFFERENT record whose own
// stored `repoPath` is T's OWN literal spelling (never through Q) -- `direct(T)` legitimately equals
// `direct(Q)` (both resolve to T), but `literal(T)` ("T" itself) never equals `literal(Q)` ("Q").
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const d5 = freshRepo("s5-d");
  const t5 = path.join(d5, "t"); fs.mkdirSync(t5, { recursive: true });
  const q5 = path.join(d5, "q");
  fs.symlinkSync(t5, q5, "junction");

  const tok5 = enterMergeQuarantine(q5, "s5-b1", "s5-r1");
  clearMergeQuarantineByToken(q5, tok5); // tombstones tok5 under direct(q5)=realpath(q5)=t5 AND literal(q5)="q5" (q5 still resolves)
  check("(s5 precondition) Q fully lifted", !activeMergeQuarantineFor(q5));

  // A DIFFERENT record, stored under T's OWN literal spelling (never through Q), carries tok5 as a
  // stale leftover in a marked-unreadable final, alongside a genuine survivor.
  const kT5 = canonicalRepoLockKey(t5);
  const finT5 = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kT5)}.json`);
  const tSurv5 = `s5-tsurv-${freshSfx()}`;
  const tOther5 = `s5-tother-${freshSfx()}`;
  fs.writeFileSync(finT5, JSON.stringify({ repoPath: t5, branch: "s5-tb", reason: "s5-t stale", enteredAt: Date.now(), tokens: [tok5, tSurv5] }, null, 2) + "\n");
  setActiveQuarantineTestOnly(kT5, { repoPath: t5, branch: "s5-tb", reason: "s5-t active", enteredAt: Date.now(), tokens: [tSurv5, tOther5], armedKeys: [kT5] });
  markLatchFileUnreadableTestOnly(path.basename(finT5));
  clearMergeQuarantineByToken(t5, tOther5);
  const memT5 = listActiveMergeQuarantines().find((e) => e.repoPath === t5 && e.branch === "s5-tb");
  note(`(s5) T tokens after reconcile: ${JSON.stringify(memT5?.tokens)}`);
  check("*** M2 DISCRIMINATOR *** tok5 is recognized as tombstoned via direct(T)==direct(Q) (never literal)", !!memT5 && !memT5.tokens.includes(tok5));
  clearMergeQuarantineByToken(t5, tSurv5);
  check("(s5) T fully lifts once its own genuinely-outstanding tokens are cleared", !activeMergeQuarantineFor(t5));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 6 (round 3, the 7-route drift matrix) — tombstone t1 via EACH clear ROUTE while junction y
// resolves; remove y; reingest a stale final carrying [t1, t2] onto a placeholder; t1 must stay
// filtered and the repo must lift once t2/t3/synth (genuinely outstanding) are cleared -- for every
// route a human/manager clear can take, not just the by-token path Scenarios 1/2 already cover.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
function driftRoute(route) {
  const d6 = freshRepo(`s6-${route}`);
  const real6 = path.join(d6, "r"); fs.mkdirSync(real6, { recursive: true });
  const y6 = path.join(d6, "j");
  fs.symlinkSync(real6, y6, "junction");
  const k6 = canonicalRepoLockKey(y6);
  let t1;
  if (route === "pending-id" || route === "pending-id-2spell") {
    t1 = `s6-${route}-t1-${freshSfx()}`;
    const id6 = randomBytes(12).toString("hex");
    pushPendingQuarantineTestOnly({ repoPath: y6, branch: "s6-pb", reason: "s6 pending", enteredAt: Date.now(), tokens: [t1] }, `${id6}.json`);
    if (route === "pending-id-2spell") {
      pushPendingQuarantineTestOnly({ repoPath: real6, branch: "s6-pb2", reason: "s6 pending 2", enteredAt: Date.now(), tokens: [`${t1}-sib`] }, `${id6}.json`);
    }
    clearMergeQuarantineLatchFile(id6);
  } else {
    t1 = enterMergeQuarantine(y6, `s6-${route}-b1`, "s6 r1");
    if (route === "token") clearMergeQuarantineByToken(y6, t1);
    else if (route === "identity") clearMergeQuarantineReporting(y6);
    else if (route === "recorded-path") clearMergeQuarantineByRecordedPath(y6);
    else if (route === "key") clearMergeQuarantineByKey(k6, y6, undefined, true);
    else if (route === "active-id") clearMergeQuarantineLatchFile(hashForKey(k6));
  }
  check(`(s6 ${route} precondition) lifted at t1`, !activeMergeQuarantineFor(y6));

  fs.rmdirSync(y6);
  const kAfter6 = canonicalRepoLockKey(y6);
  const t2 = `s6-${route}-t2-${freshSfx()}`;
  const fin6 = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kAfter6)}.json`);
  fs.writeFileSync(fin6, JSON.stringify({ repoPath: y6, branch: "s6-stale", reason: "s6 stale", enteredAt: Date.now() - 6e4, tokens: [t1, t2] }, null, 2) + "\n");
  const synth6 = `s6-${route}-synth-${freshSfx()}`;
  setActiveQuarantineTestOnly(kAfter6, { repoPath: y6, branch: PLACEHOLDER_BRANCH_UNREADABLE, reason: "s6 ph", enteredAt: Date.now() - 12e4, tokens: [synth6, t2], placeholder: true, armedKeys: [kAfter6] });
  markLatchFileUnreadableTestOnly(path.basename(fin6));
  const t3 = enterMergeQuarantine(y6, `s6-${route}-b3`, "s6 r3");
  for (const t of [t2, t3, synth6]) clearMergeQuarantineByToken(y6, t);
  const still6 = activeMergeQuarantineFor(y6);
  note(`(s6 ${route}) after clearing t2/t3/synth: still=${JSON.stringify(still6?.tokens ?? null)}`);
  check(`*** SF2/round-2/round-3 (drift route: ${route}) *** lifts after drift`, !still6);
}
for (const route of ["token", "identity", "recorded-path", "key", "active-id", "pending-id", "pending-id-2spell"]) driftRoute(route);

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 16 (round 8, Code Review MAJOR — a fail-CLOSED regression) — recordIdentity spelled with the
// extended-length local-drive prefix (`\\?\C:\...`), a PLAIN directory, NO junction anywhere. SF2's own
// drift (the directory later removed entirely) must still LIFT once every genuinely-outstanding token is
// cleared. Round 7's check (ii) compared realpath(ancestor) -- which `fs.realpathSync.native` strips the
// `\\?\` prefix from -- against the ancestor's OWN `\\?\`-prefixed lexical spelling (never stripped by
// `path.dirname`/`path.resolve`), so EVERY ancestor of a `\\?\`-spelled path mismatched, forever, with no
// redirect anywhere: the repo stayed quarantined permanently. RED at eccd24c9; GREEN after this round.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const d16 = freshRepo("s16-d");
  const real16 = path.join(d16, "r"); fs.mkdirSync(real16, { recursive: true }); // a PLAIN directory, no junction at all
  const extSpelled16 = "\\\\?\\" + real16; // \\?\C:\...\r -- the extended-length local-drive form
  const t1_16 = enterMergeQuarantine(extSpelled16, "s16-b1", "s16 r1");
  clearMergeQuarantineByToken(extSpelled16, t1_16);
  check("(s16 precondition) lifted at t1", !activeMergeQuarantineFor(extSpelled16));

  fs.rmdirSync(real16); // the directory is removed ENTIRELY -- genuine SF2 drift, no redirect anywhere
  const kAfter16 = canonicalRepoLockKey(extSpelled16);
  const t2_16 = `s16-t2-${freshSfx()}`;
  const fin16 = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kAfter16)}.json`);
  fs.writeFileSync(fin16, JSON.stringify({ repoPath: extSpelled16, branch: "s16-stale", reason: "s16 stale", enteredAt: Date.now() - 6e4, tokens: [t1_16, t2_16] }, null, 2) + "\n");
  const synth16 = `s16-synth-${freshSfx()}`;
  setActiveQuarantineTestOnly(kAfter16, { repoPath: extSpelled16, branch: PLACEHOLDER_BRANCH_UNREADABLE, reason: "s16 ph", enteredAt: Date.now() - 12e4, tokens: [synth16, t2_16], placeholder: true, armedKeys: [kAfter16] });
  markLatchFileUnreadableTestOnly(path.basename(fin16));
  const t3_16 = enterMergeQuarantine(extSpelled16, "s16-b3", "s16 r3");
  for (const t of [t2_16, t3_16, synth16]) clearMergeQuarantineByToken(extSpelled16, t);
  const still16 = activeMergeQuarantineFor(extSpelled16);
  note(`(s16) after clearing t2/t3/synth: still=${JSON.stringify(still16?.tokens ?? null)}`);
  check("*** ROUND 8 FIX (\\\\?\\-spelled drift) *** lifts after drift, despite the extended-length prefix", !still16);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 7 (round 4, Code Review MAJOR — the dangling-junction variant) — Y bled with xTok, cleared
// while junction P -> TY resolves. P is then re-pointed at a DIFFERENT target TX, and TX is later
// removed too, so at read time P is a DANGLING junction (realpath -> ENOENT, but lstat still succeeds
// -- the reparse point entry itself is still there). X's own genuine xTok must SURVIVE. Round 6: this is
// now rule 2 (lstat(P) succeeds -- ANYTHING exists at the leaf, dangling or not -- so `.literal` is
// never consulted at all; no target comparison happens any more). RED at round 3 (0eec9d53); GREEN since
// round 4 (the mechanism changed under round 5 and again under round 6; the OUTCOME is unchanged).
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const d7 = freshRepo("s7-d");
  const ty7 = path.join(d7, "ty"); fs.mkdirSync(ty7, { recursive: true });
  const tx7 = path.join(d7, "tx"); fs.mkdirSync(tx7, { recursive: true });
  const p7 = path.join(d7, "p");
  fs.symlinkSync(ty7, p7, "junction");
  const kY7 = canonicalRepoLockKey(p7);
  const yTok7 = `s7-ytok-${freshSfx()}`;
  const xTok7 = `s7-xtok-${freshSfx()}`;
  setActiveQuarantineTestOnly(kY7, { repoPath: p7, branch: "s7-yb", reason: "s7-y bled", enteredAt: Date.now(), tokens: [yTok7, xTok7], armedKeys: [kY7] });
  clearMergeQuarantineByToken(p7, xTok7);
  clearMergeQuarantineByToken(p7, yTok7);
  check("(s7 precondition) Y fully lifted at t1 (xTok7 tombstoned under direct(TY)/literal(P))", !activeMergeQuarantineFor(p7));

  fs.rmdirSync(p7);
  fs.symlinkSync(tx7, p7, "junction"); // P re-pointed at TX
  fs.rmdirSync(tx7); // TX itself removed -> P is now a DANGLING junction (lstat ok, realpath ENOENT)
  note(`(s7) direct(P) after dangling re-point: ${(() => { try { return directPathIdentity(p7); } catch (e) { return `<throws ${e.code}>`; } })()}`);

  const kX7 = canonicalRepoLockKey(p7);
  const finX7 = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kX7)}.json`);
  const xSurv7 = `s7-xsurv-${freshSfx()}`;
  const xOther7 = `s7-xother-${freshSfx()}`;
  fs.writeFileSync(finX7, JSON.stringify({ repoPath: p7, branch: "s7-xb", reason: "s7-x stale", enteredAt: Date.now(), tokens: [xTok7, xSurv7] }, null, 2) + "\n");
  setActiveQuarantineTestOnly(kX7, { repoPath: p7, branch: "s7-xb", reason: "s7-x active", enteredAt: Date.now(), tokens: [xSurv7, xOther7], armedKeys: [kX7] });
  markLatchFileUnreadableTestOnly(path.basename(finX7));
  clearMergeQuarantineByToken(p7, xOther7);
  const memX7 = listActiveMergeQuarantines().find((e) => e.repoPath === p7 && e.branch === "s7-xb");
  note(`(s7) X tokens after reconcile (dangling junction, re-pointed): ${JSON.stringify(memX7?.tokens)}`);
  check("*** FIX (dangling junction, rule 2) *** X's GENUINE xTok survives X's reconcile", !!memX7 && memX7.tokens.includes(xTok7));
  clearMergeQuarantineByToken(p7, xSurv7);
  check("*** FIX *** X stays quarantined while its genuine xTok was never cleared", !!activeMergeQuarantineFor(p7));
  clearMergeQuarantineByToken(p7, xTok7);
  check("(s7 sanity) X fully lifts once xTok7 is cleared by its own real owner", !activeMergeQuarantineFor(p7));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 8 (round 4, EXPECTATION FLIPPED round 6 — this IS the reviewer's own "control C") — a token
// is tombstoned while junction P -> TY resolves; TY itself is then removed WITHOUT re-pointing P (P stays
// dangling, still textually pointing at TY -- a genuine drift with no identity change at all). Rounds
// 4-5 recognized this as tombstoned by composing P's own unchanged readlink target. Round 6 DELETED that
// composition entirely (five straight Code Review rounds found a fail-open in some form of it) -- rule 2
// now fires unconditionally for ANY existing leaf, dangling or not, with no further comparison. The
// token therefore now SURVIVES: an ACCEPTED fail-CLOSED OVER-BLOCK (documented in the decision record's
// Round 6 section) -- the repo stays quarantined a little longer than strictly necessary, which is the
// SAME "keep more, never less" direction every reader in this module already defaults to, never a
// dropped token. This is the exact fixture the Lead's ruling calls "the reviewer's own control C".
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const d8 = freshRepo("s8-d");
  const ty8 = path.join(d8, "ty"); fs.mkdirSync(ty8, { recursive: true });
  const p8 = path.join(d8, "j");
  fs.symlinkSync(ty8, p8, "junction");
  const kY8 = canonicalRepoLockKey(p8);
  const yTok8 = `s8-ytok-${freshSfx()}`;
  const xTok8 = `s8-xtok-${freshSfx()}`;
  setActiveQuarantineTestOnly(kY8, { repoPath: p8, branch: "s8-yb", reason: "s8-y bled", enteredAt: Date.now(), tokens: [yTok8, xTok8], armedKeys: [kY8] });
  clearMergeQuarantineByToken(p8, xTok8);
  clearMergeQuarantineByToken(p8, yTok8);
  check("(s8 precondition) Y fully lifted", !activeMergeQuarantineFor(p8));

  fs.rmdirSync(ty8); // delete the TARGET only -- P stays pointing at the same (now-gone) text, never re-pointed
  note(`(s8) direct(P) after target removal: ${(() => { try { return directPathIdentity(p8); } catch (e) { return `<throws ${e.code}>`; } })()}`);

  const kX8 = canonicalRepoLockKey(p8);
  const finX8 = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kX8)}.json`);
  const xSurv8 = `s8-xsurv-${freshSfx()}`;
  const xOther8 = `s8-xother-${freshSfx()}`;
  fs.writeFileSync(finX8, JSON.stringify({ repoPath: p8, branch: "s8-xb", reason: "s8-x stale", enteredAt: Date.now(), tokens: [xTok8, xSurv8] }, null, 2) + "\n");
  setActiveQuarantineTestOnly(kX8, { repoPath: p8, branch: "s8-xb", reason: "s8-x active", enteredAt: Date.now(), tokens: [xSurv8, xOther8], armedKeys: [kX8] });
  markLatchFileUnreadableTestOnly(path.basename(finX8));
  clearMergeQuarantineByToken(p8, xOther8);
  const memX8 = listActiveMergeQuarantines().find((e) => e.repoPath === p8 && e.branch === "s8-xb");
  note(`(s8) X tokens after reconcile (dangling junction, target removed, never re-pointed): ${JSON.stringify(memX8?.tokens)}`);
  check("*** ROUND 6 ACCEPTED OVER-BLOCK (control C) *** xTok8 now SURVIVES (rule 2: a dangling leaf is always direct-only, no target comparison)", !!memX8 && memX8.tokens.includes(xTok8));
  check("(s8 sanity) xSurv8 also survives", !!memX8 && memX8.tokens.includes(xSurv8));
  clearMergeQuarantineByToken(p8, xSurv8);
  clearMergeQuarantineByToken(p8, xTok8);
  check("(s8 sanity) X fully lifts once BOTH of its own tokens are cleared by its own real owner", !activeMergeQuarantineFor(p8));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 9 (round 4, Code Review MAJOR residual) — repo-lock.ts's isRepoPathCurrentlyResolvable is a
// bare catch, so a TRANSIENT non-ENOENT error (EACCES/EBUSY/EMFILE/ELOOP) also used to wrongly enable
// `.literal`. Here P never changes on disk at all (still a live junction resolving to TY) -- we inject a
// fake EACCES on BOTH fs.realpathSync.native and fs.lstatSync for P specifically, simulating that class of
// transient failure. The fix must fail CLOSED (never consult `.literal`) rather than treat it as "gone".
// Round 6: this now reaches rule 4 (lstat's own EACCES, not ENOENT/ENOTDIR) -- same outcome, same rule
// number as it always was; only the surrounding mechanism (rules 2/3/5) changed around it.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const d9 = freshRepo("s9-d");
  const ty9 = path.join(d9, "ty"); fs.mkdirSync(ty9, { recursive: true });
  const p9 = path.join(d9, "p");
  fs.symlinkSync(ty9, p9, "junction");
  const kY9 = canonicalRepoLockKey(p9);
  const yTok9 = `s9-ytok-${freshSfx()}`;
  const xTok9 = `s9-xtok-${freshSfx()}`;
  setActiveQuarantineTestOnly(kY9, { repoPath: p9, branch: "s9-yb", reason: "s9-y bled", enteredAt: Date.now(), tokens: [yTok9, xTok9], armedKeys: [kY9] });
  clearMergeQuarantineByToken(p9, xTok9);
  clearMergeQuarantineByToken(p9, yTok9);
  check("(s9 precondition) Y fully lifted", !activeMergeQuarantineFor(p9));

  const kX9 = canonicalRepoLockKey(p9); // P never moved -- same key as kY9
  const finX9 = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kX9)}.json`);
  const xSurv9 = `s9-xsurv-${freshSfx()}`;
  const xOther9 = `s9-xother-${freshSfx()}`;
  fs.writeFileSync(finX9, JSON.stringify({ repoPath: p9, branch: "s9-xb", reason: "s9-x stale", enteredAt: Date.now(), tokens: [xTok9, xSurv9] }, null, 2) + "\n");
  setActiveQuarantineTestOnly(kX9, { repoPath: p9, branch: "s9-xb", reason: "s9-x active", enteredAt: Date.now(), tokens: [xSurv9, xOther9], armedKeys: [kX9] });
  markLatchFileUnreadableTestOnly(path.basename(finX9));

  const realRealpathNative = fs.realpathSync.native;
  const realLstatSync = fs.lstatSync;
  let injectedRealpath = 0, injectedLstat = 0;
  fs.realpathSync.native = (p, ...rest) => {
    if (p === p9) { injectedRealpath++; throw Object.assign(new Error("EACCES: simulated"), { code: "EACCES" }); }
    return realRealpathNative(p, ...rest);
  };
  fs.lstatSync = (p, ...rest) => {
    if (p === p9) { injectedLstat++; throw Object.assign(new Error("EACCES: simulated"), { code: "EACCES" }); }
    return realLstatSync(p, ...rest);
  };
  clearMergeQuarantineByToken(p9, xOther9);
  fs.realpathSync.native = realRealpathNative;
  fs.lstatSync = realLstatSync;
  note(`(s9) injected realpath=${injectedRealpath} lstat=${injectedLstat} EACCES failure(s) for P`);
  check("(s9 precondition) the injected realpath failure fired at least once", injectedRealpath > 0);
  check("(s9 precondition) the injected lstat failure fired at least once", injectedLstat > 0);

  const memX9 = listActiveMergeQuarantines().find((e) => e.repoPath === p9 && e.branch === "s9-xb");
  note(`(s9) X tokens after reconcile under injected non-ENOENT error: ${JSON.stringify(memX9?.tokens)}`);
  check("*** FIX (rule 4: non-ENOENT lstat/realpath error) *** fails CLOSED: X's genuine xTok survives", !!memX9 && memX9.tokens.includes(xTok9));
  check("(s9 sanity) xSurv9 also survives", !!memX9 && memX9.tokens.includes(xSurv9));
  clearMergeQuarantineByToken(p9, xSurv9);
  clearMergeQuarantineByToken(p9, xTok9);
  check("(s9 sanity) X fully lifts once its own genuine tokens are cleared", !activeMergeQuarantineFor(p9));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 11 (round 5, Code Review MAJOR — the reviewer's own repro) — recordIdentity names a PATH
// UNDER a dangling junction (P\sub), not the junction P itself. Round 4's gate lstat'd recordIdentity's
// own LEAF only: lstat(P\sub) fails ENOENT (the OS can't traverse through P's own dangling reparse point
// to even ATTEMPT the final component), which round 4 wrongly read as "the entry is gone" (SF2's shape)
// and consulted `.literal` by presence, dropping X's genuine xTok. Round 5's ancestor walk found P itself
// (one level up) IS a link and composed a target to compare; round 6 DELETED that composition -- rule 3
// now fires as soon as ANY link is found anywhere on the chain, no target comparison at all. The OUTCOME
// is unchanged (xTok11 survives); only the mechanism is simpler. RED at 877426b5; GREEN after round 5.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const d11 = freshRepo("s11-d");
  const ty11 = path.join(d11, "ty"); fs.mkdirSync(path.join(ty11, "sub"), { recursive: true });
  const tx11 = path.join(d11, "tx"); fs.mkdirSync(tx11, { recursive: true });
  const p11 = path.join(d11, "p");
  fs.symlinkSync(ty11, p11, "junction");
  const leaf11 = path.join(p11, "sub"); // recordIdentity = P\sub

  const kY11 = canonicalRepoLockKey(leaf11);
  const yTok11 = `s11-ytok-${freshSfx()}`;
  const xTok11 = `s11-xtok-${freshSfx()}`;
  setActiveQuarantineTestOnly(kY11, { repoPath: leaf11, branch: "s11-yb", reason: "s11-y bled", enteredAt: Date.now(), tokens: [yTok11, xTok11], armedKeys: [kY11] });
  clearMergeQuarantineByToken(leaf11, xTok11);
  clearMergeQuarantineByToken(leaf11, yTok11);
  check("(s11 precondition) Y fully lifted at t1 (xTok11 tombstoned under direct(TY/sub)/literal(P/sub), TY/sub stored)", !activeMergeQuarantineFor(leaf11));

  fs.rmdirSync(p11);
  fs.symlinkSync(tx11, p11, "junction"); // P re-pointed at TX (no "sub" under TX)
  fs.rmdirSync(tx11); // TX removed -> P is a DANGLING junction; P\sub fails to even lstat
  note(`(s11) lstat(P) isSymbolicLink after dangling re-point: ${fs.lstatSync(p11).isSymbolicLink()}; lstat(P\\sub) throws: ${(() => { try { fs.lstatSync(leaf11); return "no"; } catch (e) { return e.code; } })()}`);

  const kX11 = canonicalRepoLockKey(leaf11);
  const finX11 = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kX11)}.json`);
  const xSurv11 = `s11-xsurv-${freshSfx()}`;
  const xOther11 = `s11-xother-${freshSfx()}`;
  fs.writeFileSync(finX11, JSON.stringify({ repoPath: leaf11, branch: "s11-xb", reason: "s11-x stale", enteredAt: Date.now(), tokens: [xTok11, xSurv11] }, null, 2) + "\n");
  setActiveQuarantineTestOnly(kX11, { repoPath: leaf11, branch: "s11-xb", reason: "s11-x active", enteredAt: Date.now(), tokens: [xSurv11, xOther11], armedKeys: [kX11] });
  markLatchFileUnreadableTestOnly(path.basename(finX11));
  clearMergeQuarantineByToken(leaf11, xOther11);
  const memX11 = listActiveMergeQuarantines().find((e) => e.repoPath === leaf11 && e.branch === "s11-xb");
  note(`(s11) X tokens after reconcile (subdir of a dangling junction): ${JSON.stringify(memX11?.tokens)}`);
  check("*** FIX (subdir of a dangling junction, rule 3) *** X's GENUINE xTok survives X's reconcile", !!memX11 && memX11.tokens.includes(xTok11));
  clearMergeQuarantineByToken(leaf11, xSurv11);
  check("*** FIX *** X stays quarantined while its genuine xTok was never cleared", !!activeMergeQuarantineFor(leaf11));
  clearMergeQuarantineByToken(leaf11, xTok11);
  check("(s11 sanity) X fully lifts once xTok11 is cleared by its own real owner", !activeMergeQuarantineFor(leaf11));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 12 (round 6, Code Review MAJOR 1 — a CHAINED redirection) — P is a junction to T1, and T1 is
// a PLAIN directory (not a link) at clear time, so the stored direct form is realpath(T1/sub). T1 is
// later REPLACED: removed entirely, then recreated AS ITSELF a junction pointing to T2 (which holds a
// DIFFERENT repo, X's); T2 is then removed too. P itself was NEVER touched -- it still names "T1"
// literally. Round 5's own nearest-link composition found P (unchanged), read its target text ("T1",
// unchanged literal text) and composed T1\sub -- which, normalized, happened to equal the ORIGINAL
// stored form (itself T1\sub, from before T1 became a link) even though the REAL repo moved twice and
// is now gone. Round 6 never composes a target at all: `.direct` misses (the real resolved form at read
// time, if realpath succeeded, would be via T2, not T1 -- but it does not succeed at all, since T2 is
// gone) and rule 3 fires as soon as the walk finds P itself IS a link -- direct-only, no composition, no
// coincidental match. RED at 2a8b411c; GREEN after this round.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const d12 = freshRepo("s12-d");
  const t1_12 = path.join(d12, "t1"); fs.mkdirSync(path.join(t1_12, "sub"), { recursive: true }); // T1: a PLAIN dir at clear time
  const p12 = path.join(d12, "p");
  fs.symlinkSync(t1_12, p12, "junction"); // P -> T1 (plain dir)
  const leaf12 = path.join(p12, "sub");

  const kY12 = canonicalRepoLockKey(leaf12);
  const yTok12 = `s12-ytok-${freshSfx()}`;
  const xTok12 = `s12-xtok-${freshSfx()}`;
  setActiveQuarantineTestOnly(kY12, { repoPath: leaf12, branch: "s12-yb", reason: "s12-y bled", enteredAt: Date.now(), tokens: [yTok12, xTok12], armedKeys: [kY12] });
  clearMergeQuarantineByToken(leaf12, xTok12);
  clearMergeQuarantineByToken(leaf12, yTok12);
  check("(s12 precondition) Y fully lifted at t1 (xTok12 tombstoned while T1 was still a plain dir)", !activeMergeQuarantineFor(leaf12));

  const t2_12 = path.join(d12, "t2"); fs.mkdirSync(path.join(t2_12, "sub"), { recursive: true }); // T2: X's real repo, for now
  fs.rmSync(t1_12, { recursive: true }); // T1 (plain dir + its own "sub") removed entirely
  fs.symlinkSync(t2_12, t1_12, "junction"); // T1 is now ITSELF a junction -> T2 (same literal path "T1", new meaning)
  fs.rmSync(t2_12, { recursive: true }); // T2 removed too -> P -> T1(junction) -> T2(gone): a two-hop dangling chain
  note(`(s12) lstat(P) isSymbolicLink after T1's replacement: ${fs.lstatSync(p12).isSymbolicLink()}; lstat(T1) isSymbolicLink: ${fs.lstatSync(t1_12).isSymbolicLink()}; lstat(P\\sub) throws: ${(() => { try { fs.lstatSync(leaf12); return "no"; } catch (e) { return e.code; } })()}`);

  const kX12 = canonicalRepoLockKey(leaf12);
  const finX12 = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kX12)}.json`);
  const xSurv12 = `s12-xsurv-${freshSfx()}`;
  const xOther12 = `s12-xother-${freshSfx()}`;
  fs.writeFileSync(finX12, JSON.stringify({ repoPath: leaf12, branch: "s12-xb", reason: "s12-x stale", enteredAt: Date.now(), tokens: [xTok12, xSurv12] }, null, 2) + "\n");
  setActiveQuarantineTestOnly(kX12, { repoPath: leaf12, branch: "s12-xb", reason: "s12-x active", enteredAt: Date.now(), tokens: [xSurv12, xOther12], armedKeys: [kX12] });
  markLatchFileUnreadableTestOnly(path.basename(finX12));
  clearMergeQuarantineByToken(leaf12, xOther12);
  const memX12 = listActiveMergeQuarantines().find((e) => e.repoPath === leaf12 && e.branch === "s12-xb");
  note(`(s12) X tokens after reconcile (chained redirection, P unchanged, T1 became a link): ${JSON.stringify(memX12?.tokens)}`);
  check("*** ROUND 6 FIX (MAJOR 1: chained redirection) *** X's GENUINE xTok survives X's reconcile", !!memX12 && memX12.tokens.includes(xTok12));
  clearMergeQuarantineByToken(leaf12, xSurv12);
  check("*** ROUND 6 FIX *** X stays quarantined while its genuine xTok was never cleared", !!activeMergeQuarantineFor(leaf12));
  clearMergeQuarantineByToken(leaf12, xTok12);
  check("(s12 sanity) X fully lifts once xTok12 is cleared by its own real owner", !activeMergeQuarantineFor(leaf12));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 13 (round 6, Code Review MAJOR 2 — a Scenario-9 variant injecting into realpath ONLY, against
// REAL on-disk state) — a real, on-disk PLAIN directory (no junction anywhere in its ancestry) whose
// `fs.realpathSync.native` is monkey-patched to throw a fake EACCES, with `fs.lstatSync` left REAL
// (unintercepted) -- exercising `classifyLiteralGate`'s own real-fs binding end-to-end, rather than the
// fully-mocked pure classifier the table-driven unit test already covers. Round 5's own walk, after
// realpath failed, lstat'd the leaf (succeeds, real, not a link) and WRONGLY kept walking up past it
// looking for a link, reaching the REAL filesystem root (no link anywhere in this host's own temp-dir
// ancestry) and returning `{kind:"open"}` -- round 6's rule 2 instead fires the instant lstat(leaf)
// succeeds AT ALL, with no walk at all, returning the bare string `"direct-only"`. RED at 2a8b411c (a
// shape mismatch alone: round 5 returns an object, never the string "direct-only", for this exact input);
// GREEN after this round.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const d13 = freshRepo("s13-d");
  const real13 = path.join(d13, "real"); fs.mkdirSync(real13, { recursive: true }); // a real, on-disk PLAIN directory, no junction anywhere, ever

  const realRealpathNative13 = fs.realpathSync.native;
  let injectedRealpath13 = 0;
  fs.realpathSync.native = (p, ...rest) => {
    if (p === real13) { injectedRealpath13++; throw Object.assign(new Error("EACCES: simulated"), { code: "EACCES" }); }
    return realRealpathNative13(p, ...rest);
  };
  const gate13 = classifyLiteralGateFromFs(real13, { realpathNative: (p) => fs.realpathSync.native(p), lstat: (p) => fs.lstatSync(p) });
  fs.realpathSync.native = realRealpathNative13;
  note(`(s13) injected realpath-ONLY EACCES ${injectedRealpath13} time(s) for a real, on-disk plain directory (lstat left real); gate=${JSON.stringify(gate13)}`);
  check("(s13 precondition) the injected realpath-only failure fired at least once", injectedRealpath13 > 0);
  check("*** ROUND 6 FIX (MAJOR 2, end-to-end against real disk) *** classifyLiteralGate returns direct-only (rule 2), never open, for a real plain leaf under a realpath-only fault", gate13 === "direct-only");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 14 (round 7, Code Review MAJOR — the DANGLING volume-GUID junction) — a junction targeted via
// a `\\?\Volume{GUID}\...` path is INVISIBLE to libuv's own link detection once its target is removed:
// `lstat(P)` itself returns ENOENT (not merely `isSymbolicLink()`=false) even though P genuinely still
// exists on disk as a junction entry. Round 6's rules 2/3 both require `lstat` to SUCCEED before they can
// run at all, so both miss it entirely; round 7's check (i) (readdirSync the parent, looking for the
// invisible entry's own basename) is what catches it. `mklink /J` accepts this spelling without admin
// rights (confirmed on this host via `mountvol <drive>: /L`). SKIPS (never fails vacuously) if
// mountvol/mklink are unavailable in this environment. RED at caf914db; GREEN after this round.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const d14 = freshRepo("s14-d");
  const ty14 = path.join(d14, "ty"); fs.mkdirSync(path.join(ty14, "sub"), { recursive: true });
  const p14 = path.join(d14, "p");
  const created14 = tryVolumeGuidJunction(p14, ty14);
  if (!created14.ok) {
    note(`(s14) SKIP -- could not create a \\\\?\\Volume{GUID}\\... junction on this host: ${created14.reason}`);
  } else {
    const leaf14 = path.join(p14, "sub");
    const kY14 = canonicalRepoLockKey(leaf14);
    const yTok14 = `s14-ytok-${freshSfx()}`;
    const xTok14 = `s14-xtok-${freshSfx()}`;
    setActiveQuarantineTestOnly(kY14, { repoPath: leaf14, branch: "s14-yb", reason: "s14-y bled", enteredAt: Date.now(), tokens: [yTok14, xTok14], armedKeys: [kY14] });
    clearMergeQuarantineByToken(leaf14, xTok14);
    clearMergeQuarantineByToken(leaf14, yTok14);
    check("(s14 precondition) Y fully lifted at t1", !activeMergeQuarantineFor(leaf14));

    fs.rmSync(ty14, { recursive: true }); // the TARGET is removed -- P itself (the vol-GUID junction entry) becomes invisible to lstat
    const lstatP14 = (() => { try { return "ok link=" + fs.lstatSync(p14).isSymbolicLink(); } catch (e) { return e.code; } })();
    note(`(s14) lstat(P) after target removal: ${lstatP14} (P is STILL a real junction entry on disk)`);

    const kX14 = canonicalRepoLockKey(leaf14);
    const finX14 = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kX14)}.json`);
    const xSurv14 = `s14-xsurv-${freshSfx()}`;
    const xOther14 = `s14-xother-${freshSfx()}`;
    fs.writeFileSync(finX14, JSON.stringify({ repoPath: leaf14, branch: "s14-xb", reason: "s14-x stale", enteredAt: Date.now(), tokens: [xTok14, xSurv14] }, null, 2) + "\n");
    setActiveQuarantineTestOnly(kX14, { repoPath: leaf14, branch: "s14-xb", reason: "s14-x active", enteredAt: Date.now(), tokens: [xSurv14, xOther14], armedKeys: [kX14] });
    markLatchFileUnreadableTestOnly(path.basename(finX14));
    clearMergeQuarantineByToken(leaf14, xOther14);
    const memX14 = listActiveMergeQuarantines().find((e) => e.repoPath === leaf14 && e.branch === "s14-xb");
    note(`(s14) X tokens after reconcile (dangling volume-GUID junction): ${JSON.stringify(memX14?.tokens)}`);
    check("*** ROUND 7 FIX (dangling volume-GUID junction) *** X's GENUINE xTok survives X's reconcile", !!memX14 && memX14.tokens.includes(xTok14));
    clearMergeQuarantineByToken(leaf14, xSurv14);
    check("*** ROUND 7 FIX *** X stays quarantined while its genuine xTok was never cleared", !!activeMergeQuarantineFor(leaf14));
    clearMergeQuarantineByToken(leaf14, xTok14);
    check("(s14 sanity) X fully lifts once xTok14 is cleared by its own real owner", !activeMergeQuarantineFor(leaf14));
    try { execFileSync("cmd.exe", ["/c", "rmdir", p14]); } catch { /* best-effort cleanup */ }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 15 (round 7, Code Review MAJOR — the LIVE volume-GUID junction) — P is re-pointed (still via
// `mklink /J` to a `\\?\Volume{GUID}\...` target) at a DIFFERENT, EXISTING target TX that has no "sub"
// child. P itself is LIVE (`realpath` resolves it fine) but `lstat(P).isSymbolicLink()` reports FALSE —
// invisible to round 6's rule 3 even though it genuinely IS a redirect. Round 7's check (ii) (compare
// `realpath(P)` against P's own lexical spelling, at the nearest existing ancestor) is what catches this.
// SKIPS (never fails vacuously) if unavailable. RED at caf914db; GREEN after this round.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const d15 = freshRepo("s15-d");
  const ty15 = path.join(d15, "ty"); fs.mkdirSync(path.join(ty15, "sub"), { recursive: true });
  const tx15 = path.join(d15, "tx"); fs.mkdirSync(tx15, { recursive: true }); // no "sub" here
  const p15 = path.join(d15, "p");
  const created15 = tryVolumeGuidJunction(p15, ty15);
  if (!created15.ok) {
    note(`(s15) SKIP -- could not create a \\\\?\\Volume{GUID}\\... junction on this host: ${created15.reason}`);
  } else {
    const leaf15 = path.join(p15, "sub");
    const kY15 = canonicalRepoLockKey(leaf15);
    const yTok15 = `s15-ytok-${freshSfx()}`;
    const xTok15 = `s15-xtok-${freshSfx()}`;
    setActiveQuarantineTestOnly(kY15, { repoPath: leaf15, branch: "s15-yb", reason: "s15-y bled", enteredAt: Date.now(), tokens: [yTok15, xTok15], armedKeys: [kY15] });
    clearMergeQuarantineByToken(leaf15, xTok15);
    clearMergeQuarantineByToken(leaf15, yTok15);
    check("(s15 precondition) Y fully lifted at t1", !activeMergeQuarantineFor(leaf15));

    execFileSync("cmd.exe", ["/c", "rmdir", p15]);
    const repointed15 = tryVolumeGuidJunction(p15, tx15); // P re-pointed at TX (no "sub" there)
    if (!repointed15.ok) {
      note(`(s15) SKIP at re-point step -- ${repointed15.reason}`);
    } else {
      note(`(s15) lstat(P) after re-point: link=${fs.lstatSync(p15).isSymbolicLink()}; realpath(P)=${fs.realpathSync.native(p15)}`);

      const kX15 = canonicalRepoLockKey(leaf15);
      const finX15 = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kX15)}.json`);
      const xSurv15 = `s15-xsurv-${freshSfx()}`;
      const xOther15 = `s15-xother-${freshSfx()}`;
      fs.writeFileSync(finX15, JSON.stringify({ repoPath: leaf15, branch: "s15-xb", reason: "s15-x stale", enteredAt: Date.now(), tokens: [xTok15, xSurv15] }, null, 2) + "\n");
      setActiveQuarantineTestOnly(kX15, { repoPath: leaf15, branch: "s15-xb", reason: "s15-x active", enteredAt: Date.now(), tokens: [xSurv15, xOther15], armedKeys: [kX15] });
      markLatchFileUnreadableTestOnly(path.basename(finX15));
      clearMergeQuarantineByToken(leaf15, xOther15);
      const memX15 = listActiveMergeQuarantines().find((e) => e.repoPath === leaf15 && e.branch === "s15-xb");
      note(`(s15) X tokens after reconcile (live, re-pointed volume-GUID junction): ${JSON.stringify(memX15?.tokens)}`);
      check("*** ROUND 7 FIX (live volume-GUID junction, re-pointed) *** X's GENUINE xTok survives X's reconcile", !!memX15 && memX15.tokens.includes(xTok15));
      clearMergeQuarantineByToken(leaf15, xSurv15);
      check("*** ROUND 7 FIX *** X stays quarantined while its genuine xTok was never cleared", !!activeMergeQuarantineFor(leaf15));
      clearMergeQuarantineByToken(leaf15, xTok15);
      check("(s15 sanity) X fully lifts once xTok15 is cleared by its own real owner", !activeMergeQuarantineFor(leaf15));
    }
    try { execFileSync("cmd.exe", ["/c", "rmdir", p15]); } catch { /* best-effort cleanup */ }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// TABLE-DRIVEN UNIT TEST (round 7) — classifyLiteralGateFromFs is a PURE function over an injected fs;
// this exercises its full rule table (rules 1/2/3/4/5 plus round 7's own checks (i)/(ii)) via mocked
// realpath/lstat/readdir, with no real fs touched (beyond directPathIdentity's own internal, side-effect-
// free realpath attempt on a synthetic, nonexistent path, which always falls back to path.resolve).
//
// mockOps defaults, read together: `realpathNative(p)` resolves `p` TO ITSELF (no redirect) unless `p`
// is in `enoentPaths`/`links`/`realpathFails` (resolution fails) or `realpathRedirects` (resolves to a
// DIFFERENT value — check (ii)'s own positive case). `lstat(p)` reports a plain, existing, non-link entry
// unless `p` is in `enoentPaths` (ENOENT) or `lstatErrors` (some other errno) or `links` (a live link).
// `readdir(p)` returns `[]` (nothing invisible-but-present) unless `p` is in `readdirListing` (an
// explicit basename list — check (i)'s own positive case), `readdirErrors` (some other errno), or
// `enoentPaths` (the directory itself is also missing, consistent with continuing the walk).
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
const ROOT = path.parse(process.cwd()).root;
const synth = (...segs) => path.join(ROOT, "mq0d3b64-synth", ...segs);

function mockOps({ realpathOk = null, realpathFails = new Set(), realpathRedirects = new Map(), links = new Set(), enoentPaths = new Set(), lstatErrors = new Map(), readdirListing = new Map(), readdirErrors = new Map() } = {}) {
  return {
    realpathNative(p) {
      if (realpathOk && realpathOk(p)) return p;
      if (realpathRedirects.has(p)) return realpathRedirects.get(p);
      if (realpathFails.has(p) || enoentPaths.has(p) || links.has(p)) throw Object.assign(new Error("ENOENT: simulated"), { code: "ENOENT" });
      return p; // default: resolves to itself -- an ordinary, non-redirected entry
    },
    lstat(p) {
      if (lstatErrors.has(p)) throw Object.assign(new Error(`${lstatErrors.get(p)}: simulated`), { code: lstatErrors.get(p) });
      if (enoentPaths.has(p)) throw Object.assign(new Error("ENOENT: simulated"), { code: "ENOENT" });
      const isLink = links.has(p);
      return { isSymbolicLink: () => isLink };
    },
    readdir(p) {
      if (readdirErrors.has(p)) throw Object.assign(new Error(`${readdirErrors.get(p)}: simulated`), { code: readdirErrors.get(p) });
      if (readdirListing.has(p)) return readdirListing.get(p);
      if (enoentPaths.has(p)) throw Object.assign(new Error("ENOENT: simulated"), { code: "ENOENT" }); // the directory itself is also missing
      return [];
    },
  };
}

function checkGate(label, result, expected) {
  check(`${label}: expected=${expected} (got ${result})`, result === expected);
}

{
  const leaf = synth("resolves", "leaf");
  const r = classifyLiteralGateFromFs(leaf, mockOps({ realpathOk: (p) => p === leaf }));
  checkGate("rule 1: leaf resolves", r, "direct-only");
}
{
  const leaf = synth("plaindir", "missing-leaf");
  const r = classifyLiteralGateFromFs(leaf, mockOps({ enoentPaths: new Set([leaf]) }));
  checkGate("rule 5: leaf missing under a plain dir, no link anywhere (SF2's own shape)", r, "open");
}
{
  const leaf = synth("danglingleaf", "p"); // the leaf itself EXISTS (lstat ok) but doesn't resolve -- a dangling link/junction
  const r = classifyLiteralGateFromFs(leaf, mockOps({ links: new Set([leaf]) }));
  checkGate("rule 2: a dangling leaf (lstat ok, realpath fails) -- anything existing at all", r, "direct-only");
}
{
  const leaf = synth("plainleaf-realpath-throws", "real"); // a PLAIN leaf; realpath throws for an unrelated reason, lstat succeeds normally
  const r = classifyLiteralGateFromFs(leaf, mockOps({ realpathFails: new Set([leaf]) })); // not in enoentPaths/lstatErrors -> lstat succeeds, not a link
  checkGate("rule 2: a plain (non-link) leaf whose realpath throws -- MAJOR 2's own shape", r, "direct-only");
}
{
  const p = synth("ancestorlink", "p");
  const leaf = path.join(p, "sub"); // leaf missing; p (its parent) is a link -- regardless of whether p's OWN target exists
  const r = classifyLiteralGateFromFs(leaf, mockOps({ enoentPaths: new Set([leaf]), links: new Set([p]) }));
  checkGate("rule 3: a link on the immediate ancestor -- never composed/compared", r, "direct-only");
}
{
  const q = synth("nested-ancestor-link", "q");
  const mid = path.join(q, "mid"); // mid exists, plain, not a link -- walk must continue past it to find q
  const leaf = path.join(mid, "leaf");
  const r = classifyLiteralGateFromFs(leaf, mockOps({ enoentPaths: new Set([leaf]), links: new Set([q]) }));
  checkGate("rule 3: a link found further up, past an existing non-link ancestor -- MAJOR 1's own shape", r, "direct-only");
}
{
  const leaf = synth("eacces-leaf", "q");
  const r = classifyLiteralGateFromFs(leaf, mockOps({ realpathFails: new Set([leaf]), lstatErrors: new Map([[leaf, "EACCES"]]) }));
  checkGate("rule 4: EACCES on the leaf's own lstat", r, "direct-only");
}
{
  const leaf = synth("eacces-ancestor", "mid", "leaf");
  const mid = synth("eacces-ancestor", "mid");
  const r = classifyLiteralGateFromFs(leaf, mockOps({ enoentPaths: new Set([leaf]), lstatErrors: new Map([[mid, "EACCES"]]) }));
  checkGate("rule 4: EACCES on an ancestor's lstat (after one ENOENT hop)", r, "direct-only");
}
{
  const deep = Array.from({ length: LITERAL_GATE_WALK_MAX_STEPS + 20 }, (_, i) => `lvl${i}`);
  const leaf = synth("deep", ...deep, "leaf");
  const prefixes = new Set();
  let probe = leaf;
  for (let i = 0; i < LITERAL_GATE_WALK_MAX_STEPS + 25; i++) { prefixes.add(probe); const parent = path.dirname(probe); if (parent === probe) break; probe = parent; }
  const r = classifyLiteralGateFromFs(leaf, mockOps({ enoentPaths: prefixes }));
  checkGate(`rule 4: the walk bound (${LITERAL_GATE_WALK_MAX_STEPS} steps) exceeded`, r, "direct-only");
}
{
  const d = synth("multi-missing", "a", "b", "c", "leaf"); // several ENOENT hops before a plain existing dir, no link anywhere
  const r = classifyLiteralGateFromFs(d, mockOps({ enoentPaths: new Set([d, synth("multi-missing", "a", "b", "c"), synth("multi-missing", "a", "b")]) }));
  checkGate("rule 5: several missing ancestors, no link anywhere on the chain", r, "open");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// ROUND 7 TABLE ROWS — checks (i) and (ii), and their own failure branches.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const parent = synth("check-i-present", "parentdir");
  const leaf = path.join(parent, "vj"); // lstat fails ENOENT, but readdir(parent) lists "vj" -- invisible but present
  const r = classifyLiteralGateFromFs(leaf, mockOps({ enoentPaths: new Set([leaf]), readdirListing: new Map([[parent, ["vj"]]]) }));
  checkGate("round 7, check (i): invisible-but-present component (readdir lists it despite lstat ENOENT)", r, "direct-only");
}
{
  const parent = synth("check-i-present-case", "parentdir");
  const leaf = path.join(parent, "VJ"); // different case from the readdir listing
  const r = classifyLiteralGateFromFs(leaf, mockOps({ enoentPaths: new Set([leaf]), readdirListing: new Map([[parent, ["vj"]]]) }));
  checkGate("round 7, check (i): case-insensitive match on win32 ('VJ' vs listed 'vj')", r, process.platform === "win32" ? "direct-only" : "open");
}
{
  const parent = synth("check-i-absent", "parentdir");
  const leaf = path.join(parent, "nope");
  const r = classifyLiteralGateFromFs(leaf, mockOps({ enoentPaths: new Set([leaf]), readdirListing: new Map([[parent, ["somethingelse"]]]) }));
  checkGate("round 7, check (i) negative: component genuinely absent from the parent's own listing", r, "open");
}
{
  const parent = synth("check-i-readdir-eacces", "parentdir");
  const leaf = path.join(parent, "x");
  const r = classifyLiteralGateFromFs(leaf, mockOps({ enoentPaths: new Set([leaf]), readdirErrors: new Map([[parent, "EACCES"]]) }));
  checkGate("round 7, check (i) failure branch: readdir throws a non-ENOENT/ENOTDIR errno", r, "direct-only");
}
{
  const p = synth("check-ii-redirect", "p");
  const leaf = path.join(p, "sub"); // leaf missing; p EXISTS, lstat says NOT a link, but realpath resolves elsewhere
  const r = classifyLiteralGateFromFs(leaf, mockOps({ enoentPaths: new Set([leaf]), realpathRedirects: new Map([[p, synth("check-ii-redirect", "elsewhere")]]) }));
  checkGate("round 7, check (ii): nearest existing ancestor's realpath differs from its own lexical form (an invisible LIVE redirect)", r, "direct-only");
}
{
  const p = synth("check-ii-realpath-throws", "p");
  const leaf = path.join(p, "sub");
  const r = classifyLiteralGateFromFs(leaf, mockOps({ enoentPaths: new Set([leaf]), realpathFails: new Set([p]) }));
  checkGate("round 7, check (ii) failure branch: realpath throws at the nearest existing ancestor", r, "direct-only");
}
{
  const p = synth("check-ii-ordinary", "p");
  const leaf = path.join(p, "sub");
  const r = classifyLiteralGateFromFs(leaf, mockOps({ enoentPaths: new Set([leaf]) })); // p resolves to itself by default -- ordinary, no redirect
  checkGate("round 7, check (ii) negative: an ordinary existing ancestor (realpath equals its own lexical form) never false-positives", r, "open");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// ROUND 8 TABLE ROWS — pins the normalizer: a case-only difference must still reach "open" (never a
// false redirect), and a genuine \\?\Volume{...}-spelled redirect must still reach "direct-only" (the
// prefix-strip must not swallow round 7's own fix).
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const p = synth("check-ii-case-diff", "CamelCaseDir");
  const leaf = path.join(p, "sub");
  const realCaseDiffering = synth("check-ii-case-diff", "camelcasedir"); // SAME ancestor, different case -- a case-preserving filesystem's own realpath spelling
  const r = classifyLiteralGateFromFs(leaf, mockOps({ enoentPaths: new Set([leaf]), realpathRedirects: new Map([[p, realCaseDiffering]]) }));
  checkGate("round 8: a case-differing realpath spelling of the SAME ancestor normalizes to a match (never a false redirect) -- pins the lowercase step (M10)", r, "open");
}
{
  const p = "\\\\?\\Volume{11111111-1111-1111-1111-111111111111}\\p"; // a genuine vol-GUID-spelled ancestor
  const leaf = path.join(p, "sub");
  const realElsewhere = synth("check-ii-volguid-after-normalizer", "elsewhere");
  const r = classifyLiteralGateFromFs(leaf, mockOps({ enoentPaths: new Set([leaf]), realpathRedirects: new Map([[p, realElsewhere]]) }));
  checkGate("round 8: a \\\\?\\Volume{...}-spelled ancestor still -> direct-only (the prefix-strip must never swallow round 7's own fix)", r, "direct-only");
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
