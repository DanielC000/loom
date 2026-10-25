import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card aa7677fa round 3 (decision record 2a6a292a round 21) — Code Review 34562ac8 found round 2's own
// ledger fix (round 20) still CRITICAL: the solo ledger tip was a bare `git rev-parse HEAD` RE-READ after
// `git commit` (worktrees.ts), and `verifyLandedOnMainline` only ever checked the branch NAME, never that
// the re-read sha was Loom's OWN commit. A racer moving `refs/heads/main` in the window between the real
// `git commit` settling and that re-read (reproduced below via a post-commit hook, exactly the reviewer's
// own probe) got a FORGED commit a ledger row — and, independently (an OLDER hole predating round 20),
// `advanceMainlineWatermark` stamped a totally FRESH `readMainlineHead().tip` into TRUST unconditionally,
// so the same forgery went straight into trust too, with zero events.
//
// FIX: `mergeBranchLocked` now captures the staged TREE (`git write-tree`) in the SAME pre-commit window
// it already captures `preCommitHead` (card c862f14c's own adjacency rule), and verifies a post-commit
// re-read's parent+tree against both before trusting it as "our own commit" (`verifyLandedAsOwnCommit`,
// returning the ledger `base` only when verified). `recordMainlineLedgerEntryIfRepoUnchanged` no longer re-derives `base`
// via its own git read at all — it takes `merge.landedBase` directly, so an unverified `merge.sha` never
// gets a row. `advanceMainlineWatermark` now REQUIRES `head.tip === mergeSha` before even considering the
// trust stamp, where `mergeSha` is passed as `undefined` (never a free pass) whenever `merge.landedBase`
// is unset — so a forgery that fooled mergeBranchLocked's OWN re-read (this file's main scenario) is ALSO
// blocked at the trust layer, not just the ledger layer.
//
//   (FORGE-RACE) the CRITICAL repro, on the project's FIRST-EVER landing (trust null going in): a
//       post-commit hook on the canonical repo races `refs/heads/main` onto a forged sibling commit — SAME
//       parent as the real squash, a DIFFERENT tree (it adds EVIL.txt, so the content genuinely differs —
//       the exact probe from the Code Review, not a content-identical forgery), with a forged
//       `Loom-Worker-Branch:` trailer. The landing still reports ok:true (4fa36502: never block a landing)
//       and the forged tip IS now live HEAD (inherent — Loom cannot un-move a ref after the fact); trust is
//       never stamped to the forged tip, and never auto-heals onto it either (stays null). NOTE (CR
//       5882d8cb Minor 3): on THIS specific (first-ever) landing, `expectedMainlineBranch` is `undefined`
//       (M1's own asymmetry — no watermark exists yet to resolve a branch from), so the ledger write is
//       skipped regardless of the fix. NOTE (CR 57d7a27d finding 2, round 5): `mergeSha` is unverified
//       here (the tree mismatch rejects it), but preCommitHead/stagedTree WERE captured and checked — so
//       this is the "rejected" case, not "uncaptured", and now DOES fire the null-trust HIGH event (it
//       used to be a silent console.warn before round 23's fix; this scenario IS exactly the race Finding
//       2 closes). See (FORGE-RACE-2) below for the ledger-row-skip + ordinary (non-null-trust) freeze.
//   (FORGE-RACE-2) the SAME forging hook, raced AFTER two clean landings have already warmed up trust and
//       the ledger — HERE the ledger write is genuinely attempted (and still correctly skipped for the
//       forged tip), and `fileLandingTrustFreezeEvent`'s own `trustedBefore !== null` branch ("the main
//       protection") fires exactly once, deduped on a later, entirely ordinary landing.
//   (CONTROL) the identical setup with NO hook installed: an ordinary clean landing still gets its usual
//       ledger row and trust stamp — the fix does not make verification itself more paranoid than before.
//   (UNIT) a direct `mergeBranch` call against a bare repo asserts `landedBase` is a PRESENT key (not
//       merely an absent property reading as `undefined` — see CR 5882d8cb Minor 3) equal to `undefined`
//       for the forged-tree case and to `preCommitHead` for the clean case — isolating the claim from the
//       rest of the service-layer plumbing, in case a future change to that plumbing obscures which layer
//       regressed.
//   (UNIT-TWO-PARENT) CR 5882d8cb Minor 1: a racer sharing OUR OWN exact parent AND tree (content-
//       identical — a bare parent+tree check alone would have verified this) but carrying a SECOND,
//       foreign-root parent — `landedBase` must still be `undefined`, since `git commit` on a clean squash
//       always produces exactly one parent.
//   (UNIT-GRAFT-HIDDEN) CR 57d7a27d finding 1 (round 5): the SAME two-parent racer, but with a
//       `.git/info/grafts` entry hiding the second parent from any graft-aware read — `cat-file -p`
//       (round 23's fix) reads the raw object, immune to grafts, so `landedBase` still comes back
//       `undefined` even though `rev-list --parents` (round 22's own, now-superseded fix) would be fooled.
//
// Run: 1) build daemon (pnpm build), 2) LOOM_CODEX_BIN=<nonexistent> node test/mainline-watch-own-commit-verify.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), `loom-no-such-codex-bin-${process.pid}`);
useOwnLoomHome("loom-mw-owncommit-home-");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, mergeBranch, parseLoomTrailerBlock, findLandedSquashCommit, getTaskMergedInfo, __resetMergedCommitMapCacheForTest } = await import("../dist/git/worktrees.js");
const MW = await import("../dist/git/mainline-watch.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const IDENT = { GIT_AUTHOR_NAME: "mwo", GIT_AUTHOR_EMAIL: "mwo@loom", GIT_COMMITTER_NAME: "mwo", GIT_COMMITTER_EMAIL: "mwo@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=mwo@loom -c user.name=mwo";
const now = new Date().toISOString();
const noReap = async () => ({ killedPids: [] });
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };

function makeRepo(sfx) {
  const repo = mkdtempManaged(`loom-mwo-repo-${sfx}-`);
  fs.writeFileSync(path.join(repo, "README.md"), "# mwo\n");
  git(repo, "init", "-q", "-b", "main"); git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "user.email", "mwo@loom"); git(repo, "config", "user.name", "mwo");
  commitAll(repo, "init", GIT_ID);
  return repo;
}

function newProject(tag, repo) {
  const sfx = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const projId = `mwo-proj-${sfx}`, agentId = `mwo-agent-${sfx}`, mgrId = `mwo-mgr-${sfx}`;
  const db = new Db();
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, runGate: async () => ({ passed: true, steps: [] }), reapWorktreeProcesses: noReap });
  const nudges = [];
  const origEnqueue = sessions.enqueueDurableMessage.bind(sessions);
  sessions.enqueueDurableMessage = (target, text, ...rest) => { if (String(text).startsWith("[loom:mainline-moved]")) nudges.push(text); return origEnqueue(target, text, ...rest); };
  db.insertProject({ id: projId, name: `MWO-${tag}`, repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null });
  return { db, sessions, nudges, projId, mgrId, agentId, sfx, repo };
}

const eventsFor = (db, projId) => db.listEventsSince(0, 100000).filter((e) => e.kind === "mainline_moved_outside_loom" && e.detail?.projectId === projId);
const freezeEventsFor = (db, projId) => eventsFor(db, projId).filter((e) => e.detail?.source === "landing-trust-freeze");
// Card f224632d (round 2) — the M1 advisory, a DISTINCT kind from mainline_moved_outside_loom on purpose.
const trailerAdvisoryEventsFor = (db, projId) => db.listEventsSince(0, 100000).filter((e) => e.kind === "landing_trailer_displaced" && e.detail?.projectId === projId);

let seq = 0;
async function addWorker(ctx, tag) {
  const n = `${tag}${++seq}`;
  const taskId = `mwo-${n}-task-${ctx.sfx}`, workerId = `mwo-${n}-wkr-${ctx.sfx}`;
  ctx.db.insertTask({ id: taskId, projectId: ctx.projId, title: `feat(x): change ${n}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(ctx.repo, ctx.projId, taskId);
  registerForCleanup(worktreePath);
  fs.writeFileSync(path.join(worktreePath, `${n}.ts`), `export const ${n} = 1;\n`);
  commitAll(worktreePath, `feat(x): change ${n}`, GIT_ID);
  ctx.db.insertSession({ id: workerId, projectId: ctx.projId, agentId: ctx.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: ctx.mgrId, taskId, worktreePath, branch });
  return { taskId, workerId, worktreePath, branch };
}
const confirm = async (ctx, w) => ctx.sessions.confirmWorkerMergeTracked(ctx.mgrId, w.workerId);

// The reviewer's own probe (card aa7677fa round 3, CR 34562ac8): a post-commit hook that races
// `refs/heads/main` onto a forged sibling commit — SAME parent as the real squash (so a bare parent check
// alone would pass), a DIFFERENT tree (adds EVIL.txt — genuine content divergence, not a byte-identical
// forgery), with a forged Loom trailer. Ends by `reset --hard` so the working tree/index land consistent
// with whatever ref state the hook leaves behind (never relied on by the merge code itself, which only
// ever reads via plain `rev-parse` after this point, but keeps the repo sane for anything run afterward).
//
// GOTCHA (found the hard way): git worktrees share hooks via the common `.git/hooks` directory — a hook
// installed this way ALSO fires on the worker's OWN commit inside its worktree (`commitAll(worktreePath,
// ...)`), not just on the canonical squash, corrupting `refs/heads/main` from the wrong parent context
// before the real landing even starts. Scope the forgery to the CANONICAL checkout only, via a toplevel
// comparison baked into the script as a literal (computed once, at install time).
function installForgingPostCommitHook(repo) {
  const hookPath = path.join(repo, ".git", "hooks", "post-commit");
  const canonicalToplevel = git(repo, "rev-parse", "--show-toplevel");
  const script = [
    "#!/bin/sh",
    "set -e",
    `if [ "$(git rev-parse --show-toplevel)" != ${JSON.stringify(canonicalToplevel)} ]; then exit 0; fi`,
    "PARENT=$(git rev-parse HEAD^)",
    "printf 'evil\\n' > EVIL.txt",
    "git add EVIL.txt",
    "TREE=$(git write-tree)",
    'FORGED=$(git commit-tree "$TREE" -p "$PARENT" -m "feat(x): innocuous" -m "Loom-Worker-Branch: loom/deadbeef0000")',
    'git update-ref -m "commit: x" refs/heads/main "$FORGED"',
    "git reset --hard",
    "",
  ].join("\n");
  fs.writeFileSync(hookPath, script);
  fs.chmodSync(hookPath, 0o755);
}

// CR 5882d8cb Minor 1 (card aa7677fa round 4): a racer commit sharing the real squash's OWN first parent
// AND its OWN exact tree (content-identical — no EVIL.txt, nothing a tree-diff could catch) but carrying
// a SECOND, foreign-root parent. `git commit` on a clean, non-merge squash always produces a single-
// parent commit, so a second parent alone is proof this wasn't ours — round 21's parent+tree checks
// alone would have passed this. Same canonical-toplevel scoping gotcha as installForgingPostCommitHook.
function installTwoParentRacingPostCommitHook(repo) {
  const hookPath = path.join(repo, ".git", "hooks", "post-commit");
  const canonicalToplevel = git(repo, "rev-parse", "--show-toplevel");
  const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"; // git's well-known empty-tree object id
  const script = [
    "#!/bin/sh",
    "set -e",
    `if [ "$(git rev-parse --show-toplevel)" != ${JSON.stringify(canonicalToplevel)} ]; then exit 0; fi`,
    "PARENT=$(git rev-parse HEAD^)",
    "TREE=$(git rev-parse HEAD^{tree})",
    `FOREIGNROOT=$(git commit-tree ${EMPTY_TREE} -m "unrelated foreign history")`,
    'FORGED=$(git commit-tree "$TREE" -p "$PARENT" -p "$FOREIGNROOT" -m "feat(x): innocuous" -m "Loom-Worker-Branch: loom/deadbeef0003")',
    'git update-ref -m "commit: x" refs/heads/main "$FORGED"',
    "git reset --hard",
    "",
  ].join("\n");
  fs.writeFileSync(hookPath, script);
  fs.chmodSync(hookPath, 0o755);
}

// CR 57d7a27d finding 1 (card aa7677fa round 5): the SAME two-parent racer as above, but ALSO writing a
// `.git/info/grafts` entry that hides the second (foreign-root) parent from any graft-aware git read —
// `rev-list --parents` (round 22's own fix) honors grafts, so this defeats round 22 unchanged. The hook
// writes the graft entry itself, in the SAME post-commit window, before mergeBranchLocked's own re-read.
function installGraftHiddenTwoParentRacingPostCommitHook(repo) {
  const hookPath = path.join(repo, ".git", "hooks", "post-commit");
  const canonicalToplevel = git(repo, "rev-parse", "--show-toplevel");
  const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"; // git's well-known empty-tree object id
  const script = [
    "#!/bin/sh",
    "set -e",
    `if [ "$(git rev-parse --show-toplevel)" != ${JSON.stringify(canonicalToplevel)} ]; then exit 0; fi`,
    "PARENT=$(git rev-parse HEAD^)",
    "TREE=$(git rev-parse HEAD^{tree})",
    `FOREIGNROOT=$(git commit-tree ${EMPTY_TREE} -m "unrelated foreign history")`,
    'FORGED=$(git commit-tree "$TREE" -p "$PARENT" -p "$FOREIGNROOT" -m "feat(x): innocuous" -m "Loom-Worker-Branch: loom/deadbeef0004")',
    'mkdir -p "$(git rev-parse --git-path info)"',
    'echo "$FORGED $PARENT" >> "$(git rev-parse --git-path info)/grafts"', // graft: FORGED's ONLY parent is PARENT — the foreign root is hidden from any graft-aware read
    'git update-ref -m "commit: x" refs/heads/main "$FORGED"',
    "git reset --hard",
    "",
  ].join("\n");
  fs.writeFileSync(hookPath, script);
  fs.chmodSync(hookPath, 0o755);
}

// Card f224632d — the SAME content-identical shape as installTwoParentRacingPostCommitHook (single
// parent, OUR OWN exact tree — no EVIL.txt), but forging the `Loom-Worker-Branch:` trailer to name a
// DIFFERENT branch instead of adding a second parent. Round 21-23's own parent+tree-only check would have
// verified this as "our own commit" — this is the exact residual card 95940402 closed for the batch path
// and f224632d closes here for the solo path.
function installSameTreeForgedBranchPostCommitHook(repo) {
  const hookPath = path.join(repo, ".git", "hooks", "post-commit");
  const canonicalToplevel = git(repo, "rev-parse", "--show-toplevel");
  const script = [
    "#!/bin/sh",
    "set -e",
    `if [ "$(git rev-parse --show-toplevel)" != ${JSON.stringify(canonicalToplevel)} ]; then exit 0; fi`,
    "PARENT=$(git rev-parse HEAD^)",
    "TREE=$(git rev-parse HEAD^{tree})",
    'FORGED=$(git commit-tree "$TREE" -p "$PARENT" -m "feat(x): innocuous" -m "Loom-Worker-Branch: loom/deadbeef0006")',
    'git update-ref -m "commit: x" refs/heads/main "$FORGED"',
    "git reset --hard",
    "",
  ].join("\n");
  fs.writeFileSync(hookPath, script);
  fs.chmodSync(hookPath, 0o755);
}

// Card f224632d — the SAME content-identical racer, keeping the REAL `Loom-Worker-Branch:` (so ONLY the
// trailer namespace's OTHER field is wrong) but forging a WRONG, DUPLICATED `Loom-Landed-Tip:` — the exact
// field `pinnedTipForLandedSquash` (sessions/service.ts) prefers as finalize's CAS pin.
function installSameTreeForgedLandedTipPostCommitHook(repo, realBranch) {
  const hookPath = path.join(repo, ".git", "hooks", "post-commit");
  const canonicalToplevel = git(repo, "rev-parse", "--show-toplevel");
  const script = [
    "#!/bin/sh",
    "set -e",
    `if [ "$(git rev-parse --show-toplevel)" != ${JSON.stringify(canonicalToplevel)} ]; then exit 0; fi`,
    "PARENT=$(git rev-parse HEAD^)",
    "TREE=$(git rev-parse HEAD^{tree})",
    `MSG=$(printf 'Loom-Worker-Branch: %s\\nLoom-Landed-Tip: 0000000000000000000000000000000000000000\\nLoom-Landed-Tip: 1111111111111111111111111111111111111111' ${JSON.stringify(realBranch)})`,
    'FORGED=$(git commit-tree "$TREE" -p "$PARENT" -m "feat(x): innocuous" -m "$MSG")',
    'git update-ref -m "commit: x" refs/heads/main "$FORGED"',
    "git reset --hard",
    "",
  ].join("\n");
  fs.writeFileSync(hookPath, script);
  fs.chmodSync(hookPath, 0o755);
}

// Card f224632d (round 2, Code Review 5e586b56 M1) — a LEGITIMATE `commit-msg` hook (runs DURING `git
// commit`, before cleanup, never a post-commit race) that appends a whole NEW paragraph after Loom's own
// trailer paragraph — the "displaced" shape. Scoped to the canonical toplevel only, same gotcha as every
// post-commit hook above (a shared `.git/hooks` dir also fires on the worker's own in-worktree commit).
function installDisplacingCommitMsgHook(repo) {
  const hookPath = path.join(repo, ".git", "hooks", "commit-msg");
  const canonicalToplevel = git(repo, "rev-parse", "--show-toplevel");
  const script = [
    "#!/bin/sh",
    "set -e",
    `if [ "$(git rev-parse --show-toplevel)" != ${JSON.stringify(canonicalToplevel)} ]; then exit 0; fi`,
    "printf '\\n[skip ci]\\n' >> \"$1\"",
    "",
  ].join("\n");
  fs.writeFileSync(hookPath, script);
  fs.chmodSync(hookPath, 0o755);
}

// Card 45036494 — the SAME "displaced" shape as installDisplacingCommitMsgHook above, but appending a
// genuinely TRAILER-SHAPED paragraph (a realistic DCO `Signed-off-by:` hook) instead of a prose `[skip
// ci]` line. `tolerantFindLoomTrailerBlock`'s own discovery widening is deliberately narrower than
// "displaced" itself: it only recovers a displaced landing when every paragraph AFTER Loom's own block is
// ITSELF a well-formed `Key: value`-only block — `[skip ci]` is NOT that shape (discovery correctly still
// refuses it), so the (HOOK-DISPLACED-DISCOVERY)/(HOOK-DISPLACED-RESPAWN) scenarios below need THIS hook,
// not the `[skip ci]` one L1/L2 already used above.
function installDcoDisplacingCommitMsgHook(repo) {
  const hookPath = path.join(repo, ".git", "hooks", "commit-msg");
  const canonicalToplevel = git(repo, "rev-parse", "--show-toplevel");
  const script = [
    "#!/bin/sh",
    "set -e",
    `if [ "$(git rev-parse --show-toplevel)" != ${JSON.stringify(canonicalToplevel)} ]; then exit 0; fi`,
    "printf '\\nSigned-off-by: CI Bot <ci@example.com>\\n' >> \"$1\"",
    "",
  ].join("\n");
  fs.writeFileSync(hookPath, script);
  fs.chmodSync(hookPath, 0o755);
}

// Card f224632d (round 2, M1) — the SAME legitimate hook shape, but appending its line with NO leading
// blank line, so it stays in Loom's OWN final paragraph instead of starting a new one — the "unreadable"
// shape (the exact-set audit still sees only Loom's own reserved lines and passes; `parseLoomTrailerBlock`
// fails because the appended line isn't `key: value`-shaped).
function installUnreadableCommitMsgHook(repo) {
  const hookPath = path.join(repo, ".git", "hooks", "commit-msg");
  const canonicalToplevel = git(repo, "rev-parse", "--show-toplevel");
  const script = [
    "#!/bin/sh",
    "set -e",
    `if [ "$(git rev-parse --show-toplevel)" != ${JSON.stringify(canonicalToplevel)} ]; then exit 0; fi`,
    "printf '[skip ci]\\n' >> \"$1\"",
    "",
  ].join("\n");
  fs.writeFileSync(hookPath, script);
  fs.chmodSync(hookPath, 0o755);
}

// Card f224632d (round 2, m2) — a hook that adds a FOREIGN (non-Loom) trailer INSIDE the same final
// paragraph, with a blank-line separator from the subject/body but NONE before the foreign line itself —
// i.e. the foreign line joins Loom's OWN trailer paragraph, exactly like a real `Signed-off-by:`/
// `Change-Id:` hook. Must stay fully "ok:true" (no displacement, no unreadability) — neither
// `scanLoomNamespaceLines` nor `parseLoomTrailerBlock` cares about a non-reserved `key: value` line.
function installForeignTrailerInBlockCommitMsgHook(repo) {
  const hookPath = path.join(repo, ".git", "hooks", "commit-msg");
  const canonicalToplevel = git(repo, "rev-parse", "--show-toplevel");
  const script = [
    "#!/bin/sh",
    "set -e",
    `if [ "$(git rev-parse --show-toplevel)" != ${JSON.stringify(canonicalToplevel)} ]; then exit 0; fi`,
    "printf 'Change-Id: I1234567890abcdef\\n' >> \"$1\"",
    "",
  ].join("\n");
  fs.writeFileSync(hookPath, script);
  fs.chmodSync(hookPath, 0o755);
}

// ===================== (FORGE-RACE): the CRITICAL repro — a post-commit hook races main onto a forged,
//                        genuinely-content-diverged sibling commit during the real squash itself ========
{
  const repo = makeRepo("forgerace");
  const ctx = newProject("forgerace", repo);
  const C0 = git(repo, "rev-parse", "HEAD");
  check("(FORGE-RACE) setup: no trust established yet", ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === null);

  installForgingPostCommitHook(repo);
  const w1 = await addWorker(ctx, "a");
  const r1 = await confirm(ctx, w1);
  check("(FORGE-RACE) THE LANDING STILL PROCEEDS: never blocked (4fa36502's own Do-not)", r1.settled === true && r1.ok === true);

  const liveTip = git(repo, "rev-parse", "HEAD");
  // Checked against the COMMIT's own tree (`cat-file -e <sha>:<path>`), never the working directory —
  // the working tree can legitimately diverge from the forged commit's own tree afterward (e.g. a hook's
  // own `reset --hard` running under git's temporary post-commit index state); the commit OBJECT is the
  // thing under test here, and it is unambiguous either way.
  let evilInCommit = false;
  try { execFileSync("git", ["cat-file", "-e", `${liveTip}:EVIL.txt`], { cwd: repo, stdio: "ignore" }); evilInCommit = true; } catch { /* absent */ }
  check("(FORGE-RACE) setup control: the hook genuinely raced main onto a DIFFERENT commit than an ordinary squash would have produced (EVIL.txt is IN the live tip's own tree)", evilInCommit);
  check("(FORGE-RACE) setup control: the live tip now carries the forged trailer", /Loom-Worker-Branch: loom\/deadbeef0000/.test(git(repo, "log", "-1", "--format=%B", liveTip)));

  // NOTE (card aa7677fa round 4, CR 5882d8cb Minor 3): the ledger-row assertion this scenario used to make
  // here ("the forged tip gets NO ledger row") is VACUOUS on THIS specific landing — it is the project's
  // true FIRST-EVER landing, and `expectedMainlineBranch` resolves to `undefined` on a true first sight
  // (no watermark exists yet to resolve a branch from, per the M1 asymmetry noted in decision 2a6a292a
  // round 21), so the ledger write is skipped BEFORE it ever reaches `landedBase`'s verified/unverified
  // distinction — pre-round-3 code would pass this same assertion for the same reason, proving nothing
  // about the fix. The FORGE-RACE-2 scenario below reproduces the identical forgery AFTER trust (and the
  // ledger) are already warm, where the write is actually attempted and the assertion is meaningful.
  check("(FORGE-RACE) THE CRITICAL FIX: trust is NEVER stamped to the forged tip", ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") !== liveTip);
  // First landing ever (trust was null) — the OLD code's unconditional `head.tip` stamp would have
  // established trust AT the forgery here; the fix must leave it either null or (if a human/earlier step
  // had seeded something else) unmoved, but never equal to the live forged tip.
  check("(FORGE-RACE) trust stays exactly as it was before this landing (null — never auto-healed onto the forgery)", ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === null);

  // CR 57d7a27d finding 2 (card aa7677fa round 5): this landing is REJECTED (checked, tree mismatched —
  // not UNCAPTURED), so it now fires the SAME HIGH null-trust event Finding 2 added, where round 22 left
  // it fully silent. This is the exact scenario Finding 2's own test asked for.
  const forgeRaceEvents = freezeEventsFor(ctx.db, ctx.projId);
  check("(FORGE-RACE) THE FIX (Finding 2): exactly ONE null-trust-forge-race event, from=\"\" to=liveTip", forgeRaceEvents.length === 1 && forgeRaceEvents[0].detail.evidence.includes("first-establishment-forge-race") && forgeRaceEvents[0].detail.from === "" && forgeRaceEvents[0].detail.to === liveTip);
  check("(FORGE-RACE) exactly one manager nudge for the forge-race event", ctx.nudges.length === 1);

  // NAMED RESIDUAL (found while verifying this round, not covered by the CR's own prescribed fix — see
  // decision 2a6a292a round 21's own "Residual" section): a SECOND, entirely ordinary landing that lands
  // directly on top of the still-live forged tip DOES establish trust at ITS OWN tip, because trust was
  // null going in and first-establishment is UNCONDITIONAL by design (round 9's own ruling — there is
  // nothing to compare a true first landing against). This is narrower than the pre-fix bug (the forged
  // commit ITSELF is never trusted, and once trust is non-null this exact gap is closed by the ledger
  // walk — see FORGE-RACE's own earlier assertions, and round 20's design), but it IS a real residual:
  // trust ends up resting on a parent (the forgery) that was never itself verified. Asserted here as what
  // ACTUALLY happens, not papered over as "safe".
  fs.rmSync(path.join(repo, ".git", "hooks", "post-commit"), { force: true });
  const w2 = await addWorker(ctx, "b");
  const r2 = await confirm(ctx, w2);
  check("(FORGE-RACE) a second, entirely ordinary landing on top of the forgery also succeeds", r2.settled === true && r2.ok === true);
  const t2 = git(repo, "rev-parse", "HEAD");
  check("(FORGE-RACE) THE NAMED RESIDUAL: trust establishes at the second landing's own tip (first-establishment is unconditional) — never at the forged tip itself", ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === t2 && t2 !== liveTip);
  // The residual is narrow: ONE more ordinary landing after this one is enough to prove it does NOT
  // compound — a THIRD landing's own checkedTip is t2 (a real, Loom-produced tip, now correctly ledgered),
  // so the ordinary exact-match path takes over from here on, with no further laundering risk.
  const w3 = await addWorker(ctx, "b2");
  const r3 = await confirm(ctx, w3);
  check("(FORGE-RACE) a third landing lands cleanly on the now-established trust, no NEW freeze (still just the one from the first landing's own forge-race)", r3.settled === true && r3.ok === true && ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === git(repo, "rev-parse", "HEAD") && freezeEventsFor(ctx.db, ctx.projId).length === 1);
  void C0;
}

// ===================== (FORGE-RACE-2): the SAME forging hook, raced AFTER trust (and the ledger) are
//                        already warm from two clean landings (CR 5882d8cb Minor 3) — this is what makes
//                        the ledger-row-skip assertion meaningful (expectedMainlineBranch resolves here,
//                        so the write is actually attempted) and exercises fileLandingTrustFreezeEvent's
//                        own `trustedBefore !== null` branch ("the main protection"), untested before this
//                        round, plus its dedupe on a later, entirely ordinary landing =====================
{
  const repo = makeRepo("forgerace2");
  const ctx = newProject("forgerace2", repo);

  const w1 = await addWorker(ctx, "fr2a");
  const r1 = await confirm(ctx, w1);
  check("(FORGE-RACE-2) setup: L1 (first-ever landing) establishes trust unconditionally", r1.settled === true && r1.ok === true);
  const w2 = await addWorker(ctx, "fr2b");
  const r2 = await confirm(ctx, w2);
  check("(FORGE-RACE-2) setup: L2 (an ordinary second landing) succeeds", r2.settled === true && r2.ok === true);
  const trustBeforeForge = ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main");
  check("(FORGE-RACE-2) setup: trust is now established at L2's own tip (non-null going into the forge)", trustBeforeForge !== null && trustBeforeForge === git(repo, "rev-parse", "HEAD"));

  installForgingPostCommitHook(repo);
  const w3 = await addWorker(ctx, "fr2c");
  const r3 = await confirm(ctx, w3);
  check("(FORGE-RACE-2) the landing still proceeds despite the forge race (4fa36502's own Do-not)", r3.settled === true && r3.ok === true);
  const forgedTip = git(repo, "rev-parse", "HEAD");
  let forgedEvilPresent = false;
  try { execFileSync("git", ["cat-file", "-e", `${forgedTip}:EVIL.txt`], { cwd: repo, stdio: "ignore" }); forgedEvilPresent = true; } catch { /* absent */ }
  check("(FORGE-RACE-2) setup control: the forged tip genuinely carries EVIL.txt", forgedEvilPresent);

  check("(FORGE-RACE-2) THE CRITICAL LEDGER FIX, NOW MEANINGFULLY TESTED: the forged tip gets NO ledger row (the write IS attempted here — trust is warm, unlike FORGE-RACE's own first landing)", ctx.db.db.prepare("SELECT COUNT(*) AS c FROM mainline_landed_commits WHERE project_id = ? AND tip = ?").get(ctx.projId, forgedTip).c === 0);
  check("(FORGE-RACE-2) trust stays EXACTLY at its pre-forge value — never laundered onto the forged tip", ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === trustBeforeForge);

  const freezeAfterForge = freezeEventsFor(ctx.db, ctx.projId);
  check("(FORGE-RACE-2) THE MAIN PROTECTION, NOW TESTED: exactly ONE freeze event, from=trustBeforeForge to=forgedTip", freezeAfterForge.length === 1 && freezeAfterForge[0].detail.from === trustBeforeForge && freezeAfterForge[0].detail.to === forgedTip);
  check("(FORGE-RACE-2) exactly one manager nudge for the freeze", ctx.nudges.length === 1);

  // ── DEDUPE: a FOURTH, entirely ordinary landing on top of the still-live forged tip must NOT re-fire ────
  fs.rmSync(path.join(repo, ".git", "hooks", "post-commit"), { force: true });
  const w4 = await addWorker(ctx, "fr2d");
  const r4 = await confirm(ctx, w4);
  check("(FORGE-RACE-2) a fourth, ordinary landing on top of the forgery also succeeds", r4.settled === true && r4.ok === true);
  check("(FORGE-RACE-2) DEDUPE: trust is STILL frozen at its pre-forge value", ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === trustBeforeForge);
  check("(FORGE-RACE-2) DEDUPE: still exactly ONE freeze event (deduped on `from`)", freezeEventsFor(ctx.db, ctx.projId).length === 1);
  check("(FORGE-RACE-2) DEDUPE: still exactly one manager nudge", ctx.nudges.length === 1);
}

// ===================== (CONTROL): the identical setup, no hook — an ordinary landing is UNAFFECTED =====
{
  const repo = makeRepo("control");
  const ctx = newProject("control", repo);

  // L1 is this project's FIRST-EVER landing: `expectedMainlineBranch` resolves from the watermark read at
  // the TOP of confirmWorkerMergeTracked, before W is seeded by THIS same call — so on a true first sight
  // it is undefined and no ledger row is written for L1 (a documented, benign asymmetry with the batch
  // path: see decision 2a6a292a round 21's own M1 note). Trust still establishes unconditionally on first
  // sight regardless (trustedBefore===null), so this costs nothing — check the ledger row on L2 instead,
  // the realistic case every later landing actually hits.
  const w1 = await addWorker(ctx, "c");
  const r1 = await confirm(ctx, w1);
  check("(CONTROL) L1 (first-ever landing) succeeds and establishes trust unconditionally", r1.settled === true && r1.ok === true && ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === git(repo, "rev-parse", "HEAD"));

  const w2 = await addWorker(ctx, "d");
  const r2 = await confirm(ctx, w2);
  check("(CONTROL) an ordinary SECOND landing succeeds", r2.settled === true && r2.ok === true);
  const tip = git(repo, "rev-parse", "HEAD");
  const base = git(repo, "rev-parse", `${tip}^`);
  check("(CONTROL) the clean landing DOES get its own ledger row (base = its real parent)", ctx.db.db.prepare("SELECT base FROM mainline_landed_commits WHERE project_id = ? AND tip = ?").get(ctx.projId, tip)?.base === base);
  check("(CONTROL) trust IS stamped to the clean landing's own tip", ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === tip);
  check("(CONTROL) no freeze event fires for an entirely ordinary landing", freezeEventsFor(ctx.db, ctx.projId).length === 0);
}

// ===================== (UNIT): mergeBranch's own `landedBase` field, isolated from the service layer ====
{
  const repo = makeRepo("unit-forged");
  const branch = "loom/unit-forged";
  git(repo, "branch", branch);
  const worktree = mkdtempManaged("loom-mwo-unit-wt-");
  git(repo, "worktree", "add", "-q", worktree, branch);
  registerForCleanup(worktree);
  fs.writeFileSync(path.join(worktree, "unit.ts"), "export const unit = 1;\n");
  commitAll(worktree, "feat(x): unit change", GIT_ID);

  installForgingPostCommitHook(repo);
  const forgedResult = await mergeBranch(repo, branch, "feat(x): unit change", {});
  check("(UNIT) a forged post-commit race: mergeBranch still reports ok:true (the landing happened)", forgedResult.ok === true);
  // CR 5882d8cb Minor 3: `landedBase === undefined` alone is VACUOUS on pre-round-3 code, where the field
  // didn't exist on the result type at all — reading a genuinely absent property also evaluates to
  // `undefined` in plain JS, so that assertion passes identically whether the fix computed "unverified" or
  // never existed to compute anything. `Object.hasOwn` distinguishes "key present, value undefined" (this
  // round's actual claim) from "key absent entirely" (what pre-fix code would produce).
  check("(UNIT) a forged post-commit race: `landedBase` IS a present key on the result (the fix's own field, not an absent property)", Object.hasOwn(forgedResult, "landedBase"));
  check("(UNIT) a forged post-commit race: landedBase is undefined — never trusted as our own commit", forgedResult.landedBase === undefined);
}
{
  const repo = makeRepo("unit-clean");
  const branch = "loom/unit-clean";
  git(repo, "branch", branch);
  const worktree = mkdtempManaged("loom-mwo-unit-wt2-");
  git(repo, "worktree", "add", "-q", worktree, branch);
  registerForCleanup(worktree);
  fs.writeFileSync(path.join(worktree, "unit2.ts"), "export const unit2 = 1;\n");
  commitAll(worktree, "feat(x): unit change 2", GIT_ID);

  const preCommitHead = git(repo, "rev-parse", "HEAD");
  const cleanResult = await mergeBranch(repo, branch, "feat(x): unit change 2", {});
  check("(UNIT) a clean landing: mergeBranch reports ok:true", cleanResult.ok === true);
  check("(UNIT) a clean landing: landedBase equals the real pre-commit HEAD", cleanResult.landedBase === preCommitHead);
}

// ===================== (UNIT-TWO-PARENT): CR 5882d8cb Minor 1 — a racer sharing OUR OWN exact parent AND
//                        OUR OWN exact tree (content-identical, no EVIL.txt — a bare parent+tree check
//                        alone would have VERIFIED this), but carrying a second, foreign-root parent =====
{
  const repo = makeRepo("unit-twoparent");
  const branch = "loom/unit-twoparent";
  git(repo, "branch", branch);
  const worktree = mkdtempManaged("loom-mwo-unit-wt3-");
  git(repo, "worktree", "add", "-q", worktree, branch);
  registerForCleanup(worktree);
  fs.writeFileSync(path.join(worktree, "unit3.ts"), "export const unit3 = 1;\n");
  commitAll(worktree, "feat(x): unit change 3", GIT_ID);

  installTwoParentRacingPostCommitHook(repo);
  const racedResult = await mergeBranch(repo, branch, "feat(x): unit change 3", {});
  check("(UNIT-TWO-PARENT) a two-parent racer: mergeBranch still reports ok:true (the landing happened)", racedResult.ok === true);
  const liveTip = git(repo, "rev-parse", "HEAD");
  check("(UNIT-TWO-PARENT) setup control: the live tip genuinely carries TWO parents", git(repo, "cat-file", "-p", liveTip).split("\n").filter((l) => l.startsWith("parent ")).length === 2);
  check("(UNIT-TWO-PARENT) THE FIX: landedBase is undefined — a second parent alone disqualifies it, even with OUR exact parent+tree", racedResult.landedBase === undefined);
  check("(UNIT-TWO-PARENT) landedVerify is \"rejected\" (checked and failed), never \"uncaptured\" (card aa7677fa round 5)", racedResult.landedVerify === "rejected");
}

// ===================== (UNIT-GRAFT-HIDDEN): CR 57d7a27d finding 1 (card aa7677fa round 5) — the SAME
//                        two-parent racer, but with a `.git/info/grafts` entry hiding the second parent
//                        from any graft-aware read. `rev-list --parents` (round 22's own fix) honors
//                        grafts; `cat-file -p` (round 23's fix) does not — this is what proves it =======
{
  const repo = makeRepo("unit-grafthidden");
  const branch = "loom/unit-grafthidden";
  git(repo, "branch", branch);
  const worktree = mkdtempManaged("loom-mwo-unit-wt4-");
  git(repo, "worktree", "add", "-q", worktree, branch);
  registerForCleanup(worktree);
  fs.writeFileSync(path.join(worktree, "unit4.ts"), "export const unit4 = 1;\n");
  commitAll(worktree, "feat(x): unit change 4", GIT_ID);

  installGraftHiddenTwoParentRacingPostCommitHook(repo);
  const racedResult = await mergeBranch(repo, branch, "feat(x): unit change 4", {});
  check("(UNIT-GRAFT-HIDDEN) a grafted two-parent racer: mergeBranch still reports ok:true (the landing happened)", racedResult.ok === true);
  const liveTip = git(repo, "rev-parse", "HEAD");
  check("(UNIT-GRAFT-HIDDEN) setup control: the RAW object genuinely carries TWO parents", git(repo, "cat-file", "-p", liveTip).split("\n").filter((l) => l.startsWith("parent ")).length === 2);
  check("(UNIT-GRAFT-HIDDEN) setup control: the GRAFT genuinely hides the second parent from a graft-aware read", git(repo, "rev-list", "--parents", "-n", "1", liveTip).trim().split(/\s+/).length === 2);
  check("(UNIT-GRAFT-HIDDEN) THE FIX: landedBase is STILL undefined — a graft-hidden second parent does not fool the raw-object check", racedResult.landedBase === undefined);
  check("(UNIT-GRAFT-HIDDEN) landedVerify is \"rejected\"", racedResult.landedVerify === "rejected");
}

// ===================== (FORGE-TRAILER-BRANCH): card f224632d — a same-parent, same-tree racer (content-
//                        identical to the real squash — round 21-23's parent+tree check alone would have
//                        verified this) carrying a FORGED `Loom-Worker-Branch:` naming a different branch.
//                        This is the gap card 95940402 closed for the batch path and left open here. =====
{
  const repo = makeRepo("unit-forgedbranch");
  const branch = "loom/unit-forgedbranch";
  git(repo, "branch", branch);
  const worktree = mkdtempManaged("loom-mwo-unit-wt5-");
  git(repo, "worktree", "add", "-q", worktree, branch);
  registerForCleanup(worktree);
  fs.writeFileSync(path.join(worktree, "unit5.ts"), "export const unit5 = 1;\n");
  commitAll(worktree, "feat(x): unit change 5", GIT_ID);

  installSameTreeForgedBranchPostCommitHook(repo);
  const racedResult = await mergeBranch(repo, branch, "feat(x): unit change 5", {});
  check("(FORGE-TRAILER-BRANCH) a same-parent/same-tree, forged-branch racer: mergeBranch still reports ok:true (the landing happened)", racedResult.ok === true);
  const liveTip = git(repo, "rev-parse", "HEAD");
  check("(FORGE-TRAILER-BRANCH) setup control: the live tip carries the FORGED branch trailer, not the real one", /Loom-Worker-Branch: loom\/deadbeef0006/.test(git(repo, "log", "-1", "--format=%B", liveTip)));
  check("(FORGE-TRAILER-BRANCH) setup control: the live tip's parent+tree are genuinely OUR OWN (a bare parent+tree check alone would have verified this)", git(repo, "cat-file", "-p", liveTip).split("\n").filter((l) => l.startsWith("parent ")).length === 1);
  check("(FORGE-TRAILER-BRANCH) THE FIX: landedBase is undefined — a forged Loom-Worker-Branch disqualifies it, even with OUR exact parent+tree", racedResult.landedBase === undefined);
  check("(FORGE-TRAILER-BRANCH) landedVerify is \"rejected\" (checked and failed), never \"uncaptured\"", racedResult.landedVerify === "rejected");
}

// ===================== (FORGE-TRAILER-LANDEDTIP): card f224632d — the SAME content-identical racer, but
//                        keeping the REAL `Loom-Worker-Branch:` and forging a WRONG, DUPLICATED
//                        `Loom-Landed-Tip:` instead — the field `pinnedTipForLandedSquash` prefers as
//                        finalize's CAS pin. =====
{
  const repo = makeRepo("unit-forgedtip");
  const branch = "loom/unit-forgedtip";
  git(repo, "branch", branch);
  const worktree = mkdtempManaged("loom-mwo-unit-wt6-");
  git(repo, "worktree", "add", "-q", worktree, branch);
  registerForCleanup(worktree);
  fs.writeFileSync(path.join(worktree, "unit6.ts"), "export const unit6 = 1;\n");
  commitAll(worktree, "feat(x): unit change 6", GIT_ID);

  installSameTreeForgedLandedTipPostCommitHook(repo, branch);
  const racedResult = await mergeBranch(repo, branch, "feat(x): unit change 6", {});
  check("(FORGE-TRAILER-LANDEDTIP) a same-parent/same-tree, forged-Landed-Tip racer: mergeBranch still reports ok:true (the landing happened)", racedResult.ok === true);
  const liveTip = git(repo, "rev-parse", "HEAD");
  const liveBody = git(repo, "log", "-1", "--format=%B", liveTip);
  check("(FORGE-TRAILER-LANDEDTIP) setup control: the live tip carries the REAL branch trailer (only Loom-Landed-Tip is forged)", liveBody.includes(`Loom-Worker-Branch: ${branch}`));
  check("(FORGE-TRAILER-LANDEDTIP) setup control: the live tip carries a DUPLICATED Loom-Landed-Tip line", (liveBody.match(/Loom-Landed-Tip:/g) ?? []).length === 2);
  check("(FORGE-TRAILER-LANDEDTIP) setup control: the live tip's parent+tree are genuinely OUR OWN", git(repo, "cat-file", "-p", liveTip).split("\n").filter((l) => l.startsWith("parent ")).length === 1);
  check("(FORGE-TRAILER-LANDEDTIP) THE FIX: landedBase is undefined — a forged/duplicated Loom-Landed-Tip disqualifies it, even with the real branch name and OUR exact parent+tree", racedResult.landedBase === undefined);
  check("(FORGE-TRAILER-LANDEDTIP) landedVerify is \"rejected\" (checked and failed), never \"uncaptured\"", racedResult.landedVerify === "rejected");
}

// ===================== (FORGE-TRAILER-CONTROL): card f224632d — an entirely ordinary, no-forgery landing
//                        still lands, and `landedTip` carries the branch's own real pre-squash tip sha —
//                        the new trailer check does not regress the happy path. =====
{
  const repo = makeRepo("unit-forgedtrailer-control");
  const branch = "loom/unit-forgedtrailer-control";
  git(repo, "branch", branch);
  const worktree = mkdtempManaged("loom-mwo-unit-wt7-");
  git(repo, "worktree", "add", "-q", worktree, branch);
  registerForCleanup(worktree);
  fs.writeFileSync(path.join(worktree, "unit7.ts"), "export const unit7 = 1;\n");
  commitAll(worktree, "feat(x): unit change 7", GIT_ID);

  const preCommitHead = git(repo, "rev-parse", "HEAD");
  const branchTipBeforeSquash = git(repo, "rev-parse", branch);
  const cleanResult = await mergeBranch(repo, branch, "feat(x): unit change 7", {});
  check("(FORGE-TRAILER-CONTROL) a clean landing: mergeBranch reports ok:true", cleanResult.ok === true);
  check("(FORGE-TRAILER-CONTROL) a clean landing: landedBase equals the real pre-commit HEAD (verified, not merely uncaptured)", cleanResult.landedBase === preCommitHead);
  check("(FORGE-TRAILER-CONTROL) a clean landing: landedVerify is \"verified\"", cleanResult.landedVerify === "verified");
  check("(FORGE-TRAILER-CONTROL) a clean landing: landedTip equals the branch's own real pre-squash tip", cleanResult.landedTip === branchTipBeforeSquash);
}

// ===================== (HOOK-DISPLACED): card f224632d round 2, Code Review 5e586b56 M1 — direct
//                        mergeBranch call. A LEGITIMATE commit-msg hook (runs during `git commit`, never
//                        a post-commit race) appends a new paragraph after Loom's own trailer paragraph.
//                        THE RULING: kept VERIFIED (never routed into the parent/tree "forged" refusal),
//                        with `trailerAdvisory` surfaced instead of a silent/false "rejected". =====
{
  const repo = makeRepo("unit-hookdisplaced");
  const branch = "loom/unit-hookdisplaced";
  git(repo, "branch", branch);
  const worktree = mkdtempManaged("loom-mwo-unit-wt8-");
  git(repo, "worktree", "add", "-q", worktree, branch);
  registerForCleanup(worktree);
  fs.writeFileSync(path.join(worktree, "unit8.ts"), "export const unit8 = 1;\n");
  commitAll(worktree, "feat(x): unit change 8", GIT_ID);

  const preCommitHead = git(repo, "rev-parse", "HEAD");
  installDisplacingCommitMsgHook(repo);
  const result = await mergeBranch(repo, branch, "feat(x): unit change 8", {});
  check("(HOOK-DISPLACED) a legitimate displacing commit-msg hook: mergeBranch reports ok:true", result.ok === true);
  const liveBody = git(repo, "log", "-1", "--format=%B", git(repo, "rev-parse", "HEAD"));
  check("(HOOK-DISPLACED) setup control: the hook genuinely displaced Loom's trailer — parseLoomTrailerBlock (the REAL reader every mainline consumer uses) returns null on the actual committed message", parseLoomTrailerBlock(liveBody) === null);
  check("(HOOK-DISPLACED) THE RULING: landedBase is DEFINED — kept verified, not unverified", result.landedBase === preCommitHead);
  check("(HOOK-DISPLACED) landedVerify is \"verified\"", result.landedVerify === "verified");
  check("(HOOK-DISPLACED) trailerAdvisory is \"displaced\"", result.trailerAdvisory === "displaced");
}

// ===================== (HOOK-UNREADABLE): the SAME ruling for the other kind
//                        `verifyLoomTrailersExactAndReadable` can return — a hook line joined into Loom's
//                        OWN final paragraph (no blank-line separator), breaking the structural
//                        `key: value`-per-line reader while every reserved line is untouched. =====
{
  const repo = makeRepo("unit-hookunreadable");
  const branch = "loom/unit-hookunreadable";
  git(repo, "branch", branch);
  const worktree = mkdtempManaged("loom-mwo-unit-wt9-");
  git(repo, "worktree", "add", "-q", worktree, branch);
  registerForCleanup(worktree);
  fs.writeFileSync(path.join(worktree, "unit9.ts"), "export const unit9 = 1;\n");
  commitAll(worktree, "feat(x): unit change 9", GIT_ID);

  const preCommitHead = git(repo, "rev-parse", "HEAD");
  installUnreadableCommitMsgHook(repo);
  const result = await mergeBranch(repo, branch, "feat(x): unit change 9", {});
  check("(HOOK-UNREADABLE) a legitimate hook breaking the structural reader: mergeBranch reports ok:true", result.ok === true);
  const liveBody = git(repo, "log", "-1", "--format=%B", git(repo, "rev-parse", "HEAD"));
  check("(HOOK-UNREADABLE) setup control: parseLoomTrailerBlock genuinely returns null on the actual committed message", parseLoomTrailerBlock(liveBody) === null);
  check("(HOOK-UNREADABLE) THE RULING: landedBase is DEFINED — kept verified, not unverified", result.landedBase === preCommitHead);
  check("(HOOK-UNREADABLE) landedVerify is \"verified\"", result.landedVerify === "verified");
  check("(HOOK-UNREADABLE) trailerAdvisory is \"unreadable\"", result.trailerAdvisory === "unreadable");
}

// ===================== (HOOK-DISPLACED-MULTI-COMMIT): m2 extended control — the SAME displacing hook, on
//                        a branch with TWO commits, so `deriveWorkerCommitLogBody`'s own multi-subject
//                        body is genuinely non-empty when the trailer check runs. =====
{
  const repo = makeRepo("unit-hookdisplacedmulti");
  const branch = "loom/unit-hookdisplacedmulti";
  git(repo, "branch", branch);
  const worktree = mkdtempManaged("loom-mwo-unit-wt10-");
  git(repo, "worktree", "add", "-q", worktree, branch);
  registerForCleanup(worktree);
  fs.writeFileSync(path.join(worktree, "unit10a.ts"), "export const unit10a = 1;\n");
  commitAll(worktree, "feat(x): unit change 10a", GIT_ID);
  fs.writeFileSync(path.join(worktree, "unit10b.ts"), "export const unit10b = 1;\n");
  commitAll(worktree, "feat(x): unit change 10b", GIT_ID);

  const preCommitHead = git(repo, "rev-parse", "HEAD");
  installDisplacingCommitMsgHook(repo);
  const result = await mergeBranch(repo, branch, "feat(x): unit change 10", {});
  check("(HOOK-DISPLACED-MULTI-COMMIT) mergeBranch reports ok:true", result.ok === true);
  const liveBody = git(repo, "log", "-1", "--format=%B", git(repo, "rev-parse", "HEAD"));
  check("(HOOK-DISPLACED-MULTI-COMMIT) setup control: the squashed worker-commit-log body is genuinely non-trivial (both commit subjects present)", /unit change 10a/.test(liveBody) && /unit change 10b/.test(liveBody));
  check("(HOOK-DISPLACED-MULTI-COMMIT) THE RULING still holds with a non-trivial body: landedBase is DEFINED", result.landedBase === preCommitHead);
  check("(HOOK-DISPLACED-MULTI-COMMIT) landedVerify is \"verified\"", result.landedVerify === "verified");
  check("(HOOK-DISPLACED-MULTI-COMMIT) trailerAdvisory is \"displaced\"", result.trailerAdvisory === "displaced");
}

// ===================== (HOOK-FOREIGN-TRAILER-IN-BLOCK): m2 extended control — a hook that joins a
//                        FOREIGN (non-Loom) trailer INTO Loom's own final paragraph (no blank line),
//                        exactly like a real `Change-Id:`/`Signed-off-by:` hook. Must stay FULLY ok:true —
//                        no displacement, no unreadability, NO `trailerAdvisory` at all (this is the
//                        ordinary `ok:true` path `verifyLoomTrailersExactAndReadable` already had). =====
{
  const repo = makeRepo("unit-foreigntrailer");
  const branch = "loom/unit-foreigntrailer";
  git(repo, "branch", branch);
  const worktree = mkdtempManaged("loom-mwo-unit-wt11-");
  git(repo, "worktree", "add", "-q", worktree, branch);
  registerForCleanup(worktree);
  fs.writeFileSync(path.join(worktree, "unit11.ts"), "export const unit11 = 1;\n");
  commitAll(worktree, "feat(x): unit change 11", GIT_ID);

  const preCommitHead = git(repo, "rev-parse", "HEAD");
  installForeignTrailerInBlockCommitMsgHook(repo);
  const result = await mergeBranch(repo, branch, "feat(x): unit change 11", {});
  check("(HOOK-FOREIGN-TRAILER-IN-BLOCK) mergeBranch reports ok:true", result.ok === true);
  const liveBody = git(repo, "log", "-1", "--format=%B", git(repo, "rev-parse", "HEAD"));
  check("(HOOK-FOREIGN-TRAILER-IN-BLOCK) setup control: the foreign trailer is genuinely present", /Change-Id: I1234567890abcdef/.test(liveBody));
  check("(HOOK-FOREIGN-TRAILER-IN-BLOCK) setup control: parseLoomTrailerBlock still reads it fine — foreign trailers never break the reader", parseLoomTrailerBlock(liveBody)?.branch === branch);
  check("(HOOK-FOREIGN-TRAILER-IN-BLOCK) landedBase is DEFINED", result.landedBase === preCommitHead);
  check("(HOOK-FOREIGN-TRAILER-IN-BLOCK) landedVerify is \"verified\"", result.landedVerify === "verified");
  check("(HOOK-FOREIGN-TRAILER-IN-BLOCK) NO trailerAdvisory at all — this is the clean ok:true path, not the kept-verified-despite path", result.trailerAdvisory === undefined);
}

// ===================== (HOOK-DISPLACED-SERVICE): the FULL service-layer path (confirmWorkerMergeTracked)
//                        — proves the M1 ruling end-to-end: a ledger row, a trust stamp, exactly ONE
//                        low-severity advisory event (never a forge-race/trust-freeze event), and that the
//                        advisory dedupes PER REPO PER PROCESS across a SECOND, independent landing under
//                        the same still-installed hook. =====
{
  const repo = makeRepo("hookdisplacedsvc");
  const ctx = newProject("hookdisplacedsvc", repo);
  installDisplacingCommitMsgHook(repo);

  const w1 = await addWorker(ctx, "hd1");
  const r1 = await confirm(ctx, w1);
  check("(HOOK-DISPLACED-SERVICE) L1 lands despite the displacing hook", r1.settled === true && r1.ok === true);
  const tip1 = git(repo, "rev-parse", "HEAD");
  check("(HOOK-DISPLACED-SERVICE) setup control: main's own live tip is genuinely NOT readable as a trailer directly", parseLoomTrailerBlock(git(repo, "log", "-1", "--format=%B", tip1)) === null);
  // NOTE (same M1 asymmetry FORGE-RACE's own comment names): L1 is this project's TRUE FIRST-EVER landing,
  // so `expectedMainlineBranch` resolves to undefined before the ledger write is even attempted (no
  // watermark exists yet to resolve a branch from) — the ledger-row assertion is vacuous here regardless
  // of this card's fix. Trust still establishes unconditionally on true first sight. The REAL ledger-row
  // check is on L2 below, where `expectedMainlineBranch` genuinely resolves and the write is attempted.
  check("(HOOK-DISPLACED-SERVICE) THE RULING: trust IS stamped to L1's own tip (never frozen/null)", ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === tip1);
  check("(HOOK-DISPLACED-SERVICE) NEVER routed into forge-race/trust-freeze: zero mainline_moved_outside_loom events", eventsFor(ctx.db, ctx.projId).length === 0);
  const advisoriesAfterL1 = trailerAdvisoryEventsFor(ctx.db, ctx.projId);
  check("(HOOK-DISPLACED-SERVICE) exactly ONE advisory event, kind \"displaced\", severity \"low\"", advisoriesAfterL1.length === 1 && advisoriesAfterL1[0].detail.kind === "displaced" && advisoriesAfterL1[0].detail.severity === "low");

  const w2 = await addWorker(ctx, "hd2");
  const r2 = await confirm(ctx, w2);
  check("(HOOK-DISPLACED-SERVICE) L2 (same hook still installed) also lands and is kept verified", r2.settled === true && r2.ok === true);
  const tip2 = git(repo, "rev-parse", "HEAD");
  check("(HOOK-DISPLACED-SERVICE) L2 ALSO gets a ledger row", ctx.db.db.prepare("SELECT COUNT(*) AS c FROM mainline_landed_commits WHERE project_id = ? AND tip = ?").get(ctx.projId, tip2).c === 1);
  check("(HOOK-DISPLACED-SERVICE) L2 ALSO advances trust", ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === tip2);
  check("(HOOK-DISPLACED-SERVICE) DEDUP: still exactly ONE advisory event total — never refiled per landing, per repo per PROCESS", trailerAdvisoryEventsFor(ctx.db, ctx.projId).length === 1);
  check("(HOOK-DISPLACED-SERVICE) STILL zero forge/freeze events after L2", eventsFor(ctx.db, ctx.projId).length === 0);

}

// ===================== (HOOK-DISPLACED-DISCOVERY) / (HOOK-DISPLACED-RESPAWN): card 45036494 — own repo,
//                        own project, a TRAILER-SHAPED (DCO-style) displacing hook (installDcoDisplacingCommitMsgHook,
//                        not the `[skip ci]` one above — see that function's own doc for why).
//                        c13666c6's own ledger gate never actually reached a displaced landing, because
//                        DISCOVERY (the grep+parse loop every reader runs) could never find the candidate
//                        sha in the first place. Before this card's fix, every check below failed. =====
{
  const repo = makeRepo("hookdiscoverysvc");
  const ctx = newProject("hookdiscoverysvc", repo);
  installDcoDisplacingCommitMsgHook(repo);

  const w1 = await addWorker(ctx, "hdd1"); // true first-ever landing (no ledger row expected, same M1 asymmetry)
  const r1 = await confirm(ctx, w1);
  check("(HOOK-DISPLACED-DISCOVERY) setup: L1 lands despite the DCO hook", r1.settled === true && r1.ok === true);

  const w2 = await addWorker(ctx, "hdd2");
  const r2 = await confirm(ctx, w2);
  check("(HOOK-DISPLACED-DISCOVERY) setup: L2 lands and gets a real ledger row", r2.settled === true && r2.ok === true);
  const tip2 = git(repo, "rev-parse", "HEAD");
  check("(HOOK-DISPLACED-DISCOVERY) setup control: L2 IS ledgered", ctx.db.db.prepare("SELECT COUNT(*) AS c FROM mainline_landed_commits WHERE project_id = ? AND tip = ?").get(ctx.projId, tip2).c === 1);
  check("(HOOK-DISPLACED-DISCOVERY) setup control: the real strict reader genuinely cannot parse L2's own trailer off main", parseLoomTrailerBlock(git(repo, "log", "-1", "--format=%B", tip2)) === null);
  check("(HOOK-DISPLACED-DISCOVERY) setup control: w2's branch is genuinely gone after confirm (branch-gone arm applies)", git(repo, "branch", "--list", w2.branch) === "");

  __resetMergedCommitMapCacheForTest();
  // Thread the REAL ledger facts — without this, verifyGoneBranchLanding's own ledger leg is skipped
  // entirely (`if (!ledger) return true`), so this call alone would prove discovery but NOT that it
  // still composes with c13666c6's own gate; see (HOOK-FORGED-DISPLACED-REFUSED), below, for the
  // adversarial half of that same claim.
  const discovered = await findLandedSquashCommit(repo, w2.branch, "HEAD", { goneBranchLedger: ctx.db.getGoneBranchLedgerFacts(ctx.projId, "primary") });
  check("(HOOK-DISPLACED-DISCOVERY) THE FIX: findLandedSquashCommit now FINDS the displaced, ledgered landing", discovered === tip2);
  const boardInfo = await getTaskMergedInfo(repo, w2.taskId, { goneBranchLedger: ctx.db.getGoneBranchLedgerFacts(ctx.projId, "primary") });
  check("(HOOK-DISPLACED-DISCOVERY) THE FIX: getTaskMergedInfo now resolves it too", boardInfo !== null && tip2.startsWith(boardInfo.sha));

  // (HOOK-DISPLACED-RESPAWN): a worker RE-SPAWNED on the SAME task (same branch name, byte-identical
  // content) after a displaced landing. CORRECTED EXPECTATION (found while writing this test, not
  // assumed): `findLandedSquashCommit`'s own RE-TASK GUARD ("if the trailer commit is an ANCESTOR of the
  // branch tip, the branch was re-cut onto it... NOT an orphaned squash-merge") fires for ANY freshly
  // re-cut branch, displaced trailer or not — a re-cut branch's own tip always descends from the prior
  // landing, so `mergeBase === sha` is unconditionally true, independent of this card's fix. Verified via
  // a direct re-check immediately before the confirm below: `findLandedSquashCommit` returns `null` here
  // even though the SAME lookup against the (still-gone) branch name resolved moments ago, in
  // (HOOK-DISPLACED-DISCOVERY) above — the ONLY thing that changed in between is that THIS branch now
  // exists again. So `mergeBranch`'s `!staged` arm correctly falls through to `STAGE_EMPTY_RETRY`, never
  // `ALREADY_MERGED` — this is pre-existing, universal behavior for ANY re-cut branch, not a residual of
  // this card. What this card's fix actually guarantees here: `STAGE_EMPTY_RETRY` (not a crash, and
  // critically NOT a silent duplicate commit — `!staged` is genuinely true, so no new commit is ever
  // created either way) — the practical risk is cosmetic (an actionable "re-task or close by hand"
  // message instead of a clean ALREADY_MERGED one), never data loss or a duplicate landing.
  const changedFiles = git(repo, "diff", "--name-only", `${tip2}^..${tip2}`).trim().split("\n").filter(Boolean);
  check("(HOOK-DISPLACED-RESPAWN) setup control: L2's own landing touched exactly one file", changedFiles.length === 1);
  const respawnFile = changedFiles[0];
  // NEVER the trimming `git()` helper here — it strips the trailing newline, which would make the
  // re-written file genuinely DIFFER from main's real blob and defeat the whole point of this scenario
  // (a byte-identical re-spawn with a truly empty diff).
  const respawnContent = execFileSync("git", ["show", `${tip2}:${respawnFile}`], { cwd: repo, encoding: "utf8" });
  const respawnWorkerId = `mwo-hdd2-respawn-${ctx.sfx}`;
  const { worktreePath: respawnWt, branch: respawnBranch } = await createWorktree(ctx.repo, ctx.projId, w2.taskId);
  registerForCleanup(respawnWt);
  check("(HOOK-DISPLACED-RESPAWN) setup control: the re-cut branch is the SAME name w2 landed under", respawnBranch === w2.branch);
  fs.writeFileSync(path.join(respawnWt, respawnFile), respawnContent);
  // A genuinely byte-identical re-write stages NOTHING — `commitAll` throws on that (no --allow-empty),
  // so commit directly, allowing an empty commit: there must be a REAL commit object on this branch for
  // mergeBranch's own squash/cherry-pick to have something to diff against main at all.
  git(respawnWt, "add", "-A");
  execFileSync("git", ["-c", "user.email=mwo@loom", "-c", "user.name=mwo", "commit", "--allow-empty", "-m", `feat(x): change ${respawnFile}`], { cwd: respawnWt, env: { ...process.env, ...IDENT } });
  ctx.db.insertSession({ id: respawnWorkerId, projectId: ctx.projId, agentId: ctx.agentId, engineSessionId: null, title: null, cwd: respawnWt, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: ctx.mgrId, taskId: w2.taskId, worktreePath: respawnWt, branch: respawnBranch });
  check("(HOOK-DISPLACED-RESPAWN) setup control: the re-task guard now fires for THIS branch name (it exists again)", await findLandedSquashCommit(repo, w2.branch, "HEAD", { goneBranchLedger: ctx.db.getGoneBranchLedgerFacts(ctx.projId, "primary") }) === null);
  const headBeforeRespawn = git(repo, "rev-parse", "HEAD");
  const r3 = await confirm(ctx, { workerId: respawnWorkerId });
  check("(HOOK-DISPLACED-RESPAWN) the re-spawn settles", r3.settled === true && r3.ok === true);
  check("(HOOK-DISPLACED-RESPAWN) STAGE_EMPTY_RETRY (pre-existing re-task-guard behavior, unrelated to this card) — merged:false, never a crash", r3.value?.merged === false && r3.value?.emptyKind === "STAGE_EMPTY_RETRY");
  check("(HOOK-DISPLACED-RESPAWN) SAFE: no duplicate commit landed — HEAD genuinely unchanged (no data-loss/duplicate-landing risk)", git(repo, "rev-parse", "HEAD") === headBeforeRespawn);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
