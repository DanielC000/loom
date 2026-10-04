import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { simpleGit, type SimpleGit, type SimpleGitOptions } from "simple-git";
import { killGateProcessTree } from "../orchestration/gate-runner.js";
import { assertRepoNotQuarantined } from "./merge-quarantine.js";
import { RepoQuarantinedError } from "./repo-lock.js";

/**
 * Neutral extraction (card 9df3ea71) of the bounded-git primitives six independent copies across this
 * codebase each reimplemented: `git/worktrees.ts`, `git/writer.ts`, `orchestration/restart.ts`,
 * `sessions/service.ts`, `setup/bootstrap.ts`, `vault/versioner.ts`. A LEAF module relative to those six —
 * imports nothing from any of them, so it can be imported by all of them without reintroducing the
 * `git/writer.ts` → `vault/versioner.ts` import cycle those two already have.
 *
 * @decision 24c0bdba — one exception: `orchestration/gate-runner.ts`'s `killGateProcessTree`, reused by
 * {@link killableCanonicalRaw}'s tree-kill path rather than a second tree-killer — verified acyclic
 * (`gate-runner.ts` → `gate-spill.ts` → `paths.ts` → `pty/resolve-bin.ts` → node builtins only).
 *
 * @decision bde5d1fe — a second exception, same shape: `./merge-quarantine.js`/`./repo-lock.js`, reused by
 * {@link killableCanonicalRaw}'s own re-check rather than a third quarantine-checking copy — do not swap
 * either import for a hand-rolled quarantine check here; both are verified acyclic against this file.
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

/** Does `e` mean "there is genuinely no git repository here" (git's own `--show-toplevel`/discovery
 *  exit-128 failure), as opposed to a timeout/killed-child/other probe failure (a bare refusal, dubious
 *  ownership, `safe.bareRepository` refusing a bare-looking dir)? Message-matched, same posture as
 *  `git/writer.ts`'s `isNoUpstreamError`. Lives in this LEAF module (card 306dd105) rather than in
 *  `git/writer.ts` (which re-exports it for compatibility) so BOTH `git/writer.ts` and
 *  `vault/versioner.ts` can share the one classifier without recreating the import cycle this module's
 *  own doc above exists to avoid between those two. */
export function isNotAGitRepositoryError(e: unknown): boolean {
  return /not a git repository/i.test((e as Error)?.message ?? String(e));
}

/**
 * A TYPED marker (a non-enumerable property, never a message-text change) carried on an Error to mean "we
 * killed something, or gave up trying, without a positive confirmation the whole process TREE actually
 * died." Message text is deliberately left unchanged everywhere this is applied —
 * `test/bounded-git-kill-on-timeout.mjs` already pins the exact wording of every rejection shape this file
 * produces, and this marker rides alongside it, never replaces it.
 *
 * @decision 24c0bdba (round 3, Code Review B-1) — {@link treeDeathUnconfirmed} checks this FIRST, not a
 * string match alone: a string match alone is what let this bug happen (see {@link withTimeoutKillingChild}'s own doc).
 */
const UNCONFIRMED_KILL = Symbol("loom.unconfirmedKill");
function markUnconfirmedKill<E extends Error>(e: E): E {
  Object.defineProperty(e, UNCONFIRMED_KILL, { value: true, enumerable: false, configurable: true });
  return e;
}
function isMarkedUnconfirmedKill(e: unknown): boolean {
  return e instanceof Error && (e as unknown as Record<symbol, unknown>)[UNCONFIRMED_KILL] === true;
}

/**
 * The POSITIVE twin of {@link UNCONFIRMED_KILL}: a non-enumerable marker meaning "we killed this child AND
 * positively confirmed the whole process tree actually died." Set only at {@link spawnCanonicalGitTree}'s
 * two `confirmed:true` sites and propagated by {@link withTimeoutKillingChild} alongside
 * {@link UNCONFIRMED_KILL} — a caller must check {@link treeDeathConfirmed} directly, never infer this from
 * "not unconfirmed" (which also matches an unrelated non-kill failure).
 *
 * @decision 9f5ae011 (round 2) — mutually exclusive with {@link UNCONFIRMED_KILL} by construction: every
 * site that marks one is the disjoint if/else branch of the site that marks the other.
 */
const CONFIRMED_KILL = Symbol("loom.confirmedKill");
function markConfirmedKill<E extends Error>(e: E): E {
  Object.defineProperty(e, CONFIRMED_KILL, { value: true, enumerable: false, configurable: true });
  return e;
}
function isMarkedConfirmedKill(e: unknown): boolean {
  return e instanceof Error && (e as unknown as Record<symbol, unknown>)[CONFIRMED_KILL] === true;
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
 * Giving up is ITSELF an unconfirmed-death outcome, not a distinct third thing: this rejection is tagged
 * {@link markUnconfirmedKill} unconditionally. Because `giveUpTimer`'s deadline is measured from THIS
 * call's own start while {@link spawnCanonicalGitTree}'s own confirmation only starts counting after the
 * child's `close` fires (strictly later), give-up structurally wins the race whenever confirmation is
 * genuinely slow — tagging give-up is what actually closes that gap, not a timing fix. When `p`'s own
 * rejection wins the race first instead (the common case: a child that dies promptly), its own tag (or
 * lack of one) is propagated onto the wrapped error unchanged below.
 *
 * @decision 24c0bdba (round 3, Code Review B-1) — before this, `giveUpTimer`'s message carried nothing
 * {@link treeDeathUnconfirmed} matched, so a caller checking it after a give-up always saw `false` and ran
 * further mutating cleanup (`resetOrSkip`/rollback) anyway — the exact bug the fail-closed path prevents.
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
      reject(markUnconfirmedKill(new Error(`${label} exceeded ${ms}ms, killed, but did not die within ${killGraceMs}ms — giving up (hung git child?)`)));
    }, ms + killGraceMs);
    p.then(
      (v) => {
        clearTimeout(killTimer); clearTimeout(giveUpTimer);
        if (timedOut) { reject(new Error(`${label} exceeded ${ms}ms (git child killed)`)); return; }
        resolve(v);
      },
      (e) => {
        clearTimeout(killTimer); clearTimeout(giveUpTimer);
        if (!timedOut) { reject(e); return; }
        const wrapped = new Error(`${label} exceeded ${ms}ms (git child killed): ${e?.message ?? e}`);
        if (isMarkedUnconfirmedKill(e)) markUnconfirmedKill(wrapped);
        else if (isMarkedConfirmedKill(e)) markConfirmedKill(wrapped);
        reject(wrapped);
      },
    );
  });
}

/**
 * {@link killableCanonicalRaw}'s tree-kill spawn primitive. Bypasses simple-git entirely so an abort kills
 * the WHOLE process tree, not just git's own direct child: simple-git's `abortPlugin` only ever sends
 * `spawned.kill("SIGINT")` to that ONE process (verified on Windows 11 and Linux/WSL — a hook's own
 * `sh`/`node` descendants survive it and can keep mutating the repo afterwards, e.g. a lint-staged-shaped
 * `sleep; git add` tail landing a DIFFERENT merge's file under this call's own trailer). `canonicalRaw`
 * (356538ef) still runs its full merge-driver enumeration/blanking/verification against this adapter —
 * only WHAT executes the final git process changes, never the protection pipeline around it.
 *
 * @decision 24c0bdba — settle only once the DIRECT child's own `close` fires (never independently of it —
 * same confirmed-dead contract {@link withTimeoutKillingChild} already documents), and, on POSIX, only
 * once {@link confirmProcessGroupDead} also clears within `killGraceMs` — see {@link treeDeathUnconfirmed}.
 *
 * `onTreeDeathSettled`, when supplied, is invoked EXACTLY ONCE, asynchronously, the moment this function's
 * OWN confirmation determination is finally made (win32/pid-less: once {@link killGateProcessTree}'s own
 * promise resolves; POSIX: once {@link confirmProcessGroupDead} resolves) — independent of whether the
 * OUTER {@link withTimeoutKillingChild} wrapper already gave up and settled first via its own
 * `giveUpTimer` (round 3, Code Review B-1/B-2: a caller uses this to auto-clear a quarantine it entered on
 * an outer give-up, once the real answer eventually arrives). Never invoked on the non-aborted path.
 *
 * `spawnImpl` (default the real `spawn`) is a test seam, EXPORTED for it (card 9f5ae011, round 3) — the
 * real marker application (`markConfirmedKill`/`markUnconfirmedKill`) lives entirely inside this
 * function's `close` handler below, reachable hermetically ONLY by substituting the OS-level spawn: a
 * fake child whose `pid` is `null` takes the SAME unconditional-confirm branch this function already uses
 * for a real win32 close (see below), with zero real process involved and zero platform dependence — see
 * `bounded-git-kill-marker-exclusivity.mjs`'s `[confirmed, real marker]` case, which deletes
 * `markConfirmedKill` to confirm this goes RED. Production call sites never pass this — the default is
 * the real `spawn`, byte-identical to before this param existed.
 */
export function spawnCanonicalGitTree(
  repoPath: string,
  env: Record<string, string | undefined> | undefined,
  signal: AbortSignal,
  killGraceMs: number,
  onTreeDeathSettled?: (confirmed: boolean) => void,
  spawnImpl: typeof spawn = spawn,
): Pick<SimpleGit, "raw"> {
  // Cast: simple-git's own `raw` is a heavily overloaded `Response<string>`-returning signature (chainable
  // builder methods included) that a plain `(...args) => Promise<string>` can never structurally satisfy —
  // `canonicalRaw`'s callers only ever invoke `.raw(argsArray)` and `await` it, so a plain Promise is all
  // that's actually needed at runtime; the OLD `canonicalGit`'s own `raw` reassignment sidestepped this
  // same mismatch by going through a `Proxy` instead, whose `get` trap TypeScript does not check per-
  // property against the target's real type.
  const raw = (...callArgs: unknown[]): Promise<string> => {
    const rawArgs = (Array.isArray(callArgs[0]) ? callArgs[0] : callArgs) as string[];
    const args = [...CANONICAL_GIT_CONFIG_ARGS, ...rawArgs];
    return new Promise<string>((resolve, reject) => {
      const child = spawnImpl("git", args, {
        cwd: repoPath,
        env: prepareCanonicalEnv(env),
        windowsHide: true,
        detached: process.platform !== "win32",
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let aborted = false;
      let killIssued: Promise<void> | undefined;
      child.stdout?.on("data", (d: Buffer) => { stdout += d; });
      child.stderr?.on("data", (d: Buffer) => { stderr += d; });
      const onAbort = () => {
        if (settled || aborted) return;
        aborted = true;
        // Captured (round 3, m-b), never `void`'d: the close handler below now AWAITS this — win32's own
        // `taskkill /T /F` completing is part of what "confirmed" means there, not merely "issued".
        killIssued = killGateProcessTree(child);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      child.on("error", (e) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(e);
      });
      child.on("close", (code) => {
        if (settled) return;
        if (!aborted) {
          settled = true;
          signal.removeEventListener("abort", onAbort);
          if (code === 0) { resolve(stdout); return; }
          const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n") || `git ${rawArgs.join(" ")} exited with code ${code}`;
          reject(new Error(detail));
          return;
        }
        settled = true;
        void (async () => {
          if (killIssued) await killIssued;
          const pid = child.pid;
          if (pid == null || process.platform === "win32") {
            // win32: taskkill /T /F (awaited above) has now itself completed walking + killing the whole
            // subtree, and this child's own close firing here is confirmation on top of that — no further
            // poll available without extra tooling. Residual: a descendant reparented BEFORE taskkill ran
            // (round 3, Code Review B-2) is unreachable by a PPID-walking taskkill and can hold this same
            // pipe open indefinitely instead — `close` then never fires at all, and the OUTER
            // `withTimeoutKillingChild` give-up timer (itself now tagged unconfirmed) is what catches it.
            onTreeDeathSettled?.(true);
            reject(markConfirmedKill(new Error("Abort signal received")));
            return;
          }
          const confirmed = await confirmProcessGroupDead(pid, killGraceMs);
          onTreeDeathSettled?.(confirmed);
          const e = new Error(confirmed ? "Abort signal received" : "Abort signal received (process tree not fully confirmed dead)");
          if (confirmed) markConfirmedKill(e); else markUnconfirmedKill(e);
          reject(e);
        })();
      });
    });
  };
  return { raw } as unknown as Pick<SimpleGit, "raw">;
}

/**
 * POSIX-only: poll a pure liveness probe (`process.kill(-pid, 0)` — no signal delivered) until it throws
 * ESRCH (the whole process GROUP is gone) or `graceMs` elapses. SIGKILL to a group is immediate and
 * uncatchable, so a member not yet REAPED by its parent (a brief zombie window) can still make this probe
 * see it as "present" for a few ms without being able to act further — an accepted, documented residual
 * (a zombie cannot execute code), not a correctness gap.
 */
async function confirmProcessGroupDead(pid: number, graceMs: number): Promise<boolean> {
  const deadline = performance.now() + graceMs;
  for (;;) {
    try { process.kill(-pid, 0); } catch { return true; }
    if (performance.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * True iff `e` represents a kill (or a give-up waiting on one) that could NOT positively confirm the whole
 * process tree actually died — checks {@link markUnconfirmedKill}'s typed marker FIRST, falling back to
 * the two known message shapes only for an error this file's own tagging somehow missed.
 *
 * @decision 24c0bdba (round 3, Code Review B-1) — a caller must never run a further mutating cleanup (a
 * canonical `reset --hard` / a batch rollback) when this is true; that would race whatever might still be
 * alive. Fail closed instead — report the failure loudly, quarantine the repo, and touch nothing else.
 */
const UNCONFIRMED_TREE_RE = /\(git child killed\): Abort signal received \(process tree not fully confirmed dead\)/;
const GIVE_UP_RE = /, killed, but did not die within \d+ms — giving up \(hung git child\?\)$/;
export function treeDeathUnconfirmed(e: unknown): boolean {
  if (isMarkedUnconfirmedKill(e)) return true;
  const msg = (e as Error)?.message ?? "";
  return UNCONFIRMED_TREE_RE.test(msg) || GIVE_UP_RE.test(msg);
}

/**
 * True iff `e` represents a kill whose whole process tree was POSITIVELY CONFIRMED dead — checks
 * {@link markConfirmedKill}'s typed marker first; the `$`-anchored message-regex fallback exists ONLY for
 * a test-seam `gitFactory` call (bypasses this file's real kill machinery entirely, so no marker is ever
 * attached) that manufactures a confirmed-kill-shaped message directly — see
 * merge-confirm-verdict-cache-solo-merge-transient.mjs. The anchor is what keeps this disjoint from
 * {@link treeDeathUnconfirmed}'s own two message shapes, both of which carry trailing text after "Abort
 * signal received" that this regex's `$` refuses to match.
 *
 * @decision 9f5ae011 (round 2) — a caller gating a retry (or a leaked-lock removal) on "confirmed" must
 * check THIS function, never infer it from `!treeDeathUnconfirmed(e)` — that negation also matches an
 * unrelated non-kill failure, which is the exact over-broad gate this function exists to replace.
 *
 * @decision 9f5ae011 (round 3) — the `(git child killed): ` PREFIX is load-bearing: simple-git's OWN
 * `abortPlugin` throws a bare, unprefixed, unmarked "Abort signal received" on ANY aborted call anywhere,
 * and this regex must never widen to match that bare shape as confirmed.
 */
const CONFIRMED_TREE_RE = /\(git child killed\): Abort signal received$/;
export function treeDeathConfirmed(e: unknown): boolean {
  if (isMarkedConfirmedKill(e)) return true;
  const msg = (e as Error)?.message ?? "";
  return CONFIRMED_TREE_RE.test(msg);
}

/**
 * A MUTATING canonical-path git call must never abandon its child on a bare `withTimeout` race (see
 * 8e75ee20); the shared dual-path kill-wired pattern {@link createWorktree}'s `boundedLockedRaw` and
 * {@link attemptCodexAutoCommit} each hand-rolled independently. `gitFactory`, when supplied (the test
 * seam), has no real child to kill, so it stays on a plain `withTimeout`; otherwise every call is a fresh
 * {@link spawnCanonicalGitTree} + `AbortController`, tree-killed on timeout — never shared across calls,
 * since killing one call's tree must never touch a DIFFERENT call already in flight. `async` (not a bare
 * arrow returning a Promise) so a synchronous construct-time throw becomes a rejection like every other
 * path here, rather than propagating as a thrown exception.
 *
 * `onTreeDeathSettled`, when supplied, is forwarded verbatim to {@link spawnCanonicalGitTree} — see that
 * function's own doc. Never invoked at all on the `gitFactory` test-seam path (no real child exists there).
 *
 * @decision bde5d1fe — RE-CHECKS the quarantine immediately before every call (real or test-seam), never
 * just once at an outer entry. `quarantineRepoPath` (default `repoPath`) is the CANONICAL repo to check
 * when `repoPath` itself is an ephemeral worktree. Throws {@link RepoQuarantinedError} before spawning.
 */
export async function killableCanonicalRaw(
  repoPath: string,
  args: string[],
  timeoutMs: number,
  label: string,
  gitFactory?: (repoPath: string, blockTimeoutMs: number) => Pick<SimpleGit, "raw">,
  env?: Record<string, string | undefined>,
  onTreeDeathSettled?: (confirmed: boolean) => void,
  quarantineRepoPath: string = repoPath,
): Promise<string> {
  const quarantineCheck = assertRepoNotQuarantined(quarantineRepoPath);
  if (!quarantineCheck.ok) throw new RepoQuarantinedError(quarantineCheck.reason);
  if (gitFactory) return withTimeout(gitFactory(repoPath, timeoutMs).raw(args), timeoutMs, label);
  const controller = new AbortController();
  return withTimeoutKillingChild(
    canonicalRaw(spawnCanonicalGitTree(repoPath, env, controller.signal, timeoutMs, onTreeDeathSettled), args),
    timeoutMs, label, controller,
  );
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
  deleteEnvKeys(out, GIT_ENV_STRIP_KEYS);
  return out;
}

/**
 * The env keys simple-git's `blockUnsafeOperationsPlugin` refuses that {@link GIT_ENV_STRIP_KEYS} does NOT strip and {@link boundedSimpleGit} does not pass through:
 * the transport/auth family (ask-pass, ssh, proxy programs), the template dir and the config-env count. Derived from `@simple-git/argv-parser@1.1.1`'s own `dist/index.mjs`
 * (the `const y = { … }` env→category map read by `parseEnv`); the remaining keys of that map are the editor/pager keys (stripped by {@link scrubGitEnv}) and the
 * config-path keys (`GIT_CONFIG_GLOBAL/SYSTEM`, `GIT_CONFIG`, `GIT_EXEC_PATH`, `PREFIX`: allowed by {@link boundedSimpleGit}).
 */
export const GIT_ENV_TRANSPORT_KEYS = ["GIT_ASKPASS", "SSH_ASKPASS", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_PROXY_COMMAND", "GIT_TEMPLATE_DIR", "GIT_CONFIG_COUNT"] as const;

/**
 * Env keys that PIN which repo/working-tree/object-store a git invocation targets, overriding its
 * normal cwd-based upward discovery outright. An UNPINNED discovery probe (one that must answer "is
 * `repoPath` itself a repo, or which repo governs it") needs these ABSENT, never merely benign.
 *
 * @decision 306dd105 — an ambient `GIT_DIR` (a shell export, an IDE terminal, a decoy left by a prior
 * step) silently redirects such a probe at a DIFFERENT repo while it keeps reporting success, which is
 * worse than an honest error; see that record's "Round 3" for the regression this closed.
 *
 * Deliberately EXCLUDES `GIT_CEILING_DIRECTORIES`: that var bounds how far UPWARD a search may walk, it
 * does not point at a specific repo the way every key below does, and a caller legitimately bounding
 * discovery to its own temp root may want it left alone on an otherwise-stripped probe env.
 *
 * @see {@link stripRepoLocationEnv} — the one place this list is applied; reuses {@link deleteEnvKeys},
 * never a second hand-rolled removal loop.
 */
export const GIT_ENV_REPO_LOCATION_KEYS = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE",
] as const;

/**
 * Deletes {@link GIT_ENV_REPO_LOCATION_KEYS} from `env`, IN PLACE (mirrors {@link deleteEnvKeys}'s own
 * mutate-in-place contract) — for an UNPINNED discovery/read probe that must use git's own cwd-based
 * repo resolution and must not be silently redirected by an ambient `GIT_DIR`/`GIT_WORK_TREE`/etc.
 *
 * Never call this on an env a caller is ABOUT to pin (e.g. via `localReadGitEnv`'s own `GIT_DIR`/
 * `GIT_WORK_TREE` overrides) in order to "be safe" — stripping first is harmless there (the override
 * re-adds exactly those two keys), but the helper exists for the UNPINNED case; a caller that wants to
 * pin should just pin.
 */
export function stripRepoLocationEnv(env: Record<string, string | undefined>): void {
  deleteEnvKeys(env, GIT_ENV_REPO_LOCATION_KEYS);
}

/**
 * The env for a LOCAL, read-only git probe that needs a pinned setting (e.g. `LC_ALL=C`, to read git's English message): `base` (case-aware) MINUS {@link GIT_ENV_TRANSPORT_KEYS},
 * with `overrides` applied (any differently-cased spelling of an override key removed first, win32 env names being case-insensitive). Such a probe never authenticates or talks
 * to a remote, so the stripped keys cannot matter to it, whereas an EXPLICIT env carrying one (VS Code's terminal sets `GIT_ASKPASS`) would make simple-git throw "unsafe" on
 * EVERY call. Returns a NEW object; never mutates `base`. Callers that DO reach a remote must not use this: those keep the loud failure (see {@link GIT_ENV_STRIP_KEYS}).
 */
export function localReadGitEnv(base: Record<string, string | undefined>, overrides: Record<string, string>): Record<string, string | undefined> {
  const out = { ...base };
  deleteEnvKeys(out, GIT_ENV_TRANSPORT_KEYS);
  deleteEnvKeys(out, Object.keys(overrides));
  return { ...out, ...overrides };
}

/** The keys of `env` that name one of `names` — on win32 case-INSENSITIVELY (env names are case-insensitive there: `Git_Pager` IS `GIT_PAGER` to git-for-windows, and
 *  a `{...process.env}` copy keeps the key as spelled); on POSIX exact-match only (`Git_Config` is a different, inert variable). Card e93703d9. */
export function envKeysNamed(env: Record<string, string | undefined>, names: readonly string[]): string[] {
  if (process.platform !== "win32") return names.filter((n) => Object.prototype.hasOwnProperty.call(env, n));
  const upper = new Set(names.map((n) => n.toUpperCase()));
  return Object.keys(env).filter((k) => upper.has(k.toUpperCase()));
}
/** Delete every key {@link envKeysNamed} finds, in place. */
export function deleteEnvKeys(env: Record<string, string | undefined>, names: readonly string[]): void {
  for (const k of envKeysNamed(env, names)) delete env[k];
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
 *
 * Card 00a6cdd6 (Code Review S4): `extraUnsafe`, when supplied, is merged into the SAME `unsafe` object
 * — but ONLY for the ONE call that passes it. This is deliberately NOT another unconditional addition
 * next to `allowUnsafeConfigPaths` above: a caller-scoped opt-in keeps every OTHER existing/future
 * caller's `unsafe` allowlist exactly what it is on main, rather than silently widening it for all of
 * them. The codex auto-commit path (`git/worktrees.ts`'s `attemptCodexAutoCommit`) is the one caller
 * that passes `{ allowUnsafeHooksPath: true, allowUnsafeFsMonitor: true }` here, via its OWN dedicated
 * `gitFactory` — see that function's own doc for why it needs both.
 */
export function boundedSimpleGit(
  repoPath: string,
  blockTimeoutMs: number,
  env?: Record<string, string | undefined>,
  abortSignal?: AbortSignal,
  extraUnsafe?: SimpleGitOptions["unsafe"],
  config?: string[],
): SimpleGit {
  const scrubbedEnv = env ? scrubGitEnv(env) : undefined;
  const hasEnv = !!scrubbedEnv && Object.keys(scrubbedEnv).length > 0;
  const unsafe: SimpleGitOptions["unsafe"] = { allowUnsafeConfigPaths: true, ...extraUnsafe };
  const git = simpleGit(repoPath, {
    timeout: { block: blockTimeoutMs },
    ...(abortSignal ? { abort: abortSignal } : {}),
    ...(hasEnv || extraUnsafe ? { unsafe } : {}),
    ...(config && config.length > 0 ? { config } : {}),
  });
  return hasEnv ? git.env(scrubbedEnv as Record<string, string | undefined>) : git;
}

/**
 * The ONE factory every CANONICAL merge-path git call uses (`git/worktrees.ts`, `git/batch-merge.ts`): ignores replace refs on every
 * command and fails closed on worker-set merge drivers in the shared `.git`. Deny-by-default: an unrecognised subcommand is exec-capable.
 *
 * @decision 356538ef — do NOT construct git on the canonical path any other way (guarded by canonical-git-helper-guard.mjs), and do NOT
 * swap the driver blanking for `--attr-source`/`core.attributesFile` (verified not to stop a driver). Residual + not-hardened: the record.
 */
export const CANONICAL_GIT_CONFIG = ["core.useReplaceRefs=false"] as const;
/** The `-c` argv equivalent of {@link CANONICAL_GIT_CONFIG}, for a raw `spawn("git", …)` site that cannot use {@link canonicalGit}. */
export const CANONICAL_GIT_CONFIG_ARGS: readonly string[] = CANONICAL_GIT_CONFIG.flatMap((c) => ["-c", c]);

/** Subcommands that cannot run a merge driver UNLESS an arg asks them to (`--remerge-diff` on show/log/diff-tree does — see
 *  {@link canRunMergeDriver}). ANYTHING else is exec-capable (deny-by-default). */
const PURE_READ_SUBCOMMANDS = new Set([
  "rev-parse", "rev-list", "log", "show", "cat-file", "ls-files", "ls-tree", "merge-base", "config", "diff-tree",
  "diff", "status", "branch", "update-ref", "symbolic-ref", "for-each-ref", "show-ref", "worktree", "remote",
  "count-objects", "describe", "name-rev", "grep", "init", "reflog",
]);

/** Global options that take their value as a SEPARATE arg when written without `=` (`--exec-path`/`--super-prefix` are deliberately absent: bare, they take no value, and mis-skipping a real subcommand would be the UNSAFE direction) — the value must never be read as the subcommand. */
const GLOBAL_OPTS_WITH_VALUE = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--config-env", "--attr-source"]);

/** Parse a `raw` arg list's global options: the subcommand (or undefined). */
function parseGitArgs(args: readonly string[]): { sub: string | undefined } {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (GLOBAL_OPTS_WITH_VALUE.has(a)) { i++; continue; }
    if (a.startsWith("-")) continue;
    return { sub: a };
  }
  return { sub: undefined };
}

/** The git subcommand of a `raw` arg list, skipping global options and their separate-arg values (`-c k=v`, `-C p`, `--git-dir p`, `--x[=y]`). */
export function gitSubcommand(args: readonly string[]): string | undefined {
  return parseGitArgs(args).sub;
}

/** Could this command run a merge driver? Deny-by-default; a known pure read is exec-capable only if an arg names `--remerge-diff` (any arg matching /remerge/). */
export function canRunMergeDriver(args: readonly string[]): boolean {
  const { sub } = parseGitArgs(args);
  if (sub === undefined || !PURE_READ_SUBCOMMANDS.has(sub)) return true;
  // `--remerge-diff`, `--diff-merges=r`, and `-m`/`--diff-merges=on` (a worker-set `log.diffMerges=remerge` turns those into remerge) all run merge drivers on a read.
  return args.some((a) => /remerge/i.test(a) || /^--diff-merges/i.test(a) || /^-[A-Za-z]*m[A-Za-z]*$/.test(a));
}

/** A canonicalGit refusal: thrown BEFORE any git process runs, so nothing was changed. Callers tell it from a real git failure via {@link describeGitFailure}. */
export class CanonicalGitRefusal extends Error {
  constructor(message: string) { super(message); this.name = "CanonicalGitRefusal"; }
}

/** One shared way to describe a git failure in a result `reason`: the first line of the message (capped), and whether it was a {@link CanonicalGitRefusal} (nothing changed). */
export function describeGitFailure(e: unknown): { text: string; refusal: boolean } {
  const text = String((e as Error)?.message ?? e).split(/\r?\n/, 1)[0]!.slice(0, 400);
  return { text, refusal: e instanceof CanonicalGitRefusal };
}

/** The global options in front of the subcommand (`--git-dir p`, `-C p`, `-c k=v`, `--work-tree=…`, …): the config-affecting context the REAL call runs in. */
export function gitGlobalArgs(args: readonly string[]): string[] {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (GLOBAL_OPTS_WITH_VALUE.has(a)) { i++; continue; }
    if (a.startsWith("-")) continue;
    return args.slice(0, i);
  }
  return [...args];
}

const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);
/** `merge.<name>.driver`, matched in JS (any `<name>`, including empty, with `=`, or U+FFFD). Case-insensitive on section/variable as git canonicalises them. */
const MERGE_DRIVER_KEY = /^merge\.([\s\S]*)\.driver$/i;

/** A config key that cannot be trusted to round-trip through argv/UTF-8 decoding (a non-UTF-8 byte decodes to U+FFFD, colliding with our own `-c` key), or holds a control char. */
const keyIsUnsafe = (k: string): boolean => k.includes(REPLACEMENT_CHAR) || /[\x00-\x1f\x7f]/.test(k);

/**
 * THE INVARIANT (rulings after review rounds 1-4): stop predicting key spelling and VERIFY the resulting state, self-sufficiently. With `prefix` applied
 * — and with the call's OWN global options (`-C`, `--git-dir`, `-c`, …) so this read sees exactly the config the real call sees — re-read every
 * `merge.*.driver` and THROW a {@link CanonicalGitRefusal} unless the EFFECTIVE (last-wins) value of every key is empty. Fails closed on anything it cannot
 * PROVE empty: a key with no value is live, and so is any key containing U+FFFD or a control character (decoding collapses the real key and our
 * blanking `-c` key into one map entry, so the blank would hide the live driver — this check must not depend on the enumeration having refused first).
 */
export async function assertNoLiveMergeDrivers(git: Pick<SimpleGit, "raw">, prefix: readonly string[], args: readonly string[]): Promise<void> {
  const out = await git.raw([...prefix, ...gitGlobalArgs(args), "config", "-z", "--list"]);
  const effective = new Map<string, string | null>();
  for (const rec of out.split("\0")) {
    if (rec === "") continue;
    const nl = rec.indexOf("\n");
    const key = nl < 0 ? rec : rec.slice(0, nl);
    if (MERGE_DRIVER_KEY.test(key)) effective.set(key, nl < 0 ? null : rec.slice(nl + 1));
  }
  const live = [...effective].filter(([k, v]) => v !== "" || keyIsUnsafe(k)).map(([k]) => k);
  if (live.length > 0) {
    throw new CanonicalGitRefusal(`canonicalGit: refusing to run "git ${gitSubcommand(args) ?? ""}" — merge driver key(s) ${live.map((k) => JSON.stringify(k)).join(", ")} would still be live after neutralising (a name that cannot be carried in a -c override); remove them from the repository's git config`);
  }
}

/** Names `<x>` of every `merge.<x>.driver` visible from the call's cwd/globals (includes + worktree config honoured). */
async function configuredMergeDriverNames(git: Pick<SimpleGit, "raw">, globals: readonly string[]): Promise<string[]> {
  // LIST every entry and filter IN JS — never `--get-regexp`: on glibc in a UTF-8 locale git's regex `.` does NOT match an invalid byte, so a regex read
  // returned NOTHING for a raw-0xE9 driver name and the driver ran (a Windows git matches in every locale, so only POSIX could see it). A real error throws (fail closed).
  const out = await git.raw([...globals, "config", "-z", "--list"]);
  const names = new Set<string>();
  for (const rec of out.split("\0")) {
    const key = rec.split("\n", 1)[0]!;
    const m = MERGE_DRIVER_KEY.exec(key);
    if (m) names.add(m[1]!);
  }
  return [...names];
}

/** Builds the `-c merge.<x>.driver=` prefix from the enumerated names. The DEFAULT refuses names `-c` cannot carry; {@link canonicalRaw}'s post-check is the backstop. */
export type MergeDriverPrefixBuilder = (names: readonly string[], args: readonly string[]) => string[];
const defaultPrefixBuilder: MergeDriverPrefixBuilder = (names, args) => {
  // `-c` splits key/value at the FIRST `=`, so a name containing `=` (gitattributes accept `merge=a=b`) can never be blanked that way; refuse rather than try
  // (also control chars and U+FFFD).
  const bad = names.find((n) => n.includes("=") || keyIsUnsafe(n));
  if (bad !== undefined) {
    throw new CanonicalGitRefusal(`canonicalGit: refusing to run "git ${gitSubcommand(args) ?? ""}" — the repository's git config defines merge driver key ${JSON.stringify(`merge.${bad}.driver`)}, whose name contains "=", a control character or a non-UTF-8 byte and so cannot be safely neutralised; remove that key from the shared .git/config (or worktree/included config)`);
  }
  return names.flatMap((n) => ["-c", `merge.${n}.driver=`]);
};

/**
 * The whole `raw` pipeline of {@link canonicalGit}: enumerate (with the call's own globals) → build the blanking prefix → VERIFY it via
 * {@link assertNoLiveMergeDrivers} → run. Exported ONLY so a test can inject a `buildPrefix` that deliberately misses a driver and prove the post-check is
 * WIRED and is the last line of defence (production always uses the default builder).
 */
export async function canonicalRaw(git: Pick<SimpleGit, "raw">, args: string[], buildPrefix: MergeDriverPrefixBuilder = defaultPrefixBuilder): Promise<string> {
  let prefix: string[] = [];
  if (canRunMergeDriver(args)) {
    const names = await configuredMergeDriverNames(git, gitGlobalArgs(args));
    prefix = buildPrefix(names, args);
    await assertNoLiveMergeDrivers(git, prefix, args);
  }
  return git.raw([...prefix, ...args]);
}

/**
 * The env-prep `canonicalGit` itself applies before construction: strip ambient `GIT_CONFIG` (honoured
 * ONLY by the `git config` builtin, never by `git merge` — left in place it blinds both driver reads to a
 * file the real merge never reads; every OTHER config env var feeds the ONE config stack `merge` and
 * `config` both read, so only this one needs stripping), then {@link scrubGitEnv}. Shared with {@link
 * spawnCanonicalGitTree} (@decision 24c0bdba) so its raw spawn sees the IDENTICAL env `canonicalGit`
 * itself would build — keep env-less callers env-less either way (`undefined` stays `undefined`), since
 * simple-git's `blockUnsafeOperationsPlugin` only inspects an EXPLICIT env.
 */
function prepareCanonicalEnv(env?: Record<string, string | undefined>): Record<string, string | undefined> | undefined {
  const base = env ?? process.env;
  let cleanEnv = env;
  // Presence check AND strip both go through the ONE case-aware helper (win32: `Git_Config` is `GIT_CONFIG` — card e93703d9); a bare `base.GIT_CONFIG` read would find
  // it on process.env (Node's case-insensitive accessor) while a plain-object `delete` misses it.
  if (envKeysNamed(base, ["GIT_CONFIG"]).some((k) => base[k] !== undefined)) { cleanEnv = { ...base }; deleteEnvKeys(cleanEnv, ["GIT_CONFIG"]); }
  return cleanEnv ? scrubGitEnv(cleanEnv) : undefined;
}

export function canonicalGit(
  repoPath: string,
  blockTimeoutMs: number,
  env?: Record<string, string | undefined>,
  abortSignal?: AbortSignal,
  extraUnsafe?: SimpleGitOptions["unsafe"],
): SimpleGit {
  // `allowUnsafeMergeDriver` is required for simple-git to pass OUR `-c merge.<x>.driver=` (a blanking, never a set).
  // `boundedSimpleGit` re-applies `scrubGitEnv` to whatever `prepareCanonicalEnv` already scrubbed — idempotent, kept for its own unconditional-at-construction guarantee (f7a80d76).
  const git = boundedSimpleGit(repoPath, blockTimeoutMs, prepareCanonicalEnv(env), abortSignal, { ...extraUnsafe, allowUnsafeMergeDriver: true }, [...CANONICAL_GIT_CONFIG]);
  const raw = async (...callArgs: unknown[]): Promise<string> => {
    const args = (Array.isArray(callArgs[0]) ? callArgs[0] : callArgs) as string[];
    return canonicalRaw(git, args);
  };
  return new Proxy(git, {
    get(target, prop) {
      if (prop === "raw") return raw;
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}
