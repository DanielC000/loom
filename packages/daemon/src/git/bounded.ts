import { simpleGit, type SimpleGit, type SimpleGitOptions } from "simple-git";

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
 *
 * ⚠️ A SUCCESSFUL kill still leaves whatever the child had already written to disk — killing the process
 * stops it from doing MORE, it does not undo what it already did. Card 1a858805: `git worktree add`
 * writes `.git/worktrees/<name>/locked` (content `initializing`) at the START of the add and removes it
 * on success; a kill mid-checkout leaves that marker behind, and `git worktree prune` SKIPS locked
 * records by design, so it never self-heals. `createWorktree`'s own `worktree add` call site (git/
 * worktrees.ts) is the one caller of this function that also owns recovering that residue — see the
 * catch around its `boundedLockedRaw(["worktree", "add", ...])` call for the recovery, not here; this
 * function only guarantees the CHILD is dead (on its path-1 settlement — see below), never that its
 * on-disk side effects are undone.
 *
 * A kill's "confirmed dead" guarantee (the load-bearing property documented above) holds only for this
 * function's PATH-1 settlement (the `p.then(...)` "(git child killed)" rejection) — the `giveUpTimer`
 * fallback (PATH 2, "...giving up (hung git child?)") rejects on a bare timer with NO such confirmation.
 * A caller that needs to tell the two apart has card 963f69ab's discriminator.
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
 * Env keys simple-git's `blockUnsafeOperationsPlugin` refuses when present in an explicitly-supplied
 * `.env()` object (verified by EXECUTING `@simple-git/argv-parser@1.1.1`'s real `parseEnv` against the
 * installed simple-git, one key at a time, card f7a80d76 — this is the FULL set; a prior audit's copy of
 * "eight keys" undercounted it by ten) that (1) a real host/session can plausibly carry ambiently AND
 * (2) no non-interactive git op in this codebase (piped stdio, never a real TTY — no op here ever opens
 * an editor/pager/diff tool) legitimately needs. Unconditionally safe to strip: a leftover value here
 * could only cause an unwanted throw, never a needed effect. This is the STRIP half of the design call in
 * card f7a80d76's DoD-2 — see {@link boundedSimpleGit}'s doc for the sibling PASS-THROUGH half (the
 * `GIT_CONFIG_*` / config-path family), which is deliberately NOT in this list.
 *
 * Left OUT of this list, deliberately, matching `git/writer.ts`'s original `nonInteractiveEnv()` reasoning
 * (card 42544916) extended to the now-verified full set:
 *  - `GIT_ASKPASS` / `SSH_ASKPASS` / `GIT_SSH` / `GIT_SSH_COMMAND` / `GIT_PROXY_COMMAND` — each names an
 *    arbitrary program git would exec in its place; bypassing simple-git's refusal is an arbitrary-command
 *    vector during real auth/transport. Left BLOCKED (present ⇒ simple-git still throws) rather than
 *    stripped or allowed — a caller with one of these ambiently set gets a loud, honest failure, not a
 *    silently-widened trust boundary.
 *  - `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` / `GIT_CONFIG` / `GIT_EXEC_PATH` / `PREFIX` — simple-git's
 *    `allowUnsafeConfigPaths` category; see {@link boundedSimpleGit}'s doc — passed THROUGH, not stripped.
 *  - `GIT_CONFIG_COUNT` / `GIT_TEMPLATE_DIR` — a separate category each (`allowUnsafeConfigEnvCount` /
 *    `allowUnsafeTemplateDir`); not realistically ambient (a script-authored env-config convention and a
 *    `git init`-only var this codebase's ops never invoke that way) and not exercised by anything this
 *    fix touches — left unhandled (blocked if ever present), same posture `writer.ts` already documented.
 */
export const GIT_ENV_STRIP_KEYS = [
  "GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "EDITOR", "GIT_PAGER", "PAGER", "GIT_EXTERNAL_DIFF",
] as const;

/**
 * The ONE place this codebase decides which ambient env vars are safe to remove before handing an env to
 * simple-git — returns a NEW object with {@link GIT_ENV_STRIP_KEYS} deleted (never mutates `env`).
 * {@link boundedSimpleGit} applies this ITSELF, unconditionally, to whatever `env` it is given (card
 * f7a80d76 review round 2) — so a caller does NOT need to call this before passing an env; it is exported
 * for a caller that wants the scrubbed value earlier (to inspect/log/test it, or to feed it to something
 * other than `boundedSimpleGit`), not because skipping it would be unsafe. This function only ever handles
 * the STRIP half; the sibling config-path PASS-THROUGH+ALLOW half lives entirely in
 * {@link boundedSimpleGit} (below), since it's a construction-time simple-git option, not an env
 * transform.
 */
export function scrubGitEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out = { ...env };
  for (const key of GIT_ENV_STRIP_KEYS) delete out[key];
  return out;
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
 * **`env`, when supplied, is run through {@link scrubGitEnv} HERE, unconditionally, before being applied
 * (card f7a80d76 review round 2 — this used to be the caller's job, and "the caller must remember to
 * scrub first" is EXACTLY the failure mode that produced the card's M1/M2 findings in the first place: two
 * independent copies covering only 2-of-18 and 6-of-18 of simple-git's real refusal list, because
 * remembering was load-bearing).** A caller now passes a RAW env (e.g. a `process.env` spread) and gets
 * the same safety a caller that pre-scrubbed would have; {@link scrubGitEnv} stays exported for a caller
 * that wants the scrubbed value for its own separate purpose, not because it is still required here. If
 * the result is empty (rare — a caller would have to pass ONLY {@link GIT_ENV_STRIP_KEYS} and nothing
 * else) this falls back to a plain instance with NO `.env()` call at all, exactly as `env:undefined`/`{}`
 * already did — that is a deliberate default, not an oversight, since `.env()` REPLACES the whole child
 * env (not a merge) and calling it with an empty object is never useful. This is exactly why
 * `vault/versioner.ts`'s own bounded-git site calls this with NO `env` argument at all instead of routing
 * through this scrub (see its own doc, card 54b839c5): `commitVault` needs to PRESERVE whatever the
 * caller's real ambient `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` resolves to (including a test's
 * deliberately-broken path, to exercise its own identity-fallback) — stripping those keys there silently
 * redirects identity resolution to this HOST's real `~/.gitconfig` instead, a worse failure than a loud
 * throw. That is a narrower, caller-specific need this function does not try to solve generically;
 * `versioner.ts` stays on its own no-`.env()` path (card f7a80d76 leaves it untouched) — it is the one
 * legitimate way to opt OUT of this scrub, by not passing an env at all.
 *
 * **The config-path family is PASSED THROUGH, not stripped, and explicitly ALLOWED (card f7a80d76 DoD-2):**
 * whenever the scrubbed `env` is non-empty, this constructs the instance with
 * `unsafe: { allowUnsafeConfigPaths: true }` — the simple-git category covering
 * `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`/`GIT_CONFIG`/`GIT_EXEC_PATH`/`PREFIX` (verified via
 * `@simple-git/argv-parser`'s own category map). The two honest options were (a) omit `.env()` entirely —
 * unavailable to a caller that genuinely needs an explicit env (both `runs/snapshot.ts` and
 * `git/writer.ts`'s `nonInteractiveEnv()` do, for `GIT_INDEX_FILE` / `GIT_TERMINAL_PROMPT` respectively) —
 * or (b) opt into `allowUnsafeConfigPaths`. (b) is chosen and applied HERE, at the one construction
 * chokepoint, exactly like the scrub above, so no caller can produce a partial copy of the decision. It is
 * a no-op (the vulnerability check never runs) for the many callers in this codebase that never pass `env`
 * at all — this only takes effect for a caller that explicitly hands simple-git an env, which is exactly
 * the population that can carry the ambient var in the first place. This does NOT widen anything else:
 * `allowUnsafeConfigPaths` covers only config-PATH redirection, not the arbitrary-command-exec categories
 * (editor/pager/diff/askpass/ssh/proxy) that {@link GIT_ENV_STRIP_KEYS} strips or that stay deliberately
 * blocked (see that constant's own doc for the full breakdown) — this function DOES widen a caller's env
 * on its behalf (the strip + the allowance), by design, precisely so a caller cannot fail to.
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
  const scrubbedEnv = env ? scrubGitEnv(env) : undefined;
  const hasEnv = !!scrubbedEnv && Object.keys(scrubbedEnv).length > 0;
  const unsafe: SimpleGitOptions["unsafe"] = { allowUnsafeConfigPaths: true };
  const git = simpleGit(repoPath, {
    timeout: { block: blockTimeoutMs },
    ...(abortSignal ? { abort: abortSignal } : {}),
    ...(hasEnv ? { unsafe } : {}),
  });
  return hasEnv ? git.env(scrubbedEnv as Record<string, string | undefined>) : git;
}
