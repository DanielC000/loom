import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 9497bb7e — PHASE 2: POST /internal/merge-quarantine/clear-broad-union, the one supported,
// auditable escape for a stranded broad-genuineContributorKeys union. See the decision record.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-mq9497bb7e-bu-", { fresh: true });
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleUrl = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  enterMergeQuarantine, activeMergeQuarantineFor, clearMergeQuarantine, clearBroadUnion,
  computeBroadUnionVictimSet, composeBroadUnionClearResultTestOnly, directPathIdentity,
  MERGE_QUARANTINE_DIR, reenterMergeQuarantinesAtBoot, quarantineLatchFileIdsFor,
  setActiveQuarantineTestOnly, pushPendingQuarantineTestOnly, PLACEHOLDER_BRANCH_UNREADABLE,
} = await import(mergeQuarantineModuleUrl);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);
const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { ALL_ORCHESTRATION_EVENT_KINDS } = await import("@loom/shared");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mq9497bb7e-bu@loom -c user.name=mq9497bb7e-bu";

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
let n = 0;
function freshRepo(tag) {
  n++;
  const d = path.join(os.tmpdir(), `loom-mq9497bb7e-bu-${tag}-${sfx}-${n}`);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "README.md"), `# ${tag}\n`);
  execSync(`git init -q && git config user.email mq9497bb7e-bu@loom && git config user.name mq9497bb7e-bu`, { cwd: d });
  commitAll(d, "init", GIT_ID);
  return d;
}
function hashForKey(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

// Same stranding shape as the Phase 1 test — see merge-quarantine-9497bb7e-projectless-contributor-
// remediation-text.mjs's own buildStrandedFixture for the full rationale; duplicated here per this
// project's standalone-test-file convention.
function buildStrandedFixture(tag) {
  const s = freshRepo(`${tag}-s`);
  const r = freshRepo(`${tag}-r`);
  const ks = canonicalRepoLockKey(s);
  const kr = canonicalRepoLockKey(r);
  if (ks === kr) throw new Error(`${tag}: ks collided with kr — re-run`);
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const sFile = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ks)}.json`);
  fs.writeFileSync(sFile, JSON.stringify({
    repoPath: s, branch: "s-branch", reason: `pre-existing union, formed before card 6de79dc0's own fix (${tag})`,
    enteredAt: Date.now() - 60_000, tokens: ["s-token", "r-token"],
    resolvedKey: kr, identityAtRaise: ks, contributorRepoPaths: [r],
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);
  return { s, r, ks, kr };
}

function rebootAndCheck(paths) {
  const outFile = path.join(os.tmpdir(), `loom-mq9497bb7e-bu-reboot-out-${sfx}-${n++}.json`);
  const childScript = `
    const fs = (await import("node:fs")).default;
    const { reenterMergeQuarantinesAtBoot, assertRepoNotQuarantined } = await import(${JSON.stringify(mergeQuarantineModuleUrl)});
    reenterMergeQuarantinesAtBoot(${JSON.stringify(paths)});
    const out = {};
    for (const p of ${JSON.stringify(paths)}) out[p] = assertRepoNotQuarantined(p).ok;
    fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify(out));
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", childScript], { env: { ...process.env, LOOM_HOME: loomHome } });
  const result = JSON.parse(fs.readFileSync(outFile, "utf8"));
  fs.rmSync(outFile, { force: true });
  return result;
}

// ===================== (1) happy path: exact confirmPaths lifts everything, durably =====================
{
  const { s, r } = buildStrandedFixture("happy");
  const entry = activeMergeQuarantineFor(s);
  const expected = [directPathIdentity(s), directPathIdentity(r)].sort();
  check("(1) computeBroadUnionVictimSet matches the expected victim set", JSON.stringify(computeBroadUnionVictimSet(entry)) === JSON.stringify(expected));

  const dry = clearBroadUnion(s, [], true);
  check("(1) dryRun reports ok:true, dryRun:true", dry.ok === true && dry.dryRun === true);
  check("(1) dryRun's own victimPaths matches the same expected set", JSON.stringify([...dry.victimPaths].sort()) === JSON.stringify(expected));

  const real = clearBroadUnion(s, dry.victimPaths, false);
  check("(1) the real call with the dry run's OWN set succeeds", real.ok === true && real.dryRun === false);
  check("(1) wasQuarantined is true", real.wasQuarantined === true);
  check("(1) liftedRepoPaths names both s and r", new Set(real.liftedRepoPaths.map(directPathIdentity)).size === 2 &&
    [s, r].every((p) => real.liftedRepoPaths.some((lp) => directPathIdentity(lp) === directPathIdentity(p))));
  check("*** INVARIANT (item 6) *** every lifted identity is a SUBSET of the dry run's own victim set", real.liftedRepoPaths.every((lp) => dry.victimPaths.includes(directPathIdentity(lp))));
  check("(1) no unconfirmedLifted backstop fired when everything matched", !("unconfirmedLifted" in real) && !("unconfirmedLiftedWarning" in real));

  const ids = quarantineLatchFileIdsFor(entry);
  check("(1) the physical latch file(s) are gone from disk", ids.every((id) => !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, `${id}.json`))));
  const reboot = rebootAndCheck([s, r]);
  check("*** DURABLE *** s reads clear after a real reboot", reboot[s] === true);
  check("*** DURABLE *** r reads clear after a real reboot too", reboot[r] === true);
}

// ===================== (2) confirmPaths missing a real victim refuses, nothing deleted =====================
{
  const { s, r } = buildStrandedFixture("missing");
  const entry = activeMergeQuarantineFor(s);
  const ids = quarantineLatchFileIdsFor(entry);
  const onDiskBefore = ids.filter((id) => fs.existsSync(path.join(MERGE_QUARANTINE_DIR, `${id}.json`)));

  const result = clearBroadUnion(s, [directPathIdentity(s)], false); // r is missing
  check("(2) refuses (ok:false) when confirmPaths is missing a real victim", result.ok === false);
  check("(2) the refusal names the missing path", (result.reason ?? "").includes("Missing:") && (result.reason ?? "").includes(JSON.stringify(directPathIdentity(r)).slice(1, -1)));
  check("(2) the refusal names the dryRun recovery route", (result.reason ?? "").includes("dryRun:true"));
  check("(2) the refusal's own victimPaths is the SAME full set a dry run would report", JSON.stringify([...(result.victimPaths ?? [])].sort()) === JSON.stringify([directPathIdentity(s), directPathIdentity(r)].sort()));

  check("(2) NOTHING was deleted on disk", onDiskBefore.every((id) => fs.existsSync(path.join(MERGE_QUARANTINE_DIR, `${id}.json`))));
  const reboot = rebootAndCheck([s, r]);
  check("*** DURABLE *** s is STILL armed after a real reboot (refusal was genuine, not just in-memory)", reboot[s] === false);
  check("*** DURABLE *** r is STILL armed after a real reboot too", reboot[r] === false);
}

// ===================== (3) confirmPaths with one EXTRA, unrecognized path refuses =====================
{
  const { s, r } = buildStrandedFixture("extra");
  const entry = activeMergeQuarantineFor(s);
  const ids = quarantineLatchFileIdsFor(entry);
  const onDiskBefore = ids.filter((id) => fs.existsSync(path.join(MERGE_QUARANTINE_DIR, `${id}.json`)));
  const unrelated = freshRepo("extra-unrelated");

  const result = clearBroadUnion(s, [directPathIdentity(s), directPathIdentity(r), directPathIdentity(unrelated)], false);
  check("(3) refuses (ok:false) when confirmPaths names an extra, unrecognized path", result.ok === false);
  check("(3) the refusal names the unrecognized path", (result.reason ?? "").includes("Unrecognized") && (result.reason ?? "").includes(JSON.stringify(directPathIdentity(unrelated)).slice(1, -1)));

  check("(3) NOTHING was deleted on disk", onDiskBefore.every((id) => fs.existsSync(path.join(MERGE_QUARANTINE_DIR, `${id}.json`))));
  const reboot = rebootAndCheck([s, r]);
  check("*** DURABLE *** s is STILL armed after a real reboot", reboot[s] === false);
}

// ===================== (4) an ORDINARY union (guard never fires) refuses, points to the ordinary route =====================
{
  const ordinary = freshRepo("ordinary");
  enterMergeQuarantine(ordinary, "o-branch", "ordinary, no contributors — the guard this route exists for never fires here");
  const entry = activeMergeQuarantineFor(ordinary);
  check("(4 precondition) no contributors at all", (entry.contributorRepoPaths?.length ?? 0) === 0);

  const result = clearBroadUnion(ordinary, [directPathIdentity(ordinary)], false);
  check("(4) refuses — this route does not apply to an ordinary union", result.ok === false);
  check("(4) the refusal points at the ordinary /clear and /clear-by-path routes instead", (result.reason ?? "").includes("/internal/merge-quarantine/clear") && (result.reason ?? "").includes("does not match any union"));
  check("(4) nothing was touched — ordinary still blocked, ordinary clear still works", !!activeMergeQuarantineFor(ordinary));
  clearMergeQuarantine(ordinary); // cleanup via the ordinary route — proves it is genuinely unaffected
  check("(4 cleanup) the ORDINARY route still works fine for this entry afterward", !activeMergeQuarantineFor(ordinary));
}

// ===================== (5) dryRun deletes nothing and writes no event =====================
{
  const { s, r } = buildStrandedFixture("dryrun-noop");
  const entry = activeMergeQuarantineFor(s);
  const ids = quarantineLatchFileIdsFor(entry);
  const onDiskBefore = ids.filter((id) => fs.existsSync(path.join(MERGE_QUARANTINE_DIR, `${id}.json`)));

  const dry1 = clearBroadUnion(s, [], true);
  const dry2 = clearBroadUnion(s, ["some/arbitrary/confirmPaths/the/dry/run/path/must/ignore"], true); // dryRun ignores confirmPaths entirely
  check("(5) a dry run reports the victim set regardless of whatever confirmPaths was sent", JSON.stringify([...dry1.victimPaths].sort()) === JSON.stringify([...dry2.victimPaths].sort()));
  check("(5) NOTHING was deleted by either dry run", onDiskBefore.every((id) => fs.existsSync(path.join(MERGE_QUARANTINE_DIR, `${id}.json`))));
  check("(5) s and r are both STILL blocked after both dry runs", !!activeMergeQuarantineFor(s));
  // The event-not-written half of this check is proven at the REST level below (section H), where the
  // DB that would receive the event is actually reachable from this process.
}

// ===================== (6) provenanceUnknown refuses — no exact set can ever be enumerated =====================
{
  const s = freshRepo("provunk-s");
  const r = freshRepo("provunk-r");
  const ks = canonicalRepoLockKey(s);
  const kr = canonicalRepoLockKey(r);
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ks)}.json`), JSON.stringify({
    repoPath: s, branch: "s-branch", reason: "provenance-unknown union",
    enteredAt: Date.now() - 60_000, tokens: ["s-token", "r-token"],
    resolvedKey: kr, identityAtRaise: ks, contributorRepoPaths: [r], provenanceUnknown: true,
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);
  const entry = activeMergeQuarantineFor(s);
  check("(6 precondition) the entry genuinely carries provenanceUnknown:true", entry.provenanceUnknown === true);

  const dry = clearBroadUnion(s, [], true);
  check("(6) a dry run refuses outright — no exact set can be computed", dry.ok === false);
  check("(6) the refusal explains why (unknown provenance, never guess)", (dry.reason ?? "").includes("unknown provenance") || (dry.reason ?? "").includes("cannot enumerate"));
  const real = clearBroadUnion(s, [directPathIdentity(s), directPathIdentity(r)], false);
  check("(6) the real call refuses too, for the same reason, even with a plausible confirmPaths", real.ok === false);
  check("(6) nothing was touched", !!activeMergeQuarantineFor(s));
}

// ===================== (7) CR finding 1a: an unreadable boot-time PLACEHOLDER refuses =====================
// A reviewer's real probe found clearMergeQuarantineByKey can re-ingest a placeholder's now-readable disk
// content (reconcileClearedEntryIfPlaceholder) and union in a genuine contributor computeBroadUnionVictimSet
// never saw — this route must refuse the shape outright, on BOTH dryRun and the real call, rather than
// predict what a reconcile would reveal.
{
  const s = freshRepo("placeholder-s");
  const r = freshRepo("placeholder-r");
  const ks = canonicalRepoLockKey(s);
  setActiveQuarantineTestOnly(ks, {
    repoPath: s, branch: PLACEHOLDER_BRANCH_UNREADABLE, placeholder: true,
    reason: "boot found this latch unreadable, not corrupt", enteredAt: Date.now() - 60_000,
    tokens: ["s-token", "r-token"], contributorRepoPaths: [r],
  });
  const entry = activeMergeQuarantineFor(s);
  check("(7 precondition) the entry is genuinely a placeholder (no identityAtRaise, no live raise)", entry.placeholder === true && entry.identityAtRaise === undefined);
  check("(7 precondition) R is folded in as a contributor", !!entry.contributorRepoPaths?.some((c) => directPathIdentity(c) === directPathIdentity(r)));

  const dry = clearBroadUnion(s, [], true);
  check("(7) dryRun refuses on a placeholder entry", dry.ok === false);
  check("(7) names the placeholder shape and the restart-first remedy", (dry.reason ?? "").toLowerCase().includes("placeholder") && (dry.reason ?? "").includes("Restart the daemon"));
  const real = clearBroadUnion(s, [directPathIdentity(s), directPathIdentity(r)], false);
  check("(7) the real call refuses too, even with a plausible (correct-looking) confirmPaths", real.ok === false);
  check("(7) nothing was touched — s is still armed", !!activeMergeQuarantineFor(s));
}

// ===================== (8) CR finding 1b: a GENUINELY TIED PENDING twin of the same identity refuses =====================
// CR round 3, item 2: the original fixture's twin was UNTIED (no token overlap, no armedKeys, no
// contributors) — clearMergeQuarantineByKey's own pending loop would have SKIPPED it entirely regardless
// (its `tiedToThisEntity` check requires `p.entry === entry`, a shared armed key/orphan-file reference, OR
// a token SUBSET — none held), so "nothing touched" stayed green even under a disabled refusal, proving
// nothing about the real danger. This twin is genuinely TIED via a token subset (`subsetOfClearedTokens`)
// — the SAME condition clearMergeQuarantineByKey's own loop checks — and carries its OWN separate
// contributor `q`, a real repo computeBroadUnionVictimSet(entry) never sees (it only reads `entry`'s own
// `contributorRepoPaths`, never a pending twin's). Per `~L5755-5765`, tearing this twin down during a REAL
// clear adds `q` to the lifted set — exactly the danger this refusal exists to prevent.
{
  const { s, r } = buildStrandedFixture("pending-twin");
  check("(pending-twin precondition) R is folded in as a contributor", !!activeMergeQuarantineFor(s)?.contributorRepoPaths?.some((c) => directPathIdentity(c) === directPathIdentity(r)));
  const q = freshRepo("pending-twin-q");
  // pushPendingQuarantineTestOnly + an IMMEDIATE dry run (nothing else touches state in between) is what
  // keeps the twin genuinely pending for this check — activeMergeQuarantineFor(s) has its own cross-tier-
  // sibling GRADUATION side effect (the SAME class the Phase 1 test's (text-e) documents) and would absorb
  // this twin before clearBroadUnion's own dry run ever got a chance to see it pending, so it must not be
  // called again between here and that dry run.
  pushPendingQuarantineTestOnly({
    repoPath: s, branch: "twin-branch", reason: "a separate, boot-unresolved record sharing s's own identity, genuinely tied via a token subset",
    enteredAt: Date.now(), tokens: ["s-token"], contributorRepoPaths: [q],
  }, "pending-twin-fixture-9497bb7e.json");

  const dry = clearBroadUnion(s, [], true);
  check("(8) dryRun refuses when a tied pending twin of the same identity exists", dry.ok === false);
  check("(8) names the pending twin's own source file", (dry.reason ?? "").includes("PENDING") && (dry.reason ?? "").includes("pending-twin-fixture-9497bb7e.json"));
  const real = clearBroadUnion(s, [directPathIdentity(s), directPathIdentity(r)], false);
  check("(8) the real call refuses too", real.ok === false);
  // @decision 9497bb7e (CR round 4) — q is never active-quarantined in EITHER state, so the old
  // `!activeMergeQuarantineFor(q)` check could never fail; assert on the RESULT's own lift fields instead.
  const qIdentity = directPathIdentity(q);
  check("(8) q's identity is in neither liftedRepoPaths nor unconfirmedLifted",
    !(real.liftedRepoPaths ?? []).some((p) => directPathIdentity(p) === qIdentity) &&
    !(real.unconfirmedLifted ?? []).some((p) => directPathIdentity(p) === qIdentity));
}

// ===================== (9) CR finding 1, the POST-CLEAR BACKSTOP — exercised via a test-only seam =====================
// Both real under-counting root causes (7)/(8) are now refused upstream, so the backstop is deliberately
// UNREACHABLE through any real clearBroadUnion call — proving it requires a seam that feeds a fabricated
// `liftedRepoPaths` into the SAME shared composition function the real path calls, never a duplicate.
{
  const fakeResult = { wasQuarantined: true, liftedRepoPaths: ["/fake/s-9497bb7e", "/fake/r-9497bb7e", "/fake/UNEXPECTED-9497bb7e"], stillBlockedCoOccupants: [] };
  const composed = composeBroadUnionClearResultTestOnly(fakeResult, ["/fake/s-9497bb7e", "/fake/r-9497bb7e"]);
  check("(9) *** THE BACKSTOP *** fires when liftedRepoPaths names something outside the confirmed set", Array.isArray(composed.unconfirmedLifted) && composed.unconfirmedLifted.length === 1);
  check("(9) it names EXACTLY the unconfirmed identity", composed.unconfirmedLifted[0] === directPathIdentity("/fake/UNEXPECTED-9497bb7e"));
  check("(9) it carries a loud, unmissable warning", typeof composed.unconfirmedLiftedWarning === "string" && composed.unconfirmedLiftedWarning.includes("UNCONFIRMED DESTRUCTION"));
  check("(9) the response is still ok:true (a backstop is a disclosure, not a refusal — the clear already happened)", composed.ok === true);

  const clean = composeBroadUnionClearResultTestOnly({ wasQuarantined: true, liftedRepoPaths: ["/fake/s-9497bb7e", "/fake/r-9497bb7e"], stillBlockedCoOccupants: [] }, ["/fake/s-9497bb7e", "/fake/r-9497bb7e"]);
  check("*** NEGATIVE CONTROL (9) *** no unconfirmedLifted field at all when everything lifted was confirmed", !("unconfirmedLifted" in clean) && !("unconfirmedLiftedWarning" in clean));

  // Disclosure-field passthrough (item 3): every field clearMergeQuarantineByKey can return survives the
  // composition unchanged, mirroring /clear-by-path's own shape (decisions f5c42043/182c01cc).
  const withKeep = composeBroadUnionClearResultTestOnly({
    wasQuarantined: true, liftedRepoPaths: ["/fake/s-9497bb7e"], stillBlockedCoOccupants: [],
    latchKept: true, referencingRepoPaths: ["/fake/keeper-9497bb7e"], contentKeptRepoPaths: ["/fake/content-9497bb7e"],
    unattributed: true, provenanceUnknown: true,
  }, ["/fake/s-9497bb7e"]);
  check("(9) latchKept + referencingRepoPaths pass through", withKeep.latchKept === true && withKeep.referencingRepoPaths?.[0] === "/fake/keeper-9497bb7e");
  check("(9) contentKeptRepoPaths passes through", withKeep.contentKeptRepoPaths?.[0] === "/fake/content-9497bb7e");
  check("(9) unattributed passes through", withKeep.unattributed === true);
  check("(9) provenanceUnknown passes through", withKeep.provenanceUnknown === true);
}

// ===================== (H) the REST surface: auth mechanics, dryRun, the real call, and the audit event =====================
{
  const TMP = mkdtempManaged("loom-mq9497bb7e-bu-gw-");
  const PORT = 46900 + (process.pid % 400);
  const H = { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, "content-type": "application/json" };
  const SECRET = "test-secret-9497bb7e-bu";
  const authH = (bearer) => ({ ...H, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) });
  const db = new Db(path.join(TMP, "loom.db"));
  const app = await buildServer({
    db, pty: {}, sessions: {}, mcp: {}, orchMcp: {}, platformMcp: {}, auditMcp: {},
    userAuditMcp: {}, setupMcp: {}, runMcp: {}, control: {}, usageStatus: {}, loopbackSecret: SECRET,
  });
  try {
    const { s, r } = buildStrandedFixture("rest-h");
    const call = (bearer, payload, remoteAddress) => app.inject({
      method: "POST", url: "/internal/merge-quarantine/clear-broad-union",
      headers: authH(bearer), payload, ...(remoteAddress ? { remoteAddress } : {}),
    });

    // --- (H-auth) bearer guard mechanics — same shape as section (Q) in loopback-write-guard.mjs ---
    const noAuth = await call(undefined, { repoPath: s, dryRun: true });
    check("(H-auth) NO auth header -> 401", noAuth.statusCode === 401);
    const wrongAuth = await call("not-the-real-secret", { repoPath: s, dryRun: true });
    check("(H-auth) a WRONG bearer value -> 401", wrongAuth.statusCode === 401);

    // --- (H-nonloopback) a non-loopback caller -> 403, even with the correct secret ---
    const nonLoopback = await call(SECRET, { repoPath: s, dryRun: true }, "203.0.113.7");
    check("(H-nonloopback) a non-loopback remoteAddress -> 403 even with the CORRECT secret", nonLoopback.statusCode === 403);

    // --- (H-dryrun) the real route, dryRun:true — reads the victim set, writes no event ---
    const dryRes = await call(SECRET, { repoPath: s, dryRun: true });
    check("(H-dryrun) POSITIVE CONTROL: the correct secret + loopback reaches the real handler -> 200", dryRes.statusCode === 200);
    const dryBody = dryRes.json();
    check("(H-dryrun) body reports ok:true, dryRun:true", dryBody.ok === true && dryBody.dryRun === true);
    check("(H-dryrun) body's victimPaths names both s and r", [s, r].every((p) => dryBody.victimPaths.some((vp) => directPathIdentity(vp) === directPathIdentity(p))));
    const eventsBeforeReal = db.listRecentEventsByKinds(["merge_quarantine_broad_union_cleared"]);
    check("(H-dryrun) *** THE FIX *** a dryRun call writes NO merge_quarantine_broad_union_cleared event", eventsBeforeReal.length === 0);

    // --- (H-400) item 5: a non-string/empty confirmPaths element is a clean 400, never bounced through
    // clearBroadUnion's own exact-match refusal with a confusing "extra" message ---
    const badElement = await call(SECRET, { repoPath: s, confirmPaths: [s, 42] });
    check("(H-400) a non-string confirmPaths element -> 400", badElement.statusCode === 400);
    const emptyElement = await call(SECRET, { repoPath: s, confirmPaths: [s, ""] });
    check("(H-400) an empty-string confirmPaths element -> 400", emptyElement.statusCode === 400);
    check("(H-400) neither malformed call touched anything", !!activeMergeQuarantineFor(s));

    // --- (H-real) the real clear, with the EXACT dry-run set, over REST ---
    const realRes = await call(SECRET, { repoPath: s, confirmPaths: dryBody.victimPaths });
    check("(H-real) the real call -> 200", realRes.statusCode === 200);
    const realBody = realRes.json();
    check("(H-real) body reports ok:true, dryRun:false, liftedRepoPaths naming both s and r", realBody.ok === true && realBody.dryRun === false &&
      [s, r].every((p) => realBody.liftedRepoPaths.some((lp) => directPathIdentity(lp) === directPathIdentity(p))));
    check("(H-real) body also carries wasQuarantined:true and stillBlockedCoOccupants", realBody.wasQuarantined === true && Array.isArray(realBody.stillBlockedCoOccupants));
    check("(H-real) no unconfirmedLifted backstop fired (everything matched)", !("unconfirmedLifted" in realBody));
    check("(H-real) s and r both read clear afterward", !activeMergeQuarantineFor(s) && !activeMergeQuarantineFor(r));

    // --- (H-event) *** THE FIX *** the real clear files exactly one audit event, with the right shape ---
    const rows = db.listRecentEventsByKinds(["merge_quarantine_broad_union_cleared"]);
    check("(H-event) exactly one event was filed by the real clear", rows.length === 1);
    const ev = rows[0];
    check("(H-event) managerSessionId is the daemon-internal sentinel \"\"", ev?.managerSessionId === "");
    check("(H-event) detail carries repoPath, liftedRepoPaths, and confirmPaths", ev?.detail?.repoPath === s &&
      Array.isArray(ev?.detail?.liftedRepoPaths) && Array.isArray(ev?.detail?.confirmPaths));
    check("*** THE FIX (item 3) *** the event detail ALSO carries wasQuarantined + stillBlockedCoOccupants (the SAME ...rest spread as the response)", ev?.detail?.wasQuarantined === true && Array.isArray(ev?.detail?.stillBlockedCoOccupants));
  } finally {
    await app.close();
    db.close();
  }
}

check("(registered) merge_quarantine_broad_union_cleared is a real, registered OrchestrationEventKind", ALL_ORCHESTRATION_EVENT_KINDS.includes("merge_quarantine_broad_union_cleared"));

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nAll checks PASSED");
}
