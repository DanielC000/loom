import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card f683a5ad — the shared mainline-move tripwire's own `checkMainlineMove` used to let its `store()`
// closure (card 2a6a292a round 6) ALSO stamp the per-branch TRUST record from `classifyMainlineMove`'s
// own forgeable verdict (attacker-writable reflog message + commit-trailer text), which `project_checkout_
// branch`'s round-9/13-hardened exact-match gate then trusted unconditionally. Real git throughout.
//
//   (A) SILENT bypass: a forged commit (same tree as the trusted sha, a forged `Loom-Worker-Branch:`
//       trailer) landed via a forged, PORCELAIN-LOOKING `update-ref -m "commit: x"` ⇒ classifyMainlineMove
//       verdict `explained`, ZERO events — pre-fix, trust silently laundered onto the forged sha; post-fix,
//       trust stays at the pre-existing sha (W still advances — 4fa36502's own protected dedupe, untouched).
//   (B) ALERTED bypass: the same forged parentage, left UNTRAILERED, landed via a BARE `update-ref`
//       (empty message ⇒ raw) ⇒ verdict `alert` (reflog-raw-write) — ONE HIGH event + nudge fire (correct,
//       unaffected by this card) but pre-fix `store()` still laundered trust afterward anyway, and no
//       `mainline-boot-alerted` marker exists yet to block a manager's very next checkout/create call.
//   Both (A) and (B) assert END-TO-END through the real `checkoutProjectBranch` path (a SWITCH attempt
//   first), not just `getMainlineBranchTrust` — the property that actually matters is that the
//   manager-facing gate still refuses. Measured (not assumed): the FIRST `checkoutProjectBranch({branch:
//   "main"})` call itself files the HIGH event + a `mainline-boot-alerted` marker via
//   `refuseIfTargetBranchUntrusted`'s own `fileManagerCheckoutRefusalEvent` — THAT marker is what then
//   also blocks every later create:true call via `hasUnresolvedMainlineAlert` in THIS ordering.
//   (FIRST-SIGHT-THEN-LANDING) a fresh project with no watermark/trust at all: `checkoutProjectBranch`
//   refuses "no trusted baseline on record", naming the real-landing remedy this card added to that text;
//   a genuine landing (through `confirmWorkerMergeTracked`) then establishes W + trust with no human step,
//   and the SAME call now succeeds (no permanent orphan).
//
// ROUND 2 (card f683a5ad round 2, Code Review of 93486f69 — NOT MERGEABLE) — the round-1 fix above closed
// `checkMainlineMove`'s own store(), but `createProjectBranch` branches from W directly (never a
// per-branch trust record — there was nothing of its own to classify for a brand-new name) and W is NOT a
// trust decision (4fa36502's own dedupe still advances it after a non-branch alert). A `create:true` call
// with NO PRIOR switch — the reviewer's own repro — landed a forged tip, payload content and all, PAST
// round 1's fix: the round-1 (A)/(B) assertions above only proved the gate refuses once a PRIOR switch
// attempt has already filed the alert marker that then blocks create:true via `hasUnresolvedMainlineAlert`
// — they never proved create:true refuses on its OWN, called first, with no such marker yet. That is
// corrected by (A2)/(B2) below, each a FRESH fixture calling create:true FIRST.
//   FIX (round 17 of the decision record): `createProjectBranch` now requires `trust(W.branch) ===
//   W.sha` (checked via `refuseIfWatermarkUntrusted`, in BOTH the outer courtesy pre-check and the
//   in-lock re-check) before branching from it at all — the SAME exact-match discipline
//   `refuseIfTargetBranchUntrusted` already applies to the switch TARGET, now also applied to W itself
//   before create:true is allowed to use it as a start point.
//   (NOT-CHECKED-OUT) validates this card's OWN wording fix: the "no trusted baseline" remedy text must
//   never claim a real landing self-heals a branch that ISN'T the one currently checked out (a landing
//   always lands on canonical HEAD, never on an arbitrary named branch) — corrected from the kickoff's own
//   literal "switch back to main" framing, which this test's own author VERIFIED EMPIRICALLY does NOT
//   reproduce a refusal (main's own trust survives a create:true-and-back round trip untouched, by
//   round 6's own "Do not purge a branch's trust record merely because a switch/create moves W" design);
//   the actually-reproducible shape used here instead is a THIRD branch that was never created/switched-to
//   through Loom at all, switched to while a DIFFERENT branch is checked out.
//   (HAND-COMMIT-LOCKOUT) pins the Lead's own ruling: an ordinary, perfectly legitimate manual `git commit`
//   on the canonical branch — made by the owner directly, outside Loom entirely — is INDISTINGUISHABLE
//   from a forged move by design (round 9's whole point), so it correctly produces the SAME HIGH alert +
//   lockout a real attack would, self-heals via the human-only reset route, and the refusal/event text now
//   says so explicitly rather than reading as if the owner's own repo were compromised.
//
// RED-then-GREEN proof (not re-derived here every run — done once at authoring time, recorded in
// docs/decisions/2a6a292a-*.md's round-16/round-17 sections): reverting this card's own `service.ts` diff
// to commit 93486f69 (round 1 alone) makes (A2)/(B2)'s create:true-FIRST calls land the forged tip
// instead of refusing; reverting further, to before 93486f69, also reopens (A)/(B)'s own switch-first
// assertions exactly as round 1's own record already demonstrated.
//
// ROUND 3 (card f683a5ad round 3) — round 2's own `refuseIfWatermarkUntrusted` treated a NULL trust (never
// established at all, the ordinary state of a branch that simply hasn't landed through Loom yet) exactly
// like a genuine MISMATCH: both filed a HIGH `mainline_moved_outside_loom` event + a `mainline-boot-alerted`
// marker. Since round 16, a boot-time true-first-sight seed stamps W but never trust, so EVERY fresh
// project's very first `create:true` hit this — a false alarm that then locked the whole
// `project_checkout_branch` tool via `hasUnresolvedMainlineAlert`.
//   FIX: a null trust is now a QUIET refusal (no event, no marker), mirroring
//   `refuseIfTargetBranchUntrusted`'s own null-trust branch. A genuine mismatch (trust WAS established,
//   the live watermark no longer matches it) is unchanged — still the loud HIGH event + marker, the real
//   security case round 9/17 built. Also fixed: `createProjectBranch`'s "no established mainline
//   watermark" message (reached when W itself is null, e.g. right after a human reset) used to claim the
//   human-only reset route establishes W — false, `resetMainlineWatermark` PURGES it; `adopt` only
//   re-stamps TRUST. Both messages now name the REAL remedies: a genuine landing
//   (worker_merge_confirm/merge_batch) establishes W + trust with no human step; or, after the owner
//   checks the branch out themselves and uses the human-only reset route to establish ITS trust record, a
//   plain (non-create) `project_checkout_branch` call onto that SAME (already-checked-out) branch
//   re-seeds the watermark too, via `checkoutProjectBranch`'s own fixup path.
//   (NULL-TRUST-QUIET) pins the full sequence end to end, probe-verified against this commit, not assumed:
//   fresh project (boot-seeded W, trust null) → create:true is refused QUIETLY (no event, no marker,
//   zero nudges) → a following plain switch is NOT locked out by any marker (it gets its own, separate,
//   unaffected "no trusted baseline" refusal) → a human reset establishes trust but not W → create:true
//   right after the reset still refuses, correctly, on "no established mainline watermark" (not the stale
//   claim) → a plain switch onto the already-checked-out branch re-seeds W → create:true now succeeds.
//   (NULL-TRUST-LANDING) is the OTHER self-heal leg for create:true specifically — a genuine landing ALONE
//   (no human reset, no intervening plain switch) establishes both W and trust and create:true then
//   succeeds right after it; this is the leg round 16's own "accepted cost" section claims holds for
//   create:true, previously cited there without a dedicated test (see that section's own correction).
//   (MISMATCH-STILL-LOUD) is the negative control: a genuine trust mismatch (not null) on create:true still
//   files the loud HIGH event + marker — the fix narrows the null case only, never softens the real one.
//
// NOT covered here (out of scope for this card, unaffected by it): `project-checkout-branch.mjs` owns the
// full refuseIfTargetBranchUntrusted/createProjectBranch surface (case-folding, remote shadows, name
// validation, the TOCTOU races); `mainline-watch.mjs`/`mainline-watch-branch-divert.mjs` own the tripwire's
// own classifier + branch-diverted alert behavior, both unchanged by this card.
// Run: 1) build daemon (pnpm build), 2) node test/mainline-watch-trust-store.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), `loom-no-such-codex-bin-${process.pid}`);
useOwnLoomHome("loom-mw-trust-store-home-");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const MW = await import("../dist/git/mainline-watch.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const IDENT = { GIT_AUTHOR_NAME: "mwts", GIT_AUTHOR_EMAIL: "mwts@loom", GIT_COMMITTER_NAME: "mwts", GIT_COMMITTER_EMAIL: "mwts@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=mwts@loom -c user.name=mwts";
const now = new Date().toISOString();
const noReap = async () => ({ killedPids: [] });
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };

function makeRepo(sfx) {
  const repo = mkdtempManaged(`loom-mwts-repo-${sfx}-`);
  fs.writeFileSync(path.join(repo, "README.md"), "# mwts\n");
  git(repo, "init", "-q", "-b", "main"); git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "user.email", "mwts@loom"); git(repo, "config", "user.name", "mwts");
  commitAll(repo, "init", GIT_ID);
  return repo;
}

function newProject(tag, repo) {
  const sfx = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const projId = `mwts-proj-${sfx}`, agentId = `mwts-agent-${sfx}`, mgrId = `mwts-mgr-${sfx}`;
  const db = new Db();
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, runGate: async () => ({ passed: true, steps: [] }), reapWorktreeProcesses: noReap });
  const nudges = [];
  const origEnqueue = sessions.enqueueDurableMessage.bind(sessions);
  sessions.enqueueDurableMessage = (target, text, ...rest) => { if (String(text).startsWith("[loom:mainline-moved]")) nudges.push(text); return origEnqueue(target, text, ...rest); };
  db.insertProject({ id: projId, name: `MWTS-${tag}`, repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null });
  return { db, sessions, nudges, projId, mgrId, agentId, sfx };
}

const eventsFor = (db, projId) => db.listEventsSince(0, 100000).filter((e) => e.kind === "mainline_moved_outside_loom" && e.detail?.projectId === projId);

// ===================== (A) SILENT bypass: forged porcelain message + forged trailer =====================
{
  const repo = makeRepo("a");
  const C0 = git(repo, "rev-parse", "HEAD");
  const { db, sessions, nudges, projId, mgrId } = newProject("a", repo);
  db.setMeta(MW.mainlineWatermarkKey(projId, "primary"), JSON.stringify({ branch: "main", sha: C0 }));
  db.setMainlineBranchTrust(projId, "primary", "main", C0);

  const tree = git(repo, "rev-parse", "HEAD^{tree}");
  const forged = git(repo, "commit-tree", tree, "-p", C0, "-m", "feat(x): innocuous", "-m", "Loom-Worker-Branch: loom/deadbeef0000");
  git(repo, "update-ref", "-m", "commit: x", "refs/heads/main", forged); // forged, porcelain-LOOKING message

  const eventsBefore = eventsFor(db, projId).length;
  const tip = await sessions.checkMainlineMove({ projectId: projId, repoKey: "primary", repoPath: repo, managerSessionId: mgrId, workerSessionId: null, taskId: null, source: "landing" });
  const eventsAfter = eventsFor(db, projId).length;
  const trustAfter = db.getMainlineBranchTrust(projId, "primary", "main");
  const wAfter = MW.parseMainlineWatermark(db.getMeta(MW.mainlineWatermarkKey(projId, "primary")));

  check("(A) checkMainlineMove returns the forged tip (a tripwire, never a sandbox)", tip === forged);
  check("(A) ZERO events for a fully forged move (forged porcelain message + forged trailer)", eventsAfter === eventsBefore);
  check("(A) ZERO nudges", nudges.length === 0);
  check("(A) THE FIX: the per-branch TRUST record stays at the pre-existing sha — never laundered", trustAfter === C0);
  check("(A) W itself still advances onto the forged sha (4fa36502's own dedupe, unaffected by this card)", wAfter?.sha === forged);

  const switchResult = await sessions.checkoutProjectBranch(mgrId, { branch: "main" });
  check("(A) END-TO-END: checkoutProjectBranch({branch:\"main\"}) is REFUSED — the live (forged) tip does not match its trust record", switchResult.ok === false && /does not match its own trusted baseline/.test(switchResult.error ?? ""));
  const createSame = await sessions.checkoutProjectBranch(mgrId, { branch: "main", create: true });
  check("(A) END-TO-END: create:true of the SAME (compromised) name is ALSO refused", createSame.ok === false);
  const createNew = await sessions.checkoutProjectBranch(mgrId, { branch: "brand-new-a", create: true });
  check("(A) END-TO-END: create:true of a BRAND-NEW name is ALSO refused (blocked by the alert the switch attempt just filed)", createNew.ok === false);
}

// ===================== (B) ALERTED bypass: bare raw update-ref onto an untrailered commit =====================
{
  const repo = makeRepo("b");
  const C0 = git(repo, "rev-parse", "HEAD");
  const { db, sessions, nudges, projId, mgrId } = newProject("b", repo);
  db.setMeta(MW.mainlineWatermarkKey(projId, "primary"), JSON.stringify({ branch: "main", sha: C0 }));
  db.setMainlineBranchTrust(projId, "primary", "main", C0);

  const tree = git(repo, "rev-parse", "HEAD^{tree}");
  const forged = git(repo, "commit-tree", tree, "-p", C0, "-m", "totally unrelated local commit");
  git(repo, "update-ref", "refs/heads/main", forged); // bare — empty reflog message

  const eventsBefore = eventsFor(db, projId).length;
  const markerBefore = db.getMeta(MW.mainlineBootAlertKey(projId, "primary"));
  const tip = await sessions.checkMainlineMove({ projectId: projId, repoKey: "primary", repoPath: repo, managerSessionId: mgrId, workerSessionId: null, taskId: null, source: "landing" });
  const events = eventsFor(db, projId);
  const trustAfter = db.getMainlineBranchTrust(projId, "primary", "main");
  const wAfter = MW.parseMainlineWatermark(db.getMeta(MW.mainlineWatermarkKey(projId, "primary")));
  const markerAfterCheck = db.getMeta(MW.mainlineBootAlertKey(projId, "primary"));

  check("(B) checkMainlineMove still returns the forged tip (a tripwire, never a block)", tip === forged);
  check("(B) exactly ONE HIGH reflog-raw-write event fires", events.length === eventsBefore + 1 && events[events.length - 1]?.detail?.severity === "high" && events[events.length - 1]?.detail?.evidence?.includes("reflog-raw-write"));
  check("(B) exactly one manager nudge is sent", nudges.length === 1);
  check("(B) THE FIX: despite the HIGH alert, trust stays at the pre-existing sha — never laundered", trustAfter === C0);
  check("(B) W still advances onto the forged sha (unaffected by this card)", wAfter?.sha === forged);
  check("(B) no mainline-boot-alert MARKER exists yet from the landing-path sha-level alert itself (only checkoutProjectBranch's own precondition writes one)", markerBefore === undefined && markerAfterCheck === undefined);

  const switchResult = await sessions.checkoutProjectBranch(mgrId, { branch: "main" });
  check("(B) END-TO-END: checkoutProjectBranch({branch:\"main\"}) is REFUSED — the live (forged) tip does not match its trust record", switchResult.ok === false && /does not match its own trusted baseline/.test(switchResult.error ?? ""));
  const markerAfterSwitch = db.getMeta(MW.mainlineBootAlertKey(projId, "primary"));
  check("(B) the refused switch attempt itself files a marker (fileManagerCheckoutRefusalEvent) — THIS is what then blocks create:true below", markerAfterSwitch !== undefined);
  const createNew = await sessions.checkoutProjectBranch(mgrId, { branch: "brand-new-b", create: true });
  check("(B) END-TO-END: create:true of a BRAND-NEW name is ALSO refused", createNew.ok === false);
}

// ===================== (FIRST-SIGHT-THEN-LANDING): no permanent orphan =====================
{
  const repo = makeRepo("c");
  const { db, sessions, mgrId, projId, agentId, sfx } = newProject("c", repo);

  const noTrustResult = await sessions.checkoutProjectBranch(mgrId, { branch: "main" });
  check("(FSL) a fresh project with no watermark/trust yet refuses \"no trusted baseline\"", noTrustResult.ok === false && /no trusted baseline on record/.test(noTrustResult.error ?? ""));
  check("(FSL) the refusal names the self-healing remedy this card added (a real landing establishes trust with no human step)", /worker_merge_confirm.*establishes its trust record automatically|automatically.*no human step needed/.test(noTrustResult.error ?? ""));
  check("(FSL) the refusal still names the human-only reset route too", /mainline-watermark\/reset/.test(noTrustResult.error ?? ""));

  // A genuine landing: a real worker worktree, a real commit, confirmed through the real merge path.
  const taskId = `mwts-fsl-task-${sfx}`, workerId = `mwts-fsl-wkr-${sfx}`;
  db.insertTask({ id: taskId, projectId: projId, title: "feat(x): fsl change", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  registerForCleanup(worktreePath);
  fs.writeFileSync(path.join(worktreePath, "fsl.txt"), "change\n");
  commitAll(worktreePath, "feat(x): fsl change", GIT_ID);
  db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
  const confirmResult = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(FSL) the real landing settles ok", confirmResult.settled === true && confirmResult.ok === true);

  const wAfterLanding = MW.parseMainlineWatermark(db.getMeta(MW.mainlineWatermarkKey(projId, "primary")));
  const trustAfterLanding = db.getMainlineBranchTrust(projId, "primary", "main");
  check("(FSL) the real landing establishes BOTH W and the per-branch trust record, with no human step", wAfterLanding?.sha !== undefined && wAfterLanding.sha === trustAfterLanding);

  const switchAfterLanding = await sessions.checkoutProjectBranch(mgrId, { branch: "main" });
  check("(FSL) checkoutProjectBranch now succeeds — no permanent orphan from the earlier first-sight refusal", switchAfterLanding.ok === true);
}

// ===================== (A2) create:true FIRST, no prior switch — shape A (forged porcelain + trailer) ====
{
  const repo = makeRepo("a2");
  const C0 = git(repo, "rev-parse", "HEAD");
  const { db, sessions, projId, mgrId } = newProject("a2", repo);
  db.setMeta(MW.mainlineWatermarkKey(projId, "primary"), JSON.stringify({ branch: "main", sha: C0 }));
  db.setMainlineBranchTrust(projId, "primary", "main", C0);

  // A real payload, not just an empty-diff forged commit — content laundering is the actual severity.
  fs.writeFileSync(path.join(repo, "evil.txt"), "payload"); git(repo, "add", "evil.txt");
  const tree = git(repo, "write-tree"); git(repo, "reset", "-q"); fs.rmSync(path.join(repo, "evil.txt"));
  const forged = git(repo, "commit-tree", tree, "-p", C0, "-m", "feat(x): innocuous", "-m", "Loom-Worker-Branch: loom/deadbeef0000");
  git(repo, "update-ref", "-m", "commit: x", "refs/heads/main", forged);
  git(repo, "reset", "-q", "--hard");
  await sessions.checkMainlineMove({ projectId: projId, repoKey: "primary", repoPath: repo, managerSessionId: mgrId, workerSessionId: null, taskId: null, source: "landing" });

  const r = await sessions.checkoutProjectBranch(mgrId, { branch: "laundered-a2", create: true });
  check("(A2) THE FIX: create:true called FIRST (no prior switch) is refused — no branch created at the forged tip", r.ok === false);
  check("(A2) the refusal names the untrusted-tip mismatch", /does not match its own trust record|has no trust record on file/.test(r.error ?? ""));
  check("(A2) canonical HEAD never moved off main", git(repo, "rev-parse", "--abbrev-ref", "HEAD") === "main");
  check("(A2) the \"laundered-a2\" branch ref was never created at all — the forged payload has nowhere new to reach", !git(repo, "for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads/").split("\n").includes("laundered-a2"));
  check("(A2) no trust record was ever stamped for the never-created branch name", db.getMainlineBranchTrust(projId, "primary", "laundered-a2") === null);
  // Negative control: an UNFORGED project (trust matches W) still creates cleanly — this isn't a blanket refusal.
  const repo2 = makeRepo("a2-clean");
  const { db: db2, sessions: sessions2, projId: projId2, mgrId: mgrId2 } = newProject("a2-clean", repo2);
  const C0b = git(repo2, "rev-parse", "HEAD");
  db2.setMeta(MW.mainlineWatermarkKey(projId2, "primary"), JSON.stringify({ branch: "main", sha: C0b }));
  db2.setMainlineBranchTrust(projId2, "primary", "main", C0b);
  const clean = await sessions2.checkoutProjectBranch(mgrId2, { branch: "clean-a2", create: true });
  check("(A2) NEGATIVE CONTROL: create:true still succeeds normally when W actually matches its trust record", clean.ok === true && clean.created === true);
}

// ===================== (B2) create:true FIRST, no prior switch — shape B (bare raw update-ref) ==========
{
  const repo = makeRepo("b2");
  const C0 = git(repo, "rev-parse", "HEAD");
  const { db, sessions, projId, mgrId } = newProject("b2", repo);
  db.setMeta(MW.mainlineWatermarkKey(projId, "primary"), JSON.stringify({ branch: "main", sha: C0 }));
  db.setMainlineBranchTrust(projId, "primary", "main", C0);

  fs.writeFileSync(path.join(repo, "evil.txt"), "payload"); git(repo, "add", "evil.txt");
  const tree = git(repo, "write-tree"); git(repo, "reset", "-q"); fs.rmSync(path.join(repo, "evil.txt"));
  const forged = git(repo, "commit-tree", tree, "-p", C0, "-m", "raw");
  git(repo, "update-ref", "refs/heads/main", forged); // bare — empty reflog message
  git(repo, "reset", "-q", "--hard");
  await sessions.checkMainlineMove({ projectId: projId, repoKey: "primary", repoPath: repo, managerSessionId: mgrId, workerSessionId: null, taskId: null, source: "landing" });

  const r = await sessions.checkoutProjectBranch(mgrId, { branch: "laundered-b2", create: true });
  check("(B2) THE FIX: create:true called FIRST (no prior switch) is refused — no branch created at the forged tip", r.ok === false);
  check("(B2) canonical HEAD never moved off main", git(repo, "rev-parse", "--abbrev-ref", "HEAD") === "main");
  check("(B2) the \"laundered-b2\" branch ref was never created at all — the forged payload has nowhere new to reach", !git(repo, "for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads/").split("\n").includes("laundered-b2"));
  check("(B2) no trust record was ever stamped for the never-created branch name", db.getMainlineBranchTrust(projId, "primary", "laundered-b2") === null);
}

// ===================== (NOT-CHECKED-OUT): the "no trusted baseline" remedy must not claim a landing
//                        self-heals a branch that isn't the one currently checked out =====================
{
  const repo = makeRepo("nco");
  const C0 = git(repo, "rev-parse", "HEAD");
  const { sessions, mgrId, projId, db } = newProject("nco", repo);
  db.setMeta(MW.mainlineWatermarkKey(projId, "primary"), JSON.stringify({ branch: "main", sha: C0 }));
  db.setMainlineBranchTrust(projId, "primary", "main", C0);

  const created = await sessions.checkoutProjectBranch(mgrId, { branch: "feat-y", create: true });
  check("(NOT-CHECKED-OUT) setup: create:true succeeds (trust matched), canonical now on feat-y", created.ok === true && git(repo, "rev-parse", "--abbrev-ref", "HEAD") === "feat-y");

  // A raw git branch, never created/checked out through Loom at all — no trust record of its own, and
  // NOT the branch currently checked out (feat-y is).
  git(repo, "branch", "feat-z");
  const r = await sessions.checkoutProjectBranch(mgrId, { branch: "feat-z" });
  check("(NOT-CHECKED-OUT) refuses with \"no trusted baseline\"", r.ok === false && /no trusted baseline on record/.test(r.error ?? ""));
  check("(NOT-CHECKED-OUT) THE FIX: the refusal does NOT claim a real landing would self-heal \"feat-z\" — a landing lands on feat-y (the branch actually checked out), never on feat-z", !/worker_merge_confirm/.test(r.error ?? ""));
  check("(NOT-CHECKED-OUT) the refusal still names create:true and the human reset route", /create:true/.test(r.error ?? "") && /mainline-watermark\/reset/.test(r.error ?? ""));
  // Negative control: the SAME "no trusted baseline" case, but for the branch that IS checked out, DOES
  // still name the landing remedy (this card's fix is conditional, not a blanket removal).
  const rSelf = await sessions.checkoutProjectBranch(mgrId, { branch: "feat-y" });
  check("(NOT-CHECKED-OUT) NEGATIVE CONTROL: feat-y itself is already trusted (create:true stamped it) so this just succeeds, unaffected", rSelf.ok === true);
}

// ===================== (HAND-COMMIT-LOCKOUT): an ordinary owner hand commit triggers the SAME fail-closed
//                        lockout as a forgery — by design — legibly, and the human reset route recovers it
//                        =====================
{
  const repo = makeRepo("hcl");
  const C0 = git(repo, "rev-parse", "HEAD");
  const { db, sessions, mgrId, projId } = newProject("hcl", repo);
  db.setMeta(MW.mainlineWatermarkKey(projId, "primary"), JSON.stringify({ branch: "main", sha: C0 }));
  db.setMainlineBranchTrust(projId, "primary", "main", C0);

  // The owner's own, perfectly ordinary hand commit — nothing forged about it.
  fs.writeFileSync(path.join(repo, "owner.txt"), "owner change\n");
  commitAll(repo, "chore(x): an ordinary hand commit by the owner", GIT_ID);
  const C1 = git(repo, "rev-parse", "HEAD");
  check("(HAND-COMMIT-LOCKOUT) setup: the hand commit genuinely moved main", C1 !== C0);

  // Boot advances W (4fa36502's own dedupe) but — this card's fix — never trust.
  await sessions.checkMainlineMovesOnBoot();
  check("(HAND-COMMIT-LOCKOUT) setup: W advanced to the hand commit, trust did NOT", MW.parseMainlineWatermark(db.getMeta(MW.mainlineWatermarkKey(projId, "primary")))?.sha === C1 && db.getMainlineBranchTrust(projId, "primary", "main") === C0);

  const refused = await sessions.checkoutProjectBranch(mgrId, { branch: "main" });
  check("(HAND-COMMIT-LOCKOUT) THE RULING: an ordinary hand commit produces the SAME HIGH fail-closed refusal a forgery would (round 9's design — kept, not weakened)", refused.ok === false);
  check("(HAND-COMMIT-LOCKOUT) THE FIX: the refusal text says PLAINLY this also fires after an ordinary manual commit outside Loom", /ordinary manual `git commit`/.test(refused.error ?? "") && /by the owner/.test(refused.error ?? ""));
  check("(HAND-COMMIT-LOCKOUT) the refusal names the exact human reset route, checkout-then-reset ordering included", /mainline-watermark\/reset/.test(refused.error ?? "") && /AFTER the checkout, never before/.test(refused.error ?? ""));

  const retry = await sessions.checkoutProjectBranch(mgrId, { branch: "main" });
  check("(HAND-COMMIT-LOCKOUT) a bare retry without the reset stays locked out (dedupe, not a second alert)", retry.ok === false);

  // The human reset route — the owner has already checked out main, so `adopt` reads its real current tip.
  const resetResult = db.resetMainlineWatermark(projId, "primary", { branch: "main", sha: C1 });
  check("(HAND-COMMIT-LOCKOUT) the human-only reset route adopts the hand-committed tip", resetResult.reset === true && db.getMainlineBranchTrust(projId, "primary", "main") === C1);

  const ok = await sessions.checkoutProjectBranch(mgrId, { branch: "main" });
  check("(HAND-COMMIT-LOCKOUT) after the reset, the SAME call now succeeds — fully recovered, no residual lockout", ok.ok === true);
}

// ===================== (NULL-TRUST-QUIET): a boot-seeded W with NO trust yet is a QUIET refusal — never a
//                        HIGH alert/marker — on create:true; a fresh project's first create:true must not
//                        false-alarm the owner and lock the whole tool ===============================
{
  const repo = makeRepo("ntq");
  const { db, sessions, nudges, mgrId, projId } = newProject("ntq", repo);

  // True first sight: boot seeds W silently, never trust (round 16's own fix) — so "main" genuinely has
  // no trust record at all, not merely a stale/mismatched one.
  await sessions.checkMainlineMovesOnBoot();
  const wAfterBoot = MW.parseMainlineWatermark(db.getMeta(MW.mainlineWatermarkKey(projId, "primary")));
  check("(NULL-TRUST-QUIET) setup: boot seeded W, left trust null", wAfterBoot?.sha !== undefined && db.getMainlineBranchTrust(projId, "primary", "main") === null);

  const eventsBefore = eventsFor(db, projId).length;
  const markerBefore = db.getMeta(MW.mainlineBootAlertKey(projId, "primary"));
  const r1 = await sessions.checkoutProjectBranch(mgrId, { branch: "brand-new-ntq", create: true });
  check("(NULL-TRUST-QUIET) create:true FIRST on a null (never-established) trust is refused", r1.ok === false);
  check("(NULL-TRUST-QUIET) THE FIX: NO event is filed for a null trust (not a mismatch)", eventsFor(db, projId).length === eventsBefore);
  check("(NULL-TRUST-QUIET) THE FIX: NO mainline-boot-alert marker is filed either", db.getMeta(MW.mainlineBootAlertKey(projId, "primary")) === markerBefore);
  check("(NULL-TRUST-QUIET) THE FIX: zero nudges sent", nudges.length === 0);
  check("(NULL-TRUST-QUIET) the refusal names the real remedies (a landing, or a checkout+reset)", /worker_merge_confirm\/merge_batch/.test(r1.error ?? "") && /mainline-watermark\/reset/.test(r1.error ?? ""));

  // A plain switch is NOT locked out by any marker — it gets its own (separate, unaffected, pre-existing)
  // quiet "no trusted baseline" refusal from refuseIfTargetBranchUntrusted, never "an unresolved mainline
  // alert already exists" (the marker-driven lockout that pre-fix made the whole tool unusable).
  const r2 = await sessions.checkoutProjectBranch(mgrId, { branch: "main" });
  check("(NULL-TRUST-QUIET) THE FIX: a following plain switch is NOT locked out by a marker", !/unresolved mainline alert/.test(r2.error ?? ""));
  check("(NULL-TRUST-QUIET) that plain switch still fails (no trust yet) but with its own separate quiet message", r2.ok === false && /no trusted baseline on record/.test(r2.error ?? ""));

  // The named remedy: the owner checks "main" out themselves and uses the human-only reset route — this
  // establishes TRUST, never W itself (resetMainlineWatermark always purges W; see db.ts).
  const resetResult = db.resetMainlineWatermark(projId, "primary", { branch: "main", sha: wAfterBoot.sha });
  check("(NULL-TRUST-QUIET) the human reset route establishes trust, never W itself", resetResult.reset === true && db.getMainlineBranchTrust(projId, "primary", "main") === wAfterBoot.sha && MW.parseMainlineWatermark(db.getMeta(MW.mainlineWatermarkKey(projId, "primary"))) === null);

  // create:true right after the reset still refuses — W itself was purged, not merely untrusted — and
  // this card's OTHER fixed message (item 2) must say so honestly, never "the reset route ... must
  // establish one first".
  const r3 = await sessions.checkoutProjectBranch(mgrId, { branch: "brand-new-ntq2", create: true });
  check("(NULL-TRUST-QUIET) THE FIX (item 2): create:true right after the reset is refused on \"no established mainline watermark\"", r3.ok === false && /no established mainline watermark/.test(r3.error ?? ""));
  check("(NULL-TRUST-QUIET) THE FIX (item 2): the message does NOT claim the reset route alone establishes the watermark", !/\(or a human checkout plus the human-only reset route\) must establish one first/.test(r3.error ?? ""));
  check("(NULL-TRUST-QUIET) that message instead names the real re-seed step (a plain switch onto the checked-out branch)", /non-create\) project_checkout_branch/.test(r3.error ?? ""));

  // VERIFY BY PROBE (per the kickoff's own ruling): the named remedy actually works — a plain (non-create)
  // switch onto the already-checked-out branch re-seeds BOTH W and trust, with no further human step.
  const r4 = await sessions.checkoutProjectBranch(mgrId, { branch: "main" });
  check("(NULL-TRUST-QUIET) a plain switch onto the checked-out branch now succeeds and re-seeds the watermark", r4.ok === true);
  check("(NULL-TRUST-QUIET) W is re-established to match the reset's trusted sha", MW.parseMainlineWatermark(db.getMeta(MW.mainlineWatermarkKey(projId, "primary")))?.sha === wAfterBoot.sha);

  // And NOW create:true succeeds — the full self-heal loop actually closes, no permanent orphan.
  const r5 = await sessions.checkoutProjectBranch(mgrId, { branch: "brand-new-ntq3", create: true });
  check("(NULL-TRUST-QUIET) create:true now succeeds — the named remedy chain actually closes the loop", r5.ok === true && r5.created === true);
}

// ===================== (NULL-TRUST-LANDING): the OTHER self-heal path for create:true — a real landing
//                        ALONE, no human reset and no plain switch — closes round 16's own "accepted cost"
//                        self-heal claim for create:true specifically, not just the switch path ==========
{
  const repo = makeRepo("ntl");
  const { db, sessions, mgrId, projId, agentId, sfx } = newProject("ntl", repo);

  // True first sight: boot seeds W silently, never trust (round 16's own fix).
  await sessions.checkMainlineMovesOnBoot();
  check("(NULL-TRUST-LANDING) setup: boot seeded W, left trust null", db.getMainlineBranchTrust(projId, "primary", "main") === null);

  const r1 = await sessions.checkoutProjectBranch(mgrId, { branch: "brand-new-ntl", create: true });
  check("(NULL-TRUST-LANDING) create:true FIRST on a null trust is quietly refused (same as (NULL-TRUST-QUIET))", r1.ok === false);

  // A genuine landing: a real worker worktree, a real commit, confirmed through the real merge path —
  // mirrors (FIRST-SIGHT-THEN-LANDING)'s own proof, but exercises create:true afterward, never a plain
  // switch, since advanceMainlineWatermark stamps BOTH W and trust as a byproduct of the landing itself.
  const taskId = `mwts-ntl-task-${sfx}`, workerId = `mwts-ntl-wkr-${sfx}`;
  db.insertTask({ id: taskId, projectId: projId, title: "feat(x): ntl change", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  registerForCleanup(worktreePath);
  fs.writeFileSync(path.join(worktreePath, "ntl.txt"), "change\n");
  commitAll(worktreePath, "feat(x): ntl change", GIT_ID);
  db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
  const confirmResult = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(NULL-TRUST-LANDING) the real landing settles ok", confirmResult.settled === true && confirmResult.ok === true);

  const wAfterLanding = MW.parseMainlineWatermark(db.getMeta(MW.mainlineWatermarkKey(projId, "primary")));
  const trustAfterLanding = db.getMainlineBranchTrust(projId, "primary", "main");
  check("(NULL-TRUST-LANDING) the landing establishes BOTH W and trust, matching, with no human step", wAfterLanding?.sha !== undefined && wAfterLanding.sha === trustAfterLanding);

  // THE PROOF: create:true succeeds right after the landing alone — no human reset, no intervening plain
  // switch. This is the specific leg round 16's "accepted cost" section claims but neither (FIRST-SIGHT-
  // THEN-LANDING) (which only exercises a plain switch) nor (NULL-TRUST-QUIET) (which recovers via the
  // human reset route) actually proves.
  const r2 = await sessions.checkoutProjectBranch(mgrId, { branch: "brand-new-ntl2", create: true });
  check("(NULL-TRUST-LANDING) create:true now succeeds right after the landing alone — no human step, no plain switch needed first", r2.ok === true && r2.created === true);
}

// ===================== (MISMATCH-STILL-LOUD): a genuine trust MISMATCH (not null) on create:true still
//                        files the loud HIGH event + marker — the fix narrows the null case only, never
//                        softens the real security case ===============================================
{
  const repo = makeRepo("msl");
  const C0 = git(repo, "rev-parse", "HEAD");
  const { db, sessions, nudges, projId, mgrId } = newProject("msl", repo);
  db.setMeta(MW.mainlineWatermarkKey(projId, "primary"), JSON.stringify({ branch: "main", sha: C0 }));
  db.setMainlineBranchTrust(projId, "primary", "main", C0);

  const tree = git(repo, "rev-parse", "HEAD^{tree}");
  const forged = git(repo, "commit-tree", tree, "-p", C0, "-m", "feat(x): innocuous", "-m", "Loom-Worker-Branch: loom/deadbeef0001");
  git(repo, "update-ref", "-m", "commit: x", "refs/heads/main", forged);
  await sessions.checkMainlineMove({ projectId: projId, repoKey: "primary", repoPath: repo, managerSessionId: mgrId, workerSessionId: null, taskId: null, source: "landing" });
  check("(MISMATCH-STILL-LOUD) setup: W moved, trust did not — a genuine mismatch, not a null trust", MW.parseMainlineWatermark(db.getMeta(MW.mainlineWatermarkKey(projId, "primary")))?.sha === forged && db.getMainlineBranchTrust(projId, "primary", "main") === C0);

  const eventsBefore = eventsFor(db, projId).length;
  const r = await sessions.checkoutProjectBranch(mgrId, { branch: "brand-new-msl", create: true });
  check("(MISMATCH-STILL-LOUD) create:true FIRST is refused on the mismatch", r.ok === false);
  const events = eventsFor(db, projId);
  check("(MISMATCH-STILL-LOUD) a HIGH mainline_moved_outside_loom event IS filed for a genuine mismatch — the security case is NOT softened", events.length === eventsBefore + 1 && events[events.length - 1]?.detail?.severity === "high" && events[events.length - 1]?.detail?.evidence?.includes("untrusted-tip-mismatch"));
  check("(MISMATCH-STILL-LOUD) a mainline-boot-alert marker IS filed too", db.getMeta(MW.mainlineBootAlertKey(projId, "primary")) !== undefined);
  check("(MISMATCH-STILL-LOUD) a manager nudge IS sent too", nudges.length === 1);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
