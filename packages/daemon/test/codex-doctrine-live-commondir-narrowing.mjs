import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 29f22d83, round 4, item 3: `PtyHost#hasLiveCodexSessionAtCommonDir` must block a stale-exclude
// prune ONLY for a live codex session whose OWN cwd resolves to the NON-worktree case
// (privateDir === commonDir) — the one case `hideCodexDoctrineFromGit` ever actually wrote the entry this
// prune removes for. Before this fix, ANY live codex session sharing the target commonDir blocked pruning
// forever — including an ordinary WORKER running in a LINKED worktree (the common case for a real codex
// worker), which has no relationship to the stale entry at all. An active project can have a live worker
// on effectively every boot, so the unnarrowed guard meant the prune this whole card exists to ship would
// never actually run against a repo anyone was using.
//
// TECHNIQUE: directly registers CodexLive-shaped objects into PtyHost's private `liveCodex` map — the same
// precedented technique `pty-codex-agnostic-methods.mjs` already uses (TypeScript's `private` is
// compile-time only; a compiled JS test can read/write it). `resolveGitDirsSync` is plain `fs` (no real
// `git` binary needed), so the linked-worktree shape is built by hand: a `.git` FILE pointing at a private
// gitdir with its own `HEAD` + `commondir`.
//
// Run: 1) build (turbo builds shared first), 2) node test/codex-doctrine-live-commondir-narrowing.mjs
import fs from "node:fs";
import path from "node:path";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { PtyHost } = await import("../dist/pty/host.js");
const { resolveGitDirsSync } = await import("../dist/git/repo-lock.js");

const events = { onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onBusy() {}, onExit() {} };
const host = new PtyHost(events);

const fakePty = { pid: 1, write() {}, kill() {}, resize() {}, onData(cb) { this._onData = cb; }, onExit(cb) { this._onExit = cb; } };
const fakeLogStream = { write() {}, end() {}, on() {} };
/** A minimal CodexLive-shaped object — only the fields this guard actually reads (`alive`, `cwd`) matter;
 *  the rest exist so the object shape is a plausible live entry, mirroring pty-codex-agnostic-methods.mjs's
 *  own fixture. */
function makeCodexLive(cwd, overrides = {}) {
  return {
    kind: "codex", pty: fakePty, pid: fakePty.pid, cwd,
    geometry: { cols: 120, rows: 40 }, hookToken: "", engineSessionId: "engine-x",
    ring: { chunks: [], bytes: 0 }, subscribers: new Set(),
    alive: true, killed: false, startedAt: Date.now(),
    logStream: fakeLogStream, logBroken: false, busy: false,
    pending: [], stopping: false, drainHeld: false, role: "worker",
    mcpSeen: false, mcpSeenWaiters: [],
    activeTurnRoute: null, lastPromptRoute: null,
    activeTurnProactive: false, lastPromptProactive: false,
    activeTurnOwnerText: null, lastPromptOwnerText: null, recentOwnerTurns: [],
    activeTurnSenderId: null, lastPromptSenderId: null,
    trustDialogAnswered: true, screenScan: "", firstTurnStarted: false,
    ...overrides,
  };
}

// --- fixture 1: a NON-worktree repo (privateDir === commonDir) — the only shape the stale entry was ever
// written for. -------------------------------------------------------------------------------------------
const nonWorktreeRepo = mkdtempManaged("loom-codex-live-commondir-nonwt-");
fs.mkdirSync(path.join(nonWorktreeRepo, ".git"));
const nonWorktreeCommonDir = path.join(nonWorktreeRepo, ".git");

// --- fixture 2: a LINKED WORKTREE sharing a DIFFERENT repo's commonDir, built by hand. -------------------
const wtMain = mkdtempManaged("loom-codex-live-commondir-wt-main-");
const wtMainCommonDir = path.join(wtMain, ".git");
fs.mkdirSync(wtMainCommonDir);
const linkedWorktree = mkdtempManaged("loom-codex-live-commondir-wt-linked-");
const privateDir = path.join(linkedWorktree, ".git-private");
fs.mkdirSync(privateDir);
fs.writeFileSync(path.join(privateDir, "HEAD"), "ref: refs/heads/main\n");
fs.writeFileSync(path.join(privateDir, "commondir"), `${wtMainCommonDir}\n`);
fs.writeFileSync(path.join(linkedWorktree, ".git"), `gitdir: ${privateDir}\n`);

// --- sanity: confirm the fixtures resolve the way the test assumes, independent of PtyHost — a broken
// fixture would make every assertion below vacuous. --------------------------------------------------
{
  const nonWt = resolveGitDirsSync(nonWorktreeRepo);
  check("fixture sanity: the non-worktree repo resolves privateDir === commonDir",
    nonWt !== null && nonWt.privateDir === nonWt.commonDir);
  const wt = resolveGitDirsSync(linkedWorktree);
  check("fixture sanity: the linked worktree resolves privateDir !== commonDir, sharing the main checkout's commonDir",
    wt !== null && wt.privateDir !== wt.commonDir && path.resolve(wt.commonDir) === path.resolve(wtMainCommonDir));
}

// --- negative control: no live session registered anywhere yet -> false for either commonDir ------------
check("(absent) no live codex session anywhere -> false for the non-worktree commonDir",
  host.hasLiveCodexSessionAtCommonDir(nonWorktreeCommonDir) === false);
check("(absent) no live codex session anywhere -> false for the worktree-main commonDir",
  host.hasLiveCodexSessionAtCommonDir(wtMainCommonDir) === false);

// --- a live codex session in the NON-worktree case blocks pruning its OWN commonDir (unchanged by round 4) -
host.liveCodex.set("s-nonwt", makeCodexLive(nonWorktreeRepo));
check("a live codex session in the non-worktree case DOES block pruning its own commonDir",
  host.hasLiveCodexSessionAtCommonDir(nonWorktreeCommonDir) === true);

// --- round 4, item 3 (the actual fix): a live codex WORKER in a LINKED WORKTREE must NOT block pruning the
// shared main commonDir — the exclude entry this prune removes was never written for this shape. ----------
host.liveCodex.set("s-worker-wt", makeCodexLive(linkedWorktree));
check("round 4 item 3: a live codex WORKER in a linked worktree does NOT block pruning the shared main commonDir",
  host.hasLiveCodexSessionAtCommonDir(wtMainCommonDir) === false);

// --- positive control on the SAME commonDir: a DIFFERENT, non-worktree live session sharing that exact
// commonDir still blocks it — proves the narrowing discriminates on privateDir===commonDir, not merely on
// commonDir identity (a broken "always false" narrowing would also pass the item-3 check above). ----------
host.liveCodex.set("s-nonwt-at-main", makeCodexLive(wtMain));
check("positive control: a non-worktree live session sharing the SAME commonDir still blocks it",
  host.hasLiveCodexSessionAtCommonDir(wtMainCommonDir) === true);
host.liveCodex.delete("s-nonwt-at-main");

// --- a dead (alive:false) entry never blocks, regardless of shape ----------------------------------------
host.liveCodex.set("s-dead", makeCodexLive(wtMain, { alive: false }));
check("a dead (alive:false) codex session never blocks pruning, even in the non-worktree shape",
  host.hasLiveCodexSessionAtCommonDir(wtMainCommonDir) === false);

console.log(failures === 0
  ? "\n✅ ALL PASS — hasLiveCodexSessionAtCommonDir blocks only for a live codex session in the NON-worktree shape, never for an ordinary worker in a linked worktree."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
