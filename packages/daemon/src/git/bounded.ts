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
 * NEVER settles. `boundedSimpleGit`'s own `block` timeout also bounds the child in production, but is an
 * IDLE timer, not total-elapsed (see that function's own doc) — this race is the actual backstop
 * regardless. The timer is cleared on the winning path; if it fires first the timer is already done, so
 * nothing lingers on the event loop.
 *
 * @decision 8e75ee20 — this settles INDEPENDENT of the underlying git child: on expiry it rejects and
 * walks away, leaving the child (if still running) alone, still mutating shared state. NOT safe for a
 * call made while holding a lock (e.g. `withCanonicalIndexLock`) — use {@link withTimeoutKillingChild}.
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
 * wrapper's settlement — concretely, a call made inside a lock that guards shared on-disk state. Unlike
 * {@link withTimeout}, this does not settle independently on expiry: it calls `controller.abort()` (`p`'s
 * git instance must be constructed with that same `signal` via {@link boundedSimpleGit}'s `abortSignal`)
 * and then waits for `p` itself to settle.
 *
 * @decision 8e75ee20 — the load-bearing property: `p` only settles once the child is CONFIRMED dead, so a
 * caller inside a lock is safe to release it on return. Do NOT "simplify" this into a bare kill-then-settle
 * race — that reintroduces the exact lock race this function exists to close.
 *
 * `killGraceMs` (default `ms`) is the bounded fallback for a child that never dies on signal — past it,
 * this gives up and rejects anyway, the same abandon-the-child risk `withTimeout` always has.
 *
 * @decision 1a858805 — a successful kill only guarantees the child is dead, never that its on-disk
 * writes are undone; `createWorktree`'s own `worktree add` call site owns recovering any residue.
 *
 * @decision 963f69ab — the "confirmed dead" guarantee holds only for this function's PATH-1
 * settlement, never its `giveUpTimer` PATH-2 fallback; anchor discrimination to the specific
 * "Abort signal received" suffix, not the generic "(git child killed)" substring.
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
 * `.env()` object, that (1) a real host/session can plausibly carry ambiently AND (2) no non-interactive
 * git op in this codebase (piped stdio, never a real TTY — no op here ever opens an editor/pager/diff
 * tool) legitimately needs. Unconditionally safe to strip: a leftover value here could only cause an
 * unwanted throw, never a needed effect. This is the STRIP half of the design call — see
 * {@link boundedSimpleGit}'s doc for the sibling PASS-THROUGH half (the `GIT_CONFIG_*` / config-path
 * family), which is deliberately NOT in this list.
 *
 * @decision f7a80d76 — this is the FULL set, verified by EXECUTING `@simple-git/argv-parser@1.1.1`'s
 * real `parseEnv` against the installed simple-git, one key at a time — a prior audit's "eight keys"
 * undercounted it by ten.
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
 * runs in total. It still kills a genuinely HUNG (no-output) child, which is the case most callers
 * actually care about; a caller that also needs a total-elapsed kill (not just idle) passes `abortSignal`
 * (below) and bounds elapsed time itself via {@link withTimeoutKillingChild}.
 *
 * @decision f7a80d76 — `env`, when supplied, is scrubbed via {@link scrubGitEnv} and the config-path
 * family is explicitly allowed, BOTH unconditionally HERE at the one construction chokepoint — a
 * caller must never scrub or allow config-paths itself; that per-caller drift caused the M1/M2 gap.
 *
 * `abortSignal`, when supplied, is passed through as simple-git's own `abort` option, wiring up its
 * `abortPlugin` so a later `controller.abort()` issues a real kill of the spawned child — see the
 * `8e75ee20` record for the one caller that needs it. OMIT it (the default) for a plain instance with no
 * abort wiring, matching every existing caller byte-for-byte.
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
