import fs from "node:fs";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import chokidar, { type FSWatcher } from "chokidar";
import { simpleGit, type SimpleGit } from "simple-git";
import type { Db } from "../db.js";
import { LOOM_HOME } from "../paths.js";

/** Generic, non-personal identity used ONLY when the host has no git identity configured at all. */
const FALLBACK_GIT_IDENTITY = { name: "Loom", email: "loom@localhost" } as const;

/**
 * Default oversized-file threshold for auto-commit (card 614dfbef, origin finding 4ae8a3c9): a vault was
 * observed committing >100MB blobs (two ~2.7GB) via `loom: auto-commit`, permanently wedging the vault's
 * GitHub backup (GitHub hard-rejects any push containing a >100MB object). 95MB leaves headroom below
 * that hard limit for git's own object-format overhead. Overridable via `commitVault`'s `opts.maxFileBytes`
 * (tests use a tiny value — writing a real 95MB fixture file per test run would be slow and wasteful).
 *
 * Exported so `git/writer.ts` can size its OWN staged-file warning (finding 2 of card 237d1899) off the
 * SAME number rather than a second hardcoded copy — see that file's `commit()` for why the two paths
 * react differently (unstage-silently here vs. warn-not-refuse there) despite sharing this threshold.
 */
export const DEFAULT_MAX_VAULT_FILE_BYTES = 95 * 1024 * 1024;

export function humanBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Per-git-op ceiling for the three bounded call sites in this module (card 509716cc):
 * `resolveVaultRepoContext`'s checkIsRepo/revparse, `VaultVersioner.start()`'s checkIsRepo/init, and
 * `gitTrackedTopLevelNames`'s ls-files — all reachable from `startVaultVersioners`, which is AWAITED at
 * boot (index.ts, ahead of `sessions.resumeFleetOnBoot`). A hang on any of these previously blocked the
 * whole daemon's post-restart fleet resume, invisibly (HTTP stays up — `app.listen` runs earlier). Same
 * value + same convention as `GIT_OP_TIMEOUT_MS` (git/worktrees.ts) and `GIT_LOCAL_TIMEOUT_MS`
 * (git/writer.ts) — a local plumbing op is normally sub-second, this is generous headroom, but bounded
 * so a wedged child (a repo on a busy/locked disk) can't hang the caller forever.
 *
 * Not imported FROM those modules: neither exports its bounding helpers, and git/writer.ts already
 * imports FROM this module (`recordGitPushOutcome`, `pauseVaultAutoCommit`, …) — importing back would be
 * circular. git/writer.ts itself already carries its own independent copy of the identical
 * block-timeout + race pattern rather than importing git/worktrees.ts's, so this module doing the same
 * is the established convention, not a new mechanism.
 */
const VAULT_GIT_OP_TIMEOUT_MS = 15_000;

/**
 * Ceiling for `VaultVersioner.flushSync()`'s two WORKING-TREE-SCALE `execSync` calls (`git add -A`, which
 * hashes every new/changed blob across the whole vault, and `git commit`, which runs the user's own
 * hooks — the actual named hang vector in card 816f0056 — plus writes tree objects). Deliberately much
 * larger than {@link VAULT_GIT_OP_TIMEOUT_MS}: the goal on this path is "no INFINITE hang", not "fail
 * fast" — flushSync's timeout throwing lands in its own best-effort `catch` and SILENTLY DROPS the
 * commit (now at least logged — see `flushSync`'s own doc), so a bound tight enough to fail a real,
 * still-progressing flush on a large or network-backed vault would trade a rare hang risk for a routine,
 * guaranteed data-loss failure. See `flushSync`'s own doc for why the THIRD call (`git status
 * --porcelain`, a cheap stat-based comparison) is bound by {@link VAULT_GIT_OP_TIMEOUT_MS} instead.
 *
 * **Sizing (card 816f0056 review round 2 — corrects an earlier, wrong appeal to convention): this is NOT
 * sized to match `git checkout`.** This repo's own `GIT_LOCAL_TIMEOUT_MS` (git/writer.ts) bounds
 * `checkout` at the SAME 15s as {@link VAULT_GIT_OP_TIMEOUT_MS} — citing it as precedent for "5 min is
 * generous" was backwards. The real basis: a cold `git add -A` over a 20k-file vault measured ~11.6s on
 * local NVMe ALONE — comfortably eating a 15s bound with zero margin left for a slower disk or a bigger
 * vault — so this needs to be in the same league as this codebase's OTHER genuinely-large working-tree
 * op, `git/worktrees.ts`'s `PROVISION_TIMEOUT_MS` (3 min, for a full dependency install into a fresh
 * worktree). 5 minutes sits comfortably above both.
 */
const VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS = 5 * 60_000;

/**
 * `maxBuffer` for all three of `flushSync`'s `execSync` calls (card 816f0056 review round 2, finding 1).
 * Node's 1 MiB default covers combined stdout+stderr, and `git add -A` emits ONE "LF will be replaced by
 * CRLF" warning line to stderr PER FILE when `core.autocrlf=true` — the Git-for-Windows installer
 * default. Measured with the exact options this file uses: 8,000 files OK; 12,000 files → ENOBUFS +
 * SIGTERM at 1,048,645 bytes of stderr → throws → the existing `catch` → a SILENTLY DROPPED commit on an
 * ORDINARY ~10k-note Obsidian vault — precisely the large-vault data-loss failure
 * {@link VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS} exists to prevent, just via a different option on the SAME
 * calls. `git status --porcelain`'s stdout was separately measured at ~290KB on a first-ever 20k-file
 * flush (~1 MiB at ~70k files), so it needs headroom too, not only the two working-tree calls. 100MB is
 * a one-shot allocation on a rare shutdown-only path — cheap insurance, not a resource concern.
 */
const VAULT_FLUSH_MAX_BUFFER_BYTES = 100 * 1024 * 1024;

/** Reject `p` after `ms` if it hasn't settled — same belt-and-suspenders race as git/worktrees.ts's and
 *  git/writer.ts's own `withTimeout`: the simpleGit `block` timeout (set on the instance below) also
 *  kills the hung child in production, but this guarantees the FUNCTION returns within the window
 *  regardless. Timer cleared on the winning path. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms (hung git child?)`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * The git method surface {@link boundedVaultGit} exposes: the plumbing methods this module's
 * OTHER bounded call sites use (`checkIsRepo`/`revparse`/`init`/`raw`) UNION the three working-tree
 * methods `commitVault` needs (`add`/`status`/`commit` — card 54b839c5). One shared Pick so
 * `commitVault` reuses the SAME bounding seam as every other call site in this file instead of a
 * second bounding mechanism.
 */
export type BoundedVaultGit = Pick<SimpleGit, "checkIsRepo" | "revparse" | "init" | "raw" | "add" | "status" | "commit">;

/**
 * Injectable seam mirroring git/worktrees.ts's `BoundedGitDeps` — lets a test simulate a hanging git
 * child with a tiny budget and assert a call returns within the window instead of hanging forever.
 * `gitFactory` defaults to a simpleGit whose `block` timeout kills a no-output (hung) child; `timeoutMs`
 * bounds both that block timeout and the {@link withTimeout} race. Real callers never pass this.
 */
export interface VaultGitDeps {
  gitFactory?: (repoPath: string, blockTimeoutMs: number) => BoundedVaultGit;
  timeoutMs?: number;
  /**
   * Test-only, `flushSync`-specific override for its `git add -A` call, INDEPENDENT of `timeoutMs` /
   * {@link flushCommitTimeoutMs} (card 816f0056 review round 2, finding 7 — `timeoutMs` alone collapses
   * BOTH working-tree calls onto one injected value, so a test could never tell "add and commit share a
   * timeout" apart from "they're bound independently", and a bug that swapped which production constant
   * backs which call would go undetected). Lets a test set a LARGE `add` bound alongside a TINY `commit`
   * bound (or vice versa) to prove the two are genuinely separate code paths. Falls back to `timeoutMs`,
   * then {@link VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS}, when unset — real callers never pass this.
   */
  flushAddTimeoutMs?: number;
  /** Test-only, `flushSync`-specific override for its `git commit` call — see {@link flushAddTimeoutMs}.
   *  Real callers never pass this. */
  flushCommitTimeoutMs?: number;
}

/**
 * **`GIT_TERMINAL_PROMPT=0` is DELIBERATELY NOT SET here — a finding, not an oversight (card 54b839c5).**
 * The obvious shape, `simpleGit(p, {...}).env({ ...process.env, GIT_TERMINAL_PROMPT: "0" })` (the SAME
 * shape `restart.ts`'s `defaultGitLogSince` uses), was tried and REVERTED after it broke two real things,
 * verified live rather than assumed:
 *  1. It throws outright the instant an ambient editor/pager var is set (`GitPluginError: Use of
 *     "GIT_EDITOR" is not permitted without enabling allowUnsafeEditor` — reproduced in the very shell
 *     this fix was developed in; this repo's own worker/session spawn recipe additionally sets
 *     `GIT_PAGER`/`PAGER` — see root CLAUDE.md). This alone is fixable by stripping that family, same as
 *     `git/writer.ts`'s `nonInteractiveEnv()` does — but:
 *  2. `simpleGit(...).env(obj)` REPLACES the instance's whole env with `obj` (verified against the
 *     installed package: `Git2.prototype.env` sets `this._executor.env = obj` outright, not a merge)
 *     — so `obj` must ALSO carry `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` whenever the CALLER has them set,
 *     to preserve a caller's legitimate config redirection. But simply having those two keys PRESENT in
 *     an explicitly-supplied `.env()` object trips simple-git's `blockUnsafeOperationsPlugin` too (a
 *     DIFFERENT category, `allowUnsafeConfigPaths` — the exact one `commitVault`'s own identity fallback,
 *     two sections below, already avoids reopening, via `-c` args instead of env, for the same reason).
 *     STRIPPING those two keys instead of passing them through is not a safe alternative either — verified
 *     live: `test/vault-write-tool.mjs`'s hermetic identity-fallback case (f1) sets
 *     `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` to nonexistent paths SPECIFICALLY so `commitVault` sees NO
 *     resolvable identity and exercises its Loom-fallback path; stripping those keys from the child's env
 *     instead lets git fall back to this HOST's real `~/.gitconfig` — this dev host has one configured
 *     (`git config --global user.name` → a real identity), which would make that test silently commit
 *     under the WRONG (real, non-fallback) identity instead of throwing — a worse failure than a loud
 *     crash, since it passes or fails depending on the runner's own host config rather than the code.
 *
 * Given neither path is safe, and `commitVault` performs NO network operation (no fetch/push/clone —
 * `checkIsRepo`/`revparse`/`init`/`add`/`status`/`commit` are all local), `GIT_TERMINAL_PROMPT` has no
 * live effect here regardless: it only governs git's OWN credential-prompt logic during HTTP(S) auth,
 * which this function can never trigger. The timeout bounding below (the actual, functionally load-bearing
 * fix for the hang this card is about) does not depend on `.env()` at all. `CLAUDE.md`'s "every git write
 * is bounded + non-interactive" invariant is satisfied here by the bound; the terminal-prompt half is
 * moot for a call sequence that never touches the network.
 */

/** Build the bounded git instance + resolve the timeout for one vault-versioner op, applying the seam's
 *  defaults. No `.env()` override (see the doc immediately above for why — card 54b839c5). */
function boundedVaultGit(
  repoPath: string,
  deps: VaultGitDeps,
): { git: BoundedVaultGit; timeoutMs: number } {
  const timeoutMs = deps.timeoutMs ?? VAULT_GIT_OP_TIMEOUT_MS;
  const makeGit = deps.gitFactory ?? ((p, ms) => simpleGit(p, { timeout: { block: ms } }));
  return { git: makeGit(repoPath, timeoutMs), timeoutMs };
}

/**
 * Card 39ceb732 (chokidar opens one OS handle per watched entry, no cap): CANDIDATE top-level entries a
 * repo's own root `.gitignore` lists — a bare, non-root-anchored name or `name/`, no wildcards, no
 * negation, no nested path (e.g. `_external/`). **These are CANDIDATES ONLY, not yet safe to exclude from
 * the watcher** — see {@link safeToExcludeNames}, which is the function that actually decides what to
 * exclude. `.gitignore` has NO effect on an already-TRACKED path (confirmed live: committing a file, then
 * adding its directory to `.gitignore`, then editing it — `git add .` still stages the edit, and
 * `git check-ignore` reports the tracked file as NOT ignored), so a name straight out of this function is
 * NOT provably safe to stop watching on its own; excluding one that turns out to have tracked content
 * under it would silently stop auto-committing edits to real, history-bearing files.
 *
 * Deliberately narrow, NOT full gitignore semantics: no negation (`!`), no glob syntax, no nested paths,
 * no ROOT-ANCHORED entries (a leading `/`, e.g. `/dist` — anchoring means "top-level only", which is
 * narrower than the any-depth match this module's `ignored` pattern makes, so honoring it correctly would
 * need a second, differently-anchored regex; simpler and safer to just leave it watched, matching the
 * "unknown pattern → leave alone" fail-safe below), no LEADING whitespace (git treats it as SIGNIFICANT —
 * a line like ` scratch/` does NOT ignore `scratch/`; `.trim()`ing it away used to generate a candidate git
 * never actually excludes — the one place this parser broke its own fail-safe doctrine, in the UNSAFE
 * direction, live-verified), no TRAILING whitespace after removing a directory-marker slash (git strips
 * unescaped trailing spaces but honors an escaped one — rather than replicate that, any leftover trailing
 * whitespace is treated as "not understood"), and no BACKSLASH (an escape sequence we don't interpret —
 * e.g. an escaped leading `#`/`!`, or an escaped trailing space — so we cannot know what the real pattern
 * means; leave it watched rather than guess). A pattern we don't understand is simply left alone — we keep
 * watching it (today's status quo) — so a false negative here only costs us the handles we already had; it
 * can never mis-translate into excluding something that WOULD have been committed. Best-effort: a
 * missing/unreadable `.gitignore` returns `[]`.
 *
 * **A `:`-leading line is NOT specially rejected here (card 687d2a47 finding 1) — see
 * {@link gitTrackedTopLevelNames}'s doc for why the fix lives at the git-query SINK instead.** A one-line
 * `if (lineRaw.startsWith(":")) continue;` here was considered (cheapest, matches this parser's own
 * "unknown → leave watched" doctrine) and rejected: finding 3 (below) independently forces
 * `gitTrackedTopLevelNames` to wrap every candidate in git pathspec magic anyway (`:(icase)`, to get
 * case-insensitive matching), and folding `,literal` into that SAME wrapper closes finding 1 for free, at
 * the one place that actually talks to git, with no separate parser rule to keep in sync. Prefer this
 * over a source-side skip that would become the odd one out once the sink already treats candidate text
 * as opaque literal data.
 *
 * **A `name/`-form line is git's DIRECTORY-ONLY pattern (card 687d2a47 finding 2), live-verified:** with
 * `.gitignore` = `thing/` and a top-level FILE named `thing`, `git check-ignore -v thing` exits 1 — NOT
 * ignored; only a same-named DIRECTORY is ignored by that pattern. This parser strips the trailing slash
 * unconditionally, and the exclusion regex built from the result (`buildIgnoredPattern`) matches a bare
 * file of that name too (its `([/\\]|$)` alternative), which would over-exclude a top-level, extension-less
 * FILE sharing a `name/` entry's name. Requiring `name` to CURRENTLY be a real directory on disk before
 * emitting the candidate closes the plain-file case, but "real directory" must be judged by
 * **`fs.lstatSync`, not `fs.statSync`** (round-4 review, live-verified on WSL Ubuntu 22.04/git 2.34.1,
 * Windows can't create the fixture): an UNTRACKED **symlink to a directory** is NOT ignored by a `name/`
 * pattern (`git check-ignore -v thing` exits 1 for `thing` → `realdir/`, vs. exit 0 for a real directory)
 * and `git add .` DOES stage it — but `fs.statSync` (which follows symlinks) reports it as a directory,
 * so a `statSync`-based check would emit the candidate anyway and over-exclude live, staged content.
 * `fs.lstatSync` (which does NOT follow symlinks) correctly reports the symlink as not-a-directory, so the
 * candidate is left un-generated for it — matching git's own real behavior. **Accepted, priced-out cost:**
 * a Windows **junction** IS ignored by git's `name/` pattern (behaves like a real directory to git) but
 * `lstatSync` also reports it as not-a-directory, so a junction's candidate is never generated either —
 * under-generating (leaves it watched, a few extra handles), never the reverse. Do not special-case
 * junctions back in to reclaim those handles; that reopens the exact symlink-to-dir over-generation this
 * fix closes, since Node's `fs` has no portable way to tell "junction" (git-ignorable) apart from "symlink
 * to dir" (NOT git-ignorable) without shelling out. A bare `name` line (no trailing slash) is unaffected —
 * git already matches it against both a file and a directory of that name, which is exactly what the
 * existing regex does.
 */
export function gitignoredTopLevelNames(repoRoot: string): string[] {
  let raw: string;
  try { raw = fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8"); }
  catch { return []; }
  const names: string[] = [];
  for (const lineRaw of raw.split(/\r?\n/)) {
    if (lineRaw === "" || /^\s/.test(lineRaw)) continue; // blank, or leading whitespace (significant to git) — leave watched
    if (lineRaw.startsWith("#") || lineRaw.startsWith("!")) continue;
    if (/[*?[\]\\]/.test(lineRaw)) continue; // glob syntax or a backslash escape we don't interpret — leave watched
    if (lineRaw.startsWith("/")) continue; // root-anchored — narrower semantics than we implement; leave watched
    const hasTrailingSlash = /\/$/.test(lineRaw);
    const stripped = lineRaw.replace(/\/$/, ""); // strip only a trailing directory-marker slash
    if (!stripped || stripped.includes("/") || /\s$/.test(stripped)) continue; // nested path or unhandled trailing whitespace — leave watched
    if (hasTrailingSlash) {
      // git's directory-only form — only a real, CURRENT directory qualifies (see doc above). lstatSync,
      // NOT statSync: a symlink-to-dir must NOT count as a directory here (git itself doesn't ignore one).
      let isDir = false;
      try { isDir = fs.lstatSync(path.join(repoRoot, stripped)).isDirectory(); } catch { /* leave watched */ }
      if (!isDir) continue;
    }
    names.push(stripped);
  }
  return names;
}

/**
 * Which of `candidates` (from {@link gitignoredTopLevelNames}) git ALREADY TRACKS — either an exact
 * tracked FILE of that name, or a tracked file somewhere under a same-named directory. ONE batched
 * `git ls-files` call covers every candidate (a single git invocation, not one per name).
 *
 * **No trailing slash on the pathspec — verified live this matters:** `git ls-files -- foo/` (trailing
 * slash) returns EMPTY for a tracked FILE literally named `foo` — a trailing slash restricts the pathspec
 * to matching WITHIN a directory, silently missing the exact-file case. `git ls-files -- foo` (bare)
 * correctly matches both the exact file AND anything under a `foo/` directory.
 *
 * **`-z` (NUL-separated), not newline-split — verified live this matters too:** `core.quotePath` defaults
 * TRUE, so plain `git ls-files` QUOTES any path containing non-ASCII (or `"`/`\`) as a backslash-escaped
 * octal string, e.g. a tracked `Café/note.md` prints as `"Caf\303\251/note.md"` — literal backslashes in
 * the output, which a naive newline+`/`-split shreds into garbage that doesn't match the real candidate
 * name at all (so the real, tracked `Café` directory was wrongly reported as UNTRACKED, and offered as
 * safe to exclude — a narrower-triggering recurrence of the exact same "tracked content silently loses
 * history" defect, and an ordinary personal-vault folder name, not an exotic input). `-z` sidesteps
 * quoting entirely (raw bytes, NUL-terminated) rather than merely disabling it — verified live to emit the
 * literal `Café/note.md` — so it's used INSTEAD OF `-c core.quotePath=false`, not just in addition to it:
 * no config override is applied to the shared `git` client, and there is nothing left to parse quoting out
 * of at all.
 *
 * Fails SAFE: any git error (a corrupt repo, git not on PATH, whatever) treats every candidate as tracked
 * — i.e. excludes NOTHING — rather than risk silently dropping history for a name we couldn't verify.
 * A call that exceeds `timeoutMs` (card 509716cc — this ls-files call previously had no bound at all)
 * lands in the exact same catch, the exact same way: a hung git child fails safe identically to any
 * other git error.
 *
 * **Each candidate is queried via `:(icase,literal)<name>` pathspec magic (card 687d2a47, findings 1 + 3).
 * `icase` is what actually closes BOTH findings; `literal` is additional, currently-unreachable
 * belt-and-braces — see finding 1 below for why it doesn't get sole credit:**
 *
 * - **Finding 3 — `core.ignorecase` (default TRUE on Windows, the owner's own platform, and macOS):**
 *   `.gitignore` matching honors it; plain `git ls-files` pathspec matching does NOT, live-verified —
 *   `.gitignore` = `Notes`, tracked `notes/b.md`: `git check-ignore -v notes/new.md` exits 0 (git DOES
 *   ignore it), but `git ls-files -z -- Notes` returns EMPTY (`git ls-files -z -- notes` finds it).
 *   **Also verified a scoped `git -c core.ignorecase=true ls-files -- Notes` still returns EMPTY** — the
 *   config knob does not reach pathspec matching at all, so a config override can't fix this; only pathspec
 *   magic can. `:(icase)Notes` DOES match `notes/b.md`, live-verified. A directory case-renamed on a
 *   case-insensitive filesystem — index holds `Notes/b.md`, disk shows `notes/`, `.gitignore` names it
 *   `notes` — would otherwise make this tracked-check MISS while the (itself case-sensitive) exclusion
 *   regex still matches the on-disk `notes` path, silently dropping history for tracked content. No exotic
 *   `.gitignore` line needed — an ordinary folder rename triggers it.
 * - **Finding 1 — `:`-leading candidate text:** without this wrapper, a candidate is fed to git as a bare
 *   pathspec, and any pathspec starting with `:` is git "magic" (`:!foo`, `:(exclude)foo`, …), not a
 *   literal name — live-verified: with `_external/a.md` tracked, `git ls-files -- _external ':!'` returns
 *   EMPTY (exit 0, no error) for the WHOLE batched call, because `:!` deselects everything. A `.gitignore`
 *   containing both `_external/` and `:!` would silently report the genuinely-tracked `_external` as
 *   untracked and offer it for exclusion — Critical-1's failure shape, a new trigger. **The long-form
 *   `:(icase)` wrapper alone is what actually closes this** — live-verified batched: `_external` and
 *   `Notes` (case-differing) both still resolve correctly with a bogus `:!` candidate present in the same
 *   call, with or without `,literal`, because each `:(...)`-wrapped pathspec's magic is scoped to that one
 *   pathspec, not the whole batch. `,literal` is kept anyway as unreachable belt-and-braces (round-4
 *   review, live-verified): it disables WILDCARD reinterpretation of the candidate text, but the parser
 *   already rejects any line containing `* ? [ ] \`, so no wildcard can ever reach this call — it cannot
 *   over-generate (git docs: `literal` only affects glob-vs-literal matching), so there is no cost to
 *   keeping it, but finding 1 itself is closed by `icase` alone.
 *
 * Lowercasing the returned first-segment names (paired with lowercasing the candidate at the
 * {@link safeToExcludeNames} comparison) is still needed ALONGSIDE `:(icase)`: icase makes the QUERY find
 * a case-differing tracked entry, but the returned path keeps its OWN on-disk casing (e.g. `notes/b.md`
 * for a `Notes` candidate) — the set-membership check still needs both sides folded to the same case. On a
 * case-SENSITIVE filesystem this can only ever mark MORE candidates "tracked" than an exact compare would
 * — i.e. leave MORE watched, never less — so it is strictly under-generating on every platform. A
 * `:`-leading candidate that fails to resolve to anything real (the overwhelmingly common case, since `:`
 * is not a legal filename character on Windows) simply isn't added to `tracked` — same under-generating
 * direction as every other branch here.
 */
async function gitTrackedTopLevelNames(
  git: Pick<SimpleGit, "raw">,
  candidates: string[],
  timeoutMs: number = VAULT_GIT_OP_TIMEOUT_MS,
): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();
  try {
    const pathspecs = candidates.map((c) => `:(icase,literal)${c}`);
    const out = await withTimeout(git.raw(["ls-files", "-z", "--", ...pathspecs]), timeoutMs, "git ls-files (vault safeToExcludeNames)");
    const tracked = new Set<string>();
    for (const rel of out.split("\0")) {
      if (!rel) continue;
      tracked.add((rel.split(/[\\/]/)[0] ?? rel).toLowerCase());
    }
    return tracked;
  } catch {
    return new Set(candidates.map((c) => c.toLowerCase()));
  }
}

/**
 * The names actually SAFE to exclude from the watcher for `commitPath`: its gitignored top-level
 * candidates ({@link gitignoredTopLevelNames}) MINUS any git already tracks ({@link gitTrackedTopLevelNames}
 * — a gitignored-but-tracked name must stay watched, since `commitVault`'s `git add .` would still stage
 * an edit to it and the watcher must still be able to see that edit happen). Read/computed ONCE, at
 * `start()` — like `commitPath`/`externallyManaged` elsewhere in this class, this does not react to a
 * LATER `.gitignore` edit or a file being un-tracked without a versioner restart (a daemon restart or vault
 * re-provision); accepted, consistent with the rest of this class's resolve-once-at-start design.
 *
 * `timeoutMs` (card 509716cc) bounds the underlying `git ls-files` call — see
 * {@link gitTrackedTopLevelNames}'s doc for the fail-safe behavior on timeout. Defaults to
 * {@link VAULT_GIT_OP_TIMEOUT_MS}; real callers never override it.
 */
export async function safeToExcludeNames(
  commitPath: string,
  git: Pick<SimpleGit, "raw">,
  timeoutMs: number = VAULT_GIT_OP_TIMEOUT_MS,
): Promise<string[]> {
  const candidates = gitignoredTopLevelNames(commitPath);
  if (candidates.length === 0) return [];
  const tracked = await gitTrackedTopLevelNames(git, candidates, timeoutMs);
  // .toLowerCase() here pairs with gitTrackedTopLevelNames' own lowercasing — see that function's doc
  // (card 687d2a47 finding 3) for why the comparison must be case-insensitive.
  return candidates.filter((n) => !tracked.has(n.toLowerCase()));
}

/**
 * The four hardcoded, LOAD-BEARING exclusions (`.git`/`.obsidian`/`node_modules`/`worktrees` — these are
 * what keep worker worktrees and tool state out of the watcher today; see the module doc above) UNION
 * `extraSafeNames` (see {@link safeToExcludeNames} — the caller's job to have already proven these safe;
 * this function does no safety filtering of its own). Always additive, never a replacement, so the
 * hardcoded four are unconditionally present regardless of `extraSafeNames`.
 *
 * **NOT exported.** This regex is only ever safe to test against a path RELATIVE to `commitPath` — see
 * {@link buildIgnoredMatcher}'s doc for why an ABSOLUTE-path test can match a segment in `commitPath`'s own
 * ancestor chain and kill the whole watcher. Keeping this un-exported means that invariant lives in the
 * one place that constructs a matcher from it, instead of being a convention a second future caller could
 * silently violate by testing the bare pattern against an absolute path (exactly the form Critical-2 named
 * unsafe). `buildIgnoredMatcher` is the only public surface.
 */
function buildIgnoredPattern(commitPath: string, extraSafeNames: string[] = []): RegExp {
  const names = ["\\.git", "\\.obsidian", "node_modules", "worktrees", ...extraSafeNames.map(escapeRegExp)];
  return new RegExp(`(^|[/\\\\])(${names.join("|")})([/\\\\]|$)`);
}

/**
 * The chokidar `ignored` MATCHER (a function, not a bare pattern) for a governing repo root: tests each
 * candidate path RELATIVE TO `commitPath`, never the absolute path. Card 39ceb732's Critical-2 finding:
 * an absolute-path regex can match a segment in `commitPath`'s OWN ANCESTOR chain — including the repo
 * root's own directory name — and chokidar tests the ROOT itself, so a repo at (say)
 * `.../scratch/myvault` with `scratch/` in ITS OWN `.gitignore` got a pattern that matched the root path
 * itself, and chokidar refuses to descend into an ignored root at all: `getWatched()` came back `{}` — a
 * SILENT, TOTAL watcher death, live-verified. Testing the RELATIVE path instead makes this structurally
 * impossible, not just less likely: `path.relative(commitPath, commitPath)` is always `""`, which cannot
 * match `(^|[/\\])(name)([/\\]|$)` for any non-empty name — nothing outside the repo is ever in the string
 * being tested at all. This is the ONLY exported way to get an ignore matcher — {@link buildIgnoredPattern}
 * itself is deliberately un-exported so nothing outside this module can reintroduce the absolute-path form.
 */
export function buildIgnoredMatcher(commitPath: string, extraSafeNames: string[] = []): (p: string) => boolean {
  const pattern = buildIgnoredPattern(commitPath, extraSafeNames);
  return (p: string) => pattern.test(path.relative(commitPath, p));
}

/**
 * Paths we've already warned about for a given repo root — suppresses re-warning on every debounced
 * commit tick while a stuck oversized file just sits there untouched (chokidar re-triggers `commit()` on
 * ANY change under the watched root, which restages every untracked file, including this one, every
 * time). Module-scope + add-only: a daemon restart re-warns once, which is fine; there is no need to
 * evict an entry once the file stops being oversized (it just never gets re-added to this set).
 */
const warnedOversizedFiles = new Set<string>();

/**
 * Unstage any staged file whose on-disk size exceeds `maxFileBytes` (deletions are skipped — nothing to
 * stat, and a deletion can never re-introduce a giant blob), console.warn a `.gitignore` suggestion once
 * per path, and return the list of paths actually unstaged (possibly empty). `git reset -- <path>` is
 * used rather than `git reset HEAD -- <path>` so this also works on a brand-new repo's very first commit
 * (verified: `reset -- <path>` unstages cleanly even with no HEAD yet; `reset HEAD -- <path>` would fail
 * there). Swallows a reset failure per-file (leaves that one file staged) rather than aborting the whole
 * commit — refusing to commit ANYTHING because one file couldn't be unstaged would be a worse outcome
 * than the rare case of a stray oversized commit slipping through, and the failure itself is still logged.
 *
 * Narrowed to `Pick<SimpleGit, "raw">` and `timeoutMs`-bounded (card 54b839c5) — a `git reset` here is
 * cheap plumbing (local index manipulation, no hooks), so it shares {@link VAULT_GIT_OP_TIMEOUT_MS} with
 * this module's other plumbing-tier calls rather than the working-tree-scale ceiling `commitVault`'s
 * `add`/`commit` use.
 */
async function unstageOversizedFiles(
  git: Pick<SimpleGit, "raw">,
  root: string,
  files: Array<{ path: string; working_dir: string; index: string }>,
  maxFileBytes: number,
  timeoutMs: number = VAULT_GIT_OP_TIMEOUT_MS,
): Promise<string[]> {
  const skipped: string[] = [];
  for (const f of files) {
    if (f.working_dir === "D" || f.index === "D") continue; // deletion — nothing to stat, nothing to skip
    let size: number;
    try { size = fs.statSync(path.join(root, f.path)).size; } catch { continue; } // gone/unreadable — let the normal flow handle it
    if (size <= maxFileBytes) continue;
    try {
      await withTimeout(git.raw(["reset", "--", f.path]), timeoutMs, `git reset (vault unstage oversized: ${f.path})`);
      skipped.push(f.path);
      const key = `${root}::${f.path}`;
      if (!warnedOversizedFiles.has(key)) {
        warnedOversizedFiles.add(key);
        const rel = f.path.replace(/\\/g, "/");
        console.warn(
          `[vault-versioner] ${rel} is ${humanBytes(size)} (> ${humanBytes(maxFileBytes)}) — skipped from ` +
          `auto-commit. Add "${rel}" to .gitignore to silence this warning.`,
        );
      }
    } catch (err) {
      console.warn(`[vault-versioner] failed to unstage oversized file ${f.path}: ${(err as Error).message}`);
    }
  }
  return skipped;
}

/**
 * Whether the repo at `git`'s cwd has BOTH `user.name` and `user.email` resolvable (global/system/local
 * config, in git's own precedence order). `git config user.<key>` exits non-zero when unset, which
 * simple-git surfaces as a rejection — caught here and treated as "unresolved", never thrown.
 *
 * Narrowed to `Pick<SimpleGit, "raw">` (card 54b839c5) — the only method this calls — mirroring
 * `git/worktrees.ts`'s own copy of this same check, so callers passing a `BoundedVaultGit` (which does
 * not carry every `SimpleGit` method) can use it directly. `timeoutMs` bounds each `raw` call the same
 * way every other plumbing-tier call in this module is bounded; defaults to {@link VAULT_GIT_OP_TIMEOUT_MS}
 * since a `git config` read is cheap plumbing, not working-tree-scale.
 */
async function hasConfiguredGitIdentity(
  git: Pick<SimpleGit, "raw">,
  timeoutMs: number = VAULT_GIT_OP_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const name = (await withTimeout(git.raw(["config", "user.name"]), timeoutMs, "git config user.name (vault identity check)")).trim();
    const email = (await withTimeout(git.raw(["config", "user.email"]), timeoutMs, "git config user.email (vault identity check)")).trim();
    return !!name && !!email;
  } catch {
    return false;
  }
}

/**
 * SYNCHRONOUS mirror of {@link hasConfiguredGitIdentity}, for `flushSync`'s `execSync` path (card
 * 816f0056 review round 2, finding 2): `flushSync` never had an identity fallback at all, so on a host
 * with no global/system/local git identity configured, EVERY shutdown flush failed silently, forever —
 * measured: `fatal: empty ident name (for <>) not allowed` — while the async `commit()`/`commitVault`
 * path succeeded via its own fallback. This file's own doc on `commitVault` (below) already anticipates
 * exactly this kind of host ("may have no global/system git identity at all"), so the gap was not
 * hypothetical. Same "unset → false" semantics as the async version: `git config user.<key>` exits
 * non-zero when unset, which `execSync` throws for — caught here and treated as unresolved.
 */
function hasConfiguredGitIdentitySync(opts: { cwd: string; stdio: "pipe"; timeout: number; env: NodeJS.ProcessEnv; maxBuffer: number }): boolean {
  try {
    const name = execSync("git config user.name", opts).toString().trim();
    const email = execSync("git config user.email", opts).toString().trim();
    return !!name && !!email;
  } catch {
    return false;
  }
}

/**
 * Stage-all + commit a vault folder, honoring the same externally-managed backoff as the
 * auto-committer: if the vault sits inside a git repo whose root is ABOVE the vault folder
 * (e.g. a vault-wide Obsidian Git repo), we do NOT init or commit, to avoid double-committing.
 * Initializes a repo at the vault folder itself if there is none. Returns true if a commit was
 * made, false if skipped (externally managed, or nothing staged to commit).
 *
 * This is THE single vault commit path — shared by the auto-committer (below) and human UI
 * writes (vault/writer.ts) so the history stays consistent and there is no second git mechanism.
 *
 * **Identity fallback:** unlike `git/writer.ts` (which commits with NO identity override, by
 * deliberate convention — the Loom repo itself always has one configured), this path runs
 * unattended on an arbitrary end-user's machine, which may have no global/system git identity at
 * all. When the repo has one configured (global, system, or local), we commit exactly as before —
 * their identity, un-overridden. Only when EITHER `user.name` or `user.email` is unresolved do we
 * fall back to a generic, non-personal `Loom <loom@localhost>` identity for that single commit, via
 * `-c user.name=`/`-c user.email=` passed as ARGS on the commit invocation (never as an env-var
 * override): simple-git's `blockUnsafeOperationsPlugin` rejects an explicit `.env()` call that
 * carries `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` (a real config-injection vector it guards
 * against) — a call we'd otherwise make by spreading `process.env` to preserve PATH/HOME for the
 * child process. Scoped `-c` args sidestep that entirely (git itself only applies them to this one
 * invocation) and `user.name`/`user.email` are not among simple-git's blocklisted config keys.
 *
 * **Oversized-file guard** (card 614dfbef): before committing, any staged file above `opts.maxFileBytes`
 * (default `DEFAULT_MAX_VAULT_FILE_BYTES`, ~95MB) is unstaged and warned about instead of committed — see
 * {@link unstageOversizedFiles}. Applies to every caller of this shared path (the auto-committer below AND
 * `vault/writer.ts`'s UI writes), so a giant file is unstaged before it can enter vault history through
 * either route — UNLESS the per-file `git reset` itself fails, which leaves that one file staged (a
 * documented, rare exception swallowed per-file rather than aborting the whole commit; see
 * {@link unstageOversizedFiles}'s own doc). This is an AUTOMATIC, unattended path (no human in the loop),
 * which is why it silently unstages rather than warning — contrast `git/writer.ts`'s `GitWriter.commit`,
 * a DELIBERATE human/agent act on the project's code repo, which instead WARNS on the same threshold
 * without unstaging or refusing (see that method's own doc for the reasoning).
 *
 * **Bounded, card 54b839c5 (the Code Reviewer's finding 4 on card 816f0056's branch).** This used to
 * construct a plain `simpleGit(vaultPath)` — no block timeout, no `GIT_TERMINAL_PROMPT=0` — and run
 * `add`/`status`/`commit` through the user's own `git commit` (and therefore any pre-commit hook) with
 * nothing bounding any of it: the exact hang vector `816f0056` hardened on `flushSync`'s SHUTDOWN path,
 * left open here on the path a human's HTTP request (`vault/writer.ts`) actually blocks on. Every call
 * now goes through {@link boundedVaultGit} — the SAME seam this module's other bounded call sites use,
 * never a second mechanism — via two instances at two ceilings (the load-bearing half of this fix —
 * `GIT_TERMINAL_PROMPT=0` is deliberately NOT added here; see the doc immediately above `boundedVaultGit`
 * for why, and for why its absence doesn't matter — this function never touches the network):
 *  - **Cheap plumbing** (`checkIsRepo`/`revparse`/`init`/`status`/the identity `config` reads/
 *    `unstageOversizedFiles`'s `reset` calls): {@link VAULT_GIT_OP_TIMEOUT_MS} (15s) — measured on this
 *    host at 43-59ms steady-state, so 15s is generous headroom, not a tight fit.
 *  - **Working-tree-scale** (`add`, and `commit` — the actual named hang vector, since `commit` runs the
 *    hook): {@link VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS} (5 min) — the SAME constant `flushSync` uses for
 *    its own `add`/`commit`, sized off the SAME measurement (a cold `git add -A` over a 20k-file vault
 *    measured ~11.6s on local NVMe alone). ⛔ A single tight ceiling across both tiers would mean a
 *    genuinely-still-working large-vault flush fails EVERY time — on this path, a failed commit attempt
 *    means a DROPPED user edit stays uncommitted, so sizing the working-tree tier tight is not a safe
 *    default. `status`/`checkIsRepo`/`revparse` stay on the cheap tier deliberately (matching `flushSync`'s
 *    own `git status --porcelain`, not its `add`/`commit`) — none of them touch the working tree at scale.
 *
 * **Mechanism, verified rather than assumed (the card's own instruction):** simple-git's `block` timeout
 * is a NO-OUTPUT timer (it resets on every stdout/stderr `data` event from the child; verified by reading
 * the installed `simple-git@3.36.0` package's bundled `timeoutPlugin` — it re-arms via `spawned.stdout.on
 * ("data", wait)`/`stderr` the same way) — the right shape for a silent hung hook (e.g. `sleep`), not a
 * hard wall-clock cap on a verbose one. On expiry it calls `spawned.kill("SIGINT")` on the DIRECTLY
 * spawned child — simple-git calls `child_process.spawn(command, args, spawnOptions)` with no `shell:
 * true` anywhere in the package, so unlike `flushSync`'s shell-string `execSync` calls (where a timeout
 * only kills the wrapping `cmd.exe`, not the real `git.exe` grandchild — see that method's own doc), a
 * timeout HERE kills `git.exe` itself directly. On Windows, `child.kill()` ignores the signal argument
 * and forcibly terminates that immediate process regardless. **This still does not guarantee the pre-commit
 * hook's own child (a `sh`/`sleep` `git.exe` already spawned) dies with it** — no job object, no tree
 * kill, same abandonment risk `flushSync` already documents — so, as there, a bound here means "how long
 * THIS FUNCTION waits", not a guarantee about what the hook process does afterward, and whether a killed
 * `git commit` still lands its commit object is the same kind of race `flushSync`'s own doc describes
 * (not asserted either way by this function or its test).
 *
 * **No `maxBuffer` ceiling applies here (card 816f0056 review round 2, finding 1, re-checked for this
 * path rather than assumed to carry over):** that finding was about the Node.js `execSync`/`execFileSync`
 * family's `maxBuffer` option (a large `git add -A` under `core.autocrlf=true` can emit enough per-file
 * stderr warnings to hit Node's default 1 MiB cap and throw ENOBUFS). simple-git does not use that family
 * at all — it spawns via `child_process.spawn` and accumulates stdout/stderr itself with no size cap and
 * no `maxBuffer`-shaped option anywhere in the package (verified: zero occurrences of `maxBuffer` in the
 * installed `simple-git@3.36.0` source). So this path cannot ENOBUFS the way `flushSync`'s did; it has no
 * matching ceiling to add.
 *
 * **What a bound expiring on the REST path (`vault/writer.ts`) means — the design decision this card asks
 * for, made explicit rather than left implicit:** `writeVaultFile`/`createVaultFile`/`deleteVaultFile` all
 * write the file to disk FIRST and call this function SECOND — so a timeout (or any other commit failure)
 * here never drops the user's edit; the edit is already durable on disk, only the git commit of it is
 * delayed. Every real caller (those three, and `VaultVersioner`'s own debounced `commit()` below) already
 * treats a rejection from this function as "not committed this round" (`writer.ts`'s `.catch(() => false)`
 * turns it into `{ ok: true, committed: false }`, never a hard REST error), and that stays correct: the
 * still-uncommitted file remains on disk under the watched root, so the NEXT debounced auto-commit tick
 * (or a later retry) picks it back up and commits it then — self-healing, not a permanent loss. This
 * function therefore still REJECTS on a bound expiry (unchanged from today's behavior for any other git
 * error on these calls, which already propagated uncaught) rather than swallowing it to `false` — what
 * changes is that it no longer HANGS, and a timeout is no longer SILENT: see the `console.warn` below,
 * closing the same observability gap `flushSync`'s own review already closed on its path.
 */
export async function commitVault(
  vaultPath: string,
  message: string,
  opts?: { maxFileBytes?: number; deps?: VaultGitDeps },
): Promise<boolean> {
  const maxFileBytes = opts?.maxFileBytes ?? DEFAULT_MAX_VAULT_FILE_BYTES;
  const deps = opts?.deps ?? {};
  // Two tiers, two bounded instances (same seam, different ceiling) — see this function's own doc for
  // why one shared ceiling is wrong here. A test-injected `deps.timeoutMs` collapses both tiers onto the
  // SAME small value (both `??` fallbacks below are skipped), which is exactly what a hang test wants —
  // real callers never set `deps`, so production always gets the real 15s/5min split.
  const cheapTimeoutMs = deps.timeoutMs ?? VAULT_GIT_OP_TIMEOUT_MS;
  const workTreeTimeoutMs = deps.timeoutMs ?? VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS;
  const { git } = boundedVaultGit(vaultPath, { ...deps, timeoutMs: cheapTimeoutMs });
  const { git: workGit } = boundedVaultGit(vaultPath, { ...deps, timeoutMs: workTreeTimeoutMs });

  const isRepo = await withTimeout(git.checkIsRepo(), cheapTimeoutMs, "git check-is-repo (vault commit)").catch(() => false);
  if (isRepo) {
    const root = (await withTimeout(git.revparse(["--show-toplevel"]), cheapTimeoutMs, "git rev-parse --show-toplevel (vault commit)").catch(() => "")).trim();
    const externallyManaged = !!root && root.replace(/\\/g, "/") !== vaultPath.replace(/\\/g, "/");
    if (externallyManaged) return false;
  } else {
    await withTimeout(git.init(), cheapTimeoutMs, "git init (vault commit)");
  }

  // Tracks the call in flight so the warn below names WHICH op hit its bound (mirrors flushSync's own
  // `currentOp` tracking) — this is the section covering the actual named hang vector (add/status/commit).
  let currentOp: { label: string; timeoutMs: number } | undefined;
  try {
    currentOp = { label: "git add .", timeoutMs: workTreeTimeoutMs };
    await withTimeout(workGit.add("."), workTreeTimeoutMs, currentOp.label);
    currentOp = { label: "git status", timeoutMs: cheapTimeoutMs };
    const status = await withTimeout(git.status(), cheapTimeoutMs, currentOp.label);
    if (status.files.length === 0) return false;
    const skipped = await unstageOversizedFiles(git, vaultPath, status.files, maxFileBytes, cheapTimeoutMs);
    // NOTE: an unstaged file does NOT disappear from `git status` (it just reverts to untracked/modified),
    // so re-querying status here would still see it and wrongly think there's something left to commit.
    // Comparing counts against the ORIGINAL staged set is the correct "anything real left?" check.
    if (skipped.length >= status.files.length) return false; // everything staged was oversized — nothing left to commit
    currentOp = { label: "git commit", timeoutMs: workTreeTimeoutMs };
    if (await hasConfiguredGitIdentity(git, cheapTimeoutMs)) {
      await withTimeout(workGit.commit(message), workTreeTimeoutMs, currentOp.label);
    } else {
      await withTimeout(workGit.raw([
        "-c", `user.name=${FALLBACK_GIT_IDENTITY.name}`,
        "-c", `user.email=${FALLBACK_GIT_IDENTITY.email}`,
        "commit", "-m", message,
      ]), workTreeTimeoutMs, currentOp.label);
    }
    return true;
  } catch (err) {
    // Closing the observability gap named above: before this fix a hung commit wedged the caller
    // forever with nothing in the logs; now it's bounded AND visible. Still rethrows — see this
    // function's own doc for why a bound expiry here stays a rejection rather than a swallowed `false`.
    console.warn(
      `[vault-versioner] ${vaultPath} commitVault's "${currentOp?.label}" call FAILED (bound ${currentOp?.timeoutMs}ms) — ` +
      `a real user edit may sit uncommitted until the next auto-commit tick: ${(err as Error)?.message ?? err}`,
    );
    throw err;
  }
}

/**
 * Resolve a project's `vaultPath` to the git context that GOVERNS its history. Three real layouts:
 *  - **No repo** → we own it: `commitPath` is the vault folder itself (we git-init + commit there).
 *  - **Plain git repo** (vault IS the repo root, OR a SUBFOLDER of a larger plain repo) → no real
 *    external auto-committer, so we keep per-edit history ourselves: `commitPath` is the DETECTED
 *    repo ROOT and we commit there. Keying to the root (not the subfolder) is what lets N project
 *    vaults that are sibling subfolders of ONE repo collapse to a single root watcher.
 *  - **Obsidian-Git-managed repo** → a real external auto-committer already owns history, so we
 *    BACK OFF (`externallyManaged: true`) to avoid double-committing.
 *
 * We detect the Obsidian-Git case DISTINCTLY — by the presence of the `.obsidian/plugins/obsidian-git`
 * marker directory under the repo root — NOT by "subfolder ≠ root" (the old, wrong proxy that backed
 * off for EVERY subfolder, including subfolders of plain repos). The marker is deterministic (it exists
 * iff the Obsidian Git plugin — the thing that creates the external committer — is installed for that
 * vault) and is one cheap `fs.existsSync`; preferred over a commit-message heuristic, which is fragile
 * (depends on the user's message template, reads empty on a fresh repo, false +/-).
 *
 * **Bounded (card 509716cc)** — this is reached from `startVaultVersioners`, AWAITED at boot ahead of
 * `sessions.resumeFleetOnBoot`. A timeout on either op lands in the SAME `.catch(() => false/"")` the
 * pre-existing git-error path already used, so a hung repo degrades exactly like a non-repo/no-toplevel
 * one does today — "no governing repo, commit at the vault folder itself" — never a hang.
 */
async function resolveVaultRepoContext(
  vaultPath: string,
  deps: VaultGitDeps = {},
): Promise<{ commitPath: string; externallyManaged: boolean }> {
  const { git, timeoutMs } = boundedVaultGit(vaultPath, deps);
  const isRepo = await withTimeout(git.checkIsRepo(), timeoutMs, "git check-is-repo (vault resolve)").catch(() => false);
  if (!isRepo) return { commitPath: vaultPath, externallyManaged: false }; // no repo → we git-init it
  const root = (await withTimeout(git.revparse(["--show-toplevel"]), timeoutMs, "git rev-parse --show-toplevel (vault resolve)").catch(() => "")).trim();
  if (!root) return { commitPath: vaultPath, externallyManaged: false };
  const commitPath = path.resolve(root);
  // Obsidian-Git-managed → a real external auto-committer owns history; back off (no double-commit).
  const obsidianGitMarker = path.join(commitPath, ".obsidian", "plugins", "obsidian-git");
  return { commitPath, externallyManaged: fs.existsSync(obsidianGitMarker) };
}

export type VaultGitTargetResult =
  | { ok: true; repoPath: string }
  | { ok: false; reason: "no-vault" | "no-repo" | "externally-managed" };

/**
 * Resolve a project's vault to the git repo a WRITE lever (the companion `git-push` capability) may
 * commit/push to — reusing `resolveVaultRepoContext` (the SAME resolution the auto-committer itself
 * uses, so a companion push can never disagree with what Loom already considers "the vault's repo": a
 * vault may be a subfolder of a larger repo, and sibling project vaults can share ONE governing root —
 * see `startVaultVersioners`'s own dedupe-by-root doc). Read-only — never mutates, never `git init`s.
 *
 * Unlike `resolveVaultRepoContext` (whose caller git-inits a bare vault folder itself), this checks
 * whether the resolved `commitPath` is ACTUALLY a repo yet and REFUSES (`"no-repo"`) if not — a
 * companion-facing write lever must never silently create a new git repository on the host on the
 * owner's behalf; that host-write is out of scope for "commit to an EXISTING repo." Also refuses
 * (`"externally-managed"`) when the resolved repo is Obsidian-Git-managed — a real external
 * auto-committer already owns that history, mirroring `VaultVersioner`'s own backoff.
 */
export async function resolveVaultGitTarget(vaultPath: string): Promise<VaultGitTargetResult> {
  const trimmed = vaultPath?.trim();
  if (!trimmed) return { ok: false, reason: "no-vault" };
  const ctx = await resolveVaultRepoContext(trimmed);
  if (ctx.externallyManaged) return { ok: false, reason: "externally-managed" };
  const isRepo = await simpleGit(ctx.commitPath).checkIsRepo().catch(() => false);
  if (!isRepo) return { ok: false, reason: "no-repo" };
  return { ok: true, repoPath: ctx.commitPath };
}

/** Default advisory pause duration (10 min) — enough for a typical git-surgery sequence (untrack files,
 *  rewrite `.gitignore`, verify) without leaving a forgotten lease active indefinitely. */
const DEFAULT_VAULT_PAUSE_MS = 10 * 60_000;
/** Hard ceiling on any requested pause — the lease is meant to be SHORT-LIVED (card 614dfbef); clamping a
 *  mistaken huge duration keeps a caller from silencing auto-commit for good. */
const MAX_VAULT_PAUSE_MS = 30 * 60_000;

const PAUSE_LEASE_FILENAME = "loom-vault-pause.json";

/** Lease path for a governing repo root — inside `.git/`, so (a) chokidar's own ignore pattern
 *  (`(^|[/\\])\.git([/\\]|$)`, see `start()` below) means writing/removing it never itself triggers a
 *  spurious auto-commit cycle, and (b) it is never git-tracked (can't land in vault history). */
function pauseLeasePath(commitPath: string): string {
  return path.join(commitPath, ".git", PAUSE_LEASE_FILENAME);
}

/** Opaque per-op handle returned by {@link pauseVaultAutoCommit} — pass it back to
 *  {@link resumeVaultAutoCommit} so a resume only ever clears the lease IT holds. */
export type VaultPauseToken = string;

/**
 * Advisory pause (card 614dfbef, origin finding 4ae8a3c9): create a short-lived lease telling this repo
 * root's `VaultVersioner` to skip its commits — for an agent doing SANCTIONED git surgery on a vault repo
 * (untracking files, rewriting `.gitignore`, mid-sequence state) that would otherwise race the background
 * auto-committer. Purely advisory: a plain file the versioner checks before it commits, not an OS-level
 * lock — nothing else is blocked from touching the repo. `durationMs` is clamped to
 * `[0, MAX_VAULT_PAUSE_MS]`. Best-effort: never throws (a failed write just means "not paused").
 *
 * **Per-op token (card 237d1899, follow-up to 614dfbef):** the lease is NOT ref-counted — two concurrent
 * same-repo callers (e.g. two `GitWriter` ops on one repo, reachable from the REST/Platform/companion
 * git-write surfaces with no cross-surface mutex) can overlap. Each call writes a fresh random `token`
 * into the lease file (last writer wins the `until`/`token` pair) and returns it; the caller must pass
 * that SAME token to {@link resumeVaultAutoCommit} so a resume only clears the lease it actually holds
 * — see that function's doc for the "resume-only-if-mine" check this enables.
 */
export function pauseVaultAutoCommit(commitPath: string, durationMs = DEFAULT_VAULT_PAUSE_MS): VaultPauseToken {
  const clamped = Math.max(0, Math.min(durationMs, MAX_VAULT_PAUSE_MS));
  const token = randomUUID();
  try {
    const p = pauseLeasePath(commitPath);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ until: Date.now() + clamped, token }));
  } catch { /* best-effort — never throws into the caller's git-surgery flow */ }
  return token;
}

/**
 * End an advisory pause early (the surgery finished before the lease would have expired anyway).
 *
 * **Resume-only-if-mine (card 237d1899):** when `token` is passed, the lease is removed ONLY if it still
 * carries that exact token — so op A's `finally` can never delete a lease op B re-paused (with a NEW
 * token) while A was still running; B's protection survives until B itself resumes (or the lease's own
 * TTL expires). `token` is OPTIONAL for back-compat with a caller that never re-paused mid-op (there's
 * only ever one lease to clear) and with direct test setup; every real GitWriter op always passes the
 * token `pauseVaultAutoCommit` gave it. A missing/unreadable/mismatched lease is a harmless no-op either
 * way — best-effort: never throws.
 */
export function resumeVaultAutoCommit(commitPath: string, token?: VaultPauseToken): void {
  const p = pauseLeasePath(commitPath);
  try {
    if (token !== undefined) {
      const current = JSON.parse(fs.readFileSync(p, "utf8")) as { token?: string };
      if (current?.token !== token) return; // a newer op's lease — not mine to remove
    }
    fs.rmSync(p);
  } catch { /* no lease, unreadable, or already gone — fine */ }
}

/** Whether an unexpired pause lease exists for `commitPath`. A missing, unreadable, malformed, or expired
 *  lease all read as "not paused" — fail-open toward committing rather than getting silently stuck paused
 *  forever on a corrupt lease file. */
function isVaultAutoCommitPaused(commitPath: string): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(pauseLeasePath(commitPath), "utf8"));
    return typeof raw?.until === "number" && Date.now() < raw.until;
  } catch { return false; }
}

/**
 * Auto-commits a project's vault so doc rewrites are never truly lost (§7). Debounces writes and commits
 * at idle. Resolves the vault to its GOVERNING repo root (see `resolveVaultRepoContext`) and watches +
 * commits THERE — so a vault that is a subfolder of a plain repo gets per-edit history at the repo root,
 * while a vault folder that is its own repo root (or has no repo) is watched/committed in place. Backs
 * off ONLY for an Obsidian-Git-managed repo (a real external auto-committer owns its history).
 *
 * **Commit-only by design — this never pushes, and that is intentional, not a gap.** (Investigated under
 * task f48ee77d: a vault observed 172 `loom: auto-commit` commits ahead of `origin/main`.) Pushing a repo
 * is a HUMAN-only trust-boundary action in Loom (see `git/writer.ts` `GitWriter.push()` + the human-only
 * git-write REST surface) — this versioner runs unattended in the daemon, triggered by any filesystem
 * event (including an ordinary agent's doc rewrite), so it must never perform outbound network git
 * operations itself; doing so would silently widen that boundary. For a vault whose governing repo DOES
 * have a configured upstream, the resulting backlog is made VISIBLE instead of silent via
 * {@link checkVaultPushStatus} / {@link VaultPushStatusWatcher} below (read-only `rev-list --count`, no
 * writes) — push stays a manual action the human takes through the existing git-write surface.
 */
/** Above this many watched entries, `start()` logs a one-time visibility warning (card 39ceb732 Lever 4) —
 *  see {@link VaultVersioner.warnIfLarge}. Not a cap: nothing is skipped or throttled at this size. */
const LARGE_VAULT_WATCH_WARN_THRESHOLD = 20_000;

export class VaultVersioner {
  private git: BoundedVaultGit;
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;
  private externallyManaged = false;
  /** The folder we actually watch + commit — the governing repo ROOT, resolved in `start()`. */
  private commitPath: string;
  /** Resolves once chokidar's initial scan completes ("ready") — see {@link whenReady}. */
  private readyPromise?: Promise<void>;
  /** The matcher passed to chokidar as `ignored` — retained so {@link hasUnexcludedTopLevelEntry} can
   *  reuse it (never a second, possibly-divergent copy of the exclusion logic). */
  private matcher?: (p: string) => boolean;

  constructor(
    private vaultPath: string,
    private debounceMs = 5000,
    /** Test-only override for {@link LARGE_VAULT_WATCH_WARN_THRESHOLD} — real callers never pass this
     *  (same override-for-testability shape as `commitVault`'s `opts.maxFileBytes`; a real threshold this
     *  large would need a slow, wasteful real fixture to exercise the warning path at all). */
    private watchWarnThreshold = LARGE_VAULT_WATCH_WARN_THRESHOLD,
    /** Test-only bounded-git injection seam (card 509716cc) — real callers never pass this; see
     *  {@link VaultGitDeps}. */
    private gitDeps: VaultGitDeps = {},
  ) {
    this.commitPath = vaultPath;
    this.git = boundedVaultGit(vaultPath, gitDeps).git;
  }

  /** The resolved governing repo root this instance watches + commits (valid after `start()`). */
  get commitRoot(): string {
    return this.commitPath;
  }

  async start(): Promise<void> {
    const ctx = await resolveVaultRepoContext(this.vaultPath, this.gitDeps);
    this.commitPath = ctx.commitPath;
    this.externallyManaged = ctx.externallyManaged;
    const { git, timeoutMs } = boundedVaultGit(this.commitPath, this.gitDeps);
    this.git = git;
    if (!this.externallyManaged) {
      // git-init a bare vault folder that has no repo (resolveVaultRepoContext leaves commitPath as the
      // vault folder in that case). A real repo (own root / plain-repo root) already exists — no-op.
      // Bounded (card 509716cc): this is the boot-awaited path (startVaultVersioners → index.ts, ahead
      // of sessions.resumeFleetOnBoot) — a hung checkIsRepo degrades to "not a repo" (same as the
      // pre-existing .catch(() => false)) rather than wedging the whole daemon's post-restart fleet
      // resume.
      const isRepo = await withTimeout(this.git.checkIsRepo(), timeoutMs, "git check-is-repo (vault start)").catch(() => false);
      if (!isRepo) await withTimeout(this.git.init(), timeoutMs, "git init (vault start)");
    }
    const safeNames = await safeToExcludeNames(this.commitPath, this.git, timeoutMs);
    this.matcher = buildIgnoredMatcher(this.commitPath, safeNames);
    this.watcher = chokidar.watch(this.commitPath, {
      ignoreInitial: true,
      ignored: this.matcher,
      // sessions/liveness.ts:36-43 records a chokidar EPERM taking the whole daemon down on 2026-06-16 —
      // its fix was "never rethrow, swallow and continue"; ignorePermissionErrors:true goes one step
      // earlier and stops chokidar from even EMITTING "error" for the common EPERM/EACCES transient-race
      // class in the first place (e.g. a short-lived temp dir vanishing mid-stat), rather than relying
      // solely on the "error" listener below to catch it after the fact. Also makes chokidar's own
      // _hasReadPermissions() return true unconditionally (chokidar 4.0.3 index.js:674-676), so the
      // watcher now ATTEMPTS entries it previously skipped on permission grounds — a small INCREASE in
      // watched-entry count, the opposite direction from this file's exclusion logic; verified this can
      // only ever push the count UP, never down, so it cannot mask the zero-entries tripwire below.
      ignorePermissionErrors: true,
    });
    // Resolves ONLY on "ready" — deliberately does NOT reject on "error". Matching liveness.ts's
    // established doctrine: a chokidar error is swallow-and-log, never rethrown. An earlier version of
    // this rejected readyPromise on ANY pre-ready error, which is unsafe in exactly the way that doctrine
    // exists to prevent — a single transient, often-recoverable error (chokidar frequently still reaches
    // "ready" afterward) would otherwise turn into an unhandled-rejection risk for any caller (a test, or
    // a future consumer) that awaits whenReady() without its own try/catch.
    this.readyPromise = new Promise((resolve) => { this.watcher!.once("ready", resolve); });
    this.watcher.on("all", () => this.schedule());
    this.watcher.on("ready", () => this.warnIfLarge());
    this.watcher.on("error", (err) => {
      console.warn(`[vault-versioner] ${this.commitPath} watcher error (ignored, watcher continues): ${(err as Error)?.message ?? err}`);
    });
  }

  /**
   * Resolves once the watcher's initial filesystem scan completes (chokidar's own "ready" event). Never
   * REJECTS — a pre-ready chokidar error is logged (see `start()`) but does not settle this promise, so a
   * transient error chokidar itself recovers from (the common case) doesn't spuriously fail an awaiter. If
   * the watcher truly never reaches "ready", this will not resolve; a caller that needs a bound should use
   * its own timeout (e.g. this test suite's `waitFor`) rather than have this method guess at what counts as
   * "fatal enough" to give up on. A no-op (resolves immediately) if `start()` hasn't been called. Exposed
   * for callers/tests that need to anchor on this OBSERVABLE event rather than a fixed wait.
   */
  async whenReady(): Promise<void> {
    await this.readyPromise;
  }

  /**
   * Total tracked entries (files + dirs) the live watcher holds an OS handle for — the SAME method card
   * a0c62330 used to measure this (`watcher.getWatched()`, summed): confirmed there to be ~1:1 with both
   * `process.getActiveResourcesInfo()`'s `FSEventWrap` count and the OS handle count. `undefined` before
   * `start()` resolves (or once `stop()` has closed the watcher) — never a stale/wrong number.
   */
  get watchedEntryCount(): number | undefined {
    if (!this.watcher) return undefined;
    return Object.values(this.watcher.getWatched()).reduce((sum, names) => sum + names.length, 0);
  }

  /** Test/diagnostic-only: the raw chokidar `getWatched()` snapshot (dir path → tracked child basenames),
   *  for a caller that needs to assert precisely WHICH entries are (or are not) tracked, not just the
   *  aggregate count. `undefined` before `start()`/after `stop()`. */
  get watchedSnapshot(): Record<string, string[]> | undefined {
    return this.watcher?.getWatched();
  }

  /**
   * Card 39ceb732's Lever 4 ("do nothing to the mechanism; add a startup size warning"): logs ONCE, when
   * the initial scan completes, if this watcher ended up tracking an unusually large number of entries.
   * Chokidar opens one native OS handle PER entry with no cap, so a vault this large is a real, uncapped
   * resource cost on a local-first desktop product — this makes that cost VISIBLE instead of silent until
   * someone reads a crashlog, without changing what gets watched or committed.
   *
   * Also warns (the DISCRIMINATING form, not a naive one) when the watcher tracks exactly ZERO entries —
   * the signature of the Critical-2 dead-watcher class (now structurally prevented, see
   * {@link buildIgnoredMatcher}). **This is NOT a tripwire for "any future cause of the same failure
   * shape" (card 687d2a47 finding 4) — it only catches a scan that dies while the MATCHER STILL ADMITS
   * top-level content.** It has a real, named blind spot: an OVER-BROAD matcher (one that itself excludes
   * every top-level name) defeats it completely, because {@link hasUnexcludedTopLevelEntry} below reuses
   * that SAME matcher to decide whether to warn — chokidar reporting zero entries AND the discriminator
   * agreeing "nothing unexcluded exists" produces total, silent agreement, not a warning. An over-broad
   * matcher is exactly this card family's own primary failure class, so don't read this tripwire as a
   * backstop against it. A naive "count===0 ⇒ warn" false-positives on a legitimately brand-new, empty
   * vault (no notes yet) — so this only warns when the count is zero AND `commitPath` actually has
   * top-level content the matcher does NOT exclude (i.e. content that SHOULD have produced at least one
   * watched entry).
   *
   * Best-effort: swallows any error from `getWatched()`/`watchedEntryCount`/the zero-entry directory read
   * rather than risking the ready handler itself.
   */
  private warnIfLarge(): void {
    try {
      const count = this.watchedEntryCount;
      if (count === 0) {
        if (this.hasUnexcludedTopLevelEntry()) {
          console.warn(
            `[vault-versioner] ${this.commitPath} is watching ZERO entries despite having real, ` +
            `non-excluded top-level content — this is almost certainly a dead watcher, not an empty vault. ` +
            `Auto-commit for this vault is effectively disabled until this is investigated.`,
          );
        }
      } else if (count !== undefined && count > this.watchWarnThreshold) {
        console.warn(
          `[vault-versioner] ${this.commitPath} is watching ${count} entries (> ${this.watchWarnThreshold}) — ` +
          `chokidar opens one OS file handle per entry with no cap, so this is a real, uncapped memory/handle ` +
          `cost that scales with vault size. A subfolder this repo's own .gitignore already excludes is also ` +
          `excluded from being watched automatically — see this file's gitignoredTopLevelNames/` +
          `safeToExcludeNames for exactly what qualifies (git-TRACKED content under a gitignored name is ` +
          `deliberately still watched, so this never silently stops version history for real content).`,
        );
      }
    } catch { /* best-effort — never let a diagnostic log break watcher startup */ }
  }

  /** Whether `commitPath`'s own top-level directory listing has at least one entry `this.matcher` does NOT
   *  exclude — used only to discriminate "legitimately empty vault" from "dead watcher" in {@link
   *  warnIfLarge}'s zero-entry branch. An unreadable directory (edge case, shouldn't happen once `start()`
   *  has already succeeded) reads as "nothing to warn about" — fail toward silence, not a spurious alarm. */
  private hasUnexcludedTopLevelEntry(): boolean {
    if (!this.matcher) return false;
    try {
      return fs.readdirSync(this.commitPath).some((name) => !this.matcher!(path.join(this.commitPath, name)));
    } catch {
      return false;
    }
  }

  private schedule(): void {
    if (this.externallyManaged) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.commit(), this.debounceMs);
  }

  private async commit(): Promise<void> {
    // An agent doing sanctioned git surgery holds an advisory pause lease — sit this tick out rather than
    // race its staged changes (card 614dfbef). The debounce timer already fired; we simply skip the
    // commit itself. A future filesystem event (or the next `schedule()`) will retry once the lease lifts.
    if (isVaultAutoCommitPaused(this.commitPath)) return;
    // Route through the shared commit path (at the resolved repo root) so UI writes and auto-commits
    // stay consistent. commitVault re-confirms root === commitPath, so it commits (not backs off) here.
    try { await commitVault(this.commitPath, `loom: auto-commit ${new Date().toISOString()}`); }
    catch { /* best-effort */ }
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
    // Clear the reference (not just close()) so watchedEntryCount/watchedSnapshot's documented
    // "undefined after stop()" is actually true — chokidar's close() doesn't null out getWatched()'s
    // result, it empties it, so leaving `this.watcher` set would make those getters silently return
    // 0/{} instead, indistinguishable from "watching zero entries" rather than "not watching at all".
    this.watcher = undefined;
    if (this.timer) clearTimeout(this.timer);
  }

  /**
   * SYNCHRONOUS final flush for graceful shutdown. `gracefulShutdown` (index.ts) is synchronous and
   * ends in `process.exit(0)` immediately, so the async, debounced `commit()` above would NOT complete
   * before exit — an edit made inside the 5s debounce window would be silently dropped. This stages and
   * commits any pending on-disk changes (at the resolved repo root `commitPath`) with `execSync` so the
   * commit lands BEFORE the process exits. Honors the cached `externallyManaged` backoff (skip — an
   * Obsidian-Git-managed repo owns its own history) and is a no-op when nothing is staged. Best-effort:
   * never throws. Returns true iff it committed. Mirrors the shared `commitVault` semantics, but
   * synchronous by necessity. Also honors the advisory pause lease (card 614dfbef) — a shutdown mid
   * sanctioned git surgery must not force a commit the lease was meant to prevent.
   *
   * **Bounded (card 816f0056):** unlike the async git calls elsewhere in this file, `execSync` can't use
   * the `withTimeout` Promise race above — it's synchronous by necessity (see the class doc above for
   * why `flushSync` can't be made async). `execSync`'s own native `timeout` option is the bound instead,
   * plus `GIT_TERMINAL_PROMPT=0` so a credential prompt can't hang either, plus a generous
   * {@link VAULT_FLUSH_MAX_BUFFER_BYTES} (a large vault's `git add -A` can emit megabytes of per-file
   * `autocrlf` warnings on Windows — see that constant's own doc; a too-small `maxBuffer` drops a commit
   * exactly like a too-small timeout does). **`execSync` THROWS on timeout expiry, same as any other
   * execSync failure** — it lands in the `catch` below and returns `false` exactly like a missing
   * identity or a plain git error would. That is the intended trade: a dropped shutdown auto-commit beats
   * a wedged `gracefulShutdown` (which would otherwise hang `loom stop` and, worse, `daemon_restart`'s
   * exit `75` — see the card for why that stalls the whole fleet). The pre-existing `try/catch` here
   * guards THROWN errors, not hangs — it's the timeout option above that turns a hang into a throw.
   *
   * **A timeout here ABANDONS the child, it does not always STOP it (card 816f0056 review round 2,
   * finding 4) — and this differs between the shell-string calls and the argument-array one (round 3).**
   * `git add -A`/`git status --porcelain` still run via shell-string `execSync` (`cmd.exe` on Windows,
   * spawned by Node as the immediate child); a timeout kills only THAT shell — there is no job object, no
   * tree kill — so the REAL `git.exe` it launched (a grandchild of Node) survives and keeps running in the
   * background. Measured against `git add -A` this way: a `git commit` blocked in a `sleep` hook, timed
   * out at 500ms via a shell-wrapped call, still landed its commit ~8 seconds later. `git commit` itself
   * is different: it now runs via `execFileSync` (no shell — see the "Identity fallback" paragraph below
   * for why), so `git.exe` IS the immediate child Node kills directly on timeout. A hook grandchild it had
   * already spawned (a real `sh`/`sleep`) can still survive and run to completion harmlessly, with nothing
   * left alive to receive its result. **Whether the commit OBJECT itself lands is a RACE, not a fixed
   * outcome (card 816f0056, test/vault-flush-sync-hang-bound.mjs) — it depends on how far `git.exe` had
   * progressed (had it already written the commit object and updated the ref?) before the kill signal
   * reached it.** Observed both ways on this exact test: in an ordinary worktree run the commit did not
   * land; under merge-gate conditions (different host/scheduling timing) it did. Neither outcome is
   * assertable, and this file does not claim either. Either way, "bounds a true hang" means bounds how
   * long THIS FUNCTION waits, not a guarantee about what the underlying git process does afterward — and a
   * warn saying a commit "may have been dropped" stays the honest framing rather than a certainty, since
   * the shell-wrapped calls can still complete moments later, racing whatever touches the repo next.
   *
   * **The three calls are deliberately NOT all bound by the same ceiling.** The goal here is "no INFINITE
   * hang", not "fail fast" — a bound whose only job is to stop a wait that would otherwise never end does
   * not need to be tight, and a TIGHT one is actively worse: it converts a slow-but-working flush into a
   * GUARANTEED failure, and on this path failure means the commit is silently DROPPED (the timeout throws
   * into the same best-effort `catch` a real git error would) — the exact data loss this function exists
   * to prevent. `git status --porcelain` is a cheap, stat-based comparison (no hashing), the same cost
   * class as this module's other bounded plumbing (`ls-files`/`checkIsRepo`/`revparse`), so it keeps their
   * existing {@link VAULT_GIT_OP_TIMEOUT_MS} (15s) ceiling. `git add -A` and `git commit` (runs the
   * user's hooks — e.g. a pre-commit hook — the actual named hang vector in this card, plus writes tree
   * objects) are working-tree-scale and get {@link VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS} (5 min) instead —
   * see that constant's own doc for the sizing basis (a real measurement, NOT "same class as checkout" —
   * that appeal to convention was wrong, see the correction there).
   *
   * **Identity fallback (card 816f0056 review round 2, finding 2):** mirrors `commitVault`'s fallback (see
   * that function's own doc for why `-c` ARGS, not an env override) via {@link hasConfiguredGitIdentitySync}
   * — this path never had one at all, so a host with no configured git identity silently failed EVERY
   * shutdown flush, forever, while the async `commit()` path succeeded. **Genuinely ARGS, not a shell
   * string (round 3 correction):** the first cut of this fix interpolated the fallback identity into a
   * shell-string `execSync` call — safe only BY COINCIDENCE, because {@link FALLBACK_GIT_IDENTITY} happens
   * to contain no spaces today. `execFileSync("git", [...])` passes each piece as a real argument instead,
   * so a future edit to that constant (e.g. adding a space) can never re-open the exact silent-drop failure
   * this card exists to close.
   */
  flushSync(): boolean {
    if (this.externallyManaged) return false;
    if (isVaultAutoCommitPaused(this.commitPath)) return false;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    // Tracks the call currently in flight so the `catch` below can name WHICH op timed out and at what
    // bound (card 816f0056 review round 2, finding 5) — `execSync`'s own timeout error just names the
    // shell (`spawnSync ... cmd.exe ETIMEDOUT`), not the git command or the ceiling that fired.
    let currentOp: { label: string; timeoutMs: number } | undefined;
    try {
      const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
      const cheapTimeoutMs = this.gitDeps.timeoutMs ?? VAULT_GIT_OP_TIMEOUT_MS;
      // flushAddTimeoutMs/flushCommitTimeoutMs (test-only, see VaultGitDeps) each fall back to the shared
      // `timeoutMs` override, then to the real production default — see VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS.
      const addTimeoutMs = this.gitDeps.flushAddTimeoutMs ?? this.gitDeps.timeoutMs ?? VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS;
      const commitTimeoutMs = this.gitDeps.flushCommitTimeoutMs ?? this.gitDeps.timeoutMs ?? VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS;
      const cheapOpts = { cwd: this.commitPath, stdio: "pipe" as const, timeout: cheapTimeoutMs, env, maxBuffer: VAULT_FLUSH_MAX_BUFFER_BYTES };
      const addOpts = { cwd: this.commitPath, stdio: "pipe" as const, timeout: addTimeoutMs, env, maxBuffer: VAULT_FLUSH_MAX_BUFFER_BYTES };
      const commitOpts = { cwd: this.commitPath, stdio: "pipe" as const, timeout: commitTimeoutMs, env, maxBuffer: VAULT_FLUSH_MAX_BUFFER_BYTES };

      currentOp = { label: "git add -A", timeoutMs: addTimeoutMs };
      execSync("git add -A", addOpts);
      currentOp = { label: "git status --porcelain", timeoutMs: cheapTimeoutMs };
      const staged = execSync("git status --porcelain", cheapOpts).toString().trim();
      if (!staged) return false; // nothing to commit — no-op
      const message = `loom: auto-commit ${new Date().toISOString()} (shutdown flush)`;
      currentOp = { label: "git commit", timeoutMs: commitTimeoutMs };
      // execFileSync, not execSync (card 816f0056 review round 3): the identity-fallback branch
      // interpolates FALLBACK_GIT_IDENTITY into the command — safe TODAY only because that constant
      // happens to contain no spaces/shell metacharacters. A future edit to it (e.g. "Loom Daemon") would
      // silently break the shell-string form (`-c user.name=Loom Daemon` splits at the space, git sees a
      // stray `Daemon` argument, the commit fails) and land in the catch below as a SILENTLY DROPPED
      // shutdown commit — the exact failure class this card exists to close, reopened one constant edit
      // away. execFileSync passes each argument as a real array element, with no shell parsing at all, so
      // this is genuinely argument-safe rather than safe-by-coincidence — real ARGS, matching what this
      // doc's "Identity fallback" paragraph below claims. `git add -A`/`git status --porcelain` above stay
      // on shell-string `execSync`: both are fixed literals with no interpolation, so there is nothing for
      // an argument boundary to protect there.
      if (hasConfiguredGitIdentitySync(cheapOpts)) {
        execFileSync("git", ["commit", "-m", message], commitOpts);
      } else {
        execFileSync(
          "git",
          ["-c", `user.name=${FALLBACK_GIT_IDENTITY.name}`, "-c", `user.email=${FALLBACK_GIT_IDENTITY.email}`, "commit", "-m", message],
          commitOpts,
        );
      }
      return true;
    } catch (err) {
      // best-effort — a missing identity / no-repo / plain git error, OR a bound timeout (execSync
      // throws on timeout expiry, see the doc above) — must never block exit. Card 816f0056 follow-up:
      // this used to be silent, indistinguishable from the benign early-return no-ops above (paused /
      // externally-managed / nothing staged) — but a bound timeout on the WORKING-TREE-SCALE calls can
      // now drop a real, still-in-progress commit here, which is the one cause that represents actual
      // user data not reaching git. One warn line, no restructuring, still never throws.
      const timeoutHit = (err as NodeJS.ErrnoException)?.code === "ETIMEDOUT" && currentOp;
      const detail = timeoutHit
        ? `the "${currentOp!.label}" call exceeded its ~${currentOp!.timeoutMs}ms bound (hung git child? — see this method's own doc for exactly what survives the kill and what doesn't)`
        : ((err as Error)?.message ?? String(err));
      console.warn(`[vault-versioner] ${this.commitPath} shutdown flush FAILED — a pending commit may have been dropped: ${detail}`);
      return false;
    }
  }
}

const PUSH_OUTCOME_FILENAME = "loom-push-outcome.json";

/** Outcome-record path for a repo root — inside `.git/`, same storage convention as the pause lease
 *  above (chokidar-ignored, never git-tracked). Generic over ANY repo `GitWriter` writes to, not just a
 *  vault's governing root — see `recordGitPushOutcome`'s doc for why. */
function pushOutcomePath(repoPath: string): string {
  return path.join(repoPath, ".git", PUSH_OUTCOME_FILENAME);
}

/**
 * Durably record the outcome of an ACTUAL push attempt against `repoPath` (card 614dfbef, origin finding
 * 4ae8a3c9 — "today only an agent doing forensics finds out the remote is rejecting"). The versioner
 * itself never pushes (see the `VaultVersioner` doc above), so this is called from the ONE real
 * chokepoint that does: `GitWriter.push()` (git/writer.ts), reached from the human REST git-write
 * surface, the Platform MCP, and the companion `git-push` capability alike — a single added call there
 * covers every pusher. `repoPath` may be a vault's governing root OR an ordinary project code repo
 * (`GitWriter` doesn't know which); recording is harmless either way — only `checkVaultPushStatus` below
 * ever reads it back, and only for repo roots it already watches. Survives a daemon restart (a plain file
 * under `.git/`). Always overwrites with the LATEST outcome only (no history) so a subsequent successful
 * push cleanly clears a prior failure. Best-effort: never throws into the pusher's own flow.
 */
export function recordGitPushOutcome(repoPath: string, outcome: { ok: true } | { ok: false; error: string }): void {
  try {
    const rec = outcome.ok
      ? { ok: true, at: new Date().toISOString() }
      : { ok: false, at: new Date().toISOString(), error: outcome.error };
    const p = pushOutcomePath(repoPath);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(rec));
  } catch { /* best-effort — never throws into the pusher's own flow */ }
}

/** The most recently recorded push outcome for `repoPath`, iff it was a FAILURE. `null` when the last
 *  recorded outcome was a success, or nothing was ever recorded (fresh install, or every push against this
 *  repo happened outside `GitWriter` — e.g. a manual `git push` at the shell). */
function getGitPushFailure(repoPath: string): { at: string; error: string } | null {
  try {
    const rec = JSON.parse(fs.readFileSync(pushOutcomePath(repoPath), "utf8"));
    if (rec && rec.ok === false && typeof rec.error === "string" && typeof rec.at === "string") {
      return { at: rec.at, error: rec.error };
    }
    return null;
  } catch { return null; }
}

/** One vault's governing repo sitting some number of commits ahead of its configured upstream. */
export interface VaultPushStatus {
  /** The resolved governing repo root (same value as `VaultVersioner.commitRoot`). */
  commitPath: string;
  /** The upstream ref this was measured against, e.g. `origin/main`. */
  upstream: string;
  /** Commits reachable from HEAD but not from `upstream` — i.e. commits the vault has never pushed. */
  ahead: number;
  /** The most recent recorded push FAILURE for this repo (via `GitWriter.push()` → `recordGitPushOutcome`),
   *  present iff the last recorded outcome was a rejection rather than a success. Lets a reader tell
   *  "N ahead, never tried" apart from "N ahead because the remote is actively rejecting". */
  lastFailure?: { at: string; error: string };
}

/**
 * Read-only: how far a vault's governing repo sits ahead of its configured upstream — task f48ee77d's
 * visibility fix (auto-commit is commit-only by design; see the `VaultVersioner` doc above). Returns
 * `null`, cleanly and silently, for a vault repo with NO upstream configured for its current branch —
 * the common case for a fresh local-only vault with no remote at all — so callers can skip it with zero
 * noise instead of reporting a meaningless "ahead of nothing".
 *
 * `@{u}` (`rev-parse --abbrev-ref --symbolic-full-name @{u}`) is git's own answer to "does this branch
 * track a remote, and which one" — it fails fast (non-zero exit) when there is none, which is exactly
 * the skip signal we want. The count itself is the same read-only `rev-list --count <upstream>..HEAD`
 * shape already used (and unit-tested) for worktree branches in `git/worktrees.ts`
 * (`mayRecutOntoMain` / the ahead-checks around lines 434-437, 911-918) — never a fetch, never a write,
 * never a push.
 *
 * **Bounded (card 509716cc)** — `index.ts` UNCONDITIONALLY awaits this (via `logVaultPushStatus`) at
 * boot, 27 lines before `sessions.resumeFleetOnBoot`, wrapped only in a `try/catch` that catches a THROW
 * — never a HANG. A timeout lands in the SAME catch every other git error here already does, returning
 * `null` ("status unknown"), exactly like today's no-upstream/malformed-count paths.
 */
export async function checkVaultPushStatus(commitPath: string, deps: VaultGitDeps = {}): Promise<VaultPushStatus | null> {
  try {
    // simpleGit() itself throws synchronously for a non-existent baseDir — construct it INSIDE the try
    // so a stale/bogus commitPath degrades to "nothing to report", same as any other git error here.
    const { git, timeoutMs } = boundedVaultGit(commitPath, deps);
    const upstream = (await withTimeout(git.raw(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]), timeoutMs, "git rev-parse @{u} (vault push status)")).trim();
    if (!upstream) return null;
    const ahead = parseInt((await withTimeout(git.raw(["rev-list", "--count", `${upstream}..HEAD`]), timeoutMs, "git rev-list --count (vault push status)")).trim(), 10);
    if (!Number.isFinite(ahead)) return null; // malformed count — fail safe to "nothing to report"
    const lastFailure = getGitPushFailure(commitPath);
    return lastFailure ? { commitPath, upstream, ahead, lastFailure } : { commitPath, upstream, ahead };
  } catch {
    return null; // no upstream configured (fatal: no upstream for branch), a timeout, or any other git error
  }
}

/**
 * Check every given vault repo root and log ONE line per vault that has unpushed commits OR a recorded
 * push failure — the actual "N commits un-pushed" / "push is being rejected" visibility surface. A vault
 * with no upstream, or with an upstream, nothing ahead, and no recorded failure, is silent (no noise).
 * Returns the flagged statuses so a caller (boot log, the watcher below, or a test) can assert on them
 * without scraping console output.
 */
export async function logVaultPushStatus(commitPaths: string[]): Promise<VaultPushStatus[]> {
  const statuses = await Promise.all(commitPaths.map((p) => checkVaultPushStatus(p)));
  const unpushed = statuses.filter((s): s is VaultPushStatus => s !== null && (s.ahead > 0 || !!s.lastFailure));
  for (const s of unpushed) {
    if (s.lastFailure) {
      console.log(
        `[vault-push] ${s.commitPath} push REJECTED at ${s.lastFailure.at} (${s.lastFailure.error}) — ` +
        `${s.ahead} commit(s) still unpushed against ${s.upstream}. Fix the remote issue and push manually.`,
      );
    } else {
      console.log(
        `[vault-push] ${s.commitPath} is ${s.ahead} commit(s) ahead of ${s.upstream} ` +
        `(auto-commit is local-only by design — push manually when ready)`,
      );
    }
  }
  return unpushed;
}

/** The slice a periodic ticker needs (injectable so a test drives `tick()` directly, no real timers). */
export interface VaultPushStatusWatcherDeps {
  /** Read the CURRENT set of watched vault repo roots at tick time (not captured once at construction). */
  getCommitPaths: () => string[];
  /** Tick cadence override in ms (tests use a short interval; the daemon uses the default). */
  intervalMs?: number;
}

const DEFAULT_VAULT_PUSH_CHECK_INTERVAL_MS = 30 * 60_000; // 30 minutes — a backlog nudge, not a hot loop

/**
 * Periodic "N vault commits un-pushed" ticker — twin of `DbBackupWatcher` (index.ts), same start/stop
 * shape and best-effort posture. Read-only + additive: every tick only runs `logVaultPushStatus` (git
 * status reads), never a write, never a push.
 */
export class VaultPushStatusWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private deps: VaultPushStatusWatcherDeps) {}

  /** Run one check (best-effort; never throws). Exposed so a test can drive it directly. */
  async tick(): Promise<VaultPushStatus[]> {
    try { return await logVaultPushStatus(this.deps.getCommitPaths()); }
    catch { return []; } // best-effort — a bad tick must never kill the ticker or the daemon
  }

  start(): void {
    if (this.timer) return;
    const ms = this.deps.intervalMs ?? DEFAULT_VAULT_PUSH_CHECK_INTERVAL_MS;
    this.timer = setInterval(() => { void this.tick(); }, ms);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}

/**
 * An OPERATIONAL/daemon-home directory is NOT a docs vault — it is Loom's own state dir (`LOOM_HOME`:
 * `loom.db` + its -wal/-shm, `backups/`, `worktrees/` with node_modules, `logs/`, `tmp/`). The reserved
 * "Loom Platform" home points its `vaultPath` AT this dir, so `startVaultVersioners` must NEVER watch it:
 * a `git add -A` there would stage the LIVE SQLite DB (churn / bloat / commit-mid-write corruption) and
 * chokidar walking `worktrees/`+node_modules thrashes. We detect it by CONTENT (a `loom.db` file or a
 * `worktrees/` dir present — env-independent, the robust PRIMARY signal) with `LOOM_HOME`-equality as
 * belt-and-suspenders. Checked against BOTH the raw vault dir and its resolved governing repo root.
 */
function isOperationalVaultDir(dir: string): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  if (norm(dir) === norm(LOOM_HOME)) return true; // belt-and-suspenders: equals the daemon home
  if (fs.existsSync(path.join(dir, "loom.db"))) return true; // the live daemon DB lives here
  if (fs.existsSync(path.join(dir, "worktrees"))) return true; // worker worktrees (node_modules churn)
  return false;
}

/**
 * Boot wiring for the vault auto-committer: start ONE `VaultVersioner` per UNIQUE live project vault.
 * Factored out of index.ts so the boot wiring is itself testable (the gap this fixes existed precisely
 * because the class was unit-tested in isolation while NEVER wired). index.ts calls this at boot; the
 * test calls it against a temp project + temp vault.
 *
 * - DEDUPE by GOVERNING REPO ROOT (resolved via `resolveVaultRepoContext`), not the raw vaultPath: the
 *   owner's real layout is ONE git repo at the vault root with each project's vaultPath a SUBFOLDER, so N
 *   sibling project-subfolders of the SAME repo must collapse to ONE root watcher (committing the whole
 *   repo once), not one redundant watcher per subfolder. Two projects sharing one exact vaultPath dedupe
 *   the same way (same resolved root).
 * - SKIP an Obsidian-Git-managed repo: a real external auto-committer already owns its history, so we
 *   start NO watcher for it (and thus never commit) — the structural backoff for that layout.
 * - SKIP projects with no vaultPath (an unset string) and archived ones. `listAllProjects()` already
 *   excludes archived (and includes reserved homes, whose vaults agents do edit) — the archivedAt guard
 *   is belt-and-suspenders.
 *
 * Returns the started versioners so the caller can `flushSync()`/`stop()` them on shutdown.
 */
export async function startVaultVersioners(db: Db, opts?: { debounceMs?: number }): Promise<VaultVersioner[]> {
  const started: VaultVersioner[] = [];
  const seen = new Set<string>();
  for (const project of db.listAllProjects()) {
    if (project.archivedAt) continue;
    const vaultPath = project.vaultPath?.trim();
    if (!vaultPath) continue;
    // Per-project isolation: resolve+construct+start() can THROW on a bad/inaccessible vaultPath
    // (simpleGit construction or start()'s git calls). Guard each project so ONE bad vaultPath is
    // logged + skipped and the rest still start — best-effort, mirroring the boot-watcher /
    // worktree-provision posture (the boot caller wraps the WHOLE call, so an unguarded throw here
    // would poison every subsequent project).
    try {
      // Resolve to the governing repo root FIRST so the dedupe key + the back-off decision both key off
      // the root, collapsing sibling project-subfolders of one repo to a single watcher.
      const ctx = await resolveVaultRepoContext(vaultPath);
      // SKIP operational/daemon-home vaults (a reserved/.loom-rooted home is NOT a docs vault) — checked
      // against both the raw vault dir and the resolved governing repo root. BEFORE constructing/starting.
      if (isOperationalVaultDir(vaultPath) || isOperationalVaultDir(ctx.commitPath)) {
        console.warn(`[vault-versioner] project ${project.id} vault (${vaultPath}) is an operational/daemon-home dir (loom.db/worktrees/LOOM_HOME) — skipping; not a docs vault.`);
        continue;
      }
      const key = ctx.commitPath.replace(/\\/g, "/");
      if (seen.has(key)) continue; // already watching this repo root
      seen.add(key);
      if (ctx.externallyManaged) continue; // Obsidian-Git owns this history — no loom watcher/commit
      const versioner = new VaultVersioner(vaultPath, opts?.debounceMs);
      await versioner.start();
      started.push(versioner);
    } catch (err) {
      console.warn(`[vault-versioner] project ${project.id} vault (${vaultPath}) failed to start (${(err as Error).message}); skipping — other projects' versioners still start.`);
    }
  }
  return started;
}
