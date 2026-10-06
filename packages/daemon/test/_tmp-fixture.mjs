// SHARED TEST TEMP-DIR HELPER (card 995be21f, SCOPE A of a2fdff78) — cleanup-by-construction.
//
// WHY THIS EXISTS: an audit of the daemon test suite (a2fdff78) found that "did this test clean up its
// own temp dirs" was manual, per-file bookkeeping — an array to push a path into, a `finally` loop to
// enumerate it correctly — and that bookkeeping desynced in a large fraction of files audited: a `repo`
// fixture captured in a tuple but never actually `fs.rmSync`'d (only used to call `removeWorktree`, a
// git op); several `reposDir` roots referenced by no cleanup variable at all; a container dir whose only
// child FILE gets cleaned, never the dir itself; ~28% of companion-*.mjs files with NO cleanup call
// whatsoever. This helper makes "created" and "registered for guaranteed cleanup" the SAME call, so
// there is no second bookkeeping step left to forget. It does NOT change any prefix — callers supply the
// exact current literal string; centralising WHERE naming happens is the entire value, not WHAT the
// names are.
//
// TWO TERMINATION PATHS, DELIBERATELY:
//   - `beforeExit` (the PRIMARY cleanup path): fires only when Node drains its event loop NATURALLY —
//     i.e. a caller sets `process.exitCode = N` instead of calling `process.exit(N)`. CAN `await`, so it
//     gets a REAL async backoff against a still-open handle (see EBUSY below).
//   - `exit` (the SYNC BACKSTOP): fires on every termination shape `beforeExit` does NOT — an explicit
//     `process.exit(N)` (today's universal end-of-file pattern in this suite: `process.exit(failures ===
//     0 ? 0 : 1)`) and an uncaught exception (this is what closes the "no cleanup on the failure path"
//     leak shape). An `exit` handler cannot `await`; anything scheduled inside it is discarded the
//     instant it returns.
// A caller that still calls `process.exit()` explicitly (nearly every file today) gets ONLY the sync
// backstop — `beforeExit` never fires for them. That is fine: the backstop is a complete, independent
// implementation of the same contract, not a "best-effort partial" — see CORRECTION 1 below for why it
// needed a real fix to actually deliver on that promise.
//
// 🔴 CORRECTION 1 (card 995be21f review): the first draft did 5 IMMEDIATE `rmSync` retries with no
// delay, reasoning "an exit handler can't await" — true, but the conclusion didn't follow: 5 synchronous
// retries complete in microseconds, while an EBUSY/EPERM handle takes MILLISECONDS TO SECONDS to clear,
// so all 5 would fail together and the retry would buy nothing — a green you cannot fail, and exactly the
// failure mode `a-comment-is-a-claim` warns about (a comment claiming a fix that isn't one). Fixed: a
// REAL blocking delay between sync attempts via `Atomics.wait` on a throwaway SharedArrayBuffer — legal
// inside an `exit` handler (unlike `await`), and what actually gives a transient handle time to clear.
// This is NOT the `_wait.mjs` blind-sleep anti-pattern (racing a KNOWN async duration you could
// otherwise observe): there is no cheaper observable for "has this OS-level handle released" than
// attempting the removal itself, so retry-with-a-real-delay is the correct shape here, not a workaround
// for an observation we were too lazy to make properly.
//
// 🔴 CORRECTION 2 (card 995be21f review): `rmSync` is main-thread — there is NO libuv threadpool
// exposure here, so `worktree-gc-threadpool-leak` (the reverted P0: a retry LOOP over a HUNG `fs.rm`
// leaked threadpool threads and wedged the DAEMON) does not apply to this code path. But bounding the
// ATTEMPT COUNT does not help if a single `rmSync` call itself never returns — a genuine hang here blocks
// this exit handler, and therefore this TEST PROCESS's own exit, indefinitely. Stated explicitly rather
// than papered over: a real NTFS directory removal does not block indefinitely in practice (this is not
// the P0's case, which was a retry loop amplifying an ALREADY-wedged removal on the daemon's own event
// loop — a different context entirely), but if it ever did, there is no clean way to cancel a
// synchronous syscall from JS, so this code does not attempt to. A hung test process is a loud, visible
// failure (it hits the test-runner's own TEST_TIMEOUT_MS and gets killed and reported — see
// scripts/test-daemon.mjs) — worse than a leaked directory, but a structurally different failure, named
// here rather than implied away.
//
// KNOWN NON-COVERAGE, STATED NOT FIXED: neither `beforeExit` nor `exit` fires on SIGKILL, `taskkill /F`,
// or `process.abort()` — those bypass Node's JS-level shutdown entirely. A dir created immediately
// before such a kill leaks; this helper cannot prevent that and does not claim to.
//
// 🔴 `process.exitCode = N` vs `finishAndExit(N)` (card 995be21f review, directive #8): the FIRST pilot
// pass converted each file's ending from `process.exit(N)` to `process.exitCode = N` so `beforeExit`
// would actually fire — correct for those 3 files, but NOT a safe blanket substitution for the coming
// 581-file sweep. `process.exit(N)` terminates immediately; `process.exitCode = N` only terminates once
// the event loop drains NATURALLY — so any file with a lingering timer, an open socket, an unref'd-but-
// alive handle, or a still-running child process would HANG instead of exiting, and a hung file burns
// the suite's own timeout rather than failing cleanly. That risk is a property of each file's own handle
// hygiene, which cannot be verified for 581 files at once — exactly the per-file judgement this whole
// helper exists to eliminate. `finishAndExit` below is the fix: it awaits real cleanup and then calls
// `process.exit(code)` itself — deterministic termination, real async backoff, no dependency on the loop
// draining naturally, so no hang risk regardless of what else a given file is holding open.
export async function finishAndExit(code) {
  const paths = [...registry];
  registry.clear(); // exit's sync backstop iterates an empty registry afterward — harmless no-op, not a double-attempt
  for (const p of paths) await cleanupOnePathAsync(p);
  await flushStdoutAndExit(code);
}
// If a caller forgets to `await` this: the cleanup steps inside it are real async work (fs.promises.rm /
// setTimeout backoff) that keeps the event loop non-empty on their own, independent of whether anything
// awaits the outer promise — so `finishAndExit` still runs to completion and still calls `process.exit`
// even unawaited; it does not silently no-op or drop cleanup. The only actual risk is code a caller
// places AFTER an unawaited call, which would then run concurrently with (or before) the exit — narrow,
// since this call is meant to be a file's terminal statement, and callable-as-a-lint-check if it matters.

// 🔴 Card 4eb6cbc0: `finishAndExit`'s own `process.exit(code)` call above carried the IDENTICAL
// POSIX-async-pipe race card 14e733fb fixed in test-daemon.mjs's own `FAILURES:` epilogue — Node
// documents process.stdout/process.stderr writes to a PIPE as ASYNCHRONOUS on POSIX (synchronous on
// Windows; see that card's investigation for the empirical proof), so a caller's own preceding
// `console.log`s can still be sitting in the stream's internal write queue, not yet delivered to the OS,
// at the instant `process.exit()` tears the process down.
//
// `finishAndExit` already awaited real async work (`cleanupOnePathAsync`'s `fs.promises.rm`) before
// reaching `process.exit()` above — which is WHY the files calling it were INCIDENTALLY shielded from the
// same bug the other ~800 test files carry (card 4eb6cbc0's investigation) — but ONLY when the cleanup
// registry was non-empty: an empty registry (no `mkdtempManaged()` path ever registered) makes the `for`
// loop above run ZERO iterations, so `process.exit()` fires exactly as synchronously as every bare-exit
// file. `flushStdoutAndExit` makes the protection DELIBERATE and UNCONDITIONAL instead of a side effect
// of an unrelated cleanup loop.
//
// 🔴 BOUNDED, non-negotiably: an unbounded wait for a stream to drain would HANG the whole test file if it
// somehow never completes (e.g. a parent that stops reading) — a hung file burns the suite's own
// TEST_TIMEOUT_MS, precisely the failure this file's own header (directive #8, the `process.exitCode`
// rejection) already exists to prevent. Giving up and exiting anyway on timeout — with whatever tail
// didn't make it — is the PRE-EXISTING behaviour this replaces, strictly better than a hang, never worse.
//
// MECHANISM: an empty-string write is still enqueued behind every chunk already sitting in the stream's
// own internal write queue, and a Writable stream invokes a given write's callback only once THAT write's
// own underlying `_write` has actually completed — since a stream processes its queue strictly in order,
// that callback firing proves every earlier chunk already reached the OS. This drains "what's already
// queued" — exactly the guarantee needed here, since nothing runs between a caller's last `console.log`
// and this flush. Short-circuits when `writableLength` is already 0 (nothing pending — the common case,
// including every real run on THIS host, where writes never queue at all — see the card's investigation).
// `writeFullySync` (scripts/test-daemon.mjs, card 14e733fb) is the SAME root cause but a deliberately
// DIFFERENT idiom: that function WRITES new bytes synchronously; this one DRAINS bytes some earlier
// `console.log` already handed to an async stream, which needs the stream's own completion callback, not
// a raw `fs.writeSync` retry loop — forcing that function into this role would not fit what it was built
// for.
const FLUSH_TIMEOUT_MS = 2_000;
function flushStream(stream, timeoutMs = FLUSH_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (!stream.writableLength) { resolve(); return; } // nothing queued — every prior write already landed
    let settled = false;
    const settle = () => { if (settled) return; settled = true; resolve(); };
    const timer = setTimeout(settle, timeoutMs);
    stream.write("", () => { clearTimeout(timer); settle(); });
  });
}

/**
 * Deterministically flush any output still queued on stdout/stderr, then exit — the fix for the race
 * described above. Bounded: gives up and exits anyway after FLUSH_TIMEOUT_MS per stream rather than
 * risking a hang.
 * @param {number} code
 */
export async function flushStdoutAndExit(code) {
  await Promise.all([flushStream(process.stdout), flushStream(process.stderr)]);
  process.exit(code);
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const registry = new Set();
let hooksInstalled = false;
const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 100; // a REAL delay — see CORRECTION 1: near-zero-delay retries all fail together

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isTransient(err) {
  return err && (err.code === "EBUSY" || err.code === "EPERM");
}

// Synchronous cleanup of ONE path — used by the `exit` backstop. See CORRECTION 2: this bounds the
// ATTEMPT COUNT, not any single call's own duration; a genuinely hung rmSync would still hang this
// handler (and this process), by design left unmitigated — see the file header.
function cleanupOnePathSync(dir) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true }); // force:true swallows ENOENT, NOT EBUSY/EPERM
      return;
    } catch (err) {
      if (err.code === "ENOENT") return; // already gone
      if (attempt === MAX_ATTEMPTS || !isTransient(err)) {
        console.error(`[tmp-fixture] could not remove ${dir} after ${attempt} attempt(s): ${err.message}`);
        return; // LOG and move on — never throw out of an exit handler, never retry forever
      }
      sleepSync(RETRY_DELAY_MS);
    }
  }
}

// Async cleanup of ONE path — used by the `beforeExit` primary path, which CAN await a real backoff.
async function cleanupOnePathAsync(dir) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (err.code === "ENOENT") return;
      if (attempt === MAX_ATTEMPTS || !isTransient(err)) {
        console.error(`[tmp-fixture] could not remove ${dir} after ${attempt} attempt(s): ${err.message}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}

function installHooksOnce() {
  if (hooksInstalled) return;
  hooksInstalled = true;

  process.on("beforeExit", async () => {
    if (registry.size === 0) return;
    const paths = [...registry];
    registry.clear();
    for (const p of paths) await cleanupOnePathAsync(p);
  });

  process.on("exit", () => {
    for (const p of registry) cleanupOnePathSync(p);
  });
}

/**
 * Create a REAL mkdtemp'd dir (atomic, kernel-guaranteed-unique — not a hand-rolled
 * `Date.now()`/pid path) and register it for guaranteed cleanup. `prefix` is caller-supplied so the
 * CURRENT literal string is preserved byte-for-byte — this centralises WHERE naming happens, not WHAT
 * the names are.
 * @param {string} prefix
 * @returns {string} the created directory's absolute path
 */
export function mkdtempManaged(prefix) {
  installHooksOnce();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  registry.add(dir);
  return dir;
}

/**
 * Like `mkdtempManaged`, but rooted at an arbitrary existing directory instead of unconditionally
 * `os.tmpdir()` — the primitive behind `useOwnLoomHome`'s `{fresh: true}` option (card 8378984b), which
 * needs to nest a guaranteed-empty subdirectory inside an AMBIENT LOOM_HOME (one this process did not
 * itself create) rather than an unrelated tmpdir path.
 * @param {string} baseDir
 * @param {string} prefix
 * @returns {string} the created directory's absolute path
 */
function mkdtempManagedIn(baseDir, prefix) {
  installHooksOnce();
  fs.mkdirSync(baseDir, { recursive: true });
  const dir = fs.mkdtempSync(path.join(baseDir, prefix));
  registry.add(dir);
  return dir;
}

/**
 * Register a path this module did NOT create itself (e.g. `createWorktree()`'s return value, a marker
 * log file) for the SAME guaranteed cleanup. Closes the "tracked in my own array but never actually
 * removed" leak shape — a registered path is swept regardless of whether the caller's own `finally`
 * block is correct, present, or forgotten.
 * @param {string} p
 */
export function registerForCleanup(p) {
  installHooksOnce();
  registry.add(p);
}

/**
 * Install this process's LOOM_HOME, cleanup-by-construction (card 08638e79). `scripts/test-daemon.mjs`
 * spawns each test file with its OWN fresh, RUNNER-tracked `LOOM_HOME` — a file that then hand-assigns
 * `process.env.LOOM_HOME` to a second, `os.tmpdir()`-based path SILENTLY REPLACES the runner-assigned one
 * with a runner-INVISIBLE one nothing ever sweeps. This closes that gap the same way it was already
 * closed once, ad hoc, in claude-version-prewarm.mjs: if LOOM_HOME is ALREADY set (the runner — or any
 * parent harness — owns and cleans its own assigned home), REUSE it unchanged, never override it. Only
 * when it's unset (this file run directly, outside the runner) does this create its OWN dir, via
 * `mkdtempManaged` — so "created" and "registered for guaranteed cleanup" happen in the same call and
 * there is no ordering in which a self-assigned home can escape tracking.
 *
 * 🔴 CARD 8378984b: "reuse unchanged" means exactly that — under the normal runner, LOOM_HOME is always
 * fresh already, but a human who runs this file DIRECTLY with an externally-exported `LOOM_HOME` (e.g.
 * iterating on a single test outside the suite) gets that SAME, possibly-already-populated directory
 * back verbatim. A test whose own assertions ASSUME the resulting home starts empty/absent — a hardcoded
 * `0`/`[]` baseline later compared via a delta, a marker/pid file asserted "doesn't exist yet", an
 * `initRepo()`-style helper that unconditionally `git checkout -b main`s the home itself — is silently
 * wrong (or outright crashes, e.g. "branch already exists") under that reused-home case, even though
 * nothing is actually broken in the code under test. Two fixes for this, pick whichever fits the shape:
 *   1. SEED THE BASELINE FROM A REAL READ instead of assuming empty (see
 *      graceful-teardown-hard-exit-backstop.mjs's `listAsideFiles`-seeded `asideFilesSeenSoFar` for the
 *      worked example) — right when the check is itself a running COUNT/delta over time.
 *   2. PASS `{ fresh: true }` here (below) when the test needs a genuinely pristine directory up front —
 *      right when the check is a one-shot "nothing here yet" / "no pre-existing repo" assumption that a
 *      directory-read can't meaningfully seed (there's no baseline to subtract, only a precondition to
 *      guarantee). This nests a SECOND, independently-tracked `mkdtemp`'d subdirectory inside whatever
 *      LOOM_HOME already resolved to (ambient-set or freshly minted — either way) and points LOOM_HOME at
 *      THAT instead: still swept transitively when the ambient home is cleaned up, and swept on its own
 *      via the normal registry backstop if it isn't. When LOOM_HOME was unset to begin with, this is a
 *      harmless no-op on top of the already-fresh dir the plain path minted (one extra nesting level,
 *      same guarantee).
 * @param {string} prefix used only when this process creates its own home (LOOM_HOME was unset) or when
 *   `opts.fresh` nests a new subdirectory inside an ambient one
 * @param {{fresh?: boolean}} [opts] pass `{fresh: true}` to guarantee a pristine directory even when an
 *   ambient LOOM_HOME was reused from outside this process — see CARD 8378984b above
 * @returns {string} the LOOM_HOME now in effect — the pre-existing one, the newly created one, or (with
 *   `opts.fresh`) a freshly minted subdirectory nested inside whichever of those applied
 */
export function useOwnLoomHome(prefix, opts = {}) {
  if (!process.env.LOOM_HOME) {
    process.env.LOOM_HOME = mkdtempManaged(prefix);
  } else if (opts.fresh) {
    process.env.LOOM_HOME = mkdtempManagedIn(process.env.LOOM_HOME, prefix);
  }
  return process.env.LOOM_HOME;
}

/**
 * Release a path from the registry — but ONLY after the caller has PROVEN it is actually gone (e.g.
 * `fs.existsSync(p) === false`). This is NOT optional bookkeeping: deregistering a path whose removal
 * FAILED (EBUSY/EPERM) silently discards the exit backstop in exactly the case it exists for — a caller
 * must never call this unconditionally from a `finally`. See card 995be21f §THE COMPOSITION BUG.
 * @param {string} p
 */
export function unregister(p) {
  registry.delete(p);
}

/**
 * Immediately remove ONE path with the same bounded retry + real-delay backoff as the registry's own
 * `exit` backstop (see CORRECTION 1 above for why a real delay matters) — WITHOUT registering it. For a
 * caller that only learns the path to clean up lazily, at its OWN exit time (e.g. `_guard.mjs`'s
 * WORKTREES_DIR sibling cleanup, card de7abf0b — derived from `LOOM_HOME`, which isn't set yet when
 * `_guard.mjs` is imported, so it can't `registerForCleanup` a concrete path up front). Reuses this
 * module's proven-correct retry logic rather than re-implementing it at the new call site.
 * @param {string} dir
 */
export function cleanupPathSync(dir) {
  cleanupOnePathSync(dir);
}

// Exported for this helper's OWN tests only (positive-controlling the EBUSY path needs to call the
// retry logic directly) — not part of the public fixture-creation surface.
export const _internal = { cleanupOnePathSync, cleanupOnePathAsync, flushStream };
