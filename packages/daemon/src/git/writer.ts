import fs from "node:fs";
import path from "node:path";
import type { SimpleGit } from "simple-git";
import {
  recordGitPushOutcome,
  pauseVaultAutoCommit,
  resumeVaultAutoCommit,
  DEFAULT_MAX_VAULT_FILE_BYTES,
  humanBytes,
  isLoomHomeOrAncestor,
  OPERATIONAL_HOME_GIT_WRITE_ERROR,
} from "../vault/versioner.js";
import { withCanonicalIndexLock } from "./repo-lock.js";
import {
  withTimeout,
  boundedSimpleGit,
  scrubGitEnv,
  localReadGitEnv,
  killableCanonicalRaw,
  treeDeathUnconfirmed,
  isNotAGitRepositoryError,
} from "./bounded.js";
import { enterMergeQuarantine, clearMergeQuarantineByToken, unconfirmedKillReason } from "./merge-quarantine.js";

// The WRITE side of the project git view — sibling to reader.ts (which stays read-only introspection).
// Like the vault writer (vault/writer.ts) and gateCommand, git writes are a TRUST-BOUNDARY surface:
// checkout/commit and ESPECIALLY push (outward-facing, network, irreversible) are reachable from the
// human REST path AND — as a deliberate, role-gated trust elevation (Platform Manager P3) — from the
// PLATFORM MCP, whose tools are gated strictly to role==="platform" (the human-equivalent Lead, a
// human-created-only session). commit/push/createBranch are NEVER exposed on the loom-tasks or
// orchestration (manager/worker) MCP servers — an ordinary agent must never commit/push/create a branch.
// `checkout` (switch to an EXISTING branch, never create one) is the ONE deliberate exception — also
// reachable from the orchestration MCP's manager surface, scoped to the caller's OWN project
// (`project_checkout_branch`, mcp/orchestration.ts — never the worker surface).
//
// @decision 2a6a292a round 4 — see that record's "manager-checkout" section for the full rationale.
//
// Every caller REUSES this class verbatim, so its bounds/timeouts/identity guarantees hold everywhere.
// The REST endpoints in gateway/server.ts, the platform git tools in mcp/platform.ts, and the operator
// git tools in mcp/operator.ts (codex parity surface) call in too — four callers total, as of the
// decision record's round 11.
//
// @decision 59e53710 — `checkout()`/`createBranch()` both run `unsafeBranchNameShapeReason` THEMSELVES,
// before any git call, so every one of the four callers refuses a name-shape bypass uniformly.

/**
 * Per-op ceiling. Every git write runs BOUNDED + NON-INTERACTIVE: this repo has been bitten twice by
 * an unbounded git op HANGING (not throwing) and wedging the daemon (the 2026-06-03 boot-reconcile
 * outage). A push that needs credentials, or a child stuck on a locked ref, must fail within this
 * window — never hang. Mirrors GIT_OP_TIMEOUT_MS in git/worktrees.ts (push gets a longer budget than
 * a local op because a reachable remote can be legitimately slow, but it is still bounded).
 *
 * These are the DEFAULTS / test seams; the live values are `platform.timeouts.gitLocalMs`/`gitPushMs`,
 * threaded in via the {@link GitWriter} constructor opts (the gateway passes the resolved numbers at
 * boot — BOOT-BOUND). A misconfigured (sub-second) value is FLOORED to {@link GIT_TIMEOUT_FLOOR_MS} so
 * a bad config can never make every git write fail-fast.
 */
const GIT_LOCAL_TIMEOUT_MS = 15_000;
const GIT_PUSH_TIMEOUT_MS = 45_000;

/** Conservative branch-name charset: must start alnum, each later char is alnum/dot/underscore/dash, or a
 *  slash immediately followed by alnum — rejects "//" ", a leading/trailing slash, and (by construction,
 *  since none of these characters are in the allowed set) "@", "{", "}", "~", "^", ":", "?", "*", "[", "\\",
 *  spaces and control characters. */
const SAFE_BRANCH_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]|\/[A-Za-z0-9])*$/;

/**
 * @decision 59e53710 — the leading-"-"/"@{"/"refs/"-prefix checks belong here, enforced for EVERY
 * `GitWriter.checkout`/`createBranch` caller. Never fold ".."/the conservative charset in here too —
 * those stay caller-side-only, inside `unsafeBranchNameReason` below.
 *
 * Returns the reason a name is unsafe, or `null` when it is a plain branch name.
 */
export function unsafeBranchNameShapeReason(name: string): string | null {
  if (name.startsWith("-")) return `"${name}" starts with "-" — it could be parsed as a git command-line option, not a branch name`;
  if (name.includes("@{")) return `"${name}" contains "@{" — that is revision/reflog shorthand (e.g. the previous-branch shortcut "@{-1}"), never a plain branch name`;
  if (/^refs\//i.test(name)) return `"${name}" starts with "refs/" — pass a short branch name (e.g. "main"), not a full ref path`;
  return null;
}

/**
 * @decision 2a6a292a round 10 — pre-git shape validation; no git-argument-level mitigation exists for
 * "-"/"@{-1}"/"-bsneaky" (verified: neither `--no-guess` nor a trailing `--` stops them). Callers accepting
 * an untrusted branch name MUST call this before any git call. See the decision record's round-10 section.
 *
 * @decision 59e53710 — never re-inline the leading-"-"/"@{"/"refs/"-prefix checks here; delegate to
 * `unsafeBranchNameShapeReason` so `GitWriter` itself enforces that subset for every caller, not just
 * `project_checkout_branch`. Keep the ".."/charset checks here, caller-side-only.
 *
 * Returns the reason a name is unsafe, or `null` when it is a plain branch name. Deliberately does NOT
 * reject a name merely because it looks like `<remote>/<name>` (e.g. "origin/evil") — see the record for why.
 */
export function unsafeBranchNameReason(name: string): string | null {
  if (!name) return "a branch name is required";
  const shapeReason = unsafeBranchNameShapeReason(name);
  if (shapeReason) return shapeReason;
  if (name.includes("..")) return `"${name}" contains ".." — that is range syntax, never a plain branch name`;
  if (!SAFE_BRANCH_NAME_RE.test(name)) return `"${name}" contains characters outside the conservative branch-name charset (letters, digits, ".", "_", "-", and "/" between segments)`;
  return null;
}
/** Hard floor (1s) for any threaded git-write timeout — never let a misconfig fail-fast every op. */
const GIT_TIMEOUT_FLOOR_MS = 1_000;

/**
 * Env that forces git to FAIL FAST instead of blocking on any interactive prompt:
 *  - GIT_TERMINAL_PROMPT=0 — git never prompts on the terminal (the classic hang: a push to an
 *    auth-required remote sits forever waiting for a username/password on stdin we don't have).
 *  - GCM_INTERACTIVE=never — Git Credential Manager (the common Windows prompt source) never opens a
 *    dialog; it fails closed.
 *  - LC_ALL=C / LANG=C — pin git's locale so its stderr is stable ENGLISH. We MACHINE-READ git's error
 *    text ({@link isNoUpstreamError} matches "no upstream"/"no configured push destination") to decide
 *    the no-upstream `push -u` retry; on a host with a non-English git locale git emits localized text,
 *    the substring match misses, and the UI "+ Branch" first push fails confusingly. LC_ALL wins over
 *    any inherited LANG/LC_* so the detection holds regardless of the host locale.
 * We deliberately do NOT set GIT_ASKPASS/SSH_ASKPASS: simple-git's injection guard refuses to run with
 * those in a supplied env (they're an arbitrary-command vector) and disabling that guard is the wrong
 * trade for a trust-boundary surface. The residual GUI-askpass hang risk is covered by the
 * {@link withTimeout} race below — the hard backstop regardless of env: even a never-settling git
 * promise unblocks the caller within the op's budget.
 */
const NONINTERACTIVE_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  LC_ALL: "C",
  LANG: "C",
};

/**
 * The child env for a git write: the inherited env (git needs PATH/HOME/etc.) MINUS
 * {@link GIT_ENV_STRIP_KEYS}, PLUS {@link NONINTERACTIVE_ENV}. simple-git ships a
 * `blockUnsafeOperationsPlugin` (via `@simple-git/argv-parser`'s `vulnerabilityCheck`) that throws if ANY
 * of a fixed list of env vars is present in the supplied env, unless the matching `unsafe.allow*` flag is
 * explicitly set — each entry below is one of those categories, decided on the SAME two-part test the
 * original `GIT_EDITOR`/`GIT_SEQUENCE_EDITOR` strip used: (1) could a real host/session ambiently carry
 * it, and (2) would {@link GitWriter.push}'s own instance (this function's ONE remaining caller — see
 * {@link localNonInteractiveEnv} for every LOCAL-only caller, which strips the transport family instead)
 * ever legitimately need it.
 *
 * @decision f7a80d76 — STRIPPED (delegated to {@link scrubGitEnv}: includes GIT_PAGER/PAGER, proved to
 * 500 every git op, card 42544916) vs PASSED-THROUGH-EXPLICITLY-ALLOWED (the config-path family, via
 * `unsafe.allowUnsafeConfigPaths`) — never re-add GIT_PAGER/PAGER, never blanket-strip config-paths.
 *
 * @decision a746a3eb — the transport family below is DELIBERATELY LEFT BLOCKED for `push()` specifically,
 * never a gap. Every OTHER, LOCAL-only caller instead strips it via {@link localNonInteractiveEnv}.
 *
 * DELIBERATELY LEFT BLOCKED (simple-git's guard staying active for `push()` is the intended behavior):
 *  - GIT_ASKPASS / SSH_ASKPASS — pre-existing decision (see {@link NONINTERACTIVE_ENV}'s comment):
 *    genuinely reachable ambiently (e.g. VS Code's integrated terminal sets `GIT_ASKPASS` for its own
 *    Git extension), but bypassing the guard is an arbitrary-command vector during a real auth prompt —
 *    the wrong trade for the one instance that actually authenticates against a remote.
 *  - GIT_SSH / GIT_SSH_COMMAND — same trust class as ASKPASS: plausibly ambient (devs pin a custom
 *    identity file via `GIT_SSH_COMMAND`), but it names an arbitrary program git will exec in place of
 *    `ssh` for the real network transport `push()` uses — bypassing it is the same class of risk as
 *    bypassing ASKPASS, so it stays blocked rather than silently honored.
 *  - GIT_PROXY_COMMAND — same reasoning: a corporate proxy setup could plausibly export this, but it
 *    too names an arbitrary program git execs for the connection; left blocked rather than trusted.
 *
 * CHECKED, NOT REALISTICALLY REACHABLE (left unhandled — not because bypassing would be unsafe, but
 * because no ordinary shell profile or IDE integration plausibly exports these, unlike EDITOR/PAGER):
 *  - GIT_CONFIG_COUNT — a DIFFERENT category (`allowUnsafeConfigEnvCount`) from the config-path family
 *    above, NOT covered by `allowUnsafeConfigPaths`; git's env-based config injection count, a
 *    script-authored convention, not an ambient shell export.
 *  - GIT_TEMPLATE_DIR — only affects `git init`, which no op in this file invokes.
 * If either of these turns out to be reachable in practice, it hits the exact same 500 this file already
 * proved GIT_PAGER causes — treat a report of one as confirmation to extend the relevant allowance, not a
 * reason to relitigate the categories left blocked deliberately above.
 */
export function nonInteractiveEnv(): Record<string, string | undefined> {
  return { ...scrubGitEnv(process.env), ...NONINTERACTIVE_ENV };
}

/**
 * @decision a746a3eb — the LOCAL-ONLY sibling of {@link nonInteractiveEnv}: also strips the transport
 * family (GIT_ASKPASS, SSH_ASKPASS, GIT_SSH, GIT_SSH_COMMAND, GIT_PROXY_COMMAND, ...), left BLOCKED by
 * `nonInteractiveEnv()` itself. Never use this for an instance that can reach a remote (e.g. push).
 */
export function localNonInteractiveEnv(): Record<string, string | undefined> {
  return localReadGitEnv(nonInteractiveEnv(), {});
}

/** A structured outcome the UI can render — never a thrown 500 for an EXPECTED git failure. */
export type GitWriteResult<T = Record<string, never>> = ({ ok: true } & T) | { ok: false; error: string };

/** Matches one `Claude-Session:` trailer line — the Claude Code harness's own attribution line, which
 *  this project's CLAUDE.md forbids on mainline commits (a Loom worker's per-task squash merge auto-
 *  appends `Loom-Worker-Branch:` instead; that rule has no way to reach a message this class of caller
 *  composes). {@link GitWriter.commit} (below) and the batch cherry-pick landing path
 *  (`git/batch-merge.ts`, which imports {@link stripClaudeSessionTrailer} from here rather than
 *  duplicating it) both land a caller-composed message with no other filtering, so this is the ONE place
 *  either of them strips it. Keyed on this EXACT trailer name only — never touches
 *  `Loom-Worker-Branch`/`Loom-Worker-Base`/`Loom-Worker-PathSet`, which are load-bearing for
 *  `scanMergedCommitMap`/path-set verification (git/worktrees.ts); a filter that over-strips would pass
 *  every obvious check while silently breaking ship-state resolution. */
const CLAUDE_SESSION_TRAILER_LINE = /^Claude-Session:\s*\S/;

/**
 * Removes every `Claude-Session:` trailer line from `message`, collapsing the double blank line the
 * removal leaves behind (mirrors this project's own validated `sed '/^Claude-Session: /d' | cat -s`
 * history-rewrite recipe). Returns `{ message, stripped }` rather than mutating silently — `stripped`
 * lets a caller surface a non-blocking warning instead of the removal being invisible to whoever wrote
 * the trailer in good faith (their own harness told them to).
 */
export function stripClaudeSessionTrailer(message: string): { message: string; stripped: boolean } {
  const lines = message.split("\n");
  if (!lines.some((l) => CLAUDE_SESSION_TRAILER_LINE.test(l))) return { message, stripped: false };
  const cleaned = lines
    .filter((l) => !CLAUDE_SESSION_TRAILER_LINE.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  return { message: cleaned, stripped: true };
}

/** First line of a git/simple-git error — the human-readable reason (dirty tree, no upstream, etc.).
 *  Exported so the READ side (gateway/server.ts's git/log, git/branches, and the reference/registered
 *  repo log routes) can surface the same clean, cause-naming message on a genuine failure instead of
 *  fastify's generic default-error-handler body — one helper, so the two sides can't drift apart. */
export function gitError(e: unknown): string {
  const msg = (e as Error)?.message ?? String(e);
  return msg.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "git operation failed";
}

/**
 * Does this push failure mean "this branch has no tracking ref to push to" (vs. a remote/auth/reject
 * failure)? A branch freshly created via the UI "+ Branch" button has no upstream, so a plain `git push`
 * fails with `The current branch <x> has no upstream branch.` (or, on a repo with no remote at all,
 * `No configured push destination.`). Those are the ONLY conditions we retry with set-upstream — any
 * other failure (unreachable remote, auth required, rejected non-fast-forward) is surfaced unchanged.
 */
function isNoUpstreamError(e: unknown): boolean {
  const msg = ((e as Error)?.message ?? String(e)).toLowerCase();
  return msg.includes("no upstream") || msg.includes("no configured push destination");
}

/** Every method GitWriter's bounded git calls need, across checkout/createBranch/commit/push/pendingPushSummary. */
type WriterGit = Pick<SimpleGit, "checkout" | "checkoutLocalBranch" | "branchLocal" | "status" | "raw" | "commit" | "revparse">;

/**
 * Injectable seam mirroring git/reader.ts's `ReaderGitDeps` / git/worktrees.ts's `BoundedGitDeps` — lets a
 * test inject a fake whose `branchLocal()` (or any other method) never settles, and assert a call is
 * bounded instead of hanging forever. Real callers never pass this; `GitWriter` had NO such seam before
 * card 40a264d3, which is why the two unbounded in-lock calls below could not be hermetically proven
 * bounded until now.
 */
export interface GitWriterDeps {
  gitFactory?: (repoPath: string, blockTimeoutMs: number, env: Record<string, string | undefined>) => WriterGit;
}

/**
 * Resolve `repoPath`'s git-resolved TOPLEVEL (bounded, fail-closed) and refuse if it is Loom's own
 * operational home dir or an ancestor of it — the toplevel-probe HALF of {@link
 * GitWriter.refuseIfOperationalHome} (that method's raw-path check is the other half), factored out so a
 * PRE-PROPOSE check (companion/capabilities.ts's `resolveGitPushTarget`, `"repo"` branch) can run the
 * SAME resolution before asking the owner to confirm a write `GitWriter` would refuse anyway at commit
 * time — never a second, drifting implementation of this probe. `timeoutMs`/`gitFactory` let a caller
 * override the bound/injected git; omitted, real callers get the module defaults.
 *
 * @decision f9360c84 — also refuses an EMPTY toplevel from an otherwise-successful probe, completing the
 * fail-closed property this decision established; see that record.
 */
export async function resolveOperationalHomeToplevelRefusal(
  repoPath: string,
  timeoutMs: number = GIT_LOCAL_TIMEOUT_MS,
  gitFactory: NonNullable<GitWriterDeps["gitFactory"]> = (p, ms, env) => boundedSimpleGit(p, ms, env),
): Promise<{ ok: false; error: string } | null> {
  try {
    // @decision a746a3eb — LOCAL-only discovery (never touches a remote), so this always uses
    // localNonInteractiveEnv() regardless of what the calling write eventually does.
    const git = gitFactory(repoPath, timeoutMs, localNonInteractiveEnv());
    const toplevel = (await withTimeout(
      git.revparse(["--show-toplevel"]),
      timeoutMs,
      "git rev-parse --show-toplevel (operational-home guard)",
    )).trim();
    if (!toplevel || isLoomHomeOrAncestor(toplevel)) {
      return { ok: false, error: OPERATIONAL_HOME_GIT_WRITE_ERROR };
    }
  } catch (e) {
    if (!isNotAGitRepositoryError(e)) {
      return { ok: false, error: `could not verify this repo's location; refusing to write (${gitError(e)})` };
    }
    // An affirmative "not a git repository" — there is genuinely no toplevel to check. Fall through;
    // the real op below fails on its own, clean terms.
  }
  return null;
}

/** A GitHub noreply commit identity — correct for github.com repos, unroutable anywhere else. */
const GITHUB_NOREPLY_SUFFIX = "@users.noreply.github.com";

/**
 * Extract the bare host from an `origin` URL across the forms git emits — scheme URLs
 * (`https://github.com/o/r.git`, `ssh://git@host:22/o/r`) and the scp-like shorthand
 * (`git@github.com:o/r.git`). Returns the lowercased host, or null if it can't be parsed (→ no warning).
 * Exported so the bind-time identity assert (git/reader.ts) reuses the SAME host parser.
 */
export function originHost(url: string): string | null {
  const u = url.trim();
  if (!u) return null;
  // scp-like shorthand: [user@]host:path  (no scheme, a colon before the first slash)
  const scp = /^(?:[^@/]+@)?([^:/]+):/.exec(u);
  if (scp?.[1] && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return scp[1].toLowerCase();
  // scheme://[user@]host[:port]/path
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^:/]+)/i.exec(u);
  return m?.[1] ? m[1].toLowerCase() : null;
}

/** github.com or any subdomain of it (gist.github.com, …) — vs. any self-hosted forge. */
function isGithubHost(host: string): boolean {
  return host === "github.com" || host.endsWith(".github.com");
}

/**
 * The PURE GitHub-vs-self-hosted (Forgejo/Gitea/GitLab) host rule, single-sourced so the push-time
 * {@link GitWriter.identityWarning} and the bind-time identity assert ({@link checkCommitIdentity}) can
 * never diverge. Given an origin `host` (or null when there's no remote / it didn't parse) and a commit
 * `email` (or null), returns a non-blocking advisory when the identity is wrong for the host:
 *  - self-hosted origin carrying a `@users.noreply.github.com` identity → unroutable there; OR
 *  - GitHub origin carrying a real (non-noreply) address → a leakable email is being published.
 * Otherwise (no host, no email, or an appropriate pairing) returns undefined — never a throw.
 */
export function commitIdentityHostWarning(host: string | null, email: string | null): string | undefined {
  if (!host || !email) return undefined;
  const e = email.trim().toLowerCase();
  if (!e) return undefined;
  const github = isGithubHost(host);
  const noreply = e.endsWith(GITHUB_NOREPLY_SUFFIX);
  if (!github && noreply) {
    return `Commit identity ${e} is a GitHub noreply address, but origin (${host}) is self-hosted — this email is unroutable there. Consider a real identity for this remote.`;
  }
  if (github && !noreply) {
    return `Commit identity ${e} is a real address being published to GitHub (${host}) — consider a @users.noreply.github.com identity to avoid leaking it.`;
  }
  return undefined;
}

/**
 * Bounded, non-interactive git WRITE operations for the project repo. Each method returns a structured
 * {@link GitWriteResult} (never throws for an expected git failure) and is wrapped in {@link withTimeout}
 * so a wedged child can't hang the daemon.
 *
 * Commit identity (project convention): plain commit using whatever the repo is configured with — NO
 * `-c user.email/user.name` overrides, NO Co-Authored-By trailer, no personal identity injected. The UI
 * supplies only a commit message.
 */
export class GitWriter {
  private repoPath: string;
  private readonly localMs: number;
  private readonly pushMs: number;
  private readonly gitFactory: NonNullable<GitWriterDeps["gitFactory"]>;
  /** The RAW injected test seam (undefined on every real/production caller) — kept separate from
   *  {@link gitFactory} (always defined, defaulting to a real `boundedSimpleGit`) so {@link
   *  killableGitFactory} can tell "a test injected a fake git" apart from "this is the real production
   *  path", which must go through `killableCanonicalRaw`'s own real tree-kill, never a fake's `.raw()`. */
  private readonly testGitFactory: GitWriterDeps["gitFactory"];
  /**
   * `opts` (the gateway passes the resolved `platform.timeouts.gitLocalMs`/`gitPushMs`) override the
   * module-const defaults; absent → the consts (today's behavior, e.g. the 1-arg test constructor).
   * Each is FLOORED to GIT_TIMEOUT_FLOOR_MS so a sub-second misconfig can't make every git write fail-fast.
   * `gitFactory` ({@link GitWriterDeps}) is the TEST seam — real callers never pass it.
   */
  constructor(repoPath: string, opts?: { gitLocalMs?: number; gitPushMs?: number } & GitWriterDeps) {
    this.repoPath = repoPath;
    this.localMs = Math.max(GIT_TIMEOUT_FLOOR_MS, opts?.gitLocalMs ?? GIT_LOCAL_TIMEOUT_MS);
    this.pushMs = Math.max(GIT_TIMEOUT_FLOOR_MS, opts?.gitPushMs ?? GIT_PUSH_TIMEOUT_MS);
    this.testGitFactory = opts?.gitFactory;
    this.gitFactory = opts?.gitFactory ?? ((p, ms, env) => boundedSimpleGit(p, ms, env));
  }

  /** A simpleGit bound to this repo with a kill-the-hung-child block timeout + the non-interactive env.
   *  NETWORK-CAPABLE (push() is the one caller that needs GIT_ASKPASS left blocked) — see {@link gitLocal}
   *  for the sibling used by every LOCAL-only write (checkout/createBranch/commit). */
  private git(blockMs: number): WriterGit {
    return this.gitFactory(this.repoPath, blockMs, nonInteractiveEnv());
  }

  /** @decision a746a3eb — the LOCAL-only sibling of {@link git}: same bound instance, but with the
   *  transport env family (GIT_ASKPASS/...) stripped rather than left blocked, since none of its callers
   *  ever reach a remote. Never call this from push() or identityWarning() — see {@link git}'s own doc. */
  private gitLocal(blockMs: number): WriterGit {
    return this.gitFactory(this.repoPath, blockMs, localNonInteractiveEnv());
  }

  /**
   * Refuse a write whose RAW `this.repoPath`, OR whose git-resolved TOPLEVEL, is Loom's own operational
   * home dir (`LOOM_HOME`) or an ancestor of it — checked BEFORE any mutating git call, from every write
   * method below (checkout/createBranch/commit/push). The raw-path check alone misses a non-git
   * DESCENDANT of `LOOM_HOME` (e.g. a vault-only project home nested under it): git itself walks up from
   * `this.repoPath` to find the nearest `.git`, so such a descendant's `add -A`/commit lands in
   * `LOOM_HOME`'s own repo — this guard resolves that SAME toplevel via `git rev-parse --show-toplevel`
   * (the writer's own bounded git runner) and checks it too. PATH RELATION ONLY
   * ({@link isLoomHomeOrAncestor}) — never `isOperationalVaultDir`'s content sniff, which would wrongly
   * refuse an ordinary code repo that happens to have its own top-level `worktrees/` folder.
   *
   * The toplevel probe is FAIL-CLOSED (round 3): only an AFFIRMATIVE "not a git repository" result falls
   * through to let the real op below fail on its own terms — that is the one case that actually proves
   * there's no toplevel to check. Any OTHER probe failure (a timeout, a killed child, an unexpected git
   * error) refuses instead of falling through; a retryable refusal beats risking a write into `LOOM_HOME`
   * because the probe itself happened to be slow or flaky under host load. The raw-path check, by
   * contrast, always runs regardless of the probe's outcome.
   *
   * The toplevel-probe half is {@link resolveOperationalHomeToplevelRefusal} (factored out so a
   * pre-propose caller can reuse it); this method is that function plus the raw-path check.
   *
   * @decision f9360c84 (round 2 owns this invariant HERE, not at each caller; round 3 made the probe
   * fail-closed) — see that decision record.
   */
  private async refuseIfOperationalHome(): Promise<{ ok: false; error: string } | null> {
    if (isLoomHomeOrAncestor(this.repoPath)) {
      return { ok: false, error: OPERATIONAL_HOME_GIT_WRITE_ERROR };
    }
    return resolveOperationalHomeToplevelRefusal(this.repoPath, this.localMs, this.gitFactory);
  }

  /**
   * Adapts {@link testGitFactory} (if a test injected one) to the narrower shape
   * `killableCanonicalRaw` itself expects. Returns `undefined` on the real production path, so
   * `killableCanonicalRaw` spawns a REAL, tree-killable child instead of reusing a test fake that has
   * nothing real to kill.
   *
   * @decision a746a3eb — every caller of this is a LOCAL-only mutation (checkout/checkout-b/add-A/commit),
   * so it uses `localNonInteractiveEnv()`, never `nonInteractiveEnv()`.
   */
  private killableGitFactory(): ((repoPath: string, blockTimeoutMs: number) => Pick<SimpleGit, "raw">) | undefined {
    const tf = this.testGitFactory;
    if (!tf) return undefined;
    return (repoPath, blockMs) => tf(repoPath, blockMs, localNonInteractiveEnv());
  }

  /**
   * Hold the vault auto-commit pause lease for the duration of one git-surgery op on `this.repoPath`.
   * @decision 614dfbef — advisory only: this stops `VaultVersioner`'s own commit tick, nothing else is
   * blocked from touching the repo; always resumed in `finally` so a lease never outlives this call.
   * @decision 237d1899 — the per-op token makes a resume "mine-only" under overlap: never resume a
   * lease by its bare presence — a DIFFERENT still-running op may have re-paused it with a new token.
   * @decision 6e6b342d — `checkout`/`createBranch`/`commit` must call this from INSIDE their own
   * `withCanonicalIndexLock` callback, never before the lock; `push()` has no lock to be inside of and
   * keeps calling this standalone.
   */
  private async withVaultPauseLease<T>(fn: () => Promise<T>): Promise<T> {
    const pauseToken = pauseVaultAutoCommit(this.repoPath);
    try {
      return await fn();
    } finally {
      resumeVaultAutoCommit(this.repoPath, pauseToken);
    }
  }

  /**
   * Switch to an EXISTING local branch. Fails (structured) on an unknown branch or a dirty tree that
   * would be overwritten — git's own message is surfaced for the UI.
   *
   * **Admitted through {@link withCanonicalIndexLock} (card e41dbb58):** a checkout mutates the SAME
   * canonical working tree/index `mergeBranchLocked` (git/worktrees.ts) squash-merges against — without
   * this, a checkout interleaved mid-merge could switch branches out from under an in-progress squash, or
   * itself get silently clobbered by one. See that lock's own doc for the full corruption history and why
   * this is safe from deadlock (this method never runs while a merge already holds the lock, because
   * nothing on the merge path calls into `GitWriter`).
   *
   * `opts.precondition` (card 4fabafd1, round 2 of the Code Review): an OPTIONAL check run INSIDE the
   * lock, AFTER it is acquired, immediately BEFORE the real `git checkout` spawns — the one place a
   * caller's own live-state refusal checks can run atomically with the mutation they're protecting,
   * closing the TOCTOU window a courtesy pre-check taken before this call can only narrow. A refusal
   * (`{ok:false,error}`) aborts before `git checkout` ever runs — nothing is touched. Every existing
   * caller omits it and is byte-identical. `branch`+`sha` on success are both read inside the SAME lock,
   * right after the checkout itself, so a caller needing the landed sha (not just the branch name) never
   * has to re-read it outside the lock in a second, separately-racy step.
   */
  async checkout(branch: string, opts?: { precondition?: () => Promise<{ ok: true } | { ok: false; error: string }> }): Promise<GitWriteResult<{ branch: string; sha: string | null }>> {
    if (!branch?.trim()) return { ok: false, error: "branch name required" };
    const target = branch.trim();
    // @decision 59e53710 — the no-legitimate-use subset (leading "-", "@{") is enforced HERE, for every
    // caller of this method, not just project_checkout_branch (which runs the wider unsafeBranchNameReason
    // before ever constructing a GitWriter).
    const shapeReason = unsafeBranchNameShapeReason(target);
    if (shapeReason) return { ok: false, error: shapeReason };
    const homeRefusal = await this.refuseIfOperationalHome();
    if (homeRefusal) return homeRefusal;
    // @decision 24c0bdba (round 6) — the try/catch wraps the WHOLE withCanonicalIndexLock(...) call, not
    // just the callback passed to it: a quarantine refusal (RepoQuarantinedError) is thrown by the lock
    // itself BEFORE that callback ever runs, so a try/catch nested inside it would never see it.
    try {
      return await withCanonicalIndexLock(this.repoPath, () =>
        this.withVaultPauseLease(async () => {
          if (opts?.precondition) {
            const pre = await opts.precondition();
            if (!pre.ok) return pre;
          }
          const git = this.gitLocal(this.localMs);
          // @decision 59e53710 — verify target is an existing local branch via `for-each-ref`, never
          // `branchLocal().all` (round 3: a detached HEAD's pseudo-entry can false-match) or
          // `raw(["show-ref",...])` (unrejected). See the decision record for the full repro.
          const refsRaw = await withTimeout(
            git.raw(["for-each-ref", "--format=%(refname)", "refs/heads/"]),
            this.localMs,
            "git for-each-ref (existence check)",
          );
          const localRefs = new Set((refsRaw ?? "").split("\n").map((line) => line.trim()).filter(Boolean));
          if (!localRefs.has(`refs/heads/${target}`)) {
            return { ok: false, error: `"${target}" is not an existing local branch — checkout only switches to an EXISTING branch` };
          }
          // @decision d8bb2074 — kill-confirmed (killableCanonicalRaw), not a bare withTimeout race: an
          // orphaned checkout child must never survive past the lock releasing, and the repo is re-checked
          // for quarantine immediately before spawning.
          let raisedToken: string | undefined;
          const onTreeDeathSettled = (confirmed: boolean): void => {
            if (confirmed && raisedToken) clearMergeQuarantineByToken(this.repoPath, raisedToken);
          };
          try {
            // @decision 2a6a292a round 10 — `--no-guess` disables git's own DWIM (a plain checkout of a
            // non-existent local name silently tracking a same-named remote ref); verified safe/additive
            // for every caller. See the decision record's round-10 section for the full repro + proof.
            // @decision 59e53710 — trailing "--" marks end-of-revision: if target somehow isn't a real
            // ref despite the exists-check above (a check/use race), git hard-fails "invalid reference"
            // instead of silently falling back to pathspec-restore mode (measured, real git: a dirty
            // tracked file named identically to `target` is left byte-unchanged on that failure).
            await killableCanonicalRaw(this.repoPath, ["checkout", "--no-guess", target, "--"], this.localMs, "git checkout", this.killableGitFactory(), localNonInteractiveEnv(), onTreeDeathSettled);
          } catch (e) {
            if (treeDeathUnconfirmed(e)) {
              raisedToken = enterMergeQuarantine(this.repoPath, target, unconfirmedKillReason(`git checkout could not be confirmed dead after a kill: ${(e as Error).message}`));
            }
            throw e;
          }
          const current = (await withTimeout(git.branchLocal(), this.localMs, "git branch")).current;
          // @decision 2a6a292a round 6 (N1) — the checkout itself already happened above; a timeout/
          // error reading its sha must never surface as ok:false for a mutation that succeeded. Every
          // existing caller already treats `sha` as informational, so `null` is a safe, additive widening.
          let sha: string | null;
          try { sha = (await withTimeout(git.revparse(["HEAD"]), this.localMs, "git rev-parse HEAD")).trim(); }
          catch { sha = null; }
          return { ok: true, branch: current, sha };
        }),
        // @decision 62c4953a (round 2 scope) — opts in: checkout writes the canonical index.
        { checkIndexLock: true },
      );
    } catch (e) {
      return { ok: false, error: gitError(e) };
    }
  }

  /**
   * Create a NEW local branch off the current HEAD and switch to it (`checkout -b`). Fails (structured)
   * if the branch already exists or the name is invalid. Does NOT touch any remote.
   *
   * **Admitted through {@link withCanonicalIndexLock} (card e41dbb58):** `checkout -b` moves canonical
   * HEAD to a brand-new branch ref pointing at the SAME commit — git raises no conflict even with a
   * staged-but-uncommitted diff sitting in the index (verified directly: `git checkout -b` carries staged
   * content forward onto the new branch unchanged). If this landed mid-merge — after `mergeBranchLocked`
   * (git/worktrees.ts) has staged its squash but before its own `git commit` runs — the squash would
   * commit onto the FRESHLY-CREATED branch instead of the mainline: the mainline branch silently never
   * receives the work, while `mergeBranchLocked` still reads `git rev-parse HEAD` and reports
   * `{ok:true, sha, subject}` — a false success pointing at a sha that isn't even reachable from the
   * branch it thinks it merged onto. Same corruption family as `commit()`/`checkout()` above.
   */
  /**
   * `opts.startPoint` (card 4fabafd1 round 6) — branch off this EXACT sha/ref instead of current HEAD
   * (`checkout -b <name> <startPoint>`); every pre-existing caller omits it and keeps branching off HEAD,
   * byte-identical. `opts.precondition` mirrors {@link checkout}'s own: an optional check run INSIDE the
   * lock, immediately before the real `git checkout -b` spawns — its success value may now ALSO carry a
   * `startPoint` (card 4fabafd1 round 7, n2), which OVERRIDES `opts.startPoint` for the actual spawn: a
   * caller branching off a value it reads AGAIN inside the lock (e.g. a watermark that could move between
   * the outer courtesy read and lock admission) must spawn against the freshest read, not the stale one.
   */
  async createBranch(name: string, opts?: { startPoint?: string; precondition?: () => Promise<{ ok: true; startPoint?: string } | { ok: false; error: string }> }): Promise<GitWriteResult<{ branch: string }>> {
    if (!name?.trim()) return { ok: false, error: "branch name required" };
    const target = name.trim();
    // @decision 59e53710 — see checkout()'s identical comment above: enforced here too, so EVERY caller
    // of createBranch (not just project_checkout_branch's create:true) refuses these two shapes.
    const shapeReason = unsafeBranchNameShapeReason(target);
    if (shapeReason) return { ok: false, error: shapeReason };
    const homeRefusal = await this.refuseIfOperationalHome();
    if (homeRefusal) return homeRefusal;
    // @decision 24c0bdba (round 6) — see checkout()'s identical comment above: the try/catch must wrap
    // the WHOLE withCanonicalIndexLock(...) call, not just its callback.
    try {
      return await withCanonicalIndexLock(this.repoPath, () =>
        this.withVaultPauseLease(async () => {
          let startPoint = opts?.startPoint;
          if (opts?.precondition) {
            const pre = await opts.precondition();
            if (!pre.ok) return pre;
            if (pre.startPoint) startPoint = pre.startPoint;
          }
          // @decision d8bb2074 — same kill-confirm + per-call re-check treatment as checkout() above.
          let raisedToken: string | undefined;
          const onTreeDeathSettled = (confirmed: boolean): void => {
            if (confirmed && raisedToken) clearMergeQuarantineByToken(this.repoPath, raisedToken);
          };
          const args = startPoint ? ["checkout", "-b", target, startPoint] : ["checkout", "-b", target];
          try {
            await killableCanonicalRaw(this.repoPath, args, this.localMs, "git checkout -b", this.killableGitFactory(), localNonInteractiveEnv(), onTreeDeathSettled);
          } catch (e) {
            if (treeDeathUnconfirmed(e)) {
              raisedToken = enterMergeQuarantine(this.repoPath, target, unconfirmedKillReason(`git checkout -b could not be confirmed dead after a kill: ${(e as Error).message}`));
            }
            throw e;
          }
          return { ok: true, branch: target };
        }),
        // @decision 62c4953a (round 2 scope) — opts in: moving canonical HEAD mid-flight would divert an
        // external git commit onto this new branch (checkout -b itself does NOT race a staged diff — see
        // this method's own doc above for the full rationale).
        { checkIndexLock: true },
      );
    } catch (e) {
      return { ok: false, error: gitError(e) };
    }
  }

  /**
   * Stage ALL changes (`add -A`) and commit with the UI-supplied message. Returns the new commit hash.
   * A clean tree is an EXPECTED no-op failure ("nothing to commit") — surfaced, not thrown. Identity is
   * the repo's configured user (no overrides, no trailer).
   *
   * @decision 237d1899 — oversized-staged-file handling: WARN, never refuse or silently unstage (unlike
   * `commitVault`'s fully-automatic path) — this call is a deliberate human/agent act on the code repo.
   *
   * `opts.maxFileBytes` overrides the shared default — a TEST seam only (mirrors `commitVault`'s own
   * `opts.maxFileBytes`: writing a real ~95MB fixture per test run would be slow and wasteful). Every
   * real caller omits it and gets {@link DEFAULT_MAX_VAULT_FILE_BYTES}.
   *
   * @decision e41dbb58 — admitted through {@link withCanonicalIndexLock}, so this never races an
   * in-progress squash-merge or createBranch/checkout landing under the wrong message or branch.
   */
  async commit(
    message: string,
    opts?: { maxFileBytes?: number; paths?: string[] },
  ): Promise<GitWriteResult<{ hash: string; warning?: string; residue?: string[] }>> {
    if (!message?.trim()) return { ok: false, error: "commit message required" };
    // Card c77dda7d: `paths` narrows the commit to exactly those repo-relative paths (add -A -- <paths> +
    // commit -- <paths>), so an unrelated untracked file in the checkout is never swept in. Validated as
    // plain repo-relative pathspecs: no absolute/drive paths, no `..`, nothing option-shaped.
    const paths = opts?.paths;
    if (paths !== undefined) {
      if (paths.length === 0) return { ok: false, error: "paths must be non-empty when provided" };
      const bad = paths.find((p) => !p.trim() || path.isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.startsWith("-") || p.split(/[\\/]/).includes(".."));
      if (bad !== undefined) return { ok: false, error: `invalid path "${bad}" — paths must be non-empty repo-relative paths with no "..", no absolute path, and no leading "-"` };
    }
    const maxFileBytes = opts?.maxFileBytes ?? DEFAULT_MAX_VAULT_FILE_BYTES;
    const { message: cleanedMessage, stripped } = stripClaudeSessionTrailer(message);
    // Re-check emptiness AFTER the strip — a message consisting of nothing but a Claude-Session trailer
    // passes the guard above but strips to "", which would otherwise reach `git.commit("")` and fail with
    // git's own "Aborting commit due to empty commit message" instead of this writer's clean, structured
    // "commit message required" — same shape as the original guard, just evaluated on what will actually
    // be committed.
    if (!cleanedMessage.trim()) return { ok: false, error: "commit message required" };
    const homeRefusal = await this.refuseIfOperationalHome();
    if (homeRefusal) return homeRefusal;
    // @decision 24c0bdba (round 6) — see checkout()'s identical comment above: the try/catch must wrap
    // the WHOLE withCanonicalIndexLock(...) call, not just its callback.
    try {
      return await withCanonicalIndexLock(this.repoPath, () =>
        this.withVaultPauseLease(async () => {
          const git = this.gitLocal(this.localMs);
          // Nothing staged AND nothing to stage → don't even attempt the commit (git would exit 1).
          const status = await withTimeout(git.status(), this.localMs, "git status");
          if (status.isClean()) return { ok: false, error: "nothing to commit (working tree clean)" };
          // @decision 8d49c36c — captured BEFORE this call's own `add -A` runs: names anything already
          // staged (e.g. an escaped descendant's orphaned residue from an earlier unconfirmed kill) that
          // `add -A` is about to sweep in as if it were part of what the caller asked to commit.
          const residue = await this.preExistingResidue(git, paths);
          // @decision d8bb2074 — `add -A` and `commit` both kill-confirmed (killableCanonicalRaw), each
          // re-checking quarantine immediately before it spawns: an UNLOCKED batch assembly elsewhere can
          // quarantine this repo between the two calls even though this whole sequence holds the lock.
          let raisedToken: string | undefined;
          const onTreeDeathSettled = (confirmed: boolean): void => {
            if (confirmed && raisedToken) clearMergeQuarantineByToken(this.repoPath, raisedToken);
          };
          const quarantineOnUnconfirmedKill = (e: unknown, label: string): void => {
            if (treeDeathUnconfirmed(e)) {
              raisedToken = enterMergeQuarantine(this.repoPath, "(GitWriter commit)", unconfirmedKillReason(`${label} could not be confirmed dead after a kill: ${(e as Error).message}`));
            }
          };
          try {
            await killableCanonicalRaw(this.repoPath, paths ? ["add", "-A", "--", ...paths] : ["add", "-A"], this.localMs, "git add -A", this.killableGitFactory(), localNonInteractiveEnv(), onTreeDeathSettled);
          } catch (e) {
            quarantineOnUnconfirmedKill(e, "git add -A");
            throw e;
          }
          const staged = await withTimeout(git.status(), this.localMs, "git status (post-add)");
          const oversizedWarning = this.oversizedStagedWarning(staged.files, maxFileBytes);
          // With `paths`, `git commit -m <message> -- <paths>` (no simple-git parser involved any more —
          // the hash below is always read back via `rev-parse HEAD`) commits just those paths even if
          // something else was already staged; without, the whole index as before. `--` matches `add`'s
          // own pathspec separator above (code review of a8dbb159: paths are already validated against a
          // leading `-`, so this is defense-in-depth, not a correctness fix).
          try {
            await killableCanonicalRaw(this.repoPath, ["commit", "-m", cleanedMessage.trim(), ...(paths ? ["--", ...paths] : [])], this.localMs, "git commit", this.killableGitFactory(), localNonInteractiveEnv(), onTreeDeathSettled);
          } catch (e) {
            quarantineOnUnconfirmedKill(e, "git commit");
            throw e;
          }
          const hash = (await withTimeout(git.revparse(["HEAD"]), this.localMs, "git rev-parse HEAD")).trim();
          const strippedWarning = stripped
            ? "Removed a Claude-Session: trailer from the commit message — this project's mainline commits don't carry harness attribution."
            : undefined;
          const residueWarning = residue.length
            ? `${residue.length} file(s) were already staged before this commit — not necessarily part of what you asked to commit: ${residue.join(", ")}.`
            : undefined;
          const warning = [oversizedWarning, strippedWarning, residueWarning].filter((w): w is string => !!w).join(" ") || undefined;
          return {
            ok: true, hash,
            ...(warning ? { warning } : {}),
            ...(residue.length ? { residue } : {}),
          };
        }),
        // @decision 62c4953a (round 2 scope) — opts in: add -A + commit write the canonical index.
        { checkIndexLock: true },
      );
    } catch (e) {
      return { ok: false, error: gitError(e) };
    }
  }

  /** Paths that were ALREADY staged before `commit()`'s own `add -A` call runs — content `add -A` is about
   *  to sweep in that the caller never explicitly asked for. Scoped to `paths` when given via a REAL
   *  `git diff --cached --name-only -- <paths>` pathspec match (unscoped, every already-staged file
   *  counts) — never a hand-rolled prefix compare, which disagrees with git's own pathspec semantics (a
   *  trailing slash, a leading `./`, or a glob like `*.md` all scope differently under git than under a
   *  naive `startsWith`; card 8d49c36c review). */
  private async preExistingResidue(git: WriterGit, paths?: string[]): Promise<string[]> {
    const out = await withTimeout(
      git.raw(["diff", "--cached", "--name-only", ...(paths ? ["--", ...paths] : [])]),
      this.localMs,
      "git diff --cached --name-only (pre-existing residue)",
    );
    return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  }

  /** A human-readable warning naming any staged (non-deletion) file over `maxFileBytes`, or `undefined`
   *  if none — see {@link commit}'s doc for why this path warns instead of unstaging. */
  private oversizedStagedWarning(
    files: Array<{ path: string; working_dir: string; index: string }>,
    maxFileBytes: number,
  ): string | undefined {
    const oversized: string[] = [];
    for (const f of files) {
      if (f.working_dir === "D" || f.index === "D") continue; // deletion — nothing to stat
      let size: number;
      try { size = fs.statSync(path.join(this.repoPath, f.path)).size; } catch { continue; }
      if (size > maxFileBytes) oversized.push(`${f.path} (${humanBytes(size)})`);
    }
    if (!oversized.length) return undefined;
    return `Staged file(s) exceed ${humanBytes(maxFileBytes)}: ${oversized.join(", ")} — ` +
      `this may be rejected by a remote with an object-size limit (e.g. GitHub's 100MB hard cap).`;
  }

  /**
   * Push the current branch to its remote. A plain `git push` is tried first (respecting whatever
   * tracking remote the branch already has). If that fails ONLY because the branch has no upstream —
   * the case for a branch just made with the UI "+ Branch" button — we publish it with
   * `git push -u origin <branch>`, setting tracking to origin/<branch>. Any OTHER push failure
   * (unreachable remote, auth required, rejected) is surfaced unchanged — we never retry past a real
   * remote error. Non-interactive + bounded throughout: a push to an unreachable/auth-required remote
   * FAILS FAST (GIT_TERMINAL_PROMPT=0 + the timeout) rather than hanging the daemon — the set-upstream
   * retry runs under the same guards.
   *
   * On success we ALSO surface a non-blocking {@link identityWarning} (commit-identity vs. remote-host
   * mismatch) so the human who just published sees if their email is wrong for this remote. It never
   * blocks the push and a detection failure is silently swallowed — see {@link identityWarning}.
   *
   * @decision 614dfbef — durably records the outcome via `recordGitPushOutcome`, on success AND
   * failure — never skip it; surfacing a rejected remote durably is the origin finding this closes.
   */
  async push(): Promise<GitWriteResult<{ branch: string; warning?: string }>> {
    const homeRefusal = await this.refuseIfOperationalHome();
    if (homeRefusal) return homeRefusal;
    return this.withVaultPauseLease(async () => {
      try {
        const git = this.git(this.pushMs);
        // Wrapped for the same reason as checkout()/commit()'s branchLocal()/revparse() calls (card
        // 40a264d3): `block` only bounds a SILENT child, not a slow-but-talking one. Lower consequence
        // here than those two — this call sits OUTSIDE withCanonicalIndexLock, so an unsettling promise
        // would hang only this request, never wedge the shared per-repo lock queue — but it's the same
        // defect class on the same trust-boundary surface, and wrapping it costs nothing.
        const branch = (await withTimeout(git.branchLocal(), this.pushMs, "git branch")).current;
        try {
          await withTimeout(git.raw(["push"]), this.pushMs, "git push");
        } catch (e) {
          if (!isNoUpstreamError(e)) throw e;
          await withTimeout(
            git.raw(["push", "-u", "origin", branch]),
            this.pushMs,
            "git push -u origin",
          );
        }
        recordGitPushOutcome(this.repoPath, { ok: true });
        const warning = await this.identityWarning(git);
        return warning ? { ok: true, branch, warning } : { ok: true, branch };
      } catch (e) {
        const error = gitError(e);
        recordGitPushOutcome(this.repoPath, { ok: false, error });
        return { ok: false, error };
      }
    });
  }

  /**
   * Heuristic, NO hardcoded owner email: compare the remote HOST (`git remote get-url origin`) against
   * the email on HEAD (the identity actually being published) and warn on a mismatch —
   *  - self-hosted origin (non-GitHub) carrying a `@users.noreply.github.com` identity → the email is
   *    unroutable on that forge; OR
   *  - GitHub origin carrying a real (non-noreply) address → a leakable email is being published.
   * FAIL-SAFE BY CONSTRUCTION: any detection error (no origin, no commits, parse miss) returns
   * `undefined` — never a throw, never blocks the push. Bounded by the local-op timeout like every read here.
   */
  private async identityWarning(git: WriterGit): Promise<string | undefined> {
    try {
      const originUrl = (await withTimeout(git.raw(["remote", "get-url", "origin"]), this.localMs, "git remote get-url")).trim();
      const host = originHost(originUrl);
      if (!host) return undefined;
      const email = (await withTimeout(git.raw(["log", "-1", "--pretty=%ae"]), this.localMs, "git log identity")).trim().toLowerCase();
      if (!email) return undefined;
      return commitIdentityHostWarning(host, email);
    } catch {
      return undefined; // detection must NEVER block or fail the push
    }
  }

  /**
   * Read-only preview of what a `push()` call would publish — the current branch, how many local
   * commits sit ahead of its upstream tracking ref (null if unresolvable, e.g. no upstream configured
   * yet — a first push), and the SUBJECT (first line only) of the most recent commit. Built for a
   * confirm-prompt's BOUNDED disclosure (the companion `git-push` lever): a vault repo can sit hundreds
   * of commits ahead of its remote, so a caller shows "N ahead, latest: …", never a full log dump.
   * NEVER throws — returns `null` on any read failure (no repo, no commits, git error), mirroring
   * `identityWarning`'s own fail-safe posture; a caller degrades to a generic confirm text rather than
   * blocking on preview detail. Read-only + bounded like `vault/versioner.ts`'s `checkVaultPushStatus`
   * (the analogous helper for a project's vault repo) — this is the project CODE repo's own version.
   */
  async pendingPushSummary(): Promise<{ branch: string; ahead: number | null; latestSubject: string | null } | null> {
    try {
      // @decision a746a3eb — gitLocal(), not git(): this is a read-only preview, never a push.
      const git = this.gitLocal(this.localMs);
      const branch = (await withTimeout(git.branchLocal(), this.localMs, "git branch")).current;
      if (!branch) return null;
      let ahead: number | null = null;
      try {
        const upstream = (await withTimeout(
          git.raw(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]), this.localMs, "git rev-parse @{u}",
        )).trim();
        if (upstream) {
          const count = parseInt(
            (await withTimeout(git.raw(["rev-list", "--count", `${upstream}..HEAD`]), this.localMs, "git rev-list --count")).trim(), 10,
          );
          if (Number.isFinite(count)) ahead = count;
        }
      } catch { /* no upstream configured yet (a first push) — ahead stays null, still a valid summary */ }
      let latestSubject: string | null = null;
      try {
        latestSubject = (await withTimeout(git.raw(["log", "-1", "--pretty=%s"]), this.localMs, "git log subject")).trim() || null;
      } catch { /* no commits yet */ }
      return { branch, ahead, latestSubject };
    } catch {
      return null;
    }
  }
}
