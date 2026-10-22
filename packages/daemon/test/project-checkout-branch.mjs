import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 4fabafd1 / @decision 2a6a292a rounds 4-6 — `project_checkout_branch`: a manager-initiated checkout
// switch that re-points the project's mainline watermark to the resulting {branch,sha}, so a subsequent
// landing doesn't need a human reset to clear branchDiverted. REAL git on temp repos throughout.
//
//   (SURF)   the tool is on the manager's orchestration MCP surface, NOT the worker's.
//   (HOME)   Loom's own reserved/operational home is refused.
//   (UNK)    round 10 — an unknown branch is now refused DIRECTLY by this tool's own precondition, never
//            deferred to GitWriter.checkout() (SUPERSEDES the old "reused verbatim" framing — see (DWIM)
//            below for why deferring was itself the CRITICAL #1 bug).
//   (DWIM)   round 10's CRITICAL #1 (sixth Code Review) — a same-named `refs/remotes/<remote>/<branch>`
//            ref existing when no LOCAL branch does is refused with a HIGH event (evidence
//            `remote-tracking-shadow`), never silently adopted via git's own checkout DWIM (which used to
//            be reachable because an unknown branch deferred to GitWriter.checkout() — see (UNK) above).
//   (NAMES)  round 10's MAJOR #2 (sixth Code Review) — "-"/"@{-1}" (git's own previous-branch shorthand),
//            "-bsneaky" (parsed as the -b option), and "refs/heads/x" (a full ref path) are refused BEFORE
//            any git call at all, by a pure pre-git shape check — verified directly that no git-argument-
//            level mitigation (neither `--no-guess` nor a trailing `--`) closes any of these once they
//            reach git. "origin/x" is deliberately NOT rejected by that shape check (it's a legal local
//            branch name too) — it's refused instead by the ordinary "no such local branch" case.
//   (GATE)   REFUSAL — a live/queued gate op of ANY gateType (merge/batch/deploy/worker self-check) on
//            this repo blocks the switch, hard, no override; negative control proves the SAME call
//            succeeds once it clears. Covers BOTH arms: the pending_gate_ops row (round 4) AND the live
//            GateSemaphore snapshot itself — a RUNNING and a QUEUED entry, across merge/batch/deploy kinds.
//   (CUT)    REFUSAL — a worktree cut in flight against this exact repo blocks the switch, hard, no
//            override; negative control proves the same call succeeds once the mark clears. Also proves
//            the refcount is released even when the real `createWorktree` call THROWS (a quarantined repo).
//   (DIRTY)  REFUSAL — a tracked (not untracked) change in the canonical tree blocks the switch.
//   (UNMRG)  REFUSAL — an unmerged worker branch (live OR exited) in the project blocks the switch, named.
//   (TRUST)  REFUSAL (round 6) — an EXISTING branch with no trust record on file is refused outright, not
//            adopted; negative control manually stamps a trust record (the owner-adopt remedy) and the
//            same call then succeeds.
//   (LNDR-1) REFUSAL — laundering: a raw, non-Loom commit on the CURRENTLY-checked-out watermark branch,
//            then a SAME-branch call, is refused + a HIGH mainline_moved_outside_loom event is filed; W
//            is left untouched (never silently adopted as the new baseline).
//   (LNDR-2) REFUSAL — a call targeting an unrelated, cleanly-trusted branch right after LNDR-1 is ALSO
//            refused, but for a DIFFERENT reason: LNDR-1 already filed a project-wide, undelivered
//            mainline alert, which blocks every call for this (project, repoKey) regardless of target
//            until resolved. (This is AWAY-ONLY, never completing a round trip — the genuine
//            away-and-back shape, with no pre-existing alert in the way, is B1 below.)
//   (CREATE) round 6's `create:true`: makes a brand-new branch at W's CURRENT sha (never a caller start
//            point), refuses an existing name / an invalid name / a `loom/`-prefixed name, and a real
//            landing on the created branch afterward advances its own trust record.
//   (B1)     round 6's Code Review repro — the genuine away-and-back laundering case round 5 missed:
//            switch away (create+land on atlas), raw-tamper the now-DEPARTED branch, switch back to it →
//            refused, HIGH event filed, W unchanged. Also proves the symmetric "tamper the switch TARGET
//            while parked elsewhere, then switch to it" shape, and that switching back to the ORIGINAL
//            (untouched) branch succeeds cleanly first.
//   (M1)     round 8's fix (fourth Code Review) — six bypasses onto a tip that stays FORWARD of the
//            trusted sha and keeps that branch's reflog fully intact: delete-and-recreate, `branch -f`,
//            `branch -D` + recreate, a forged `update-ref -m "commit: …"` message, a genuine porcelain
//            commit made from a second `git worktree add` while the branch sits parked, and a genuinely
//            NON-ANCESTOR tip. **SUPERSEDED by round 9 (fifth Code Review, see (FORGED)/(FORGED-FIXUP)
//            below): round 8's own "every intervening commit carries a real Loom trailer" fix was ITSELF a
//            bypass — a `Loom-Worker-Branch:` trailer is unauthenticated text (`parseLoomTrailerBlock` is a
//            pure string match), so any of the above onto a tip carrying a PLANTED trailer passed round
//            8's check and was silently adopted.** Round 9 deletes ALL git-derived classification from this
//            gate — every repro below (trailered or not) is refused for the SAME reason now
//            (`evidence` includes `untrusted-tip-mismatch`, the one tag this gate ever files), not because
//            of what the commit itself carries. EACH repro gets its OWN fresh fixture and asserts the
//            filed event's evidence tag, never just `refused === true` — a shared fixture let round 7's own
//            M1 test pass for the wrong reason (a sibling repro's own leftover alert marker, not that
//            repro's own classification). Negative control: ONLY an EXACT match to the trust record is
//            allowed — a real, multi-commit, Loom-trailered chain is refused the instant trust lags even
//            ONE landing behind the live tip (the accepted cost of round 9, see the decision record); an
//            ordinary, non-trailered commit is refused too, same as before.
//   (FORGED) round 9's own repros (fifth Code Review, CRITICAL) — a tip carrying a FORGED
//            `Loom-Worker-Branch:` trailer (a real commit whose message plants the exact trailer text a
//            genuine Loom landing writes, with no actual landing ever having happened) is refused exactly
//            like any other non-matching tip, via `branch -f` (P1) and a forged `update-ref -m "commit: …"`
//            (P2) — both would have been silently ADOPTED under round 8's own "forward + every commit
//            trailered" rule.
//   (FORGED-FIXUP) round 9's own repro (P3) — the SAME forged-trailer tip, reached via the "already
//            checked out, W disagrees" fixup path (round 8's MAJOR #2) instead of an ordinary switch: the
//            canonical repo is ALREADY on the forged branch (an out-of-band raw checkout, not through this
//            tool) and W points elsewhere, so `checkoutProjectBranch` re-runs the full precondition
//            in-lock and must refuse there too, not just on the ordinary-switch path.
//   (FIXUP-TOCTOU) round 9's own test-vacuity fix (MINOR, fifth Code Review) — the fixup path's OWN in-lock
//            precondition re-run (the `withCanonicalIndexLock` block inside `checkoutProjectBranch`'s
//            "already checked out, W disagrees" branch) had no TOCTOU test proving it actually closes the
//            same race (S2) proves for the ordinary-switch path. A hook-sequenced tamper (the same
//            call-counting technique (S2)/(N2) use) inserted between the fixup path's own outer courtesy
//            pre-check and its in-lock re-run proves the re-run — not the stale outer read — is what
//            actually decides the outcome.
//   (REWIND) round 9's own test-vacuity fix (MAJOR, fifth Code Review) — a parked branch with TWO real
//            (trailered) landings, trust rolled to the SECOND, forced BACKWARD via `branch -f` onto the
//            FIRST — a genuinely real, Loom-authored commit, just not the CURRENT trust record — is
//            refused, same as any other mismatch (no special-case rewind logic exists; this just proves
//            the exact-match rule was never accidentally exercised only in the "forward" direction).
//   (ALERT)  REFUSAL — ANY existing (even unrelated/delivered) mainline alert marker for (project,repoKey)
//            blocks the switch outright — a manager must never clear the owner's alarm as a purge side
//            effect. (S3) EXCEPT the purely-informational `first-sight-declined` marker, which does not.
//   (NOOP)   calling the tool on the branch ALREADY checked out is a no-op: no checkout, no re-point,
//            after every refusal above still ran and passed.
//   (S1)     round 6 — the unmerged-worker refusal is scoped to a worker that is LIVE or whose worktree
//            still exists on disk; an exited worker whose worktree was already removed no longer blocks.
//   (S2)     round 6 — a TOCTOU race: a worker inserted between the courtesy pre-check (outside the lock)
//            and the in-lock `precondition` admission is still caught by the latter. Round 7 (M3-i) fixes
//            the race's own ORDERING proof with a call-counting hook, rather than a bare synchronous-vs-
//            async timing assumption that could land the insertion before the outer pre-check even ran.
//   (N1)     round 6 — `GitWriter.checkout()`'s post-checkout sha read degrades to `sha:null` instead of
//            failing the whole call when it times out AFTER the checkout already succeeded.
//   (LEAD)   the Platform Lead's own (pre-existing, unrelated) `git_checkout` does NOT re-point W.
//   (RESET)       round 7 (M2) — the human-only reset route's own `Db.resetMainlineWatermark(…, adopt)`
//                 re-stamps the adopted branch's trust record, closing the dead end where a reset cleared
//                 W but left the just-adopted branch refusing with "no trusted baseline" on the next call.
//   (DEDUPE)      round 7 (m4) — two identical `refuseIfTargetBranchUntrusted` refusals in a row file only
//                 ONE HIGH event, not two.
//   (DEDUPE-RESET) round 8 (m4 under-alert fix) — a retry on the SAME (branch, from, to) AFTER a human
//                 reset (which never touches the branch's own trust record) files a FRESH event instead
//                 of silently matching the pre-reset one, closing the gap where the refusal text claimed
//                 an event was filed while the dedupe had actually suppressed it.
//   (ALERT-LOCK)  round 7 (m3) — the unresolved-alert check now runs INSIDE the lock too (a TOCTOU race,
//                 same shape as S2 but for the alert marker instead of an unmerged worker).
//   (CREATE-DRIFT) round 7 (M3-ii) — create:true branches at W's own sha even when HEAD has drifted past
//                 it with no Loom landing (previously untested).
//   (N2)          round 8 (n2) — createProjectBranch re-reads W INSIDE the lock, not the stale outer read,
//                 closing a TOCTOU window on the branch-off point itself; the race insertion is sequenced
//                 via a `db.getMeta` call-counting hook (round 8 — the same technique (S2) uses), not a
//                 bare synchronous-ordering assumption.
//   (N1-MISMATCH) round 7 (n1) — the landed sha is compared against the sha classified clean moments
//                 earlier inside the SAME lock; a mismatch refuses rather than trusting the two reads
//                 implicitly agree. Round 8's negative control also asserts W actually MOVED on the retry
//                 (MAJOR #2 below), not merely `ok:true`. **ROUND 11 (CR8, item 2):** the mismatch now
//                 ALSO files the same HIGH mainline_moved_outside_loom event every other refusal in this
//                 gate files, so a bare retry is refused by the resulting alert too — the negative control
//                 now clears it first (the human-only reset's own effect), same as (ALERT) above.
//   (N1-SERVICE)  round 7 (M3-iii) — checkoutProjectBranch's OWN `sha:null` handling, exercised through
//                 the real method (a `GitWriter.prototype.checkout` patch, not a fake GitWriter) — the
//                 round-6 (N1) scenario above could only reach GitWriter.checkout() itself, never this.
//                 Round 8's negative control also asserts W actually MOVED on the retry (MAJOR #2 below).
//   (C3)          round 7 (M3-iii) — checkMainlineMove's BOOT-path store() also re-stamps the per-branch
//                 trust record, not just W.
//   (C7)          round 7 (M3-iii) — a repo rebind (`resetMainlineBaselinesForRepoChange`) wipes every
//                 per-branch trust record too, not just W.
//   (STALE-NOOP)  round 8's MAJOR #2 — the "already checked out" path used to silently report success
//                 WITHOUT fixing a STALE watermark (one left behind on the OLD branch by an earlier
//                 partial failure — sha:null, a classified-tip mismatch, GitWriter reporting a different
//                 branch than requested — all of which mutate the canonical checkout for real before
//                 failing). It now re-validates the full precondition in-lock and re-points W, reporting
//                 `noop:false`; a TRUE no-op (W already agrees) is unchanged. Covered by (N1-MISMATCH)'s
//                 and (N1-SERVICE)'s own strengthened negative controls above, not a separate scenario.
//
// C5 (`advanceMainlineWatermarkForBatch`'s own trust write) is covered in `batch-merge-watermark-branch-
// pin.mjs` instead (its own seed-landing scenario already runs the real merge_batch flow this file does
// not otherwise exercise) — round 8 closes the round-7 documented gap there, not here.
//
// ROUND 12 (seventh Code Review) — findCaseFoldPrefixCollision widens round 11's exact-full-name-only
// case check to any PATH-PREFIX collision, and the remote-tracking shadow match becomes EXACT:
//   (CASEFOLD A/B)   create:true "FEAT" / switch to "FEAT" over a PACKED "feat" — refused, naming "feat".
//   (CASEFOLD C)     switch to "FEAT" over a LOOSE "feat" — the exact CR8 "(C)" case the old rev-parse-
//                    based check could silently resolve via NTFS instead of naming the real collision.
//   (CASEFOLD D1/D2) create:true "FEAT/X" over a packed "feat/x", and the REVERSE shape — create:true
//                    "FEAT/x" over a loose "feat/y" (the candidate's own leaf colliding with an existing
//                    branch's DIRECTORY segment) — both refused; D2 pairs a non-colliding sibling
//                    negative control.
//   (NEVER-TWO-SPELLINGS) the record's own claim, checked directly: no trust record is ever stamped
//                    under a case-colliding spelling.
//   (SHADOW-EXACT)   round 11's `/${branch}` SUFFIX match over-matched `refs/remotes/origin/hotfix/zzz`
//                    as a shadow of a switch to "zzz"; now matched EXACTLY per remote, with a positive
//                    control proving the real shadow shape (`refs/remotes/origin/zzz`) still alerts.
//   (REMOTE-PREFIX-CI) create:true's remote-shadow refusal is now case-insensitive and matches a
//                    multi-segment remote name ("a/b"), not just a single first path segment.
//   (CREATE-REMOTE-SHADOW) create:true "origin/main" refused; switching to an EXISTING "origin/main"
//                    branch (once trusted) stays allowed — round 11's own promised-but-missing test.
//
// ROUND 13 (NINTH Code Review, reviewing round 12's own commits) — both refs/heads listings used
// `%(refname:short)`, which git shortens to `heads/<name>` (never the bare name) whenever "<name>" would be
// AMBIGUOUS with another ref — a same-named TAG, or a `refs/remotes/<name>/HEAD` (git's own DWIM rev-parse
// rules include "refs/remotes/%.*s/HEAD" alongside "refs/tags/%.*s"). Both sites now read
// `%(refname:lstrip=2)` instead, which strips the `refs/heads/` prefix unconditionally with no
// ambiguity-dependent shortening:
//   (R13-TAG-CREATE)      a packed, trusted "feat" plus a same-named TAG used to make create:true "FEAT"
//                    silently succeed (planting a real refs/heads/FEAT sibling) — now refused, naming
//                    "feat".
//   (R13-TAG-SWITCH)      the same tag-ambiguity used to false-refuse a switch to the EXACT existing name
//                    "feat" as "no local branch exists" — now succeeds.
//   (R13-REMOTEHEAD) a refs/remotes/feat/HEAD ref (no configured remote needed — the bare ref is enough)
//                    is a SECOND, independent trigger for the identical bug; both the switch-succeeds and
//                    create-is-refused shapes are covered.
//
// Card 1bc9602b (found by CR9 reviewing round 12, scoped OUT of round 13 above as its own card) —
// `listUnmergedWorkerBranches` (sessions/service.ts) had the IDENTICAL `%(refname:short)` bug as round
// 13's two sites, but on the OTHER side of the shape: it treats a live worker branch MISSING from the
// listing as "gone" (never merged-but-deleted ⇒ safe to ignore), so an ambiguous shortening there makes a
// real, unmerged worker branch look gone and the unmerged-worker refusal silently FAILS OPEN instead of
// false-refusing. Now reads `%(refname:lstrip=2)`, same fix:
//   (UNMRG-TAG)         a same-named TAG on the worker's own `loom/<id>` branch used to make it vanish
//                        from the listing, letting an UNMERGED worker branch through as if merged/gone.
//   (UNMRG-REMOTEHEAD)  a `refs/remotes/<branch>/HEAD` ref sharing the worker branch's own full name is
//                        the second, independent trigger for the identical bug.
//
// Run: 1) build daemon (pnpm build), 2) node test/project-checkout-branch.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
useOwnLoomHome("loom-pcb-home-");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { clearMergeQuarantine, enterMergeQuarantine } = await import("../dist/git/merge-quarantine.js");
const { withCanonicalIndexLock } = await import("../dist/git/repo-lock.js");
const { GitWriter, unsafeBranchNameReason } = await import("../dist/git/writer.js");
const MW = await import("../dist/git/mainline-watch.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const IDENT = { GIT_AUTHOR_NAME: "pcb", GIT_AUTHOR_EMAIL: "pcb@loom", GIT_COMMITTER_NAME: "pcb", GIT_COMMITTER_EMAIL: "pcb@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=pcb@loom -c user.name=pcb";
const noReap = async () => ({ killedPids: [] });
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const PASS_GATE = { passed: true, steps: [{ step: "gate", durationMs: 1, status: 0 }] };

const listToolNames = async (server) => {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st)]);
  const client = new Client({ name: "pcb-test", version: "0" });
  await client.connect(ct);
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  await client.close();
  return names;
};
const parse = (res) => JSON.parse(res.content[0].text);
async function callTool(server, name, args) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st)]);
  const client = new Client({ name: "pcb-test", version: "0" });
  await client.connect(ct);
  const out = parse(await client.callTool({ name, arguments: args }));
  await client.close();
  return out;
}

const db = new Db();
let fxSeq = 0;

/** A fresh repo + project + manager (+ optional platform session) fixture — most scenarios below get
 *  their OWN, so laundering/alert/dirty-tree/unmerged-worker mutations never contaminate another
 *  scenario's own watermark/marker state. */
function makeFixture(label, opts = {}) {
  const sfx = `${Date.now()}-${++fxSeq}-${Math.random().toString(36).slice(2, 6)}`;
  const repo = opts.repoPath ?? path.join(os.tmpdir(), `loom-pcb-${label}-${sfx}`);
  if (!opts.repoPath) {
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# pcb\n");
    git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "pcb@loom"); git(repo, "config", "user.name", "pcb");
    commitAll(repo, "init", GIT_ID);
  }
  const main = opts.repoPath ? null : git(repo, "rev-parse", "--abbrev-ref", "HEAD");
  const now = new Date().toISOString();
  const projId = `pcb-${label}-proj-${sfx}`, agentId = `pcb-${label}-agent-${sfx}`, mgrId = `pcb-${label}-mgr-${sfx}`;
  db.insertProject({ id: projId, name: label, repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  let pfmId;
  if (opts.withPlatform) {
    pfmId = `pcb-${label}-pfm-${sfx}`;
    db.insertSession({ id: pfmId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "platform" });
  }
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, runGate: async () => PASS_GATE, reapWorktreeProcesses: noReap });
  const orch = new OrchestrationMcpRouter(db, sessions);
  const canonHead = () => git(repo, "rev-parse", "HEAD");
  const canonBranch = () => { try { return git(repo, "symbolic-ref", "--short", "HEAD"); } catch { return null; } };
  const wKey = MW.mainlineWatermarkKey(projId, "primary");
  const watermark = () => MW.parseMainlineWatermark(db.getMeta(wKey));
  const trust = (branch) => db.getMainlineBranchTrust(projId, "primary", branch);
  const alertKey = MW.mainlineBootAlertKey(projId, "primary");
  const mwEvents = () => db.listEventsSince(0, 100000).filter((e) => e.kind === "mainline_moved_outside_loom" && e.detail?.projectId === projId);
  /** Directly stamp a branch's trust record, bypassing the tool — the owner-adopt / already-landed-
   *  elsewhere shortcut most scenarios below use so they can test their OWN concern (a gate, a dirty
   *  tree, an unmerged worker, …) without first routing through create:true or a real landing. */
  const trustBranch = (branch) => db.setMainlineBranchTrust(projId, "primary", branch, git(repo, "rev-parse", branch));
  let wseq = 0;
  async function addWorker(tag) {
    const n = `${label}${tag}${++wseq}`;
    const taskId = `pcb-${n}-task-${sfx}`, workerId = `pcb-${n}-wkr-${sfx}`;
    db.insertTask({ id: taskId, projectId: projId, title: `feat(x): change ${n}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    registerForCleanup(worktreePath);
    fs.writeFileSync(path.join(worktreePath, `${n}.ts`), `export const ${n} = 1;\n`);
    commitAll(worktreePath, `feat(x): change ${n}`, GIT_ID);
    db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
    return { taskId, workerId, worktreePath, branch };
  }
  const call = (toolName, args) => callTool(orch.buildServer(mgrId, "manager"), toolName, args);
  return { label, repo, projId, agentId, mgrId, pfmId, sessions, orch, main, canonHead, canonBranch, watermark, trust, trustBranch, alertKey, mwEvents, addWorker, call };
}

try {
  // ===================== (SURF) manager has the tool, worker does not =====================
  {
    const fx = makeFixture("surf");
    const mgrTools = await listToolNames(fx.orch.buildServer(fx.mgrId, "manager"));
    check("(SURF) manager surface registers project_checkout_branch", mgrTools.includes("project_checkout_branch"));
    const w = await fx.addWorker("w");
    const wkrTools = await listToolNames(fx.orch.buildServer(w.workerId, "worker"));
    check("(SURF) worker surface does NOT register project_checkout_branch", !wkrTools.includes("project_checkout_branch"));
  }

  // ===================== (HOME) Loom's own reserved/operational home is refused =====================
  {
    const fx = makeFixture("home", { repoPath: process.env.LOOM_HOME });
    const res = await fx.call("project_checkout_branch", { branch: "main" });
    check("(HOME) refused on Loom's own reserved home", res.ok === false && /operational home/i.test(res.error));
  }

  // ===================== (UNK) round 10 — an unknown branch is now refused DIRECTLY, never deferred to GitWriter =====================
  // Round 10 (sixth CR, CRITICAL #1): a non-existent local branch used to return {ok:true,classifiedTip:
  // null} and defer to GitWriter.checkout()'s own unknown-branch handling — which is exactly the path a
  // same-named remote-tracking ref could DWIM through. It is now a hard, structured refusal decided here,
  // before any git mutation — inverting this scenario's own OLD assertion (refused !== true).
  {
    const fx = makeFixture("unk");
    const res = await fx.call("project_checkout_branch", { branch: "no-such-branch" });
    check("(UNK) an unknown branch is refused DIRECTLY by this tool's own precondition (round 10 — no longer deferred to GitWriter)", res.ok === false && res.refused === true && /no local branch/.test(res.error));
    check("(UNK) canonical untouched", fx.canonBranch() === fx.main);
    check("(UNK) watermark stays absent", fx.watermark() === null);
    check("(UNK) no event is filed for an ORDINARY unknown name (no remote-tracking shadow)", fx.mwEvents().length === 0);
  }

  // ===================== (DWIM) round 10's CRITICAL #1 — a same-named remote-tracking ref is refused, not silently DWIM'd =====================
  // The exact repro: a REAL configured "origin" remote (git remote add alone is enough — verified
  // directly, no clone/fetch needed), refs/remotes/origin/evil written directly (no local "evil"), then a
  // plain `project_checkout_branch({branch:"evil"})`. Under the pre-round-10 code this returned ok:true —
  // GitWriter.checkout()'s own plain `git checkout evil` DWIM'd a new local branch tracking origin/evil,
  // and the in-lock mismatch guard never ran because classifiedTip was null.
  {
    const fx = makeFixture("dwim");
    git(fx.repo, "remote", "add", "origin", "https://example.invalid/nope.git");
    const forged = git(fx.repo, "commit-tree", git(fx.repo, "write-tree"), "-p", fx.canonHead(), "-m", "forged");
    git(fx.repo, "update-ref", "refs/remotes/origin/evil", forged);
    check("(DWIM) setup: a remote-tracking shadow ref exists, no local 'evil' branch", git(fx.repo, "for-each-ref", "--format=%(refname)", "refs/remotes/origin/evil") === "refs/remotes/origin/evil");
    const r = await fx.call("project_checkout_branch", { branch: "evil" });
    check("(DWIM) is refused — round 8 would have returned ok:true here via git's own checkout DWIM", r.ok === false && r.refused === true && /remote-tracking ref/.test(r.error));
    check("(DWIM) canonical was NEVER switched to evil", fx.canonBranch() === fx.main);
    check("(DWIM) W was never established (never laundered)", fx.watermark() === null);
    check("(DWIM) a HIGH mainline_moved_outside_loom event was filed, naming remote-tracking-shadow", fx.mwEvents().some((e) => e.detail.branch === "evil" && e.detail.severity === "high" && e.detail.evidence.includes("remote-tracking-shadow") && e.detail.to === forged));
    // negative control: a REAL local branch of the same shape (no shadow involved) still works normally.
    git(fx.repo, "branch", "real-branch");
    fx.trustBranch("real-branch");
    db.deleteMeta(fx.alertKey); // the DWIM refusal above filed a project-wide alert; clear it for the control
    const r2 = await fx.call("project_checkout_branch", { branch: "real-branch" });
    check("(DWIM) negative control: an ordinary, trusted LOCAL branch switch is unaffected", r2.ok === true);
  }

  // ===================== (NAMES) round 10's MAJOR #2 — a dangerous branch-name SHAPE is refused before any git call =====================
  // "-" and "@{-1}" are git revision shorthand for "the previous branch"; "-bsneaky" is parsed as the -b
  // option; "refs/heads/x" is a full ref path, never a short name — all refused by unsafeBranchNameReason,
  // BEFORE any repo resolution or git read, for BOTH the ordinary switch and create:true paths (a real
  // watermark is established first, via a seed landing, so the create-path refusal is PROVABLY about the
  // name, not merely "no watermark yet" — that would be a vacuous pass for the wrong reason).
  for (const bad of ["-", "@{-1}", "-bsneaky", "refs/heads/x"]) {
    const fx = makeFixture("names");
    const seedWorker = await fx.addWorker("seed");
    const seeded = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, seedWorker.workerId);
    check(`(NAMES "${bad}") setup: a real landing establishes a watermark to create from`, seeded.settled === true && seeded.ok === true);
    const headBefore = fx.canonHead();
    const r1 = await fx.call("project_checkout_branch", { branch: bad });
    check(`(NAMES switch "${bad}") refused before canonical moves`, r1.ok === false);
    check(`(NAMES switch "${bad}") HEAD unchanged`, fx.canonHead() === headBefore && fx.canonBranch() === fx.main);
    const r2 = await fx.call("project_checkout_branch", { branch: bad, create: true });
    check(`(NAMES create "${bad}") refused before canonical moves, WITH a real watermark present (not a vacuous "no watermark" pass)`, r2.ok === false && !/no established mainline watermark/.test(r2.error));
    check(`(NAMES create "${bad}") HEAD unchanged`, fx.canonHead() === headBefore && fx.canonBranch() === fx.main);
  }
  // "origin/x" is DELIBERATELY excluded from the create-path loop above: it is a syntactically legal local
  // branch name (unsafeBranchNameReason does not reject it — see the negative control below), so
  // create:true genuinely succeeds with it; only the ORDINARY SWITCH path refuses it, because no local
  // ref by that name exists yet (the (UNK)-shaped refusal, not a name-validation one).
  {
    const fx = makeFixture("namesorigin");
    const headBefore = fx.canonHead();
    const r1 = await fx.call("project_checkout_branch", { branch: "origin/x" });
    check('(NAMES switch "origin/x") refused before canonical moves (no local ref by that name, not a name-shape rejection)', r1.ok === false && r1.refused === true);
    check('(NAMES switch "origin/x") HEAD unchanged', fx.canonHead() === headBefore && fx.canonBranch() === fx.main);
  }
  // Per-site negative control (a) — direct unit coverage of unsafeBranchNameReason itself, pure, no
  // fixture: proves the (NAMES) block above is testing a REAL rejection, not a vacuous one, and that a
  // genuinely ordinary name (which the (OK)/(CREATE) scenarios elsewhere in this file already exercise
  // end-to-end) is NOT rejected by this same function.
  {
    check('(NAMES) unsafeBranchNameReason("-") rejects (leading dash)', typeof unsafeBranchNameReason("-") === "string");
    check('(NAMES) unsafeBranchNameReason("@{-1}") rejects (revision shorthand)', typeof unsafeBranchNameReason("@{-1}") === "string");
    check('(NAMES) unsafeBranchNameReason("-bsneaky") rejects (option-shaped)', typeof unsafeBranchNameReason("-bsneaky") === "string");
    check('(NAMES) unsafeBranchNameReason("refs/heads/x") rejects (full ref path)', typeof unsafeBranchNameReason("refs/heads/x") === "string");
    check('(NAMES) unsafeBranchNameReason("a..b") rejects (range syntax)', typeof unsafeBranchNameReason("a..b") === "string");
    check('(NAMES) negative control: unsafeBranchNameReason("origin/x") does NOT reject (a legal local-branch shape)', unsafeBranchNameReason("origin/x") === null);
    check('(NAMES) negative control: unsafeBranchNameReason("feature/x") does NOT reject (an ordinary name)', unsafeBranchNameReason("feature/x") === null);
  }

  // ===================== (GATE) a live/queued op of ANY kind blocks the switch, hard =====================
  {
    const fx = makeFixture("gate");
    git(fx.repo, "branch", "atlas");
    fx.trustBranch("atlas"); // pre-trust so this scenario tests ONLY the gate-op refusal, not S1's concern
    const w = await fx.addWorker("w");

    // -- arm 1: the pending_gate_ops row (round 4) --
    const pendingOpId = "pcb-gate-pending-1";
    db.insertPendingGateOp({
      opId: pendingOpId, kind: "gate", key: `worker-gate:${pendingOpId}`, ownerSessionId: fx.mgrId,
      projectId: fx.projId, taskId: w.taskId, branch: w.branch, startedAt: new Date().toISOString(),
      state: "pending", surfacedPending: true,
    });
    check("(GATE) setup: liveGateOpsForRepoPath sees the pending_gate_ops row as gateType worker", fx.sessions.liveGateOpsForRepoPath(fx.repo).some((o) => o.opId === pendingOpId && o.gateType === "worker"));
    const r1 = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(GATE) a pending-row op refuses the switch, hard", r1.ok === false && r1.refused === true && Array.isArray(r1.liveGateOps) && r1.liveGateOps.some((o) => o.opId === pendingOpId));
    check("(GATE) canonical untouched by the refusal", fx.canonBranch() === fx.main);
    db.settlePendingGateOp(pendingOpId);
    check("(GATE) negative control: a settled row no longer reads as live", !fx.sessions.liveGateOpsForRepoPath(fx.repo).some((o) => o.opId === pendingOpId));
    // `w` itself is still an UNMERGED worker branch — land it now so it can never mask arm 2's own
    // negative control below (this is a fixture-cleanliness step, not part of what arm 1 proves).
    const wConfirmed = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, w.workerId);
    check("(GATE) fixture cleanup: the seed worker from arm 1 is landed before arm 2", wConfirmed.settled === true && wConfirmed.ok === true && wConfirmed.value.merged === true);

    // -- arm 2: the LIVE GateSemaphore snapshot itself — one RUNNING (deploy) + one QUEUED (merge/batch,
    //    cap=1 forces the queue) entry, proving BOTH phases and more than one gateType are seen. --
    let releaseRunning;
    const runningP = fx.sessions.gateSemaphore.runExclusive(
      1, { gateType: "deploy", projectId: fx.projId, sessionId: fx.mgrId, opId: "pcb-sem-running", repoPath: fx.repo },
      () => new Promise((res) => { releaseRunning = res; }), "high",
    );
    for (let i = 0; i < 200 && fx.sessions.gateSemaphore.snapshot().entries.length === 0; i++) await new Promise((r) => setImmediate(r));
    check("(GATE) setup: the deploy entry is registered as running", fx.sessions.gateSemaphore.snapshot().entries.some((e) => e.opId === "pcb-sem-running" && e.phase === "running"));
    const queuedP = fx.sessions.gateSemaphore.runExclusive(
      1, { gateType: "merge", projectId: fx.projId, sessionId: fx.mgrId, opId: "pcb-sem-queued", repoPath: fx.repo, batchBranches: ["loom/a", "loom/b"] },
      async () => PASS_GATE, "high",
    );
    for (let i = 0; i < 200 && !fx.sessions.gateSemaphore.snapshot().entries.some((e) => e.opId === "pcb-sem-queued"); i++) await new Promise((r) => setImmediate(r));
    check("(GATE) setup: the batch entry is registered as queued (cap=1 behind the running deploy)", fx.sessions.gateSemaphore.snapshot().entries.some((e) => e.opId === "pcb-sem-queued" && e.phase === "queued"));
    const liveOps = fx.sessions.liveGateOpsForRepoPath(fx.repo);
    check("(GATE) liveGateOpsForRepoPath sees the RUNNING deploy entry", liveOps.some((o) => o.opId === "pcb-sem-running" && o.gateType === "deploy" && o.phase === "running"));
    check("(GATE) liveGateOpsForRepoPath sees the QUEUED merge/batch entry", liveOps.some((o) => o.opId === "pcb-sem-queued" && o.gateType === "merge" && o.phase === "queued"));
    const r2 = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(GATE) the semaphore arm ALSO refuses the switch, hard", r2.ok === false && r2.refused === true && r2.liveGateOps?.length >= 2);
    releaseRunning();
    await runningP;
    await queuedP;
    // the semaphore's own entry removal can trail the settled promise by a tick or two — poll rather
    // than assume it's synchronous with the await above.
    for (let i = 0; i < 200 && fx.sessions.gateSemaphore.snapshot().entries.some((e) => e.opId === "pcb-sem-running" || e.opId === "pcb-sem-queued"); i++) await new Promise((r) => setImmediate(r));
    check("(GATE) setup: both semaphore entries are gone after settling", !fx.sessions.gateSemaphore.snapshot().entries.some((e) => e.opId === "pcb-sem-running" || e.opId === "pcb-sem-queued"));
    check("(GATE) negative control: once both settle, the SAME call now succeeds", (await fx.call("project_checkout_branch", { branch: "atlas" })).ok === true);
  }

  // ===================== (CUT) a worktree cut in flight blocks the switch, hard =====================
  {
    const fx = makeFixture("cut");
    git(fx.repo, "branch", "atlas");
    fx.trustBranch("atlas");
    fx.sessions.markCuttingWorktree(fx.repo);
    const r1 = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(CUT) a worktree cut in flight refuses the switch, hard", r1.ok === false && r1.refused === true);
    check("(CUT) canonical untouched", fx.canonBranch() === fx.main);
    fx.sessions.unmarkCuttingWorktree(fx.repo);
    check("(CUT) negative control: once unmarked, isWorktreeCuttingInFlight reads false", fx.sessions.isWorktreeCuttingInFlight(fx.repo) === false);
    check("(CUT) negative control: the SAME call now succeeds", (await fx.call("project_checkout_branch", { branch: "atlas" })).ok === true);

    // -- the refcount is released even when the REAL createWorktree(...) call THROWS (a quarantined repo),
    //    exercised through the real production path (spawnWorker), not the test's own addWorker helper. --
    enterMergeQuarantine(fx.repo, "atlas", "pcb-cut-throw-test");
    const taskId = "pcb-cut-throw-task";
    db.insertTask({ id: taskId, projectId: fx.projId, title: "feat(x): throw test", body: "", columnKey: "in_progress", position: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    let threw = false;
    try { await fx.sessions.spawnWorker(fx.mgrId, { taskId, agentId: fx.agentId, kickoffPrompt: "GO" }); } catch { threw = true; }
    const liveForTask = db.listAllSessions().some((s) => s.taskId === taskId && s.processState === "live");
    check("(CUT) setup control: the quarantined spawn never produced a live worker session (threw or refused cleanly)", threw || !liveForTask);
    check("(CUT) the refcount is released even though createWorktree failed (no leaked mark)", fx.sessions.isWorktreeCuttingInFlight(fx.repo) === false);
    clearMergeQuarantine(fx.repo);
  }

  // ===================== (DIRTY) a tracked change in the canonical tree blocks the switch =====================
  {
    const fx = makeFixture("dirty");
    git(fx.repo, "branch", "atlas");
    fx.trustBranch("atlas");
    fs.writeFileSync(path.join(fx.repo, "README.md"), "# pcb (tracked edit)\n"); // tracked file, modified but not committed
    const r1 = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(DIRTY) a tracked change refuses the switch, hard", r1.ok === false && r1.refused === true && /tracked/.test(r1.error));
    check("(DIRTY) canonical untouched", fx.canonBranch() === fx.main);
    git(fx.repo, "checkout", "-q", "--", "README.md"); // discard the tracked edit
    // negative control: an UNTRACKED file does NOT block.
    fs.writeFileSync(path.join(fx.repo, "untracked.txt"), "scratch\n");
    const r2 = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(DIRTY) negative control: an untracked file does NOT block the switch", r2.ok === true);
  }

  // ===================== (UNMRG) an unmerged worker branch (live OR exited) blocks the switch =====================
  {
    const fx = makeFixture("unmrg");
    git(fx.repo, "branch", "atlas");
    fx.trustBranch("atlas");
    const w = await fx.addWorker("w"); // inserted as processState:"exited" by addWorker — never landed
    const r1 = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(UNMRG) an exited, unmerged worker branch refuses the switch, hard", r1.ok === false && r1.refused === true && Array.isArray(r1.unmergedWorkers) && r1.unmergedWorkers.some((u) => u.workerSessionId === w.workerId && u.branch === w.branch));
    check("(UNMRG) canonical untouched", fx.canonBranch() === fx.main);
    check("(UNMRG) the remedy text is TRUE (no 'recycle-and-discard' mechanism is claimed)", /worker_merge_confirm/.test(r1.error) && !/recycle-and-discard/.test(r1.error));
    // negative control: land it, then the same call succeeds.
    const confirmed = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, w.workerId);
    check("(UNMRG) setup: the branch actually landed", confirmed.settled === true && confirmed.ok === true && confirmed.value.merged === true);
    const r2 = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(UNMRG) negative control: once merged, the SAME call now succeeds", r2.ok === true);
  }

  // ===================== (UNMRG-TAG) card 1bc9602b — a same-named TAG on the worker's own branch used to
  // make `listUnmergedWorkerBranches`'s `%(refname:short)` read shorten it to "heads/loom/<id>", never
  // matching the candidate's plain "loom/<id>" — the unmerged-worker refusal silently failed OPEN =====================
  {
    const fx = makeFixture("unmrg-tag");
    git(fx.repo, "branch", "atlas");
    fx.trustBranch("atlas");
    const w = await fx.addWorker("w"); // inserted as processState:"exited" — never landed, worktree still on disk
    git(fx.repo, "tag", w.branch); // same-named TAG — the real git ambiguity source
    check("(UNMRG-TAG) setup control: git's own ambiguous shortening is really present", git(fx.repo, "for-each-ref", "--format=%(refname:short)", `refs/heads/${w.branch}`) !== w.branch);
    const r1 = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(UNMRG-TAG) an unmerged worker branch shadowed by a same-named tag STILL refuses the switch", r1.ok === false && r1.refused === true && Array.isArray(r1.unmergedWorkers) && r1.unmergedWorkers.some((u) => u.workerSessionId === w.workerId && u.branch === w.branch));
    check("(UNMRG-TAG) canonical untouched", fx.canonBranch() === fx.main);
    // negative control: land it, then the same call succeeds (same shape as (UNMRG)'s own control, proving
    // the tag-ambiguity fixture itself isn't what's blocking the switch). The tag is deleted FIRST — a
    // same-named tag also defeats `detectStrandedWork`'s own bare-revision `rev-list <mainSha>..<branch>`
    // read (git's rev-parse precedence puts refs/tags/ ahead of refs/heads/ for a bare name, so it silently
    // diffs against the TAG's target instead of the real branch and false-flags "stranded work", refusing
    // the merge) — a SEPARATE, pre-existing ambiguity bug in a different function, out of scope for this
    // card (card 1bc9602b); deleting the tag here keeps this negative control isolated to the ONE concern
    // this scenario exists to prove (listUnmergedWorkerBranches), not entangled with that other one.
    git(fx.repo, "tag", "-d", w.branch);
    const confirmed = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, w.workerId);
    check("(UNMRG-TAG) setup: the branch actually landed", confirmed.settled === true && confirmed.ok === true && confirmed.value.merged === true);
    const r2 = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(UNMRG-TAG) negative control: once merged, the SAME call now succeeds", r2.ok === true);
  }

  // ===================== (UNMRG-REMOTEHEAD) card 1bc9602b — a SECOND, independent real-git ambiguity
  // source for `%(refname:short)`: a `refs/remotes/<branch>/HEAD` ref sharing the worker branch's own full
  // name (no configured remote needed — the bare ref is enough) =====================
  {
    const fx = makeFixture("unmrg-remotehead");
    git(fx.repo, "branch", "atlas");
    fx.trustBranch("atlas");
    const w = await fx.addWorker("w");
    git(fx.repo, "update-ref", `refs/remotes/${w.branch}/HEAD`, fx.canonHead());
    check("(UNMRG-REMOTEHEAD) setup control: git's own ambiguous shortening is really present", git(fx.repo, "for-each-ref", "--format=%(refname:short)", `refs/heads/${w.branch}`) !== w.branch);
    const r1 = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(UNMRG-REMOTEHEAD) an unmerged worker branch shadowed by a refs/remotes/.../HEAD ref STILL refuses the switch", r1.ok === false && r1.refused === true && Array.isArray(r1.unmergedWorkers) && r1.unmergedWorkers.some((u) => u.workerSessionId === w.workerId && u.branch === w.branch));
    check("(UNMRG-REMOTEHEAD) canonical untouched", fx.canonBranch() === fx.main);
    const confirmed = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, w.workerId);
    check("(UNMRG-REMOTEHEAD) setup: the branch actually landed", confirmed.settled === true && confirmed.ok === true && confirmed.value.merged === true);
    const r2 = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(UNMRG-REMOTEHEAD) negative control: once merged, the SAME call now succeeds", r2.ok === true);
  }

  // ===================== (TRUST) an existing branch with no trust record is refused outright =====================
  {
    const fx = makeFixture("trust");
    git(fx.repo, "branch", "stray"); // exists in git, but Loom has never trusted it
    const r1 = await fx.call("project_checkout_branch", { branch: "stray" });
    check("(TRUST) an existing branch with no trust record is refused", r1.ok === false && r1.refused === true && /no trusted baseline/.test(r1.error));
    check("(TRUST) the remedy names BOTH create:true and the owner-adopt route", /create:true/.test(r1.error) && /mainline-watermark\/reset/.test(r1.error));
    check("(TRUST) canonical untouched", fx.canonBranch() === fx.main);
    check("(TRUST) W stays absent (never adopted)", fx.watermark() === null);
    // negative control: the owner-adopt remedy (stamp a trust record directly) — the same call now succeeds.
    fx.trustBranch("stray");
    const r2 = await fx.call("project_checkout_branch", { branch: "stray" });
    check("(TRUST) negative control: once a trust record exists, the SAME call now succeeds", r2.ok === true);
  }

  // ===================== (RESET) the human-only reset route re-stamps the adopted branch's trust (M2) =====================
  {
    const fx = makeFixture("reset");
    git(fx.repo, "branch", "stray"); // exists in git, never trusted — the TRUST refusal's dead end
    git(fx.repo, "checkout", "-q", "stray");
    const strayTip = fx.canonHead();
    // Mirrors the human-only REST reset route's own effect (gateway/server.ts reads the canonical
    // checkout's live head and passes it as `adopt` — this exercises Db.resetMainlineWatermark directly,
    // the git-agnostic half of that fix).
    const resetResult = db.resetMainlineWatermark(fx.projId, "primary", { branch: "stray", sha: strayTip });
    check("(RESET) resetMainlineWatermark reports a reset", resetResult.reset === true);
    check("(RESET) the adopted branch's trust record is stamped immediately (M2)", fx.trust("stray") === strayTip);
    check("(RESET) W itself is still only ever DELETED by a reset, never stamped", fx.watermark() === null);
    git(fx.repo, "checkout", "-q", fx.main);
    // THE DEAD END, closed: switching to the human-adopted branch now succeeds immediately — no real
    // landing needed first, which was the gap before this fix (a reset cleared W but left "stray" itself
    // refusing with "no trusted baseline" on the very next call).
    const r = await fx.call("project_checkout_branch", { branch: "stray" });
    check("(RESET) switching to the human-adopted branch succeeds immediately", r.ok === true && r.branch === "stray" && r.sha === strayTip);
    check("(RESET) W is now re-pointed to the adopted branch", fx.watermark()?.branch === "stray" && fx.watermark()?.sha === strayTip);
  }

  // ===================== (LNDR-1 / LNDR-2) laundering keyed on the TARGET, not the current branch =====================
  {
    const fx = makeFixture("lndr");
    git(fx.repo, "branch", "clean-target");
    const w = await fx.addWorker("seed");
    const seeded = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, w.workerId);
    check("(LNDR) setup: a real landing established W + a trust record on main", seeded.settled === true && seeded.ok === true && seeded.value.merged === true && fx.watermark()?.branch === fx.main && fx.trust(fx.main) === fx.watermark()?.sha);
    fx.trustBranch("clean-target");
    const wBefore = fx.watermark();
    // A RAW ref-write bypass (mirrors mainline-watch-branch-divert.mjs's own D10/D11 technique). Round 9:
    // this gate no longer distinguishes a raw ref write from an ordinary porcelain commit at all — ANY tip
    // other than an exact trust-record match is refused, so the choice of bypass mechanism here is
    // arbitrary (kept as a raw write only because it's the cheapest way to produce "a tip the trust record
    // doesn't match").
    const rawTreeCommit = git(fx.repo, "commit-tree", git(fx.repo, "write-tree"), "-p", wBefore.sha, "-m", "");
    git(fx.repo, "update-ref", `refs/heads/${fx.main}`, rawTreeCommit);
    const rawTip = fx.canonHead();
    check("(LNDR) setup control: main's own trusted branch really moved outside Loom", rawTip === rawTreeCommit && rawTip !== wBefore.sha);

    // (LNDR-1) same-branch call: refused + a HIGH event filed; W left untouched.
    const r1 = await fx.call("project_checkout_branch", { branch: fx.main });
    check("(LNDR-1) a same-branch call after a raw commit is refused", r1.ok === false && r1.refused === true);
    check("(LNDR-1) W is left UNCHANGED (never laundered)", JSON.stringify(fx.watermark()) === JSON.stringify(wBefore));
    const evAfter1 = fx.mwEvents();
    check("(LNDR-1) a HIGH mainline_moved_outside_loom event was filed", evAfter1.some((e) => e.detail.severity === "high" && e.detail.from === wBefore.sha && e.detail.to === rawTip));
    check("(LNDR-1) canonical is untouched (still on main)", fx.canonBranch() === fx.main);

    // (LNDR-2) away-ONLY: targeting a DIFFERENT, perfectly clean, ALREADY-TRUSTED branch is ALSO refused
    // here — NOT because clean-target's own trust is bad (it isn't), but because LNDR-1 already filed a
    // project-wide, UNDELIVERED mainline alert, and hasUnresolvedMainlineAlert blocks EVERY call for this
    // (project, repoKey) regardless of target until the owner resolves it. This is the SAME outcome round
    // 5's own LNDR-2 asserted, now for the correct reason — see (B1) below for a scenario with no
    // pre-existing alert, which is what actually proves target-only classification.
    const r2 = await fx.call("project_checkout_branch", { branch: "clean-target" });
    check("(LNDR-2) switching to an unrelated branch is ALSO refused while LNDR-1's alert is unresolved", r2.ok === false && r2.refused === true && /unresolved mainline alert/.test(r2.error));
    check("(LNDR-2) W is still unchanged", JSON.stringify(fx.watermark()) === JSON.stringify(wBefore));
    check("(LNDR-2) canonical never moved off main", fx.canonBranch() === fx.main);
  }

  // ===================== (DEDUPE) a repeated refuseIfTargetBranchUntrusted call does not re-file/re-nudge (m4) =====================
  {
    const fx = makeFixture("dedupe");
    const w = await fx.addWorker("seed");
    const seeded = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, w.workerId);
    check("(DEDUPE) setup: a real landing establishes W + trust on main", seeded.settled === true && seeded.ok === true);
    const wBefore = fx.watermark();
    const rawTreeCommit = git(fx.repo, "commit-tree", git(fx.repo, "write-tree"), "-p", wBefore.sha, "-m", "");
    git(fx.repo, "update-ref", `refs/heads/${fx.main}`, rawTreeCommit);
    const rawTip = fx.canonHead();
    // Calling the PRIVATE classifier directly, twice in a row, bypasses `hasUnresolvedMainlineAlert`
    // (which would otherwise short-circuit a second real tool call before it ever reached this method
    // again) — this is the ONLY way to exercise the dedupe check itself rather than its usual backstop.
    const a = { projectId: fx.projId, repoKey: "primary", repoPath: fx.repo, branch: fx.main, managerSessionId: fx.mgrId, taskId: null };
    const call1 = await fx.sessions.refuseIfTargetBranchUntrusted(a);
    const call2 = await fx.sessions.refuseIfTargetBranchUntrusted(a);
    check("(DEDUPE) both direct calls refuse", call1.ok === false && call2.ok === false);
    const evs = fx.mwEvents().filter((e) => e.detail.source === "manager-checkout-precheck" && e.detail.branch === fx.main && e.detail.from === wBefore.sha && e.detail.to === rawTip);
    check("(DEDUPE) only ONE HIGH event was filed across both identical refusals (m4)", evs.length === 1 && evs[0].detail.severity === "high");
  }

  // ===================== (DEDUPE-RESET) round 8 (m4 under-alert fix) — a retry AFTER a human reset gets a FRESH event, not a stale pre-reset match =====================
  {
    const fx = makeFixture("dedupe-reset");
    const w = await fx.addWorker("seed");
    const seeded = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, w.workerId);
    check("(DEDUPE-RESET) setup: a real landing establishes W + trust on main", seeded.settled === true && seeded.ok === true);
    const wBefore = fx.watermark();
    const rawTreeCommit = git(fx.repo, "commit-tree", git(fx.repo, "write-tree"), "-p", wBefore.sha, "-m", "");
    git(fx.repo, "update-ref", `refs/heads/${fx.main}`, rawTreeCommit);
    const rawTip = fx.canonHead();
    const a = { projectId: fx.projId, repoKey: "primary", repoPath: fx.repo, branch: fx.main, managerSessionId: fx.mgrId, taskId: null };
    const call1 = await fx.sessions.refuseIfTargetBranchUntrusted(a);
    check("(DEDUPE-RESET) setup: the first call refuses", call1.ok === false);
    const evsBefore = fx.mwEvents().filter((e) => e.detail.source === "manager-checkout-precheck" && e.detail.branch === fx.main);
    check("(DEDUPE-RESET) setup: exactly one event was filed before the reset", evsBefore.length === 1);
    // The owner resets — clears W + the alert marker, but a PLAIN reset (no `adopt`) never touches main's
    // own per-branch trust record, so the SAME tampered tip is still what the next call classifies
    // against — this is deliberately the SAME (branch, from, to) triple as before the reset.
    const resetResult = db.resetMainlineWatermark(fx.projId, "primary");
    check("(DEDUPE-RESET) setup: the human reset reports reset:true", resetResult.reset === true);
    check("(DEDUPE-RESET) setup: the reset does NOT touch main's own trust record", fx.trust(fx.main) === wBefore.sha);
    const call2 = await fx.sessions.refuseIfTargetBranchUntrusted(a);
    check("(DEDUPE-RESET) the retry (same branch, same from/to) still refuses — nothing about the tamper itself changed", call2.ok === false);
    const evsAfter = fx.mwEvents().filter((e) => e.detail.source === "manager-checkout-precheck" && e.detail.branch === fx.main && e.detail.from === wBefore.sha && e.detail.to === rawTip);
    check("(DEDUPE-RESET) a FRESH event was filed after the reset — the dedupe correctly does NOT match the pre-reset episode (round 8 m4 fix)", evsAfter.length === 2);
    check("(DEDUPE-RESET) the retry's own error text says the event was JUST filed, not that one already exists", /was just filed/.test(call2.error));
  }

  // ===================== (CREATE) create:true — brand-new branch at W's sha, refusals, trust stamped =====================
  {
    const fx = makeFixture("create");
    const seedWorker = await fx.addWorker("seed");
    const seeded = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, seedWorker.workerId);
    check("(CREATE) setup: a real landing establishes W on main", seeded.settled === true && seeded.ok === true && fx.watermark()?.branch === fx.main);
    const wSha = fx.watermark().sha;

    const r1 = await fx.call("project_checkout_branch", { branch: "feature-x", create: true });
    check("(CREATE) succeeds with created:true", r1.ok === true && r1.created === true && r1.noop === false && r1.branch === "feature-x" && r1.sha === wSha);
    check("(CREATE) canonical is now actually on the new branch, at W's sha (never a different start point)", fx.canonBranch() === "feature-x" && fx.canonHead() === wSha);
    check("(CREATE) W is re-pointed to {feature-x, wSha} immediately", fx.watermark()?.branch === "feature-x" && fx.watermark()?.sha === wSha);
    check("(CREATE) the new branch's own trust record is stamped to the same sha", fx.trust("feature-x") === wSha);
    check("(CREATE) reports the previous branch (main)", r1.previousBranch === fx.main);

    // refuses an existing name
    const r2 = await fx.call("project_checkout_branch", { branch: "feature-x", create: true });
    check("(CREATE) refuses create:true on a name that already exists", r2.ok === false && /already exists/.test(r2.error));

    // refuses an invalid git branch name — round 10: a name containing spaces is now caught by
    // unsafeBranchNameReason's own conservative charset BEFORE check-ref-format ever runs, so the
    // refusal text changed (this is the "outside the conservative branch-name charset" reason, not
    // check-ref-format's "not a valid git branch name" text) — still refused, just one layer earlier.
    const r3 = await fx.call("project_checkout_branch", { branch: "not a valid branch name", create: true });
    check("(CREATE) refuses an invalid git branch name", r3.ok === false && /charset|not a valid git branch name/.test(r3.error));

    // refuses Loom's own reserved worker-branch prefix
    const r4 = await fx.call("project_checkout_branch", { branch: "loom/evil", create: true });
    check("(CREATE) refuses a name starting with Loom's reserved \"loom/\" prefix", r4.ok === false && /reserved worker-branch prefix/.test(r4.error));
    check("(CREATE) canonical untouched by any of the three refusals above", fx.canonBranch() === "feature-x");

    // a real landing on the created branch afterward advances its OWN trust record
    const postCreateWorker = await fx.addWorker("post");
    const postCreateBase = git(postCreateWorker.worktreePath, "rev-parse", "HEAD~1");
    check("(CREATE) the post-create worker's worktree forked from feature-x's own tip (wSha)", postCreateBase === wSha);
    const landed = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, postCreateWorker.workerId);
    check("(CREATE) the landing on the created branch succeeds", landed.settled === true && landed.ok === true && landed.value.merged === true);
    const landedSha = fx.canonHead();
    check("(CREATE) the created branch's trust record advanced past its creation sha", fx.trust("feature-x") === landedSha && landedSha !== wSha);
  }

  // ===================== (CREATE-DRIFT) create:true branches at W's sha even when HEAD has drifted past it (M3-ii) =====================
  {
    const fx = makeFixture("createdrift");
    const seedWorker = await fx.addWorker("seed");
    const seeded = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, seedWorker.workerId);
    const wSha = fx.watermark().sha;
    // Drift: advance the canonical checkout PAST W with a raw commit — no Loom landing, so W stays at wSha.
    fs.writeFileSync(path.join(fx.repo, "drift.txt"), "drift\n");
    commitAll(fx.repo, "chore(x): drift past W with no Loom landing", GIT_ID);
    const driftedHead = fx.canonHead();
    check("(CREATE-DRIFT) setup: HEAD has drifted past W", driftedHead !== wSha);
    const r = await fx.call("project_checkout_branch", { branch: "feature-drift", create: true });
    check("(CREATE-DRIFT) create:true branches at W's OWN sha, never the drifted HEAD (M3-ii)", r.ok === true && r.sha === wSha && r.sha !== driftedHead);
    check("(CREATE-DRIFT) canonical is actually at W's sha, not the drifted HEAD", fx.canonHead() === wSha);
  }

  // ===================== (N2) createProjectBranch re-reads W INSIDE the lock, not the stale outer read (n2) =====================
  // Round 8 fix (the same shape S2's own M3-i fix closed): the OLD race insertion ran "right after kicking
  // off the call, no await in between" — every step it needs (a real `git commit-tree`, a synchronous
  // `db.repointMainlineWatermark`) is itself synchronous, so it could complete BEFORE `createProjectBranch`
  // ever reached its own outer W read at all (every step ahead of that read — `nonCreatePrecondition`'s
  // real async git spawns — genuinely yields to the event loop first), meaning a disabled in-lock re-read
  // could still read green for the WRONG reason. A `db.getMeta` call-counting hook (the SAME technique (S2)
  // uses, applied to the one hookable point `createProjectBranch`'s own closures expose) proves the
  // ordering instead of assuming it: the FIRST call to this exact watermark key IS the outer read: the
  // repoint lands strictly between it and the SECOND (in-lock) call, never before either.
  {
    const fx = makeFixture("n2");
    const seedWorker = await fx.addWorker("seed");
    const seeded = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, seedWorker.workerId);
    const staleW = fx.watermark();

    let releaseLock;
    const lockHeld = withCanonicalIndexLock(fx.repo, () => new Promise((res) => { releaseLock = res; }));
    for (let i = 0; i < 200 && releaseLock === undefined; i++) await new Promise((r) => setImmediate(r));
    check("(N2) setup: the canonical-index lock is held by the parallel op", releaseLock !== undefined);

    const wKeyN2 = MW.mainlineWatermarkKey(fx.projId, "primary");
    let firstReadDone;
    const firstReadDoneP = new Promise((res) => { firstReadDone = res; });
    const originalGetMeta = db.getMeta.bind(db);
    db.getMeta = (key) => {
      const result = originalGetMeta(key);
      if (key === wKeyN2) {
        // One-shot: restore immediately so later reads (this test's own repoint + assertions below, and
        // the real in-lock read) are never mistaken for a second "outer" read — this hook only needs to
        // catch the FIRST one.
        db.getMeta = originalGetMeta;
        firstReadDone();
      }
      return result;
    };

    let callSettled = false;
    const callP = fx.call("project_checkout_branch", { branch: "feature-n2", create: true }).then((r) => { callSettled = true; return r; });
    await firstReadDoneP; // PROVABLY after createProjectBranch's own outer W read has already happened.
    check("(N2) ordering actually proven, not assumed: the call is still genuinely mid-flight (blocked on the held lock) when the outer read fires", callSettled === false);
    // Simulate a CONCURRENT repoint (e.g. another switch/create) landing strictly between the outer read
    // (just proven above) and the in-lock re-read — a brand-new, unreferenced-but-real commit object
    // (object creation needs no lock; only a ref/working-tree mutation does), repointed onto W via a
    // direct, lock-free Db write.
    const newTreeCommit = git(fx.repo, "commit-tree", git(fx.repo, "write-tree"), "-p", staleW.sha, "-m", "N2 concurrent repoint simulation");
    db.repointMainlineWatermark(fx.projId, "primary", fx.main, newTreeCommit, fx.mgrId);
    check("(N2) setup: W was concurrently repointed to a NEW sha strictly between the two reads", fx.watermark()?.sha === newTreeCommit && newTreeCommit !== staleW.sha);
    releaseLock();
    await lockHeld;
    const result = await callP;
    check("(N2) create:true used the FRESH sha read inside the lock, not the stale outer read (RED if the re-read is removed)", result.ok === true && result.sha === newTreeCommit);
    check("(N2) canonical is actually at the fresh sha", fx.canonHead() === newTreeCommit);
    check("(N2) the created branch's own trust record is stamped to the fresh sha, not the stale one", fx.trust("feature-n2") === newTreeCommit);
  }

  // ===================== (B1) the genuine away-and-back laundering case (Code Review round 3) =====================
  {
    const fx = makeFixture("b1");
    const seedWorker = await fx.addWorker("seed");
    const seeded = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, seedWorker.workerId);
    check("(B1) setup: a real landing establishes W + trust on main", seeded.settled === true && seeded.ok === true);
    const mainSha = fx.watermark().sha;

    // AWAY: create+switch to atlas, then land a worker on it — main is now DEPARTED and unwatched.
    const created = await fx.call("project_checkout_branch", { branch: "atlas", create: true });
    check("(B1) setup: create:true switches away to atlas", created.ok === true && fx.canonBranch() === "atlas");
    const atlasWorker = await fx.addWorker("atlas");
    const atlasLanded = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, atlasWorker.workerId);
    check("(B1) setup: a landing on atlas succeeds", atlasLanded.settled === true && atlasLanded.ok === true && atlasLanded.value.merged === true);

    // Switch back to the ORIGINAL (untouched) branch first — this must succeed cleanly, proving the
    // refusal below is specifically about the TAMPERED branch, not switching back as such.
    const backToMain = await fx.call("project_checkout_branch", { branch: fx.main });
    check("(B1) switching back to the untouched original branch succeeds cleanly", backToMain.ok === true && backToMain.branch === fx.main && backToMain.sha === mainSha);
    check("(B1) W is now on main again", fx.watermark()?.branch === fx.main);

    // Now atlas is the DEPARTED branch (main is checked out). Raw-tamper it while nothing watches it.
    const atlasTrustedSha = fx.trust("atlas");
    const rawTreeCommit = git(fx.repo, "commit-tree", git(fx.repo, "write-tree"), "-p", atlasTrustedSha, "-m", "");
    git(fx.repo, "update-ref", "refs/heads/atlas", rawTreeCommit);
    check("(B1) setup control: atlas really moved outside Loom while departed", git(fx.repo, "rev-parse", "atlas") === rawTreeCommit && rawTreeCommit !== atlasTrustedSha);

    // THE POINT: switching back to atlas is refused — the exact B1 repro.
    const back = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(B1) switching back to the tampered, departed branch is refused", back.ok === false && back.refused === true);
    check("(B1) a HIGH mainline_moved_outside_loom event was filed for atlas", fx.mwEvents().some((e) => e.detail.branch === "atlas" && e.detail.severity === "high" && e.detail.from === atlasTrustedSha && e.detail.to === rawTreeCommit));
    check("(B1) W is left UNCHANGED (still main, not laundered onto the tampered atlas)", fx.watermark()?.branch === fx.main);
    check("(B1) canonical never moved off main", fx.canonBranch() === fx.main);
  }

  // ===================== (M1) round 8's CRITICAL fix: an untrailered-descendant bypass, caught on ITS OWN classification =====================
  // Round 7's own fix (reflog-reach + forward-only) never actually needed the reflog-reach half: every
  // repro it was meant to catch lands an UNTRAILERED descendant of the trusted sha, and `branch -f` (no
  // delete) keeps that branch's reflog fully intact while staying forward — so round 7's own fix MISSED
  // it entirely (the fourth Code Review's finding). Each repro below gets its OWN fresh fixture (a shared
  // fixture let round 7's own M1 test pass for the WRONG reason — a sibling repro's leftover project-wide
  // alert marker, not that repro's own classification) and asserts the SPECIFIC filed event's `evidence`
  // tag, never just `refused === true`.
  async function m1Fixture(label) {
    const fx = makeFixture(label);
    const seedWorker = await fx.addWorker("seed");
    const seeded = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, seedWorker.workerId);
    check(`(M1 ${label}) setup: a real landing establishes W + trust on main`, seeded.settled === true && seeded.ok === true);
    const target = `m1-${label}`;
    git(fx.repo, "branch", target, fx.main);
    const trustedSha = git(fx.repo, "rev-parse", target);
    fx.trustBranch(target);
    return { fx, target, trustedSha };
  }
  const m1Evidence = (fx, target) => fx.mwEvents().filter((e) => e.detail.branch === target && e.detail.severity === "high");

  // -- repro 1: delete-and-recreate (git update-ref -d, then onto a descendant) --
  {
    const { fx, target, trustedSha } = await m1Fixture("del-recreate");
    const foreign = git(fx.repo, "commit-tree", git(fx.repo, "write-tree"), "-p", trustedSha, "-m", "");
    git(fx.repo, "update-ref", "-d", `refs/heads/${target}`);
    git(fx.repo, "update-ref", `refs/heads/${target}`, foreign);
    check("(M1 del-recreate) setup: the branch really moved via delete-and-recreate", git(fx.repo, "rev-parse", target) === foreign);
    const r = await fx.call("project_checkout_branch", { branch: target });
    check("(M1 del-recreate) is refused", r.ok === false && r.refused === true);
    check("(M1 del-recreate) the filed event's evidence names untrusted-tip-mismatch (the SPECIFIC reason, never just refused===true)", m1Evidence(fx, target).some((e) => e.detail.evidence.includes("untrusted-tip-mismatch")));
    check("(M1 del-recreate) W was NOT laundered onto the foreign tip", fx.watermark()?.branch !== target);
  }

  // -- repro 2: `git branch -f` onto a descendant — no delete happens, so the branch's reflog stays fully
  //    intact; round 9 no longer reads the reflog at all for this gate, so that is irrelevant here. --
  {
    const { fx, target, trustedSha } = await m1Fixture("force-descendant");
    const foreign = git(fx.repo, "commit-tree", git(fx.repo, "write-tree"), "-p", trustedSha, "-m", "");
    git(fx.repo, "branch", "-f", target, foreign);
    check("(M1 force-descendant) setup: the branch really moved via branch -f onto a descendant (reflog intact, forward)", git(fx.repo, "rev-parse", target) === foreign);
    const r = await fx.call("project_checkout_branch", { branch: target });
    check("(M1 force-descendant) is refused — any tip other than an exact trust-record match is refused", r.ok === false && r.refused === true);
    check("(M1 force-descendant) the filed event's evidence names untrusted-tip-mismatch", m1Evidence(fx, target).some((e) => e.detail.evidence.includes("untrusted-tip-mismatch")));
  }

  // -- repro 3: `git branch -D` then recreate under the SAME name, onto a descendant --
  {
    const { fx, target, trustedSha } = await m1Fixture("delete-recreate2");
    const foreign = git(fx.repo, "commit-tree", git(fx.repo, "write-tree"), "-p", trustedSha, "-m", "");
    git(fx.repo, "branch", "-D", target);
    git(fx.repo, "branch", target, foreign);
    check("(M1 delete-recreate2) setup: the branch really moved via branch -D + recreate", git(fx.repo, "rev-parse", target) === foreign);
    const r = await fx.call("project_checkout_branch", { branch: target });
    check("(M1 delete-recreate2) is refused", r.ok === false && r.refused === true);
    check("(M1 delete-recreate2) the filed event's evidence names untrusted-tip-mismatch", m1Evidence(fx, target).some((e) => e.detail.evidence.includes("untrusted-tip-mismatch")));
  }

  // -- repro 4: a FORGED `update-ref -m "commit: …"` message onto a descendant — the message LOOKS
  //    porcelain (matches PORCELAIN_REFLOG) but no porcelain commit ever happened --
  {
    const { fx, target, trustedSha } = await m1Fixture("forged-message");
    const foreign = git(fx.repo, "commit-tree", git(fx.repo, "write-tree"), "-p", trustedSha, "-m", "");
    git(fx.repo, "update-ref", "-m", "commit: a forged message that looks porcelain", `refs/heads/${target}`, foreign);
    check("(M1 forged-message) setup: the branch really moved via a forged, porcelain-looking update-ref message", git(fx.repo, "rev-parse", target) === foreign);
    const r = await fx.call("project_checkout_branch", { branch: target });
    check("(M1 forged-message) is refused — a forged porcelain-looking reflog message does not launder a mismatched tip", r.ok === false && r.refused === true);
    check("(M1 forged-message) the filed event's evidence names untrusted-tip-mismatch", m1Evidence(fx, target).some((e) => e.detail.evidence.includes("untrusted-tip-mismatch")));
  }

  // -- repro 5: a GENUINE porcelain commit made on the parked branch from a SECOND `git worktree add` —
  //    the exact Code Review repro, a real commit (not a simulated commit-tree graft) --
  {
    const { fx, target } = await m1Fixture("parked-worktree-commit");
    const wtDir = path.join(os.tmpdir(), `loom-pcb-m1-wtadd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    registerForCleanup(wtDir);
    git(fx.repo, "worktree", "add", "-q", wtDir, target);
    fs.writeFileSync(path.join(wtDir, "wtadd.txt"), "x\n");
    commitAll(wtDir, "feat(x): a real porcelain commit on the parked branch via worktree add", GIT_ID);
    git(fx.repo, "worktree", "remove", "--force", wtDir);
    check("(M1 parked-worktree-commit) setup: the branch really moved via a genuine porcelain commit", git(fx.repo, "rev-parse", target) !== git(fx.repo, "rev-parse", fx.main));
    const r = await fx.call("project_checkout_branch", { branch: target });
    check("(M1 parked-worktree-commit) is refused — a real commit with no matching trust record is not a clean move", r.ok === false && r.refused === true);
    check("(M1 parked-worktree-commit) the filed event's evidence names untrusted-tip-mismatch", m1Evidence(fx, target).some((e) => e.detail.evidence.includes("untrusted-tip-mismatch")));
  }

  // -- repro 6: `git branch -f` onto a GENUINELY non-ancestor tip — proves the exact-match rule refuses
  //    regardless of forward/backward relationship, not just a forward-descendant shape --
  {
    const { fx, target, trustedSha } = await m1Fixture("force-non-ancestor");
    // An unrelated ROOT commit (no -p parent at all) — provably neither an ancestor nor a descendant of
    // trustedSha, regardless of any coincidental tree-content overlap.
    const unrelated = git(fx.repo, "commit-tree", git(fx.repo, "write-tree"), "-m", "");
    git(fx.repo, "branch", "-f", target, unrelated);
    check("(M1 force-non-ancestor) setup: the branch really moved onto a tip that is NOT a descendant of the trusted sha", git(fx.repo, "rev-parse", target) === unrelated && unrelated !== trustedSha);
    const r = await fx.call("project_checkout_branch", { branch: target });
    check("(M1 force-non-ancestor) is refused — any non-matching tip is refused, ancestor relationship irrelevant", r.ok === false && r.refused === true);
    check("(M1 force-non-ancestor) the filed event's evidence names untrusted-tip-mismatch", m1Evidence(fx, target).some((e) => e.detail.evidence.includes("untrusted-tip-mismatch")));
  }

  // ===================== (M1) negative control: ONLY an exact trust-record match is allowed =====================
  {
    const cleanFx = makeFixture("m1clean");
    const cleanSeed = await cleanFx.addWorker("seed");
    const cleanSeeded = await cleanFx.sessions.confirmWorkerMergeTracked(cleanFx.mgrId, cleanSeed.workerId);
    check("(M1 negative control) setup: a real landing establishes W + trust on main", cleanSeeded.settled === true && cleanSeeded.ok === true);

    // -- round 9: a REAL, multi-commit Loom-trailered chain is now REFUSED the instant trust lags even ONE
    //    landing behind the live tip — the accepted cost of deleting all git-derived classification (see
    //    the decision record's round-9 section). This REPLACES round 8's own negative control, which
    //    asserted the OPPOSITE (that such a chain was still allowed) — that was precisely the behaviour a
    //    forged trailer could exploit. --
    const created = await cleanFx.call("project_checkout_branch", { branch: "m1-clean-landing", create: true });
    check("(M1 negative control) setup: create:true switches to a brand-new branch", created.ok === true);
    const w1 = await cleanFx.addWorker("landing1");
    const landed1 = await cleanFx.sessions.confirmWorkerMergeTracked(cleanFx.mgrId, w1.workerId);
    check("(M1 negative control) setup: a FIRST real landing lands on the new branch", landed1.settled === true && landed1.ok === true && landed1.value.merged === true);
    const s1 = cleanFx.canonHead();
    const w2 = await cleanFx.addWorker("landing2");
    const landed2 = await cleanFx.sessions.confirmWorkerMergeTracked(cleanFx.mgrId, w2.workerId);
    check("(M1 negative control) setup: a SECOND real landing lands on top", landed2.settled === true && landed2.ok === true && landed2.value.merged === true);
    const s2 = cleanFx.canonHead();
    check("(M1 negative control) setup: two real landings produced two distinct, chained tips", s1 !== s2 && s1 !== null && s2 !== null);
    const backToMain = await cleanFx.call("project_checkout_branch", { branch: cleanFx.main });
    check("(M1 negative control) setup: switch back to main", backToMain.ok === true);
    // Roll the branch's own trust record BACK to the FIRST landing's tip.
    db.setMainlineBranchTrust(cleanFx.projId, "primary", "m1-clean-landing", s1);
    check("(M1 negative control) setup: trust rolled back one landing behind the live branch tip", cleanFx.trust("m1-clean-landing") === s1 && s1 !== s2);
    const r1 = await cleanFx.call("project_checkout_branch", { branch: "m1-clean-landing" });
    check("(M1) round 9: a real, multi-commit, Loom-trailered chain is now ALSO refused once trust lags behind the live tip (the accepted cost of exact-match-only — see the decision record)", r1.ok === false && r1.refused === true);
    check("(M1) the lagged-trust refusal's filed event names untrusted-tip-mismatch too", m1Evidence(cleanFx, "m1-clean-landing").some((e) => e.detail.evidence.includes("untrusted-tip-mismatch")));
    // -- the POSITIVE control: once trust is rolled forward to the actual live tip (an exact match), the
    //    SAME call succeeds — proving the refusal above is about tip equality, not a broken branch/fixture.
    //    The refusal above filed a project-wide, UNDELIVERED mainline alert (same mechanism (LNDR-2)
    //    documents) — clear it first, the same way the owner's own reset route would, or EVERY later call
    //    in this fixture (including the ordinary-commit check below) would be blocked by it regardless of
    //    target, for an unrelated reason. --
    db.deleteMeta(cleanFx.alertKey);
    db.setMainlineBranchTrust(cleanFx.projId, "primary", "m1-clean-landing", s2);
    const r1b = await cleanFx.call("project_checkout_branch", { branch: "m1-clean-landing" });
    check("(M1) positive control: once trust exactly matches the live tip, the SAME call succeeds", r1b.ok === true && r1b.sha === s2);

    // -- an ORDINARY, non-trailered commit (intact reflog, true ancestor, a real porcelain commit) is
    //    refused too — unchanged from round 8, now for the SAME reason as every other mismatch. --
    git(cleanFx.repo, "branch", "m1-ordinary", cleanFx.main);
    cleanFx.trustBranch("m1-ordinary");
    git(cleanFx.repo, "checkout", "-q", "m1-ordinary");
    fs.writeFileSync(path.join(cleanFx.repo, "m1ordinary.txt"), "ok\n");
    commitAll(cleanFx.repo, "chore(x): an ordinary, non-trailered commit", GIT_ID);
    git(cleanFx.repo, "checkout", "-q", cleanFx.main);
    const r2 = await cleanFx.call("project_checkout_branch", { branch: "m1-ordinary" });
    check("(M1) an ordinary non-trailered commit is refused — stricter than the shared tripwire, by design", r2.ok === false && r2.refused === true);
    check("(M1) the ordinary-commit refusal's filed event names untrusted-tip-mismatch too", m1Evidence(cleanFx, "m1-ordinary").some((e) => e.detail.evidence.includes("untrusted-tip-mismatch")));
  }

  // ===================== (FORGED) round 9 — a FORGED Loom-Worker-Branch trailer is no longer special-cased =====================
  // The fifth Code Review's repro: a real commit whose message plants the EXACT trailer text a genuine
  // Loom landing writes, with no actual landing ever having happened. Under round 8's own "forward + every
  // commit trailered" rule this was silently ADOPTED (ok:true, W + trust laundered onto the forged sha, no
  // event filed) — `parseLoomTrailerBlock` is pure, unauthenticated text matching. Round 9 deletes all
  // trailer-reading from this gate, so a forged trailer buys the attacker nothing: it is refused exactly
  // like repro 1-6 above, for the identical reason.
  {
    // -- P1: git branch -f onto the forged-trailer commit --
    const { fx, target, trustedSha } = await m1Fixture("forged-trailer-force");
    const forged = git(fx.repo, "commit-tree", git(fx.repo, "write-tree"), "-p", trustedSha, "-m", "feat(x): innocuous", "-m", "Loom-Worker-Branch: loom/deadbeef0000");
    git(fx.repo, "branch", "-f", target, forged);
    check("(FORGED P1) setup: the branch really moved via branch -f onto a commit carrying a FORGED Loom-Worker-Branch trailer", git(fx.repo, "rev-parse", target) === forged);
    const wBeforeP1 = fx.watermark();
    const r1 = await fx.call("project_checkout_branch", { branch: target });
    check("(FORGED P1) is refused — a forged trailer is NOT adopted (round 8 would have returned ok:true here)", r1.ok === false && r1.refused === true);
    check("(FORGED P1) W was NOT laundered onto the forged tip", JSON.stringify(fx.watermark()) === JSON.stringify(wBeforeP1));
    check("(FORGED P1) the branch's OWN trust record was NOT advanced onto the forged tip", fx.trust(target) === trustedSha);
    check("(FORGED P1) a HIGH mainline_moved_outside_loom event was filed, naming untrusted-tip-mismatch", m1Evidence(fx, target).some((e) => e.detail.evidence.includes("untrusted-tip-mismatch") && e.detail.to === forged));
  }
  {
    // -- P2: the SAME forged-trailer commit, reached via a forged `update-ref -m "commit: …"` direct ref
    //    write instead of branch -f --
    const { fx, target, trustedSha } = await m1Fixture("forged-trailer-updateref");
    const forged = git(fx.repo, "commit-tree", git(fx.repo, "write-tree"), "-p", trustedSha, "-m", "feat(x): innocuous", "-m", "Loom-Worker-Branch: loom/deadbeef0000");
    git(fx.repo, "update-ref", "-m", "commit: x", `refs/heads/${target}`, forged);
    check("(FORGED P2) setup: the branch really moved via a forged update-ref onto a commit carrying a FORGED trailer", git(fx.repo, "rev-parse", target) === forged);
    const wBeforeP2 = fx.watermark();
    const r2 = await fx.call("project_checkout_branch", { branch: target });
    check("(FORGED P2) is refused — a forged trailer via a forged update-ref message is NOT adopted either", r2.ok === false && r2.refused === true);
    check("(FORGED P2) W was NOT laundered onto the forged tip", JSON.stringify(fx.watermark()) === JSON.stringify(wBeforeP2));
    check("(FORGED P2) a HIGH mainline_moved_outside_loom event was filed, naming untrusted-tip-mismatch", m1Evidence(fx, target).some((e) => e.detail.evidence.includes("untrusted-tip-mismatch") && e.detail.to === forged));
  }

  // ===================== (FORGED-FIXUP) round 9 — the SAME forged tip, reached via the "already checked out, W disagrees" fixup path =====================
  // Round 8's MAJOR #2 fixup path (checkoutProjectBranch, "already checked out" + W disagreeing) re-runs
  // the FULL precondition in-lock before repointing — including the target-branch trust check this file
  // exercises above via an ordinary switch. This proves the SAME forged-trailer bypass is closed on THAT
  // entry point too, not just the ordinary-switch one.
  {
    const { fx, target, trustedSha } = await m1Fixture("forged-trailer-fixup");
    const forged = git(fx.repo, "commit-tree", git(fx.repo, "write-tree"), "-p", trustedSha, "-m", "feat(x): innocuous", "-m", "Loom-Worker-Branch: loom/deadbeef0000");
    git(fx.repo, "branch", "-f", target, forged);
    // Reach the forged branch OUT OF BAND (a raw checkout, never through this tool) so the canonical repo
    // is already sitting on it while W still points at main — exactly the "already checked out, W
    // disagrees" shape the fixup path exists for.
    git(fx.repo, "checkout", "-q", target);
    check("(FORGED-FIXUP P3) setup: canonical is already on the forged branch out-of-band, W still points elsewhere", fx.canonBranch() === target && fx.watermark()?.branch !== target);
    const wBeforeP3 = fx.watermark();
    const r3 = await fx.call("project_checkout_branch", { branch: target });
    check("(FORGED-FIXUP P3) the fixup path ALSO refuses — a forged trailer buys nothing via either entry point", r3.ok === false && r3.refused === true);
    check("(FORGED-FIXUP P3) W was NOT re-pointed onto the forged tip by the fixup path", JSON.stringify(fx.watermark()) === JSON.stringify(wBeforeP3));
    check("(FORGED-FIXUP P3) the branch's own trust record was NOT advanced onto the forged tip", fx.trust(target) === trustedSha);

    // -- P4 (control): an ORDINARY, untrailered commit on the SAME fixup path is ALSO refused — the fixup
    //    path's own precondition re-run genuinely runs the full check, not a weaker one. --
    const { fx: fx4, target: target4, trustedSha: trustedSha4 } = await m1Fixture("ordinary-fixup");
    git(fx4.repo, "checkout", "-q", target4);
    fs.writeFileSync(path.join(fx4.repo, "fixup-ordinary.ts"), "export const x = 1;\n");
    commitAll(fx4.repo, "chore(x): an ordinary commit on the fixup target", GIT_ID);
    const ordinaryTip = fx4.canonHead();
    check("(FORGED-FIXUP P4) setup: canonical is on an untrailered-commit branch out-of-band, W still points elsewhere", fx4.canonBranch() === target4 && ordinaryTip !== trustedSha4);
    const r4 = await fx4.call("project_checkout_branch", { branch: target4 });
    check("(FORGED-FIXUP P4) control: an ordinary, untrailered commit on the fixup path is ALSO refused", r4.ok === false && r4.refused === true);
  }

  // ===================== (REWIND) round 9 — a genuinely REAL (trailered) but STALE tip is refused, same as any mismatch =====================
  {
    const fx = makeFixture("rewind");
    const seedWorker = await fx.addWorker("seed");
    const seeded = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, seedWorker.workerId);
    check("(REWIND) setup: a real landing establishes W + trust on main", seeded.settled === true && seeded.ok === true);
    const created = await fx.call("project_checkout_branch", { branch: "rw-target", create: true });
    check("(REWIND) setup: create:true switches to a brand-new rw-target", created.ok === true && fx.canonBranch() === "rw-target");
    const w1 = await fx.addWorker("rw1");
    const landed1 = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, w1.workerId);
    check("(REWIND) setup: a FIRST real landing lands on the target branch", landed1.settled === true && landed1.ok === true && landed1.value.merged === true);
    const firstLandingSha = fx.canonHead();
    const w2 = await fx.addWorker("rw2");
    const landed2 = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, w2.workerId);
    check("(REWIND) setup: a SECOND real landing lands on top — trust now tracks this one", landed2.settled === true && landed2.ok === true && landed2.value.merged === true);
    check("(REWIND) setup: trust tracks the SECOND landing, not the first", fx.trust("rw-target") !== firstLandingSha && fx.trust("rw-target") === fx.canonHead());
    const backToMain = await fx.call("project_checkout_branch", { branch: fx.main });
    check("(REWIND) setup: switch back to main, parking rw-target", backToMain.ok === true);
    // Force the parked branch BACKWARD onto its own, genuinely real, FIRST (trailered) landing — not the
    // current trust record (the second landing). No delete, no foreign content — a real but STALE tip.
    git(fx.repo, "branch", "-f", "rw-target", firstLandingSha);
    check("(REWIND) setup: the branch really moved BACKWARD onto its own first (real) landing", git(fx.repo, "rev-parse", "rw-target") === firstLandingSha);
    const wBefore = fx.watermark();
    const r = await fx.call("project_checkout_branch", { branch: "rw-target" });
    check("(REWIND) a real but STALE tip (an earlier real landing, not the current trust record) is refused — no special-case rewind logic exists, this is just the exact-match rule", r.ok === false && r.refused === true);
    check("(REWIND) W was NOT re-pointed", JSON.stringify(fx.watermark()) === JSON.stringify(wBefore));
    check("(REWIND) the filed event names untrusted-tip-mismatch", fx.mwEvents().some((e) => e.detail.branch === "rw-target" && e.detail.evidence.includes("untrusted-tip-mismatch") && e.detail.to === firstLandingSha));
  }

  // ===================== (FIXUP-TOCTOU) round 9 — the fixup path's OWN in-lock precondition re-run actually matters =====================
  // Mirrors (S2)'s call-counting technique, but targets the DIFFERENT in-lock precondition call inside
  // checkoutProjectBranch's "already checked out, W disagrees" fixup branch (not the ordinary-switch
  // GitWriter.checkout() precondition hook (S2) already covers).
  {
    const fx = makeFixture("fixuptoctou");
    git(fx.repo, "branch", "atlas");
    fx.trustBranch("atlas");
    git(fx.repo, "checkout", "-q", "atlas"); // canonical already on atlas, out-of-band; W is still absent/elsewhere
    check("(FIXUP-TOCTOU) setup: canonical is already on atlas with no watermark yet, routing into the fixup path", fx.canonBranch() === "atlas" && fx.watermark() === null);

    let preCheckCalls = 0;
    let firstPreCheckDone;
    const firstPreCheckDoneP = new Promise((res) => { firstPreCheckDone = res; });
    const originalPrecondition = fx.sessions.checkoutProjectBranchPrecondition.bind(fx.sessions);
    fx.sessions.checkoutProjectBranchPrecondition = async (...a) => {
      const result = await originalPrecondition(...a);
      preCheckCalls++;
      if (preCheckCalls === 1) firstPreCheckDone();
      return result;
    };

    let releaseLock;
    const lockHeld = withCanonicalIndexLock(fx.repo, () => new Promise((res) => { releaseLock = res; }));
    for (let i = 0; i < 200 && releaseLock === undefined; i++) await new Promise((r) => setImmediate(r));
    check("(FIXUP-TOCTOU) setup: the canonical-index lock is held by the parallel op", releaseLock !== undefined);

    const callP = fx.call("project_checkout_branch", { branch: "atlas" });
    await firstPreCheckDoneP; // PROVABLY after the fixup path's own outer courtesy pre-check has run and passed
    // Raw-tamper atlas NOW — strictly after pre-check #1, strictly before pre-check #2 (the fixup's own
    // in-lock re-run) — so the SECOND call is what must catch it, not the stale outer read. `branch -f`
    // refuses on a branch checked out in ANY worktree (including this one, the primary checkout) — use
    // `update-ref` instead (the same plumbing bypass (LNDR)/(B1) use to tamper the CURRENTLY checked-out
    // branch), which has no such restriction.
    const foreign = git(fx.repo, "commit-tree", git(fx.repo, "write-tree"), "-p", git(fx.repo, "rev-parse", "atlas"), "-m", "");
    git(fx.repo, "update-ref", "refs/heads/atlas", foreign);
    releaseLock();
    await lockHeld;
    const result = await callP;
    fx.sessions.checkoutProjectBranchPrecondition = originalPrecondition;
    check("(FIXUP-TOCTOU) ordering actually proven: both pre-check invocations ran", preCheckCalls === 2);
    check("(FIXUP-TOCTOU) a tamper inserted between the fixup path's outer pre-check and its OWN in-lock re-run is still caught (RED if that in-lock re-run is removed)", result.ok === false && result.refused === true);
    check("(FIXUP-TOCTOU) W was never re-pointed onto the tampered tip", fx.watermark() === null || fx.watermark()?.sha !== foreign);
  }

  // ===================== (ALERT) any existing mainline alert marker blocks the switch outright =====================
  {
    const fx = makeFixture("alert");
    git(fx.repo, "branch", "atlas");
    fx.trustBranch("atlas");
    const w = await fx.addWorker("seed");
    const seeded = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, w.workerId);
    check("(ALERT) setup: W established on main", seeded.settled === true && seeded.ok === true && fx.watermark()?.branch === fx.main);
    // Seed an UNRELATED, already-DELIVERED alert marker directly — proves the gate is "does a marker
    // exist at all", not "is it still undelivered".
    db.setMeta(fx.alertKey, JSON.stringify({ branch: fx.main, from: "a".repeat(40), to: "b".repeat(40), evidence: ["reflog-raw-write"], suspectShas: ["b".repeat(40)], nudgedAt: new Date().toISOString() }));
    const r1 = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(ALERT) an existing (even DELIVERED) alert marker refuses the switch outright", r1.ok === false && r1.refused === true && /unresolved mainline alert/.test(r1.error));
    check("(ALERT) W untouched by the refusal", fx.watermark()?.branch === fx.main);
    check("(ALERT) canonical untouched", fx.canonBranch() === fx.main);
    // negative control: clear the marker (the human-only reset's own effect) and the same call succeeds.
    db.deleteMeta(fx.alertKey);
    const r2 = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(ALERT) negative control: once the marker is cleared, the SAME call now succeeds", r2.ok === true);
  }

  // ===================== (S3) a purely-informational first-sight-declined marker does NOT block =====================
  {
    const fx = makeFixture("s3");
    git(fx.repo, "branch", "atlas");
    fx.trustBranch("atlas");
    // Mirrors recordFirstSightDeclined's own marker shape exactly (nudgedAt stamped immediately).
    db.setMeta(fx.alertKey, JSON.stringify({ branch: fx.main, from: "", to: fx.main, evidence: ["first-sight-declined"], suspectShas: [], expectedBranch: "origin-default", source: "boot", nudgedAt: new Date().toISOString() }));
    const r1 = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(S3) a first-sight-declined marker does NOT block the switch", r1.ok === true);
    // negative control: a REAL evidence kind in the same slot still blocks.
    db.setMeta(fx.alertKey, JSON.stringify({ branch: fx.main, from: "a".repeat(40), to: "b".repeat(40), evidence: ["branch-diverted"], suspectShas: ["b".repeat(40)], expectedBranch: fx.main, nudgedAt: new Date().toISOString() }));
    const r2 = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(S3) negative control: a REAL evidence kind in the same marker slot still blocks", r2.ok === false && r2.refused === true);
  }

  // ===================== (NOOP) the branch already checked out is a no-op =====================
  {
    const fx = makeFixture("noop");
    const w = await fx.addWorker("seed");
    const seeded = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, w.workerId);
    check("(NOOP) setup: W established on main", seeded.settled === true && seeded.ok === true);
    const wBefore = fx.watermark();
    const evBefore = fx.mwEvents().length;
    const r1 = await fx.call("project_checkout_branch", { branch: fx.main });
    check("(NOOP) calling checkout on the branch already checked out is a noop", r1.ok === true && r1.noop === true && r1.branch === fx.main && r1.sha === wBefore.sha);
    check("(NOOP) W is NOT re-pointed (identical before/after)", JSON.stringify(fx.watermark()) === JSON.stringify(wBefore));
    check("(NOOP) no new audit event was filed for a noop", fx.mwEvents().length === evBefore);
  }

  // ===================== (S1) the unmerged-worker refusal scopes to LIVE or worktree-still-on-disk =====================
  {
    const fx = makeFixture("s1");
    git(fx.repo, "branch", "atlas");
    fx.trustBranch("atlas");

    const live = await fx.addWorker("live");
    db.setProcessState(live.workerId, "live"); // addWorker always inserts "exited" — flip it

    const gone = await fx.addWorker("gone");
    fs.rmSync(gone.worktreePath, { recursive: true, force: true }); // exited AND worktree removed

    const r1 = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(S1) a LIVE unmerged worker still blocks", r1.ok === false && r1.refused === true && r1.unmergedWorkers?.some((u) => u.workerSessionId === live.workerId));
    check("(S1) an exited worker whose worktree was already removed does NOT block", !r1.unmergedWorkers?.some((u) => u.workerSessionId === gone.workerId));

    // negative control: once the live one is also stopped AND its worktree removed, the call succeeds.
    db.setProcessState(live.workerId, "exited");
    fs.rmSync(live.worktreePath, { recursive: true, force: true });
    const r2 = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(S1) negative control: once BOTH are gone, the SAME call now succeeds", r2.ok === true);
  }

  // ===================== (S2) TOCTOU: a race between the courtesy pre-check and lock admission =====================
  // @decision 2a6a292a round 7 (M3-i) — a plain "insert right after kicking off the call, no await in
  // between" race is UNRELIABLE: every step in between (the real `git branch`/`db.insertSession` the
  // race needs) is SYNCHRONOUS and therefore runs to completion in the SAME tick BEFORE the call's own
  // async chain (MCP transport connect → tool dispatch → the courtesy pre-check's own async git reads)
  // gets a chance to run at all — the insertion can land BEFORE the outer pre-check, not strictly after
  // it, so a disabled in-lock hook could still read green for the WRONG reason (the outer pre-check
  // catching it instead). A call-counting hook on `checkoutProjectBranchPrecondition` itself removes the
  // ambiguity: it resolves a promise the instant the FIRST (outer, courtesy) invocation actually
  // completes, so the race insertion is provably ordered after it and before the SECOND (in-lock)
  // invocation, which is the one this test actually means to exercise.
  {
    const fx = makeFixture("s2");
    git(fx.repo, "branch", "atlas");
    fx.trustBranch("atlas");

    let releaseLock;
    const lockHeld = withCanonicalIndexLock(fx.repo, () => new Promise((res) => { releaseLock = res; }));
    for (let i = 0; i < 200 && releaseLock === undefined; i++) await new Promise((r) => setImmediate(r));
    check("(S2) setup: the canonical-index lock is held by the parallel op", releaseLock !== undefined);

    let preCheckCalls = 0;
    let firstPreCheckDone;
    const firstPreCheckDoneP = new Promise((res) => { firstPreCheckDone = res; });
    const originalPrecondition = fx.sessions.checkoutProjectBranchPrecondition.bind(fx.sessions);
    fx.sessions.checkoutProjectBranchPrecondition = async (...a) => {
      const result = await originalPrecondition(...a);
      preCheckCalls++;
      if (preCheckCalls === 1) firstPreCheckDone();
      return result;
    };

    // The real call's courtesy pre-check (outside the lock) runs and passes immediately — nothing blocks
    // it yet. It then calls writer.checkout(), which queues behind the held lock.
    const callP = fx.call("project_checkout_branch", { branch: "atlas" });
    await firstPreCheckDoneP; // PROVABLY after the outer courtesy pre-check has already run and passed.
    // Insert the unmerged worker NOW — guaranteed strictly after pre-check #1, and (since the lock is
    // still held) strictly before pre-check #2 (the in-lock one). Deliberately NOT via addWorker()/
    // createWorktree(): a FRESH worktree cut ALSO acquires withCanonicalIndexLock, so using it here would
    // deadlock against the lock THIS scenario is deliberately holding open. A plain `git branch` (no
    // lock) plus a direct DB session row carries everything listUnmergedWorkerBranches actually reads
    // (role/processState/worktreePath-on-disk/branch), with no lock involved.
    const raceBranch = "loom/pcb-s2-race";
    git(fx.repo, "branch", raceBranch);
    const raceWorktreeDir = path.join(os.tmpdir(), `loom-pcb-s2-race-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(raceWorktreeDir, { recursive: true });
    registerForCleanup(raceWorktreeDir);
    const raceWorkerId = "pcb-s2-race-wkr", raceTaskId = "pcb-s2-race-task";
    const nowIso = new Date().toISOString();
    db.insertTask({ id: raceTaskId, projectId: fx.projId, title: "feat(x): race", body: "", columnKey: "in_progress", position: 1, createdAt: nowIso, updatedAt: nowIso });
    db.insertSession({ id: raceWorkerId, projectId: fx.projId, agentId: fx.agentId, engineSessionId: null, title: null, cwd: raceWorktreeDir, processState: "exited", resumability: "unknown", busy: false, createdAt: nowIso, lastActivity: nowIso, lastError: null, role: "worker", parentSessionId: fx.mgrId, taskId: raceTaskId, worktreePath: raceWorktreeDir, branch: raceBranch });
    const w = { workerId: raceWorkerId };
    releaseLock();
    await lockHeld;
    const result = await callP;
    fx.sessions.checkoutProjectBranchPrecondition = originalPrecondition;
    check("(S2) the outer courtesy pre-check ran exactly once before the race insertion, and the in-lock one ran after (ordering actually proven, not assumed)", preCheckCalls === 2);
    check("(S2) a worker inserted between the courtesy pre-check and lock admission is still caught (RED if the in-lock precondition hook is removed)", result.ok === false && result.refused === true && result.unmergedWorkers?.some((u) => u.workerSessionId === w.workerId));
    check("(S2) canonical untouched by the refusal", fx.canonBranch() === fx.main);
  }

  // ===================== (ALERT-LOCK) the unresolved-alert check now runs in-lock too, not just outside (m3) =====================
  {
    const fx = makeFixture("alertlock");
    git(fx.repo, "branch", "atlas");
    fx.trustBranch("atlas");

    let releaseLock;
    const lockHeld = withCanonicalIndexLock(fx.repo, () => new Promise((res) => { releaseLock = res; }));
    for (let i = 0; i < 200 && releaseLock === undefined; i++) await new Promise((r) => setImmediate(r));
    check("(ALERT-LOCK) setup: the canonical-index lock is held by the parallel op", releaseLock !== undefined);

    let preCheckCalls = 0;
    let firstPreCheckDone;
    const firstPreCheckDoneP = new Promise((res) => { firstPreCheckDone = res; });
    const originalPrecondition = fx.sessions.checkoutProjectBranchPrecondition.bind(fx.sessions);
    fx.sessions.checkoutProjectBranchPrecondition = async (...a) => {
      const result = await originalPrecondition(...a);
      preCheckCalls++;
      if (preCheckCalls === 1) firstPreCheckDone();
      return result;
    };

    const callP = fx.call("project_checkout_branch", { branch: "atlas" });
    await firstPreCheckDoneP; // the outer courtesy pre-check already ran and passed (no alert existed yet)
    // NOW set the alert marker — strictly after pre-check #1, strictly before pre-check #2 (in-lock).
    db.setMeta(fx.alertKey, JSON.stringify({ branch: fx.main, from: "a".repeat(40), to: "b".repeat(40), evidence: ["reflog-raw-write"], suspectShas: ["b".repeat(40)], nudgedAt: new Date().toISOString() }));
    releaseLock();
    await lockHeld;
    const result = await callP;
    fx.sessions.checkoutProjectBranchPrecondition = originalPrecondition;
    check("(ALERT-LOCK) ordering actually proven: both pre-check invocations ran", preCheckCalls === 2);
    check("(ALERT-LOCK) a marker set between the outer pre-check and lock admission is still caught by the IN-LOCK check (RED if m3's move is reverted)", result.ok === false && result.refused === true && /unresolved mainline alert/.test(result.error));
    check("(ALERT-LOCK) canonical untouched by the refusal", fx.canonBranch() === fx.main);
  }

  // ===================== (N1) GitWriter.checkout()'s post-checkout sha read degrades to sha:null =====================
  {
    const fx = makeFixture("n1");
    git(fx.repo, "branch", "atlas");
    // A fully FAKE WriterGit (mirrors git-writer-kill-confirm.mjs's own test-seam convention — no real
    // simple-git instance, no real child process at all): `checkout`/`raw(["checkout",...])` succeed
    // without touching the real repo (this is a pure unit check on GitWriter's OWN degrade logic, not a
    // claim about a real mutation), `branchLocal` reports the target branch, and `revparse` throws —
    // simulating the post-checkout `git rev-parse HEAD` read timing out/erroring AFTER a checkout that
    // (in production) already succeeded.
    const fakeGit = {
      checkout: async () => {}, checkoutLocalBranch: async () => {},
      // @decision 59e53710 (round 3) — `checkout()`'s PRE-spawn existence check reads `refs/heads/` via
      // `raw(["for-each-ref",...])`, not `branchLocal()` — the response must list "refs/heads/atlas" or
      // that check refuses first, before ever reaching the simulated POST-checkout revparse failure below.
      branchLocal: async () => ({ current: "atlas", all: ["atlas"] }),
      status: async () => ({ isClean: () => true, files: [] }),
      raw: async (args) => (Array.isArray(args) && args[0] === "for-each-ref" ? "refs/heads/atlas\n" : ""),
      commit: async () => ({ commit: "" }),
      // `revparse` is ALSO used for the unrelated operational-home toplevel probe
      // (`["--show-toplevel"]`) earlier in checkout() — only the post-checkout `["HEAD"]` read must fail.
      revparse: async (args) => {
        if (Array.isArray(args) && args[0] === "HEAD") throw new Error("simulated rev-parse HEAD failure (N1 test seam)");
        return fx.repo;
      },
    };
    const writer = new GitWriter(fx.repo, { gitFactory: () => fakeGit });
    const result = await writer.checkout("atlas");
    check("(N1) checkout() still reports ok:true for a mutation that (in production) already happened", result.ok === true && result.branch === "atlas");
    check("(N1) sha degrades to null instead of the whole call failing", result.ok === true && result.sha === null);
    // checkoutProjectBranch's OWN handling of this exact shape (refuse the repoint, name that the
    // checkout itself succeeded) has no test seam to reach via a fake GitWriter — it is exercised
    // directly in sessions/service.ts's own code path and covered by this file's other scenarios
    // constructing a REAL GitWriter; this scenario's job is proving GitWriter.checkout() itself degrades
    // instead of throwing, which is the one new behavior round 6 adds. (M3-iii closes the gap this
    // comment used to describe — see (N1-SERVICE) below, which DOES reach checkoutProjectBranch's own
    // handling, through the real method, via a `GitWriter.prototype.checkout` patch instead of a fake.)
  }

  // ===================== (N1-SERVICE) checkoutProjectBranch's OWN sha:null handling, through the real method (M3-iii) =====================
  {
    const fx = makeFixture("n1service");
    git(fx.repo, "branch", "atlas");
    fx.trustBranch("atlas");
    // Patches the CLASS prototype (checkoutProjectBranch constructs its own GitWriter instance, so there
    // is no instance to inject into) — forwards to the REAL checkout() (so the real precondition hook,
    // the real git mutation, and the real branch read all still happen exactly as in production), then
    // forces `sha` to `null` on an otherwise-successful result — simulating the post-checkout rev-parse
    // timing out AFTER the checkout already succeeded, without weakening any check along the way.
    const originalCheckout = GitWriter.prototype.checkout;
    GitWriter.prototype.checkout = async function (branch, opts) {
      const real = await originalCheckout.call(this, branch, opts);
      return real.ok ? { ...real, sha: null } : real;
    };
    const r1 = await fx.call("project_checkout_branch", { branch: "atlas" });
    GitWriter.prototype.checkout = originalCheckout;
    check("(N1-SERVICE) checkoutProjectBranch refuses to repoint when the sha could not be confirmed (M3-iii)", r1.ok === false && /could not be confirmed/.test(r1.error));
    check("(N1-SERVICE) the checkout itself DID actually succeed (canonical really moved)", fx.canonBranch() === "atlas");
    check("(N1-SERVICE) W was NOT re-pointed despite the real mutation succeeding", fx.watermark() === null);
    // negative control (round 8 MAJOR #2): with real sha reporting restored, the same call now succeeds —
    // and, because W was left stuck on the OLD (absent) watermark by the refusal above while the canonical
    // checkout genuinely moved to atlas, this is NOT a bare untouched noop: it re-validates the full
    // precondition in-lock and actually RE-POINTS W, which the old noop path never did.
    const r2 = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(N1-SERVICE) negative control: the SAME call now succeeds and actually re-points the previously-stuck watermark (round 8 MAJOR #2, not a bare noop)", r2.ok === true && r2.noop === false && fx.watermark()?.branch === "atlas" && fx.watermark()?.sha === fx.canonHead());
  }

  // ===================== (N1-MISMATCH) the landed sha is compared against the in-lock classified tip (n1) =====================
  {
    const fx = makeFixture("n1mismatch");
    git(fx.repo, "branch", "atlas");
    fx.trustBranch("atlas");
    // Patches the INSTANCE method (unlike (N1-SERVICE) above, which patches the GitWriter class) so the
    // real checkout still happens unmodified — only the CLASSIFIED tip `refuseIfTargetBranchUntrusted`
    // reports is deliberately wrong, simulating a genuine divergence between what was classified and what
    // actually landed.
    const original = fx.sessions.refuseIfTargetBranchUntrusted.bind(fx.sessions);
    fx.sessions.refuseIfTargetBranchUntrusted = async (a) => {
      const real = await original(a);
      return real.ok ? { ok: true, classifiedTip: "0".repeat(40) } : real;
    };
    const r1 = await fx.call("project_checkout_branch", { branch: "atlas" });
    fx.sessions.refuseIfTargetBranchUntrusted = original;
    check("(N1-MISMATCH) refuses when the landed sha does not match the classified tip (n1)", r1.ok === false && /does not match/.test(r1.error));
    check("(N1-MISMATCH) W was NOT re-pointed on the mismatch", fx.watermark() === null);
    // @decision 2a6a292a round 11 (CR8, item 2) — this mismatch is now direct evidence of a concurrent
    // ref write and files the SAME HIGH event/alert every other refusal in this gate files, so a bare
    // retry is refused too (see immediately below) until a human clears it — round 8's own "a bare retry
    // silently succeeds" no longer holds; see the decision record's round-11 section.
    check("(N1-MISMATCH) a HIGH mainline_moved_outside_loom event was filed, naming untrusted-tip-mismatch", fx.mwEvents().some((e) => e.detail.evidence?.includes("untrusted-tip-mismatch")));
    const r1b = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(N1-MISMATCH) a bare retry is refused by the newly-filed alert, not silently re-admitted", r1b.ok === false && /unresolved mainline alert/.test(r1b.error));
    // negative control (round 8 MAJOR #2, now gated behind clearing the alert — the human-only reset's
    // own effect, see (ALERT) above): once cleared, a retry re-validates the full precondition in-lock and
    // actually RE-POINTS the previously-stuck watermark, not a bare untouched noop.
    db.deleteMeta(fx.alertKey);
    const r2 = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(N1-MISMATCH) negative control: once the alert is cleared, the SAME call now succeeds and actually re-points the previously-stuck watermark (round 8 MAJOR #2, not a bare noop)", r2.ok === true && r2.noop === false && fx.watermark()?.branch === "atlas" && fx.watermark()?.sha === fx.canonHead());
  }

  // ===================== (C3) checkMainlineMove's BOOT-path store() also re-stamps the per-branch trust record (M3-iii) =====================
  {
    const fx = makeFixture("c3boot");
    const w = await fx.addWorker("seed");
    const seeded = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, w.workerId);
    const landedSha = fx.watermark().sha;
    check("(C3) setup: trust stamped by the landing", fx.trust(fx.main) === landedSha);
    // checkMainlineMove's "w.sha === head.tip" shortcut returns EARLY, skipping store() entirely, when
    // nothing has moved since the landing — so an UNCHANGED boot check can never exercise it. Advancing
    // with an ORDINARY (non-Loom) commit forces a real classification: classifyMainlineMove treats a
    // genuine porcelain commit as "explained"/benign (same technique the (LNDR)/(DEDUPE) scenarios use
    // for the OPPOSITE case — a raw `update-ref` — to prove the alert path instead).
    fs.writeFileSync(path.join(fx.repo, "c3.txt"), "c3\n");
    commitAll(fx.repo, "chore(x): ordinary advance for the boot check to classify", GIT_ID);
    const advancedTip = fx.canonHead();
    check("(C3) setup: HEAD advanced past W via an ordinary (non-Loom) commit", advancedTip !== landedSha);
    // Clear the trust record directly — this isolates the BOOT path's OWN store() as what's actually
    // being tested below, rather than leaning on the landing's own (separately-tested) write.
    db.deleteMeta(MW.mainlineBranchTrustKey(fx.projId, "primary", fx.main));
    check("(C3) setup: trust record cleared", fx.trust(fx.main) === null);
    await fx.sessions.checkMainlineMovesOnBoot();
    check("(C3) the boot path's own checkMainlineMove store() re-stamps the trust record to the NEW tip (C3)", fx.trust(fx.main) === advancedTip);
    check("(C3) W itself also advanced to the new tip", fx.watermark()?.sha === advancedTip);
  }

  // ===================== (C7) a repo rebind wipes every per-branch trust record too, not just W (M3-iii) =====================
  {
    const fx = makeFixture("c7rebind");
    const w = await fx.addWorker("seed");
    const seeded = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, w.workerId);
    check("(C7) setup: trust stamped by the landing", fx.trust(fx.main) === fx.watermark().sha);
    db.updateProject(fx.projId, { repoPath: path.join(os.tmpdir(), `loom-pcb-c7-other-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`) });
    check("(C7) rebind wipes the per-branch trust record too (C7)", fx.trust(fx.main) === null);
    check("(C7) rebind also wipes W itself (pre-existing behavior, unchanged)", fx.watermark() === null);
  }

  // ===================== (OK / LEAD): SUCCESS via create:true, then the Platform Lead's own checkout =====================
  let okFx;
  {
    const fx = makeFixture("ok", { withPlatform: true });
    okFx = fx;
    const seedWorker = await fx.addWorker("seed");
    const seeded = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, seedWorker.workerId);
    check("(OK) setup: a real landing establishes W on main FIRST", seeded.settled === true && seeded.ok === true && seeded.value.merged === true && fx.watermark()?.branch === fx.main && fx.watermark()?.sha === fx.canonHead());

    const created = await fx.call("project_checkout_branch", { branch: "atlas", create: true });
    check("(OK) create:true switches to a brand-new atlas", created.ok === true && created.created === true && fx.canonBranch() === "atlas");

    // THE POINT (removing the re-point would turn this RED): a worker spawned AFTER the switch, forked
    // from the NEW checkout, lands on atlas — not main — with no branchDiverted refusal.
    const afterSwitch = await fx.addWorker("post");
    const confirmResult = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, afterSwitch.workerId);
    check("(OK) the solo merge confirm lands cleanly (NO branchDiverted refusal)", confirmResult.settled === true && confirmResult.ok === true && confirmResult.value.merged === true && !confirmResult.value.branchDiverted);
    const landedSha = fx.canonHead();
    check("(OK) canonical is still on atlas after the landing", fx.canonBranch() === "atlas");
    check("(OK) the watermark advanced to the new landed tip, branch unchanged", fx.watermark()?.branch === "atlas" && fx.watermark()?.sha === landedSha);
  }

  // ===================== (LEAD) the Platform Lead's own git_checkout does NOT re-point W =====================
  {
    const fx = okFx;
    git(fx.repo, "checkout", "-q", fx.main);
    const wBeforeLead = fx.watermark();
    const evCountBefore = fx.mwEvents().length;
    const platform = new PlatformMcpRouter(db, fx.sessions);
    const leadResult = await callTool(platform.buildServer(fx.pfmId), "git_checkout", { projectId: fx.projId, branch: fx.main });
    check("(LEAD) setup control: the Lead's own git_checkout actually succeeded", leadResult.ok === true && leadResult.branch === fx.main);
    check("(LEAD) canonical really moved back to main", fx.canonBranch() === fx.main);
    check("(LEAD) THE POINT: W is UNCHANGED by the Lead's checkout — still atlas, not re-pointed to main", JSON.stringify(fx.watermark()) === JSON.stringify(wBeforeLead) && fx.watermark()?.branch === "atlas");
    check("(LEAD) no new manager-checkout audit event was filed by the Lead's call", fx.mwEvents().length === evCountBefore);
  }

  // ===================== (CASEFOLD A) create:true "FEAT" over a PACKED "feat" ⇒ refused, naming feat; feat's own sha is untouched (seventh CR, MAJOR 1) =====================
  {
    const fx = makeFixture("casefold-a");
    const seedWorker = await fx.addWorker("seed");
    await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, seedWorker.workerId);
    git(fx.repo, "branch", "feat");
    fx.trustBranch("feat");
    const featShaBefore = git(fx.repo, "rev-parse", "feat");
    git(fx.repo, "pack-refs", "--all");
    const r = await fx.call("project_checkout_branch", { branch: "FEAT", create: true });
    check("(CASEFOLD A) create:true \"FEAT\" over a packed \"feat\" is refused", r.ok === false);
    check("(CASEFOLD A) the refusal names the real existing branch \"feat\"", /"feat"/.test(r.error));
    check("(CASEFOLD A) feat's own sha is unchanged", git(fx.repo, "rev-parse", "feat") === featShaBefore);
    check("(CASEFOLD A) no local \"FEAT\" ref was ever created", (() => { try { git(fx.repo, "rev-parse", "--verify", "--quiet", "refs/heads/FEAT"); return false; } catch { return true; } })());
  }

  // ===================== (CASEFOLD B) switch to "FEAT" over a PACKED "feat" ⇒ refused (seventh CR, MAJOR 1) =====================
  {
    const fx = makeFixture("casefold-b");
    git(fx.repo, "branch", "feat");
    fx.trustBranch("feat");
    git(fx.repo, "pack-refs", "--all");
    const r = await fx.call("project_checkout_branch", { branch: "FEAT" });
    check("(CASEFOLD B) switch to \"FEAT\" over a packed \"feat\" is refused", r.ok === false);
    check("(CASEFOLD B) the refusal names the real existing branch \"feat\"", /"feat"/.test(r.error));
    check("(CASEFOLD B) canonical is untouched (still on main)", fx.canonBranch() === fx.main);
  }

  // ===================== (CASEFOLD C) switch to "FEAT" over a LOOSE "feat" (never packed) ⇒ refused — the
  // exact CR8 "(C)" case: the OLD rev-parse-based check could resolve "FEAT" via NTFS case-folding and
  // then misdiagnose it as "no trusted baseline" instead of naming the real collision =====================
  {
    const fx = makeFixture("casefold-c");
    git(fx.repo, "branch", "feat");
    fx.trustBranch("feat");
    const r = await fx.call("project_checkout_branch", { branch: "FEAT" });
    check("(CASEFOLD C) switch to \"FEAT\" over a loose \"feat\" is refused", r.ok === false);
    check("(CASEFOLD C) the refusal names the real branch \"feat\", not a \"no trusted baseline\" misdiagnosis", /"feat"/.test(r.error) && !/no trusted baseline/.test(r.error));
    check("(CASEFOLD C) canonical is untouched (still on main)", fx.canonBranch() === fx.main);
    // negative control: the exact, real-cased name still switches cleanly.
    const ok = await fx.call("project_checkout_branch", { branch: "feat" });
    check("(CASEFOLD C) negative control: the exact existing name \"feat\" switches cleanly", ok.ok === true && fx.canonBranch() === "feat");
  }

  // ===================== (CASEFOLD D1) create:true "FEAT/X" over a PACKED "feat/x" ⇒ refused (seventh CR, MAJOR 1) =====================
  {
    const fx = makeFixture("casefold-d1");
    const seedWorker = await fx.addWorker("seed");
    await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, seedWorker.workerId);
    git(fx.repo, "branch", "feat/x");
    fx.trustBranch("feat/x");
    git(fx.repo, "pack-refs", "--all");
    const r = await fx.call("project_checkout_branch", { branch: "FEAT/X", create: true });
    check("(CASEFOLD D1) create:true \"FEAT/X\" over a packed \"feat/x\" is refused", r.ok === false);
    check("(CASEFOLD D1) the refusal names the colliding existing branch \"feat/x\"", /"feat\/x"/.test(r.error));
  }

  // ===================== (CASEFOLD D2) create:true "FEAT/x" over a LOOSE "feat/y" ⇒ refused — the
  // reverse shape: the candidate's own leaf segment collides with an existing branch's DIRECTORY segment
  // (seventh CR, MINOR 4 / D2) =====================
  {
    const fx = makeFixture("casefold-d2");
    const seedWorker = await fx.addWorker("seed");
    await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, seedWorker.workerId);
    git(fx.repo, "branch", "feat/y");
    fx.trustBranch("feat/y");
    const r = await fx.call("project_checkout_branch", { branch: "FEAT/x", create: true });
    check("(CASEFOLD D2) create:true \"FEAT/x\" over a loose \"feat/y\" is refused", r.ok === false);
    check("(CASEFOLD D2) the refusal names the colliding directory component via \"feat/y\"", /"feat"/.test(r.error) && /"feat\/y"/.test(r.error));
    // negative control: a genuinely non-colliding sibling under the SAME exact-case directory still works.
    const ok = await fx.call("project_checkout_branch", { branch: "feat/z", create: true });
    check("(CASEFOLD D2) negative control: a non-colliding sibling \"feat/z\" (same exact-case directory) still creates cleanly", ok.ok === true && ok.created === true && fx.canonBranch() === "feat/z");
  }

  // ===================== (NEVER-TWO-SPELLINGS) a branch's trust record is never keyed under two
  // case-spellings of the same name — this record's own claim, checked directly =====================
  {
    const fx = makeFixture("never-two-spellings");
    git(fx.repo, "branch", "feat");
    fx.trustBranch("feat");
    const featTrustBefore = fx.trust("feat");
    git(fx.repo, "pack-refs", "--all");
    await fx.call("project_checkout_branch", { branch: "FEAT", create: true });
    await fx.call("project_checkout_branch", { branch: "FEAT" });
    check("(NEVER-TWO-SPELLINGS) no trust record was ever stamped under the colliding case \"FEAT\"", fx.trust("FEAT") == null);
    check("(NEVER-TWO-SPELLINGS) \"feat\"'s own trust record is untouched", fx.trust("feat") === featTrustBefore);
  }

  // ===================== (SHADOW-EXACT) the remote-tracking shadow match is EXACT, never a loose "/branch"
  // suffix — round 11's suffix match over-matched refs/remotes/origin/hotfix/zzz as a shadow of a switch to
  // "zzz" (seventh CR, MAJOR 2) =====================
  {
    const fx = makeFixture("shadow-exact-negative");
    git(fx.repo, "remote", "add", "origin", "https://example.invalid/repo.git");
    git(fx.repo, "update-ref", "refs/remotes/origin/hotfix/zzz", fx.canonHead());
    const negative = await fx.call("project_checkout_branch", { branch: "zzz" });
    check("(SHADOW-EXACT) switching to \"zzz\" when only \"refs/remotes/origin/hotfix/zzz\" exists is an ORDINARY refusal, not a shadow match", negative.ok === false && !/remote-tracking ref/.test(negative.error));
    check("(SHADOW-EXACT) no HIGH event was filed for the non-match", fx.mwEvents().length === 0);
  }
  {
    const fx = makeFixture("shadow-exact-positive");
    git(fx.repo, "remote", "add", "origin", "https://example.invalid/repo.git");
    git(fx.repo, "update-ref", "refs/remotes/origin/zzz", fx.canonHead());
    const positive = await fx.call("project_checkout_branch", { branch: "zzz" });
    check("(SHADOW-EXACT) positive control: switching to \"zzz\" when \"refs/remotes/origin/zzz\" exists IS the shadow case", positive.ok === false && /remote-tracking ref/.test(positive.error));
    check("(SHADOW-EXACT) positive control files a HIGH event naming remote-tracking-shadow", fx.mwEvents().some((e) => e.detail.evidence.includes("remote-tracking-shadow")));
  }

  // ===================== (REMOTE-PREFIX-CI) create:true refuses a remote-name-shadowing prefix
  // case-insensitively, and against a multi-segment remote name (seventh CR, MINOR 3) =====================
  {
    const fx = makeFixture("remote-prefix-ci");
    const seedWorker = await fx.addWorker("seed");
    await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, seedWorker.workerId);
    git(fx.repo, "remote", "add", "origin", "https://example.invalid/repo.git");
    const r1 = await fx.call("project_checkout_branch", { branch: "Origin/main", create: true });
    check("(REMOTE-PREFIX-CI) create:true \"Origin/main\" is refused case-insensitively against remote \"origin\"", r1.ok === false && /configured remote/.test(r1.error));
  }
  {
    const fx = makeFixture("remote-prefix-slash");
    const seedWorker = await fx.addWorker("seed");
    await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, seedWorker.workerId);
    // A remote literally named "a/b" — configured directly (git remote add's own name validation is
    // untested for this shape), same technique this record's round-10 section already documented.
    git(fx.repo, "config", "remote.a/b.url", "https://example.invalid/repo.git");
    git(fx.repo, "config", "remote.a/b.fetch", "+refs/heads/*:refs/remotes/a/b/*");
    const r2 = await fx.call("project_checkout_branch", { branch: "a/b/c", create: true });
    check("(REMOTE-PREFIX-CI) create:true \"a/b/c\" is refused against the multi-segment remote \"a/b\"", r2.ok === false && /configured remote/.test(r2.error));
  }

  // ===================== (CREATE-REMOTE-SHADOW) create:true "origin/main" is refused; switching to an
  // EXISTING "origin/main" branch (once trusted) stays allowed — round 11's own promised test, actually
  // written (seventh CR, MAJOR 1 finding: the record claimed this existed and it did not) =====================
  {
    const fx = makeFixture("create-remote-shadow");
    git(fx.repo, "remote", "add", "origin", "https://example.invalid/repo.git");
    const seedWorker = await fx.addWorker("seed");
    await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, seedWorker.workerId);
    const refused = await fx.call("project_checkout_branch", { branch: "origin/main", create: true });
    check("(CREATE-REMOTE-SHADOW) create:true \"origin/main\" is refused", refused.ok === false && /configured remote/.test(refused.error));
    git(fx.repo, "branch", "origin/main", fx.main);
    fx.trustBranch("origin/main");
    const switched = await fx.call("project_checkout_branch", { branch: "origin/main" });
    check("(CREATE-REMOTE-SHADOW) negative control: switching to an EXISTING \"origin/main\" branch stays allowed", switched.ok === true && fx.canonBranch() === "origin/main");
  }

  // ===================== (R13-TAG-CREATE) create:true "FEAT" over a PACKED, trusted "feat" that ALSO has a
  // same-named TAG ⇒ refused, naming "feat" — ninth CR (CR9) MAJOR: `%(refname:short)` shortens a branch to
  // `heads/<name>` (never the bare name) whenever the short name would be AMBIGUOUS with another ref (a
  // same-named tag here); the for-each-ref listing this gate reads then never matches "feat" against
  // anything, so the case-fold collision check (and the plain exact-name check) went blind to "feat"
  // entirely, letting create:true plant a real refs/heads/FEAT sibling beside it =====================
  {
    const fx = makeFixture("r13-tag-create");
    const seedWorker = await fx.addWorker("seed");
    await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, seedWorker.workerId);
    git(fx.repo, "branch", "feat");
    fx.trustBranch("feat");
    const featShaBefore = git(fx.repo, "rev-parse", "feat");
    git(fx.repo, "pack-refs", "--all");
    git(fx.repo, "tag", "feat"); // same-named TAG — the real git ambiguity source (CR9 MAJOR)
    check("(R13-TAG-CREATE) setup control: git's own ambiguous shortening is really present", git(fx.repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/feat") !== "feat");
    const r = await fx.call("project_checkout_branch", { branch: "FEAT", create: true });
    check("(R13-TAG-CREATE) create:true \"FEAT\" over a tag-shadowed, packed \"feat\" is refused", r.ok === false);
    check("(R13-TAG-CREATE) the refusal names the real existing branch \"feat\"", /"feat"/.test(r.error));
    check("(R13-TAG-CREATE) feat's own sha is unchanged", git(fx.repo, "rev-parse", "feat") === featShaBefore);
    check("(R13-TAG-CREATE) no local \"FEAT\" ref was ever created", (() => { try { git(fx.repo, "rev-parse", "--verify", "--quiet", "refs/heads/FEAT"); return false; } catch { return true; } })());
  }

  // ===================== (R13-TAG-SWITCH) switching to the EXACT existing name "feat" still succeeds when a
  // same-named tag makes %(refname:short) shorten it to "heads/feat" — CR9's MAJOR false-refuse: the old
  // code compared a.branch ("feat") against that shortened "heads/feat", never found a match, and refused a
  // real, trusted, existing branch as "no local branch exists" =====================
  {
    const fx = makeFixture("r13-tag-switch");
    git(fx.repo, "branch", "feat");
    fx.trustBranch("feat");
    git(fx.repo, "tag", "feat");
    check("(R13-TAG-SWITCH) setup control: git's own ambiguous shortening is really present", git(fx.repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/feat") !== "feat");
    const r = await fx.call("project_checkout_branch", { branch: "feat" });
    // NOTE: fx.canonBranch() itself calls `git symbolic-ref --short HEAD`, which is ALSO ambiguity-prone
    // against a same-named tag (verified directly) — asserting on it here would test the wrong thing. The
    // unshortened `git symbolic-ref HEAD` is never ambiguity-shortened, so it's the sound check for this
    // scenario specifically (every OTHER scenario in this file keeps using fx.canonBranch(), which is fine
    // there since nothing else manufactures this exact tag-name collision).
    check("(R13-TAG-SWITCH) switching to the exact existing name \"feat\" succeeds despite the tag-ambiguous shortening (not a false \"no local branch exists\")", r.ok === true && git(fx.repo, "symbolic-ref", "HEAD") === "refs/heads/feat" && !/no local branch/.test(JSON.stringify(r)));
  }

  // ===================== (R13-REMOTEHEAD) a refs/remotes/<name>/HEAD ref sharing "feat"'s own name is a
  // SECOND, independent real-git ambiguity source for %(refname:short) — git's own DWIM rev-parse rules
  // include "refs/remotes/%.*s/HEAD" alongside "refs/tags/%.*s", so a bare ref (even one never registered as
  // a configured remote, just the ref existing) is enough to trigger the same shortening bug =====================
  {
    const fx = makeFixture("r13-remotehead-switch");
    git(fx.repo, "branch", "feat");
    fx.trustBranch("feat");
    git(fx.repo, "update-ref", "refs/remotes/feat/HEAD", fx.canonHead());
    check("(R13-REMOTEHEAD-SWITCH) setup control: git's own ambiguous shortening is really present", git(fx.repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/feat") !== "feat");
    const r = await fx.call("project_checkout_branch", { branch: "feat" });
    check("(R13-REMOTEHEAD-SWITCH) switching to \"feat\" succeeds despite a refs/remotes/feat/HEAD ambiguity", r.ok === true && fx.canonBranch() === "feat");
  }
  {
    const fx = makeFixture("r13-remotehead-create");
    const seedWorker = await fx.addWorker("seed");
    await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, seedWorker.workerId);
    git(fx.repo, "branch", "feat");
    fx.trustBranch("feat");
    const featShaBefore = git(fx.repo, "rev-parse", "feat");
    git(fx.repo, "update-ref", "refs/remotes/feat/HEAD", featShaBefore);
    check("(R13-REMOTEHEAD-CREATE) setup control: git's own ambiguous shortening is really present", git(fx.repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/feat") !== "feat");
    const r = await fx.call("project_checkout_branch", { branch: "FEAT", create: true });
    check("(R13-REMOTEHEAD-CREATE) create:true \"FEAT\" over a remote-HEAD-shadowed \"feat\" is refused", r.ok === false);
    check("(R13-REMOTEHEAD-CREATE) the refusal names the real existing branch \"feat\"", /"feat"/.test(r.error));
    check("(R13-REMOTEHEAD-CREATE) feat's own sha is unchanged", git(fx.repo, "rev-parse", "feat") === featShaBefore);
  }
} finally {
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — project_checkout_branch switches to an existing branch (or, via create:true, makes a brand-new one at the current trusted tip) and re-points the mainline watermark immediately (not lazily), so a subsequent solo merge lands cleanly with no human reset needed. It is a no-op on the branch already checked out. It hard-refuses, no override, on: Loom's own reserved home; any live/queued gate op of any kind; a worktree cut in flight (refcount released even when the real createWorktree throws); a tracked change in the canonical tree (untracked files do not block); an unmerged worker branch scoped to LIVE or worktree-still-on-disk (round 6); the SWITCH TARGET's own per-branch trust record failing an EXACT-match check (round 9 — a trailered or untrailered descendant, forged or genuine, an ancestor/rewind, or a non-ancestor move are ALL refused identically, since round 9 deleted all git-derived classification after a forged Loom-Worker-Branch trailer defeated rounds 7/8's own layered checks) OR simply not existing yet (round 6 — closing the away-and-back laundering gap a source-only check left open, now closed on the already-checked-out fixup entry point too); and any existing mainline alert marker other than the purely-informational first-sight-declined one (round 6). Every refusal carries a negative control proving the call succeeds once the condition clears. A TOCTOU race between the courtesy pre-check and lock admission is still caught by the in-lock precondition hook, on BOTH the ordinary-switch path (round 6) and the already-checked-out, W-disagrees fixup path (round 9). GitWriter.checkout()'s post-checkout sha read degrades to sha:null instead of failing a mutation that already happened. It is manager-only (absent from the worker surface), and leaves the Platform Lead's own pre-existing git_checkout (which never touches the watermark) unchanged."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
