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
 * NEVER settles. In production the simpleGit `block` timeout (set on the instance) also kills the hung
 * child so it doesn't leak — this race is the belt-and-suspenders guarantee that the FUNCTION returns
 * within the window regardless. The timer is cleared on the winning path; if it fires first the timer
 * is already done, so nothing lingers on the event loop.
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
 * Build a simpleGit instance bound by a kill-the-hung-child block timeout. `env`, when supplied, is
 * applied via `.env(env)`; OMIT it to get a plain instance with NO `.env()` call at all — that is a
 * deliberate default, not an oversight. `.env()` REPLACES the whole child env (not a merge), which is
 * exactly why `vault/versioner.ts`'s own bounded-git site calls this with no `env` argument at all (see
 * its own doc, card 54b839c5): passing `.env()` anything there — even `{}` or a spread of `process.env`
 * — either throws on an ambient `GIT_EDITOR`/`PAGER` in the caller's own env, or (if those are stripped
 * first) silently drops a caller's legitimate `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` redirection. A
 * caller that needs a non-interactive env passes one explicitly (e.g. `git/writer.ts`'s
 * `nonInteractiveEnv()`). `orchestration/restart.ts` passes `{ ...process.env, GIT_TERMINAL_PROMPT: "0"
 * }` — a `process.env` spread of exactly the shape this doc warns against above. That is a KNOWN DEFECT
 * at that site, not a sanctioned exception: measured against the installed simple-git, an ambient
 * `GIT_EDITOR`/`GIT_PAGER`/`PAGER`/`EDITOR`/`GIT_SEQUENCE_EDITOR`/`GIT_EXTERNAL_DIFF` makes it THROW, and
 * `supervisorScriptChangedSince` swallows that throw into `return false`, so the supervisor-changed
 * warning silently never fires. Tracked by card 469b5e67 — do NOT copy this shape into a new call site.
 * This function never chooses or widens a caller's env on its behalf.
 */
export function boundedSimpleGit(
  repoPath: string,
  blockTimeoutMs: number,
  env?: Record<string, string | undefined>,
): SimpleGit {
  const git = simpleGit(repoPath, { timeout: { block: blockTimeoutMs } });
  return env ? git.env(env) : git;
}
