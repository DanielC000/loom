import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 9497bb7e — a broad-genuineContributorKeys union strands its primary behind every REST clear
// route when its contributor has no registered project; see the decision record for the full narrative.
//
// Fixture: reuses the exact shape from `6de79dc0`'s own "(pre-fix-field-less)" scenario — S genuinely
// raises for real (genuine `identityAtRaise`), is hand-edited to carry a stale secondary `resolvedKey`
// pointing at a SECOND, genuinely independent repo R's own real canonical key, and `genuineContributorKeys`
// is left absent (never an empty array) — the BROAD legacy fallback this card's stranding depends on.
// R itself never raises independently here (matching that same scenario): it is "genuinely blocked" purely
// via the ancestor/key-collapse mechanism (R's own canonical key is the stale secondary key S occupies),
// which is exactly how a REAL, un-registered repo reads as blocked without ever needing its own raise.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-mq9497bb7e-", { fresh: true });
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleUrl = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  enterMergeQuarantine, activeMergeQuarantineFor, clearMergeQuarantine, clearMergeQuarantineReporting,
  clearMergeQuarantineByRecordedPath, clearMergeQuarantineLatchFile, assertRepoNotQuarantined,
  directPathIdentity, MERGE_QUARANTINE_DIR, reenterMergeQuarantinesAtBoot, quarantineLatchIdFor,
  quarantineLatchFileIdsFor, clearBroadUnion, pushPendingQuarantineTestOnly, setActiveQuarantineTestOnly,
  PLACEHOLDER_BRANCH_UNREADABLE,
} = await import(mergeQuarantineModuleUrl);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);
const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mq9497bb7e@loom -c user.name=mq9497bb7e";

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
let n = 0;
function freshRepo(tag) {
  n++;
  const d = path.join(os.tmpdir(), `loom-mq9497bb7e-${tag}-${sfx}-${n}`);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "README.md"), `# ${tag}\n`);
  execSync(`git init -q && git config user.email mq9497bb7e@loom && git config user.name mq9497bb7e`, { cwd: d });
  commitAll(d, "init", GIT_ID);
  return d;
}
function hashForKey(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

// Builds this card's own stranding shape, fresh each call — mirrors 6de79dc0's own "(pre-fix-field-less)"
// scenario exactly: hand-write S's own latch directly, simulating a union formed and persisted by
// 3be11be4-era code (so `identityAtRaise` is genuinely stamped) BEFORE card 6de79dc0's own fix ever
// shipped (so `contributorRepoPaths`/`resolvedKey` are baked in, but `genuineContributorKeys` was never
// computed and is absent — never an empty array). S is never put through a prior real raise here: the
// REAL on-disk shape this simulates never went through 6de79dc0-aware code at all.
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

function checkPrecondition(tag, s, r) {
  const sEntry = activeMergeQuarantineFor(s);
  check(`(${tag} precondition) S is dual-armed [Ks, Kr]`, (() => {
    const keys = new Set(sEntry?.armedKeys ?? []);
    return keys.has(canonicalRepoLockKey(s)) && keys.has(canonicalRepoLockKey(r));
  })());
  check(`(${tag} precondition) genuineContributorKeys is genuinely ABSENT (the BROAD fallback)`, sEntry?.genuineContributorKeys === undefined);
  check(`(${tag} precondition) R is folded in as a contributor`, !!sEntry?.contributorRepoPaths?.some((c) => directPathIdentity(c) === directPathIdentity(r)));
  check(`(${tag} precondition) R is genuinely resolvable on disk (a real repo, not a bare subdir)`, fs.existsSync(path.join(r, ".git")));
  check(`(${tag} precondition) R is genuinely blocked before any clear`, assertRepoNotQuarantined(r).ok === false);
  check(`(${tag} precondition) S is genuinely blocked before any clear`, assertRepoNotQuarantined(s).ok === false);
}

// ===================== VERIFY THE PREMISE: the stranding reproduces against current main =====================
{
  const { s, r } = buildStrandedFixture("premise");
  checkPrecondition("premise", s, r);

  const selfClear = clearMergeQuarantineReporting(s);
  check("(premise) /clear(s) refuses — nothing lifted", selfClear.wasQuarantined === true && selfClear.liftedRepoPaths.length === 0);
  const clearByPath = clearMergeQuarantineByRecordedPath(s);
  check("(premise) clear-by-path(s) refuses — nothing lifted", clearByPath.wasQuarantined === true && clearByPath.liftedRepoPaths.length === 0);
  const idsS = quarantineLatchFileIdsFor(activeMergeQuarantineFor(s));
  check("(premise) S carries exactly two latch ids (both armed keys)", idsS.length === 2);
  for (const id of idsS) {
    // Clear-by-id refuses OUTRIGHT here (82032b5c's pre-existing ambiguity guard: a bare id cannot tell
    // which of the union's two folded identities a human means), never ok:true/wasQuarantined:false.
    const byId = clearMergeQuarantineLatchFile(id);
    check(`(premise) clear-by-id(${id}) refuses outright (ambiguous)`, byId.ok === false);
    check(`(premise) clear-by-id(${id})'s own refusal ALSO carries this card's fixed text`, (byId.reason ?? "").includes("IF one is registered there"));
  }
  const clearByPathR = clearMergeQuarantineByRecordedPath(r);
  check("(premise) clear-by-path(r) does NOT reduce membership — wasQuarantined:false, stillQuarantined:true", clearByPathR.wasQuarantined === false && clearByPathR.stillQuarantined === true);
  check("(premise) S and R are still both blocked after every route above", assertRepoNotQuarantined(s).ok === false && assertRepoNotQuarantined(r).ok === false);
  console.log("(premise) THE STRANDING REPRODUCES against current main, exactly as the card describes.");
}

// ===================== (text-a) remediationTextFor's own two-step-sequence text is now accurate =====================
{
  const { s, r } = buildStrandedFixture("text-a");
  checkPrecondition("text-a", s, r);

  const result = clearMergeQuarantineReporting(s);
  const reason = result.reason ?? "";
  check("(text-a) the two-step sequence phrase every pre-existing test pins is still present verbatim", reason.includes("clear each contributor's own quarantine directly FIRST"));
  check("*** THE FIX *** the project-resolved route is now hedged on a project actually being registered there", reason.includes("IF one is registered there"));
  check("*** THE FIX *** the text no longer claims the project-resolved route unconditionally", !reason.includes("for a project rooted at its own path (this may release"));
  check("*** PHASE 2 FIX *** the SUPPORTED escape is the new clear-broad-union route with dryRun", reason.includes("/internal/merge-quarantine/clear-broad-union") && reason.includes("dryRun:true"));
  check("*** PHASE 2 FIX *** it requires an EXACT confirmPaths match after independent confirmation", reason.includes("confirmPaths set to EXACTLY that set") && reason.includes("no process running under it"));
  check("*** PHASE 2 FIX *** it warns that route destroys every contributor's own quarantine too", reason.toLowerCase().includes("destroys every contributor's own quarantine too"));
  check("*** PHASE 2 FIX *** the raw manual edit is demoted to an explicit LAST RESORT", reason.includes("LAST RESORT") && reason.includes("manual edit") && reason.includes("GET /internal/merge-quarantine/list") && reason.includes("restart the daemon"));
}

// ===================== (text-b) stillQuarantinedReason no longer names a dead-end clear-by-path route =====================
// Reproduces the 2026-10-27 triage note's exact shape: querying the bare, RESOLVABLE contributor R lands
// in the "ANOTHER repo's own, separate quarantine" branch, which used to unconditionally suggest
// clear-by-path on S's own repoPath — a dead end here, since S's own self-clear refuses (this card's
// guard). It must now route to the SAME honest multi-step text instead.
{
  const { s, r } = buildStrandedFixture("text-b");
  checkPrecondition("text-b", s, r);

  const result = clearMergeQuarantineByRecordedPath(r);
  const reason = result.reason ?? "";
  check("(text-b) querying r reports the pre-existing 'ANOTHER repo's own, separate quarantine' wording", reason.includes("ANOTHER repo's own, separate quarantine"));
  check("*** THE FIX *** the suggestion no longer offers the bare, dead-end clear-by-path route", !reason.includes(`clear-by-path with ${JSON.stringify({ repoPath: s })}`));
  check("*** THE FIX *** it instead names the SAME two-step sequence text", reason.includes("clear each contributor's own quarantine directly FIRST"));
  check("*** THE FIX *** and discloses that clearing by s's own path would itself refuse right now", reason.includes("would itself refuse right now"));
}

// ===================== (text-c) a provenanceUnknown shape must NEVER be pointed at clear-broad-union =====================
// CR item 2: clear-broad-union refuses outright for a provenanceUnknown entry (it cannot enumerate an
// exact victim set) — the remediation text must branch on `ambiguous.unknownProvenance` and name ONLY
// the manual-edit escape for this shape, never the route it would be a dead end for.
{
  const s = freshRepo("text-c-s");
  const r = freshRepo("text-c-r");
  const ks = canonicalRepoLockKey(s);
  const kr = canonicalRepoLockKey(r);
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ks)}.json`), JSON.stringify({
    repoPath: s, branch: "s-branch", reason: "pre-existing, provenance-unknown union (text-c)",
    enteredAt: Date.now() - 60_000, tokens: ["s-token", "r-token"],
    resolvedKey: kr, identityAtRaise: ks, contributorRepoPaths: [r], provenanceUnknown: true,
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);
  check("(text-c precondition) the entry genuinely carries provenanceUnknown:true", activeMergeQuarantineFor(s)?.provenanceUnknown === true);
  check("(text-c precondition) clearBroadUnion itself refuses for this exact entry", clearBroadUnion(s, [], true).ok === false);

  const result = clearMergeQuarantineReporting(s);
  const reason = result.reason ?? "";
  check("(text-c) the two-step sequence phrase is still present verbatim", reason.includes("clear each contributor's own quarantine directly FIRST"));
  check("*** THE FIX (CR item 2) *** the text NEVER names clear-broad-union for a provenanceUnknown shape", !reason.includes("/internal/merge-quarantine/clear-broad-union"));
  check("*** THE FIX *** it names the provenance-unknown reason explicitly", reason.toLowerCase().includes("provenance is also unknown"));
  check("*** THE FIX *** it still names the manual-edit escape directly (no LAST RESORT gate — there is no earlier route to try first)", reason.includes("a manual edit") && reason.includes("GET /internal/merge-quarantine/list") && reason.includes("restart the daemon"));

  // --- REST-body proof (CR item 2's own instruction) ---
  const TMP = mkdtempManaged("loom-mq9497bb7e-textc-gw-");
  const PORT = 47100 + (process.pid % 400);
  const H = { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, "content-type": "application/json" };
  const db = new Db(path.join(TMP, "loom.db"));
  const now = new Date().toISOString();
  db.insertProject({
    id: "projTextC", name: "ProjTextC", repoPath: s, vaultPath: s, config: {}, createdAt: now,
    archivedAt: null, reserved: false, referenceRepos: [], repos: [],
  });
  const stub = {};
  const app = await buildServer({
    db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
    userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
  });
  try {
    const clearS = await app.inject({ method: "POST", url: "/internal/merge-quarantine/clear", headers: H, payload: { projectId: "projTextC" } });
    check("(text-c rest) POST /clear -> 200", clearS.statusCode === 200);
    const bodyS = clearS.json();
    check("*** THE FIX, AT THE REST SURFACE *** the response body NEVER names clear-broad-union for this shape", !(bodyS.reason ?? "").includes("/internal/merge-quarantine/clear-broad-union"));
    check("*** THE FIX, AT THE REST SURFACE *** it names the manual-edit escape instead", (bodyS.reason ?? "").includes("restart the daemon"));
  } finally {
    await app.close();
    db.close();
  }
}

// ===================== (text-d) ENUMERATE every shape remediationTextFor can describe: a text naming =====================
// ===================== clear-broad-union must ALWAYS be for a shape that route genuinely accepts =====================
// CR item 2's own rule, verified mechanically rather than asserted by hand: for each fixture builder below,
// read the remediation text, and if (and only if) it names clear-broad-union, a SEPARATE, freshly-built
// instance of the SAME shape's own dryRun call must report ok:true. A text that names the route for a
// refusing shape — or silently omits it for a shape that genuinely accepts — fails this check.
//
// @decision 9497bb7e — each shape is a BUILDER called TWICE on two distinct repos — reading routeAccepts
// and namesRoute off ONE instance would see `resolveQuarantineFor`'s own graduation mutate it mid-check.
{
  function buildOrdinary(tag) {
    const s = freshRepo(`${tag}-s`); const r = freshRepo(`${tag}-r`);
    const ks = canonicalRepoLockKey(s); const kr = canonicalRepoLockKey(r);
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ks)}.json`), JSON.stringify({
      repoPath: s, branch: "s-branch", reason: `ordinary (${tag})`, enteredAt: Date.now() - 60_000,
      tokens: ["s-token", "r-token"], resolvedKey: kr, identityAtRaise: ks, contributorRepoPaths: [r],
    }, null, 2) + "\n");
    reenterMergeQuarantinesAtBoot([]);
    return s;
  }
  function buildProvenanceUnknown(tag) {
    const s = freshRepo(`${tag}-s`); const r = freshRepo(`${tag}-r`);
    const ks = canonicalRepoLockKey(s); const kr = canonicalRepoLockKey(r);
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ks)}.json`), JSON.stringify({
      repoPath: s, branch: "s-branch", reason: `provunk (${tag})`, enteredAt: Date.now() - 60_000,
      tokens: ["s-token", "r-token"], resolvedKey: kr, identityAtRaise: ks, contributorRepoPaths: [r],
      provenanceUnknown: true,
    }, null, 2) + "\n");
    reenterMergeQuarantinesAtBoot([]);
    return s;
  }
  function buildPlaceholder(tag) {
    const s = freshRepo(`${tag}-s`); const r = freshRepo(`${tag}-r`);
    setActiveQuarantineTestOnly(canonicalRepoLockKey(s), {
      repoPath: s, branch: PLACEHOLDER_BRANCH_UNREADABLE, placeholder: true,
      reason: `placeholder (${tag})`, enteredAt: Date.now() - 60_000, tokens: ["s-token", "r-token"],
      contributorRepoPaths: [r],
    });
    return s;
  }
  // The tied-pending-twin shape is deliberately NOT a builder here — see (text-e) below for why it
  // cannot be meaningfully asserted through this same enumeration loop.

  // CR round 3 (the reviewer's own probe-mirror.mjs): two DISTINCT active entries sharing one repoPath
  // identity under different keys — B (a placeholder, inserted first, armed at an unrelated kx) and A (an
  // ordinary stranded union, armed at its own [ks, kr]). The ORDINARY route's own `resolveQuarantineFor`
  // resolves to A (it recomputes s's REAL canonical key, ks, and finds A there directly); the OLD
  // `clearBroadUnion`'s own identity-scan (`activeMatchesAndLiftedKeysFor` + `matched.find`) picked B
  // instead (Map insertion order put B first) — text said "accepts" (judging A) while the route refused
  // (having selected B) — exactly the disagreement `broadUnionTargetFor` now closes by construction: BOTH
  // sides call the SAME function, so there is only ever one selection to agree or disagree with.
  function buildTwoEntryAmbiguous(tag) {
    const s = freshRepo(`${tag}-s`); const r = freshRepo(`${tag}-r`); const r2 = freshRepo(`${tag}-r2`);
    const x = freshRepo(`${tag}-x`);
    const ks = canonicalRepoLockKey(s); const kr = canonicalRepoLockKey(r); const kx = canonicalRepoLockKey(x);
    // B first (insertion order = activeQuarantines iteration order): placeholder, repoPath s, at kx.
    setActiveQuarantineTestOnly(kx, {
      repoPath: s, branch: PLACEHOLDER_BRANCH_UNREADABLE, placeholder: true, reason: `B placeholder (${tag})`,
      enteredAt: Date.now() - 90_000, tokens: ["b-token"], contributorRepoPaths: [r2], armedKeys: [kx],
    });
    // A: ordinary stranded union, repoPath s, own key ks + stale contributor key kr.
    const A = {
      repoPath: s, branch: "A ordinary", reason: `A ordinary (${tag})`, enteredAt: Date.now() - 60_000,
      tokens: ["s-token", "r-token"], identityAtRaise: ks, contributorRepoPaths: [r], armedKeys: [ks, kr],
      genuineContributorKeys: [kr],
    };
    setActiveQuarantineTestOnly(ks, A);
    setActiveQuarantineTestOnly(kr, A);
    return { s, ks, kr, kx };
  }

  const shapes = [
    { name: "ordinary-stranded", build: buildOrdinary, expectAccepts: true },
    { name: "provenanceUnknown", build: buildProvenanceUnknown, expectAccepts: false },
    { name: "unreadable-placeholder", build: buildPlaceholder, expectAccepts: false },
    { name: "two-entries-same-identity", build: (tag) => buildTwoEntryAmbiguous(tag).s, expectAccepts: false },
  ];

  for (const shape of shapes) {
    const sForAccept = shape.build(`text-d-${shape.name}-accept`);
    const routeAccepts = clearBroadUnion(sForAccept, [], true).ok === true;
    check(`(text-d, ${shape.name}) clearBroadUnion's own dryRun acceptance matches the fixture's own expectation`, routeAccepts === shape.expectAccepts);

    const sForText = shape.build(`text-d-${shape.name}-text`);
    const result = clearMergeQuarantineReporting(sForText);
    const reason = result.reason ?? "";
    const namesRoute = reason.includes("/internal/merge-quarantine/clear-broad-union");
    check(`*** THE RULE (text-d, ${shape.name}) *** the text names clear-broad-union IF AND ONLY IF the route genuinely accepts this exact entry`, namesRoute === routeAccepts);
  }

  // Direct proof of the reviewer's own probe, beyond the generic loop above: EVERY text site built on
  // this same ambiguous shape resolves the SAME (refused) verdict for s — never A silently "accepted" by
  // one path while B (or another) is what a different path actually selects (CR round 4: widened from
  // just clearMergeQuarantineReporting to assertRepoNotQuarantined and the clear-by-id ambiguous branch).
  {
    const { s, kx } = buildTwoEntryAmbiguous("text-d-two-entry-direct");
    const dry = clearBroadUnion(s, [], true);
    check("*** THE PROBE, DIRECTLY *** clearBroadUnion refuses (never silently picks A or B)", dry.ok === false);
    check("*** THE PROBE, DIRECTLY *** the refusal names the ambiguity explicitly", (dry.reason ?? "").includes("DIFFERENT active quarantine entries sharing this exact identity"));
    const rep = clearMergeQuarantineReporting(s);
    check("*** THE PROBE, DIRECTLY *** the ordinary route's own text does NOT claim clear-broad-union accepts", !(rep.reason ?? "").includes("/internal/merge-quarantine/clear-broad-union"));
    const assertResult = assertRepoNotQuarantined(s);
    check("*** THE PROBE, DIRECTLY (assertRepoNotQuarantined) *** also does NOT claim clear-broad-union accepts", !(assertResult.reason ?? "").includes("/internal/merge-quarantine/clear-broad-union"));
    // clear-by-id on B's own key (kx): reaches B via activeMatch, hits the ambiguous branch (B carries its
    // own contributor r2), and builds remediation text for repoPath s — the SAME identity, so it must
    // agree too, regardless of which of the two colliding entries the id itself happened to address.
    const byId = clearMergeQuarantineLatchFile(hashForKey(kx));
    check("*** THE PROBE, DIRECTLY (clear-by-id ambiguous branch) *** also does NOT claim clear-broad-union accepts", !(byId.reason ?? "").includes("/internal/merge-quarantine/clear-broad-union"));
  }
}

// ===================== (text-e) the TIED PENDING TWIN shape, named for what text-d does NOT cover ====
// @decision 9497bb7e (CR round 3) — see the decision record's own "Do not" list for the short form of
// the construction-vs-graduation point this comment restates at length.
//
// `clearMergeQuarantineReporting`'s own `before = resolveQuarantineFor(repoPath)` graduates (absorbs) a
// tied pending twin of the SAME identity as an unavoidable PRECONDITION of resolving quarantine status at
// all — so by the time ANY remediation text is built on that same call, the twin this card's own refusal
// (8) exists to protect has ALREADY been resolved away. This shape is deliberately NOT in (text-d)'s own
// enumeration: asserting `canUseBroadUnion:false` there would assert something this call path cannot
// actually produce, not verify the rule. Two things ARE verified instead: (a) reached THIS way (via the
// ordinary route), the text's "accepts" claim is genuinely true for the SAME instance right afterward —
// never a stale/misleading claim; (b) reached DIRECTLY (clearBroadUnion's own dryRun, bypassing the
// ordinary route and its graduation side effect), the twin is still there and the route still refuses —
// scenario (8) in the Phase 2 test file is the authoritative proof of that refusal; this just confirms the
// SAME shape, built fresh here, behaves identically before this file's own builder runs anything on it.
{
  const s = freshRepo("text-e-pendingtwin-s");
  const r = freshRepo("text-e-pendingtwin-r");
  const ks = canonicalRepoLockKey(s);
  const kr = canonicalRepoLockKey(r);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ks)}.json`), JSON.stringify({
    repoPath: s, branch: "s-branch", reason: "pendingtwin (text-e)", enteredAt: Date.now() - 60_000,
    tokens: ["s-token", "r-token"], resolvedKey: kr, identityAtRaise: ks, contributorRepoPaths: [r],
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);
  pushPendingQuarantineTestOnly({
    repoPath: s, branch: "twin-branch", reason: "a separate pending record (text-e)",
    enteredAt: Date.now(), tokens: ["twin-token"],
  }, "text-e-pending-twin.json");

  check("(text-e, direct) clearBroadUnion's OWN dryRun, called BEFORE anything else touches this entry, refuses", clearBroadUnion(s, [], true).ok === false);

  const result = clearMergeQuarantineReporting(s);
  const reason = result.reason ?? "";
  check("(text-e, via ordinary route) the text names clear-broad-union (its own precondition was already resolved by this same call)", reason.includes("/internal/merge-quarantine/clear-broad-union"));
  check("*** VERIFIED, NOT ASSUMED (text-e) *** immediately afterward, THIS SAME instance genuinely does accept — the text's claim was true, not stale", clearBroadUnion(s, [], true).ok === true);
}

// ===================== (negative-control) an ordinary, unrelated "ANOTHER repo" case is UNCHANGED =====================
// A plain ancestor-walk-to-a-genuinely-unrelated-entry query (no contributors at all) must keep the
// ORIGINAL, unconditional clear-by-path suggestion — proves the fix is scoped to the guard firing, not a
// blanket rewrite of this branch.
{
  const rPlain = freshRepo("negctrl-r");
  enterMergeQuarantine(rPlain, "r-branch", "negative control: plain quarantine, no contributors");
  const ghostSubdir = path.join(rPlain, "never-raised-subdir");
  const result = clearMergeQuarantineReporting(ghostSubdir);
  const reason = result.reason ?? "";
  check("(negative-control) reports the pre-existing 'ANOTHER repo's own, separate quarantine' wording", reason.includes("ANOTHER repo's own, separate quarantine"));
  check("*** NEGATIVE CONTROL *** the plain clear-by-path suggestion is UNCHANGED (no contributor guard to route around)", reason.includes(`clear-by-path with ${JSON.stringify({ repoPath: rPlain })}`));
  check("*** NEGATIVE CONTROL *** the two-step sequence text is NOT present here (nothing to hedge)", !reason.includes("clear each contributor's own quarantine directly FIRST"));
  clearMergeQuarantine(rPlain);
}

// ===================== (rest) the surface the human actually reads: the REST response body =====================
// Card 9497bb7e's own DoD: a producer-side string with no consumer test doesn't count (project lesson
// 279). S is given a REGISTERED project (so `/clear {projectId}` can even be invoked at all); R is
// deliberately given NO project — proving the "no REST route can reach it" half of the fix is itself true,
// not just reworded.
{
  const { s, r } = buildStrandedFixture("rest");
  checkPrecondition("rest", s, r);

  const TMP = mkdtempManaged("loom-mq9497bb7e-gw-");
  const PORT = 46700 + (process.pid % 400);
  const H = { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, "content-type": "application/json" };
  const db = new Db(path.join(TMP, "loom.db"));
  const now = new Date().toISOString();
  db.insertProject({
    id: "projS", name: "ProjS", repoPath: s, vaultPath: s, config: {}, createdAt: now,
    archivedAt: null, reserved: false, referenceRepos: [], repos: [],
  });
  // R is deliberately left unregistered — no project anywhere names it.
  check("(rest precondition) no project resolves to r", db.listAllRegisteredRepoPaths().every((p) => p !== r));
  const stub = {};
  const app = await buildServer({
    db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
    userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
  });
  try {
    const clearS = await app.inject({ method: "POST", url: "/internal/merge-quarantine/clear", headers: H, payload: { projectId: "projS" } });
    check("(rest) POST /clear {projectId:projS} -> 200", clearS.statusCode === 200);
    const bodyS = clearS.json();
    check("(rest) the REST response body carries wasQuarantined:true (refused, nothing lifted)", bodyS.wasQuarantined === true && (bodyS.liftedRepoPaths ?? []).length === 0);
    check("*** THE FIX, AT THE REST SURFACE *** the response body's own reason hedges the project-resolved route on registration", (bodyS.reason ?? "").includes("IF one is registered there"));
    check("*** PHASE 2 FIX, AT THE REST SURFACE *** the response body names clear-broad-union as the supported escape", (bodyS.reason ?? "").includes("/internal/merge-quarantine/clear-broad-union"));
    check("*** PHASE 2 FIX, AT THE REST SURFACE *** the response body demotes the manual edit to a LAST RESORT", (bodyS.reason ?? "").includes("LAST RESORT") && (bodyS.reason ?? "").includes("restart the daemon"));

    const clearByPathR = await app.inject({ method: "POST", url: "/internal/merge-quarantine/clear-by-path", headers: H, payload: { repoPath: r } });
    check("(rest) POST /clear-by-path {repoPath:r} -> 200", clearByPathR.statusCode === 200);
    const bodyR = clearByPathR.json();
    check("(rest) the REST response body reports wasQuarantined:false, stillQuarantined:true for r", bodyR.wasQuarantined === false && bodyR.stillQuarantined === true);
    check("*** THE FIX, AT THE REST SURFACE *** no dead-end clear-by-path-on-s suggestion reaches the human", !(bodyR.reason ?? "").includes(`clear-by-path with ${JSON.stringify({ repoPath: s })}`));
    check("*** THE FIX, AT THE REST SURFACE *** the human-facing reason instead carries the two-step sequence", (bodyR.reason ?? "").includes("clear each contributor's own quarantine directly FIRST"));
  } finally {
    await app.close();
    db.close();
  }
}

// ===================== (manual-escape) the named fallback actually works, end to end =====================
// Proves the text's own claimed escape is truthful, not merely newly-worded: delete S's own latch file(s)
// by latch id (per the text's own recipe) and restart (a real reboot, a fresh child process) — S must
// read clear afterward. This also demonstrates the text's own warning is accurate: R is NOT independently
// protected anywhere else, so this manual escape genuinely does destroy its quarantine too.
{
  const { s, r } = buildStrandedFixture("manual-escape");
  checkPrecondition("manual-escape", s, r);

  const entry = activeMergeQuarantineFor(s);
  const ids = quarantineLatchFileIdsFor(entry);
  const onDiskIds = ids.filter((id) => fs.existsSync(path.join(MERGE_QUARANTINE_DIR, `${id}.json`)));
  check("(manual-escape precondition) at least one on-disk latch file exists for s's own union", onDiskIds.length > 0);
  // Confirm the file's own repoPath before deleting, per the text's own recipe.
  for (const id of onDiskIds) {
    const onDisk = JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, `${id}.json`), "utf8"));
    check(`(manual-escape) latch file ${id} genuinely belongs to s before deleting it`, onDisk.repoPath === s);
    fs.unlinkSync(path.join(MERGE_QUARANTINE_DIR, `${id}.json`));
  }

  // A REAL reboot — a fresh child process re-scanning MERGE_QUARANTINE_DIR from scratch — proves this is a
  // durable release, not merely an in-process one.
  const outFile = path.join(os.tmpdir(), `loom-mq9497bb7e-reboot-out-${sfx}.json`);
  const childScript = `
    const fs = (await import("node:fs")).default;
    const { reenterMergeQuarantinesAtBoot, assertRepoNotQuarantined } = await import(${JSON.stringify(mergeQuarantineModuleUrl)});
    reenterMergeQuarantinesAtBoot([${JSON.stringify(s)}, ${JSON.stringify(r)}]);
    const out = { sOk: assertRepoNotQuarantined(${JSON.stringify(s)}).ok, rOk: assertRepoNotQuarantined(${JSON.stringify(r)}).ok };
    fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify(out));
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", childScript], { env: { ...process.env, LOOM_HOME: loomHome } });
  const rebootResult = JSON.parse(fs.readFileSync(outFile, "utf8"));
  fs.rmSync(outFile, { force: true });
  check("*** THE NAMED ESCAPE WORKS *** s reads clear after the manual delete + restart", rebootResult.sOk === true);
  check("*** THE TEXT'S OWN WARNING IS ACCURATE *** r's quarantine was destroyed too (no separate record survived)", rebootResult.rOk === true);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nAll checks PASSED");
}
