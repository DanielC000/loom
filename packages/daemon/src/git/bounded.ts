import { simpleGit, type SimpleGit } from "simple-git";

/**
 * Neutral extraction (card 9df3ea71) of the bounded-git primitives six independent copies across this
 * codebase each reimplemented: `git/worktrees.ts`, `git/writer.ts`, `orchestration/restart.ts`,
 * `sessions/service.ts`, `setup/bootstrap.ts`, `vault/versioner.ts`. Deliberately a LEAF module — imports
 * nothing from any of the six, only `simple-git` itself — so it can be imported by all of them without
 * reintroducing the `git/writer.ts` → `vault/versioner.ts` import cycle those two already have.
 *
 * This module intentionally does NOT bundle a `withTimeout` race with `.env()` handling, a fixed timeout
 * constant, or non-interactive env into one opinionated helper: the six sites differ on purpose (per-
 * call-class timeout budgets, and whether/what non-interactive env is applied — see {@link
 * boundedSimpleGit}'s own doc), and folding those differences away would be a regression, not a fix.
 */

/**
 * Reject `p` after `ms` if it hasn't settled, so a git step is bounded even if the underlying promise
 * NEVER settles. In production the simpleGit `block` timeout (set on the instance) ALSO bounds the child,
 * but — see the WARNING below — `block` is an IDLE timeout, not a total-elapsed one, so it is not a
 * reliable backstop for a slow-but-talking child; this race is what actually guarantees the FUNCTION
 * returns within the window regardless. The timer is cleared on the winning path; if it fires first the
 * timer is already done, so nothing lingers on the event loop.
 *
 * ⚠️ **This settles independent of the underlying git child** — on expiry it rejects and walks away; the
 * child (if still running) is left alone, still mutating whatever it was mutating. That is FINE for a
 * read-mostly or fire-and-forget call, but NOT safe for a call made while holding a lock that guards
 * shared on-disk state (e.g. `git/repo-lock.ts`'s `withCanonicalIndexLock`) — releasing such a lock here
 * lets the next holder start while this call's child is still alive and still writing. Use {@link
 * withTimeoutKillingChild} there instead (card 8e75ee20).
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms (hung git child?)`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Like {@link withTimeout}, but for a caller that CANNOT tolerate the underlying child outliving the
 * wrapper's settlement — concretely, a call made inside a lock that guards shared on-disk state (card
 * 8e75ee20: `createWorktree`'s `withCanonicalIndexLock` block). `withTimeout` alone is not sufficient
 * there: it rejects on a bare, independent timer and abandons `p`, so the lock releases while the git
 * child p is backed by may still be running and still mutating that shared state — exactly the race the
 * lock exists to close.
 *
 * ⭐ THE LOAD-BEARING PROPERTY, stated precisely because it's easy to "simplify" away: killing the child
 * on expiry is NOT BY ITSELF enough to make releasing the lock safe — a kill signal doesn't guarantee the
 * child is dead the instant it's sent, only that it will die soon. What actually makes this safe to await
 * from inside a lock is that this function does NOT settle independently once it has issued the kill; it
 * keeps awaiting `p` itself, and `p` only settles once the child is CONFIRMED dead (see below). A version
 * of this function that killed the child and then resolved/rejected on its own timer — the same shape as
 * {@link withTimeout} — would reintroduce the exact race this exists to close, just with a much smaller
 * window. Do not "simplify" this into a bare kill-then-settle race.
 *
 * On expiry this calls `controller.abort()` — REQUIRES `p`'s git instance to have been constructed with
 * that same controller's `signal` passed to {@link boundedSimpleGit}'s `abortSignal` param, so the abort
 * reaches simple-git's `abortPlugin` and issues a REAL kill (`spawned.kill("SIGINT")` — forceful/
 * TerminateProcess-equivalent on Windows, since Windows has no real signals) — then, rather than settling
 * independently, WAITS FOR `p` ITSELF to settle: `p` (a `git.raw()` call) only resolves/rejects once
 * simple-git's completion-detection plugin observes the child's REAL `close`/`exit` event (verified at
 * source, `completion-detection.plugin.ts` — this runs unconditionally, kill or no kill), so a caller
 * that awaits this function's result really is only released once the child is confirmed dead, not
 * merely signaled. See [[simple-git-block-timeout-is-idle-not-elapsed]] for why the instance's own
 * `block` idle-timeout does not already guarantee this for a child that keeps producing output.
 *
 * `killGraceMs` (default: `ms`, i.e. a doubled worst-case ceiling) is the explicit, bounded fallback for
 * the residual case where even the kill fails to make `p` settle — a test double that ignores `abort`
 * (this file's own callers keep using bare {@link withTimeout} against those, since there's no real child
 * to kill or wait for), or, in production, a pathological child that doesn't die on signal. Past that
 * grace window this gives up and rejects anyway, accepting the same abandon-the-child risk `withTimeout`
 * always has — bounding the CONSEQUENCE of a kill that doesn't work, not pretending it can't happen.
 */
export function withTimeoutKillingChild<T>(
  p: Promise<T>,
  ms: number,
  label: string,
  controller: AbortController,
  killGraceMs: number = ms,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ms);
    const giveUpTimer = setTimeout(() => {
      reject(new Error(`${label} exceeded ${ms}ms, killed, but did not die within ${killGraceMs}ms — giving up (hung git child?)`));
    }, ms + killGraceMs);
    p.then(
      (v) => {
        clearTimeout(killTimer); clearTimeout(giveUpTimer);
        if (timedOut) { reject(new Error(`${label} exceeded ${ms}ms (git child killed)`)); return; }
        resolve(v);
      },
      (e) => {
        clearTimeout(killTimer); clearTimeout(giveUpTimer);
        reject(timedOut ? new Error(`${label} exceeded ${ms}ms (git child killed): ${e?.message ?? e}`) : e);
      },
    );
  });
}

/**
 * Build a simpleGit instance bound by a block timeout. ⚠️ **`block` is an IDLE timeout — the kill timer
 * resets on every `data` event from the child's stdout/stderr (verified at source,
 * `node_modules/.pnpm/simple-git@3.36.0/.../timeoutPlugin`) — it is NOT a total-elapsed ceiling.** A
 * child that emits output at least once per `blockTimeoutMs` is never killed by this, however long it
 * runs in total; see [[simple-git-block-timeout-is-idle-not-elapsed]]. It still kills a genuinely HUNG
 * (no-output) child, which is the case most callers actually care about; a caller that also needs a
 * total-elapsed kill (not just idle) passes `abortSignal` (below) and bounds elapsed time itself via
 * {@link withTimeoutKillingChild}.
 *
 * `env`, when supplied and non-empty, is applied via `.env(env)`; OMIT it (or pass `{}`) to get a plain
 * instance with NO `.env()` call at all — that is a deliberate default, not an oversight. `.env()`
 * REPLACES the whole child env (not a merge), which is exactly why `vault/versioner.ts`'s own bounded-git
 * site calls this with no `env` argument at all (see its own doc, card 54b839c5): passing `.env()`
 * anything there — even `{}` or a spread of `process.env` — either throws on an ambient
 * `GIT_EDITOR`/`PAGER` in the caller's own env, or (if those are stripped first) silently drops a
 * caller's legitimate `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` redirection. Treating `{}` the same as
 * `undefined` (card e02d0d06) closes that hazard for a caller that computes its env and happens to
 * produce an empty object, without changing behavior for `undefined` or a populated env. A caller that
 * needs a non-interactive env passes one explicitly (e.g. `git/writer.ts`'s `nonInteractiveEnv()`).
 * A `process.env` spread (e.g. `{ ...process.env, GIT_TERMINAL_PROMPT: "0" }`) is exactly the shape this
 * doc warns against above: measured against the installed simple-git, an ambient `GIT_EDITOR`/
 * `GIT_PAGER`/`PAGER`/`EDITOR`/`GIT_SEQUENCE_EDITOR`/`GIT_EXTERNAL_DIFF` in the spread makes `.env()`
 * THROW — and a caller that swallows that throw (e.g. into a `return false` "unchanged" advisory) ends up
 * silently and permanently wrong. `orchestration/restart.ts` once passed this exact shape and was fixed to
 * call `boundedSimpleGit` with no `env` argument at all (card 469b5e67) — do NOT copy the spread shape
 * into a new call site.
 * This function never chooses or widens a caller's env on its behalf.
 *
 * `abortSignal`, when supplied, is passed through as simple-git's own `abort` option — wiring up its
 * `abortPlugin` so a later `controller.abort()` (the controller this signal came from) issues a real kill
 * of the spawned child. OMIT it (the default) for a plain instance with no abort wiring, matching every
 * existing caller byte-for-byte. See {@link withTimeoutKillingChild}'s doc for the one caller that needs it.
 */
export function boundedSimpleGit(
  repoPath: string,
  blockTimeoutMs: number,
  env?: Record<string, string | undefined>,
  abortSignal?: AbortSignal,
): SimpleGit {
  const git = simpleGit(repoPath, {
    timeout: { block: blockTimeoutMs },
    ...(abortSignal ? { abort: abortSignal } : {}),
  });
  return env && Object.keys(env).length > 0 ? git.env(env) : git;
}
