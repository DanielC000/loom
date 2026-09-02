import fs from "node:fs";
import path from "node:path";
import { LOOM_HOME } from "./paths.js";

// Top-level fatal-exit crash handler. A real daemon crash once left NO log signature at all (grep for
// ENOSPC/EMFILE/chokidar/heap/FATAL/OOM found nothing), so the cause was unconfirmable. These handlers
// capture a single diagnosable record — the failure plus a best-effort resource snapshot (active
// watchers, open FDs, memory) — to a dedicated crashlog BEFORE the process dies.

/**
 * The dedicated fatal-exit crashlog. Lives under LOOM_HOME (the `.loom` dir), resolved via the paths
 * helper — never hardcode `~/.loom`. `.loom` is DELIBERATELY excluded from the docs-vault auto-committer
 * (0b72369: startVaultVersioners skips an operational/`.loom`-rooted home), so writing here accrues no
 * vault git history and never trips the VaultVersioner — keep the crashlog under LOOM_HOME to preserve that.
 */
export const CRASHLOG_PATH = path.join(LOOM_HOME, "crash.log");

/** The rotated previous-crash slot. Kept alongside {@link CRASHLOG_PATH}; holds the last-but-one crash. */
export const CRASHLOG_PREV_PATH = `${CRASHLOG_PATH}.prev`;

/**
 * Whether the PRECEDING run actually wrote a JS-level fatal crash record — card 2f146782's boot-time
 * signal for the `[loom:crash-recovered]` nudge (SessionService.recoverCrashOrphanedWorkers), so it can
 * say "was killed from outside" instead of a "crashed" that never happened when no such record exists.
 * Must be called BEFORE {@link installCrashHandlers} rotates {@link CRASHLOG_PATH} away — that's the only
 * point in boot where `fs.existsSync(CRASHLOG_PATH)` is still meaningful on the UNSUPERVISED (shipped,
 * supervisor-less) path, where THIS boot's own rotation is the only thing that will ever move it.
 *
 * `env.LOOM_PRIOR_CRASHLOG` (Code Review finding #2 on card 2f146782) covers the SUPERVISED path
 * (`daemon:stable`), where `fs.existsSync` alone is NOT enough: scripts/daemon-supervisor.mjs's own
 * `rotateCrashlog()` already rotates crash.log→.prev immediately before EVERY daemon launch — so by the
 * time this process could check, a real prior crash's record is already gone regardless of whether this
 * boot is a crash-recovery boot at all. The supervisor sets this env var ONLY when its own rotation
 * genuinely moved a file, so on that path it is the sole source of truth — never asserted speculatively.
 */
export function hadCrashLogAtBoot(env: NodeJS.ProcessEnv = process.env): boolean {
  return fs.existsSync(CRASHLOG_PATH) || env.LOOM_PRIOR_CRASHLOG === "1";
}

// Must match RESTART_EXIT_CODE in orchestration/restart.ts (and scripts/daemon-supervisor.mjs): the
// daemon exits 75 to ASK the supervisor for a restart. That is an intentional, healthy exit — NOT a
// crash — so the exit-hook backstop below must never mistake it for one and write a spurious crashlog.
const RESTART_EXIT_CODE = 75;

let installed = false;
let wrote = false;

/** Best-effort count of OPEN file descriptors (Linux `/proc` only; null on Windows/macOS or on error). */
function openFdCount(): number | null {
  try {
    return fs.readdirSync("/proc/self/fd").length;
  } catch {
    return null;
  }
}

/**
 * Best-effort snapshot of active libuv resources — the watcher/handle-leak diagnostic. `watcherCount`
 * isolates FSWatcher/StatWatcher (the chokidar class implicated in the unconfirmed crash); `counts` is
 * the full type→count breakdown (Timeout, TCPServerWrap, …) for any other handle leak.
 */
function activeResourceSnapshot(): { watcherCount: number | null; counts: Record<string, number> | null } {
  try {
    const info = process.getActiveResourcesInfo();
    const counts: Record<string, number> = {};
    let watcherCount = 0;
    for (const type of info) {
      counts[type] = (counts[type] ?? 0) + 1;
      if (type === "FSWatcher" || type === "StatWatcher") watcherCount++;
    }
    return { watcherCount, counts };
  } catch {
    return { watcherCount: null, counts: null };
  }
}

export interface CrashlogInput {
  kind: "uncaughtException" | "unhandledRejection" | "exit";
  /** The thrown value / rejection reason (undefined for a bare exit-code death). */
  error?: unknown;
  signal?: string | null;
  exitCode?: number | null;
}

/**
 * Synchronously write ONE fatal-exit record to {@link CRASHLOG_PATH}, capturing the failure plus a
 * best-effort resource snapshot. Called from the synchronous `exit` hook, so it MUST be synchronous and
 * MUST NEVER throw — every capture is individually guarded and the whole body is a no-throw envelope.
 * Writes at most once per process (the first fatal wins); later handlers no-op so a record isn't clobbered.
 */
export function writeCrashlog(input: CrashlogInput): void {
  if (wrote) return;
  wrote = true;
  try {
    const err = input.error;
    const error =
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack ?? null }
        : err === undefined
          ? null
          : { name: null, message: String(err), stack: null };
    const { watcherCount, counts } = activeResourceSnapshot();
    let memory: NodeJS.MemoryUsage | null = null;
    try { memory = process.memoryUsage(); } catch { /* keep null */ }
    let uptimeSeconds: number | null = null;
    try { uptimeSeconds = process.uptime(); } catch { /* keep null */ }
    let ts: string;
    try { ts = new Date().toISOString(); } catch { ts = ""; }
    const record = {
      ts,
      kind: input.kind,
      signal: input.signal ?? null,
      exitCode: input.exitCode ?? null,
      error,
      activeWatcherCount: watcherCount,
      activeResourceCounts: counts,
      openFdCount: openFdCount(),
      memory,
      uptimeSeconds,
      pid: process.pid,
      ppid: process.ppid,
      platform: process.platform,
      nodeVersion: process.version,
    };
    fs.mkdirSync(path.dirname(CRASHLOG_PATH), { recursive: true });
    fs.writeFileSync(CRASHLOG_PATH, JSON.stringify(record, null, 2) + "\n");
  } catch {
    /* the crash handler must NEVER throw — a failed crashlog write is swallowed by design */
  }
}

/**
 * Rotate an existing {@link CRASHLOG_PATH} to {@link CRASHLOG_PREV_PATH} (overwriting any older `.prev`),
 * so the SHIPPED end-user daemon — which runs under the OS service manager, NOT the dev/self-host
 * supervisor — preserves the prior crash signature across a crash→auto-restart. Without this, the
 * restarted daemon would overwrite `crash.log` on its next crash and the user would keep only the most
 * recent signature — exactly the crash-loop case the crashlog exists to diagnose.
 *
 * Called once at boot from {@link installCrashHandlers}, BEFORE the handlers are installed, so it runs
 * before `writeCrashlog` can lay down a fresh record. We rotate ONLY a crash.log that exists at boot,
 * which makes the supervisor interaction safe: under the dev supervisor, `rotateCrashlog` in
 * scripts/daemon-supervisor.mjs already moved crash.log→.prev PRE-LAUNCH, so at daemon boot there is no
 * crash.log to re-rotate (harmless no-op — no double-rotation, the just-preserved `.prev` is untouched).
 * On the shipped path this daemon-side rotation is the ONLY one and does the job.
 *
 * Idempotent (no crash.log ⇒ no-op), best-effort, and NEVER throws.
 */
export function rotateCrashlog(): void {
  try {
    if (!fs.existsSync(CRASHLOG_PATH)) return;
    // Windows renameSync fails if the destination exists — clear any older .prev first.
    fs.rmSync(CRASHLOG_PREV_PATH, { force: true });
    fs.renameSync(CRASHLOG_PATH, CRASHLOG_PREV_PATH);
  } catch {
    /* best-effort: a failed rotation must never gate boot — fall through, the worst case is a clobber */
  }
}

/**
 * card 43b232ff: node-pty@1.1.0's `WindowsPtyAgent.prototype.kill()` (lib/windowsPtyAgent.js:140,
 * upstream microsoft/node-pty#952, OPEN as of 2026-08-26) calls
 * `this._getConsoleProcessList().then(list => list.forEach(...))` with NO `.catch()`, then
 * SYNCHRONOUSLY calls `this._ptyNative.kill(...)` — racing its own ConPTY teardown against that promise.
 * Lose the race and `list` resolves `undefined` after teardown, so `.forEach` throws a `TypeError`
 * INSIDE the uncaught `.then` ⇒ unhandled rejection on every hard session teardown that loses the race.
 * A local reproducer (project memory `nodepty-952-conpty-kill-race-reproducer`) hit this 9/9 under load;
 * upstream's own rate is ~5/12.
 *
 * We tolerate ONLY this exact shape rather than fixing it upstream (no `pnpm patch` precedent in this
 * repo, and `windowsPtyAgent.js` is documented elsewhere as an unsupported internal surface we already
 * accept coupling risk against — see `test/node-pty-quoting-parity.mjs`). The only work skipped when this
 * fires is the leftover-console-process sweep (the `forEach` that never ran); `reapOrphanedDescendants`
 * (pty/host.ts) independently sweeps orphaned descendants too, so tolerating this costs nothing in the
 * COMMON case — but that backstop is PARTIAL, not total: its pty-tree walk misses a survivor that has
 * detached/re-parented away from the pty's process tree entirely (see `pty/host.ts:3991`'s own doc on
 * `processRootedInWorktree`, the known gap it exists to close for the worktree-removal case specifically).
 * A future reader re-weighing the pnpm-patch option should treat this as "backstops the common case, not
 * every case" rather than a blanket guarantee.
 *
 * The match is deliberately narrow and requires BOTH conditions — matching either alone is unsafe:
 * the message alone could originate from an unrelated bug anywhere in OUR code that happens to
 * `.forEach` an undefined value; the stack-frame alone could be a legitimate, different exception from
 * some other line in that same node-pty module. Matches on the exact Node 22 V8 wording ("Cannot read
 * properties of undefined ...", not the older pre-v16 "Cannot read property 'x' of undefined" form) —
 * this is what our runtime actually produces, not a hypothetical broader family.
 *
 * ⚠️ THIS MESSAGE STRING IS A V8 IMPLEMENTATION DETAIL, NOT A STABLE CONTRACT — it has already changed
 * once (Node <16 produced "Cannot read property 'forEach' of undefined") and a future Node upgrade could
 * change it again. The failure direction if that happens is SAFE (no match ⇒ falls through to today's
 * crash-and-log, never to a silent swallow of something else) but SILENT (the tolerance quietly stops
 * firing and every existing test still passes, because nothing here re-derives the string from a live
 * throw). `test/crashlog.mjs`'s "nodepty-race" scenario is the check on THIS constant: it triggers a
 * genuine `undefined.forEach(...)` so V8 authors the message, rather than asserting our own literal back
 * at itself — a Node upgrade that changes the wording fails that test loudly, which is the signal to
 * update the pattern above.
 *
 * ⚠️ THE STACK CONDITION IS ALSO AN IMPLEMENTATION DETAIL, in a DIFFERENT axis: which FILENAME a frame
 * carries depends on whether the running process resolves source maps. `node-pty` ships
 * `windowsPtyAgent.js.map` (`sources: ["../src/windowsPtyAgent.ts"]`), so under `node
 * --enable-source-maps` or `tsx` (`pnpm daemon`'s own dev runner) the SAME real frame renders as
 * `...\node-pty\src\windowsPtyAgent.ts:NNN:MM`, not `lib\windowsPtyAgent.js:NNN:MM` — a regex anchored to
 * the `.js` extension matches under plain `node`/`pnpm daemon:stable` but silently NEVER matches under
 * `pnpm daemon`, the daemon's own first-class dev run command. The pattern below drops the extension
 * (module IDENTITY is what we mean, not build-output detail) and requires an actual stack FRAME line
 * (`\n` + indentation + `at `) rather than a bare substring search, so a message that happens to mention
 * "windowsPtyAgent" cannot satisfy this condition on its own — the two conditions stay independent, as
 * claimed above. Verified against three real, runtime-rendered stacks (not reasoned about): plain
 * `node`, `node --enable-source-maps`, and `tsx` — `test/crashlog.mjs`'s "nodepty-race" scenario is the
 * live control on this axis (run once under plain node, once under `--enable-source-maps`), deriving its
 * frame from an actual thrown error rather than a hand-typed literal, so it is automatically correct
 * under either rendering with no scenario duplication.
 */
function isNodePtyConsoleListRace(reason: unknown): boolean {
  if (!(reason instanceof TypeError)) return false;
  if (!/Cannot read properties of undefined \(reading 'forEach'\)/.test(reason.message)) return false;
  return /\n\s*at .*windowsPtyAgent\./.test(reason.stack ?? "");
}

/**
 * Install the top-level fatal-exit handlers. Wired ONCE at the daemon entrypoint:
 * - `uncaughtException` / `unhandledRejection` — write the crashlog, then `process.exit(1)`. With a
 *   handler attached Node no longer self-terminates, so we MUST exit to preserve the default fatal code.
 * - `exit` (synchronous backstop) — catches any OTHER non-zero death (a stray `process.exit(1)`, the
 *   `main()` startup-failure path) that didn't route through the handlers above. A clean stop (exit 0,
 *   the graceful path) and the intentional restart sentinel (75) are NOT crashes, so they are skipped.
 * Idempotent: a second call is a no-op.
 *
 * Card d671f1b8: `uncaughtException`/`unhandledRejection` below are TWO of the four live `process.exit`
 * routes that daemon shutdown/restart can take — and, deliberately, the two that DON'T run the shared
 * shutdown-cleanup function `gracefulShutdown` (index.ts) and `SessionService.requestDaemonRestart`'s
 * exit-75 path both run (that shared function's own doc names what it does and why — not repeated here).
 * This is an inversion worth stating explicitly, not leaving implicit: the vault-commit loss on THIS path
 * is actually the LONGEST-lived of the two shapes — `daemon-supervisor.mjs` only relaunches on the exit-75
 * restart sentinel, so a crash here leaves the daemon down (and the pending commit unrecovered) until a
 * HUMAN re-runs it.
 *
 * A bounded flush was considered and rejected here — ⛔ NOT because a bounded `execSync` can hang this
 * handler (project memory `[[execsync-timeout-kills-only-the-shell-on-windows]]` measured the timeout
 * option reliably returning control within its bound: ~511ms observed on a 500ms cap — so that fear is
 * false for a genuinely short bound). The real reason is what that SAME memory measures on the OTHER
 * side: a timed-out `git add -A` does not stop the real `git.exe` child — it ABANDONS it, and the orphan
 * keeps running and holding `.git/index.lock` for the rest of its own duration (one measured case: the
 * orphan's commit landed ~8s after the bound fired). On a large vault `git add -A` reliably exceeds a
 * short bound rather than occasionally (11.6s measured cold on a 20k-file vault vs. a 2-3s cap) — so a
 * short bound here would not merely fail to help sometimes, it would routinely leave a lock behind. The
 * crash paths already accept the deferred-commit cost (no supervisor relaunch to race against — the
 * orphan has as long as it needs to finish and release the lock before a human restarts anything), so
 * adding a flush attempt here would trade a benign wait for a NEW, self-inflicted failure mode with
 * nothing to show for it.
 */
export function installCrashHandlers(): void {
  if (installed) return;
  installed = true;

  // Rotate any crash.log from a PRIOR run to .prev BEFORE wiring the handlers below — so on the shipped
  // (supervisor-less) path a crash→auto-restart preserves the previous signature instead of clobbering it.
  rotateCrashlog();

  process.on("uncaughtException", (err) => {
    // Attaching a listener SUPPRESSES Node's default stderr stack-print, so log it ourselves FIRST —
    // the crashlog COMPLEMENTS the console/LOGS_DIR trace, it doesn't replace it. console.error won't
    // throw, but keep it inside the no-throw spirit of the handler regardless.
    console.error("[crashlog] fatal uncaughtException:", err);
    writeCrashlog({ kind: "uncaughtException", error: err });
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    if (isNodePtyConsoleListRace(reason)) {
      // Recognized, expected, non-fatal — see isNodePtyConsoleListRace's doc. Log loudly (this is a
      // tolerance, not a silence) and keep running; do NOT write a crashlog or exit.
      console.error(
        "[crashlog] tolerated known node-pty ConPTY kill() race (microsoft/node-pty#952) — " +
          "console-process sweep skipped this teardown, reapOrphanedDescendants backstops it; daemon continues:",
        reason,
      );
      return;
    }
    console.error("[crashlog] fatal unhandledRejection:", reason);
    writeCrashlog({ kind: "unhandledRejection", error: reason });
    process.exit(1);
  });
  process.on("exit", (code) => {
    if (code !== 0 && code !== RESTART_EXIT_CODE) writeCrashlog({ kind: "exit", exitCode: code });
  });
}
