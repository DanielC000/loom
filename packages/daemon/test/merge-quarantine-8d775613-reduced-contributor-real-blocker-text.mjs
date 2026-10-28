import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 8d775613 — from card 3b1944b6's THIRD Code Review (reviewer aaa1c93f, at commit a29f09b1), item 3.
// Card 3b1944b6 records a reduced contributor `sub` in the foreign union R's `reducedContributorRepoPaths`.
// After that reduce, if R's own token is then settled by `clearMergeQuarantineByToken`, the union holds
// only sub's token. `/clear(sub)` was then refused with the text "quarantined by ANOTHER repo's own,
// separate quarantine that this clear never addressed" — FALSE in this shape: the only thing outstanding
// is sub's own raise, recorded as reduced under R's still-quarantined entry.
//
// ROUND 2 (Code Review of 3ef87ee0): the FIRST fix's own `reducedContributorRepoPaths` text claimed
// "folded into another ... entry's own token set ... clearing repoPath directly never lifts a
// contributor" — true for the genuine token-absorption mechanism this card's own scenario hits, but FALSE
// for 3b1944b6's own "shape A" (an independent record cleared via its OWN clear, never absorbed at all —
// clearing it DOES lift something, on the very first call). The marker field cannot tell the two
// mechanisms apart (see the decision record), so the text must stay NEUTRAL — true for both, asserting
// token membership for neither. See docs/decisions/8d775613-name-the-real-blocker-for-a-reduced-contributor.md.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-mq8d775613-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleUrl = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  enterMergeQuarantine, activeMergeQuarantineFor, clearMergeQuarantineReporting,
  clearMergeQuarantineByToken, directPathIdentity, assertRepoNotQuarantined, listActiveMergeQuarantines,
} = await import(mergeQuarantineModuleUrl);
const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
function freshDir(tag) {
  const d = path.join(os.tmpdir(), `loom-mq8d775613-${tag}-${sfx}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function markAsGitRoot(dir) { fs.mkdirSync(path.join(dir, ".git"), { recursive: true }); }
// Code Review of bba5e027 (MINOR, probed): `activeMergeQuarantineFor(sub) === activeMergeQuarantineFor(R)`
// is VACUOUS once sub's fresh key collapses onto R's — that equality holds by construction (the
// ancestor-walk tier resolves sub straight to R) regardless of whether sub's OWN entry object was ever
// cleared. The real question is whether sub's own, distinct entry OBJECT still sits in the active map
// (keyed at its own, now-stale key) — `listActiveMergeQuarantines()` enumerates distinct objects, never
// resolving through the ancestor walk, so it still reports sub's own entry until that entry is actually
// removed.
function hasOwnEntryFor(repoPath) {
  return listActiveMergeQuarantines().some((e) => directPathIdentity(e.repoPath) === directPathIdentity(repoPath));
}

async function withGateway(fn) {
  const TMP = mkdtempManaged("loom-mq8d775613-gw-");
  const PORT = 46400 + (process.pid % 400);
  const H = { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, "content-type": "application/json" };
  const db = new Db(path.join(TMP, "loom.db"));
  const stub = {};
  const app = await buildServer({
    db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
    userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
  });
  try {
    await fn({ app, db, H });
  } finally {
    await app.close();
    db.close();
  }
}

// ===================== (card-shape) the card's own real-git shape, through the REAL REST /clear =====================
// R raises for real (its own marker `.git`). sub = R/sub raises while UNRESOLVABLE (no own `.git`), then
// becomes resolvable (a bare subdir) — collapsing its fresh key onto R's. `clearMergeQuarantineReporting`'s
// own `before` absorbs sub's pending record into R's union (card 3b1944b6's own cross-tier absorption),
// so the FIRST /clear(sub) reaches `reduceForeignUnionContributor` directly (sub was already a recorded
// `contributorRepoPaths` member, never had its own separate record) — the genuine token-absorption shape
// this card is about, distinct from 3b1944b6's own "shape A" (an independent record, never absorbed).
{
  const R = freshDir("cardshape-R");
  markAsGitRoot(R);
  const tr = enterMergeQuarantine(R, "branch-R", "R's own real raise (8d775613 card-shape)");

  const sub = path.join(R, "sub");
  fs.rmSync(sub, { recursive: true, force: true });
  enterMergeQuarantine(sub, "branch-sub", "sub's own raise while unresolvable (8d775613 card-shape)");
  fs.mkdirSync(sub, { recursive: true }); // now resolvable, no own .git — collapses onto R

  const now = new Date().toISOString();

  await withGateway(async ({ app, db, H }) => {
    db.insertProject({
      id: "projSub", name: "ProjSub", repoPath: sub, vaultPath: sub, config: {}, createdAt: now,
      archivedAt: null, reserved: false, referenceRepos: [], repos: [],
    });

    // First /clear(sub) via the REAL REST route — reduces sub out of R's contributorRepoPaths into
    // reducedContributorRepoPaths. Already a fix in itself (the bug fires on the FIRST clear too, not
    // only a later repeat) — asserted here at the REST response body, per lesson 279.
    const first = await app.inject({ method: "POST", url: "/internal/merge-quarantine/clear", headers: H, payload: { projectId: "projSub" } });
    check("(card-shape rest) first POST /clear -> 200", first.statusCode === 200);
    const firstBody = first.json();
    check("(card-shape rest) first clear: wasQuarantined true, nothing lifted", firstBody.wasQuarantined === true && (firstBody.liftedRepoPaths ?? []).length === 0);
    check("*** THE FIX, AT THE REST SURFACE (first clear) *** the NEUTRAL 'recorded as reduced' wording, never 'ANOTHER repo's own'", (firstBody.reason ?? "").includes("recorded as reduced under") && !(firstBody.reason ?? "").includes("ANOTHER repo's own, separate quarantine"));
    check("*** THE FIX *** never overclaims token membership ('token set'/'never lifts a contributor') — that is only true for the OTHER mechanism sharing this marker (see shape-A below)", !(firstBody.reason ?? "").includes("token set") && !(firstBody.reason ?? "").includes("never lifts a contributor"));
    check("(card-shape rest) first clear's reason names R as the host", (firstBody.reason ?? "").includes(R));

    check("(card-shape precondition) sub is durably recorded in R's own reducedContributorRepoPaths", (activeMergeQuarantineFor(R)?.reducedContributorRepoPaths ?? []).includes(directPathIdentity(sub)));

    // Settle R's OWN token — the card's own described trigger. The union now holds only sub's leftover
    // token (THE TOKEN QUESTION, card 3b1944b6 Round 3: R stays armed, never fully lifted by this alone).
    clearMergeQuarantineByToken(R, tr);
    check("(card-shape precondition) R stays active after its own token settles — sub's leftover token keeps it armed", !!activeMergeQuarantineFor(R));

    // Second /clear(sub) via the REAL REST route — the idempotent reduce arm. This is the card's own
    // literal complaint: "refused permanently with the text 'ANOTHER repo's own, separate quarantine'".
    const second = await app.inject({ method: "POST", url: "/internal/merge-quarantine/clear", headers: H, payload: { projectId: "projSub" } });
    check("(card-shape rest) second POST /clear -> 200", second.statusCode === 200);
    const secondBody = second.json();
    check("(card-shape rest) second clear: wasQuarantined true, nothing lifted", secondBody.wasQuarantined === true && (secondBody.liftedRepoPaths ?? []).length === 0);
    check("*** THE FIX, AT THE REST SURFACE (second/repeat clear) *** the NEUTRAL 'recorded as reduced' wording, never 'ANOTHER repo's own'", (secondBody.reason ?? "").includes("recorded as reduced under") && !(secondBody.reason ?? "").includes("ANOTHER repo's own, separate quarantine"));
    check("(card-shape rest) second clear's reason names R as the host", (secondBody.reason ?? "").includes(R));
    check("*** THE FIX *** the text names the real remedy (clearing R is what lifts it)", (secondBody.reason ?? "").includes("is what lifts it"));

    // The remedy actually works: R's own full /clear still fully lifts it (THE TOKEN QUESTION, verified
    // directly rather than assumed), freeing sub too.
    db.insertProject({
      id: "projR", name: "ProjR", repoPath: R, vaultPath: R, config: {}, createdAt: now,
      archivedAt: null, reserved: false, referenceRepos: [], repos: [],
    });
    const clearR = await app.inject({ method: "POST", url: "/internal/merge-quarantine/clear", headers: H, payload: { projectId: "projR" } });
    const clearRBody = clearR.json();
    check("*** THE NAMED REMEDY WORKS *** R's own full /clear(R) fully lifts R", clearRBody.wasQuarantined === true && !activeMergeQuarantineFor(R));
    check("*** THE NAMED REMEDY WORKS *** sub is freed too (its leftover token rode R's own clear)", assertRepoNotQuarantined(sub).ok === true);
  });
}

// ===================== (shape-A) 3b1944b6's OTHER mechanism sharing the SAME marker — through the REAL REST /clear =====================
// R raises for real. sub = R/sub raises with ITS OWN real `.git` (a genuinely independent raise, its own
// key) — never absorbed, never a `contributorRepoPaths` member. sub's `.git` is then removed, collapsing
// its fresh key onto R's. The FIRST `/clear(sub)` genuinely lifts SUB'S OWN RECORD (liftedRepoPaths is
// EMPTY in the response only because nothing of R's own was touched — sub's own clear is reported via the
// `wasQuarantined`/no-lift path the SAME way the card-shape's reduce is; see the precondition check below
// for the real proof sub's own record is gone) and ALSO stamps R's `reducedContributorRepoPaths` with
// sub's identity (3b1944b6 Round 5's own "shape A" fix, via the shared `preClearForeignKeyStamp`
// chokepoint) so a REPEAT `/clear(sub)` doesn't re-open the original over-clear. sub's token was NEVER
// folded into R's token set at any point — this is the exact shape the CONTRIBUTOR wording overclaimed
// for on commit 3ef87ee0 (Code Review finding): "never lifts a contributor" is false on sub's own first
// clear (it DID lift sub's own record), and "folded into ... token set" is false on both clears (it never
// was). Must get the SAME neutral wording the card-shape gets.
{
  const R = freshDir("shapeA-R");
  markAsGitRoot(R);
  enterMergeQuarantine(R, "branch-R", "R's own real raise (8d775613 shape-A)");

  const sub = path.join(R, "sub");
  markAsGitRoot(sub);
  enterMergeQuarantine(sub, "branch-sub", "sub's own independent raise, own .git at raise time (8d775613 shape-A)");
  check("(shape-A precondition) sub has its own, genuinely independent active record before collapse", !!activeMergeQuarantineFor(sub));
  fs.rmSync(path.join(sub, ".git"), { recursive: true, force: true }); // collapses sub onto R's key

  // PROVE THE CHECK BITES: the SAME `hasOwnEntryFor(sub)` predicate used below to confirm sub's own entry
  // is gone AFTER the clear must read the OPPOSITE way right here, BEFORE any clear has run — otherwise
  // it is as vacuous as the `activeMergeQuarantineFor` equality the Code Review flagged.
  check("(shape-A precondition) sub's own entry is STILL in the active map post-collapse, pre-clear (proves the post-clear check below can actually discriminate)", hasOwnEntryFor(sub) === true);

  const now = new Date().toISOString();
  await withGateway(async ({ app, db, H }) => {
    db.insertProject({
      id: "projSubA", name: "ProjSubA", repoPath: sub, vaultPath: sub, config: {}, createdAt: now,
      archivedAt: null, reserved: false, referenceRepos: [], repos: [],
    });

    const first = await app.inject({ method: "POST", url: "/internal/merge-quarantine/clear", headers: H, payload: { projectId: "projSubA" } });
    check("(shape-A rest) first POST /clear -> 200", first.statusCode === 200);
    const firstBody = first.json();
    check("*** THE FIX *** sub's OWN entry is genuinely REMOVED from the active map after the first clear — the over-claim's falsified premise: this clear DID lift something of sub's, it was never a no-op", !hasOwnEntryFor(sub));
    check("(shape-A precondition) R is durably marked with sub's identity in reducedContributorRepoPaths", (activeMergeQuarantineFor(R)?.reducedContributorRepoPaths ?? []).includes(directPathIdentity(sub)));
    check("*** THE FIX, AT THE REST SURFACE (shape-A, first clear) *** the NEUTRAL 'recorded as reduced' wording, never the CONTRIBUTOR clause or 'ANOTHER repo's own'", (firstBody.reason ?? "").includes("recorded as reduced under") && !(firstBody.reason ?? "").includes("recorded CONTRIBUTOR") && !(firstBody.reason ?? "").includes("ANOTHER repo's own, separate quarantine"));
    check("*** THE FIX *** never claims 'never lifts a contributor' — FALSE here: this very clear DID lift sub's own record", !(firstBody.reason ?? "").includes("never lifts a contributor"));
    check("*** THE FIX *** never claims token-set membership — sub's token was never inside R's token set", !(firstBody.reason ?? "").includes("token set"));

    const second = await app.inject({ method: "POST", url: "/internal/merge-quarantine/clear", headers: H, payload: { projectId: "projSubA" } });
    check("(shape-A rest) second POST /clear -> 200", second.statusCode === 200);
    const secondBody = second.json();
    check("*** THE FIX, AT THE REST SURFACE (shape-A, second/repeat clear) *** the SAME neutral wording, never the CONTRIBUTOR clause or 'ANOTHER repo's own'", (secondBody.reason ?? "").includes("recorded as reduced under") && !(secondBody.reason ?? "").includes("recorded CONTRIBUTOR") && !(secondBody.reason ?? "").includes("ANOTHER repo's own, separate quarantine"));
    check("*** THE FIX *** never claims 'never lifts a contributor' on the repeat clear either", !(secondBody.reason ?? "").includes("never lifts a contributor"));

    // THE PREMISE (DoD step 1): clearing R genuinely lifts sub too, for shape-A exactly as for the
    // card-shape — proven via liftedRepoPaths naming sub explicitly, not merely assumed.
    db.insertProject({
      id: "projRA", name: "ProjRA", repoPath: R, vaultPath: R, config: {}, createdAt: now,
      archivedAt: null, reserved: false, referenceRepos: [], repos: [],
    });
    const clearR = await app.inject({ method: "POST", url: "/internal/merge-quarantine/clear", headers: H, payload: { projectId: "projRA" } });
    const clearRBody = clearR.json();
    check("*** THE PREMISE, VERIFIED (shape-A) *** clearing R's own union genuinely names sub in liftedRepoPaths", (clearRBody.liftedRepoPaths ?? []).some((p) => directPathIdentity(p) === directPathIdentity(sub)));
    check("*** THE PREMISE, VERIFIED (shape-A) *** sub reads fully unquarantined afterward", assertRepoNotQuarantined(sub).ok === true);
  });
}

// ===================== (ordinary-unchanged) a genuinely unrelated repo's "ANOTHER repo's own" wording is UNCHANGED =====================
// A plain ancestor-walk to a genuinely unrelated, never-contributor-related entry — no absorption, no
// reduce, no shape-A marking of any kind — must keep the ORIGINAL wording. Proves the fix is scoped to a
// genuine reduced-contributor match, never a blanket rewrite of this branch.
{
  const rPlain = freshDir("ordinary-r");
  markAsGitRoot(rPlain);
  enterMergeQuarantine(rPlain, "r-branch", "ordinary, unrelated quarantine (8d775613 negative control)");
  // Deliberately NEVER created on disk (unresolvable) — a RESOLVABLE ghost subdir fully lifts rPlain in
  // one shot via the plain ancestor-collapse (scenario B), with no `reason` at all to assert on; this
  // negative control needs the unresolvable branch, matching card 9497bb7e's own negative-control shape.
  const ghostSubdir = path.join(rPlain, "never-raised-subdir");

  const now = new Date().toISOString();
  await withGateway(async ({ app, db, H }) => {
    db.insertProject({
      id: "projGhost", name: "ProjGhost", repoPath: ghostSubdir, vaultPath: ghostSubdir, config: {}, createdAt: now,
      archivedAt: null, reserved: false, referenceRepos: [], repos: [],
    });
    const res = await app.inject({ method: "POST", url: "/internal/merge-quarantine/clear", headers: H, payload: { projectId: "projGhost" } });
    check("(ordinary-unchanged rest) POST /clear -> 200", res.statusCode === 200);
    const body = res.json();
    check("*** NEGATIVE CONTROL, AT THE REST SURFACE *** the ordinary 'ANOTHER repo's own, separate quarantine' wording is UNCHANGED", (body.reason ?? "").includes("ANOTHER repo's own, separate quarantine"));
    check("*** NEGATIVE CONTROL *** never the CONTRIBUTOR clause (nothing was ever a contributor here)", !(body.reason ?? "").includes("recorded CONTRIBUTOR"));
    check("*** NEGATIVE CONTROL *** never the reduced-marker clause either (nothing was ever reduced here)", !(body.reason ?? "").includes("recorded as reduced under"));
    check("*** NEGATIVE CONTROL *** the ordinary unconditional clear-by-path suggestion is present (no contributor guard to route around)", (body.reason ?? "").includes(`clear-by-path with ${JSON.stringify({ repoPath: rPlain })}`));
  });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nAll checks PASSED");
}
