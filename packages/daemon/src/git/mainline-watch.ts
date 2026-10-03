import type { SimpleGit } from "simple-git";
import { canonicalGit, localReadGitEnv } from "./bounded.js";
import { parseLoomTrailerBlock } from "./worktrees.js";

/**
 * @decision 4fa36502 — a TRIPWIRE, never a sandbox and never a refusal: an error here skips (fail-open), every read is capped, only strong signals alert.
 *
 * Detects "the mainline moved without a Loom landing": a worker's worktree shares the canonical `.git`, so it can
 * `git update-ref refs/heads/<main>` past the merge gate. The shared reflog records NO worktree identity, so the
 * discriminators are (a) a reflog entry whose message is empty/non-porcelain (a raw ref write), and (b) a
 * trailer-less `loom/*` branch tip that became reachable from the mainline.
 */

/** Cap on the `W..tip` walk (commits) and on the reflog read (entries) — past it the watermark is "unverifiable", never scanned unbounded. */
export const MAINLINE_RANGE_CAP = 500;
/** Cap on the `refs/heads/loom/` refs considered. */
export const MAINLINE_LOOM_REF_CAP = 500;
/** Cap on how many in-range `loom/*` tips get the authored-tip reflog check (one git call each) — past it the move is "unverifiable". */
export const MAINLINE_LOOM_TIP_CHECK_CAP = 20;
export const MAINLINE_WATERMARK_PREFIX = "mainline-watermark:";

export const mainlineWatermarkKey = (projectId: string, repoKey: string): string => `${MAINLINE_WATERMARK_PREFIX}${projectId}:${repoKey}`;

export interface MainlineWatermark { branch: string; sha: string }

export function parseMainlineWatermark(raw: string | undefined): MainlineWatermark | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<MainlineWatermark>;
    return typeof v.branch === "string" && typeof v.sha === "string" && /^[0-9a-f]{40,64}$/.test(v.sha) ? { branch: v.branch, sha: v.sha } : null;
  } catch { return null; }
}

/** @decision 77b8319b — never collapse a present-but-unreadable row into "absent": a caller that falls
 * back to a live read on "no watermark" must refuse instead on "unreadable", never silently heal it. */
export type MainlineWatermarkReadState =
  | { state: "absent" }
  | { state: "ok"; watermark: MainlineWatermark }
  | { state: "unreadable" };

export function readMainlineWatermarkStrict(raw: string | undefined): MainlineWatermarkReadState {
  if (raw === undefined) return { state: "absent" };
  const w = parseMainlineWatermark(raw);
  return w ? { state: "ok", watermark: w } : { state: "unreadable" };
}

/** Reflog messages git itself writes for a porcelain move (commit / merge / pull / reset / rebase / fetch …). A raw `git update-ref` without `-m` writes an EMPTY message. Spoofable by `-m` — a hint, not proof. */
const PORCELAIN_REFLOG = /^(commit(?: \((?:amend|merge|initial|cherry-pick|revert)\))?:|merge\b|pull\b|reset:|rebase\b|fetch\b|cherry-pick\b|revert\b|am\b|update by push\b|checkout:|branch:)/;
export const isRawReflogMessage = (msg: string): boolean => !PORCELAIN_REFLOG.test(msg.trim());

export interface MainlineFacts {
  branch: string;
  tip: string;
  /** Reflog entries newest-first ({new sha, message}); `null` when unavailable (bare repo / logging off / no entries). */
  reflog: Array<{ sha: string; msg: string }> | null;
  /** True when `W` is an ancestor of `tip` (a forward move); false = rewind/divergence. */
  forward: boolean;
  /** First-parent commits in `W..tip` that carry NO Loom trailer. */
  untrailered: string[];
  /** Trailer-less `loom/*` branch tips reachable from `tip` but not from `W`. */
  loomTipHits: string[];
  /** The walk or reflog exceeded its cap. */
  truncated: boolean;
  /** `W` is not a resolvable commit any more. */
  watermarkMissing: boolean;
  /** The loom-tip signal exceeded one of its own caps and was SKIPPED (not "no hits"); the reflog-raw-write signal is unaffected. */
  loomTipsSkipped?: boolean;
  /** Set with `loomTipsSkipped` when the skip was caused by the aggregate deadline (not a cap): an "explained" verdict is then NOT final. */
  loomTipsDeadline?: boolean;
}

export type MainlineEvidence = "reflog-raw-write" | "loom-branch-reachable" | "rewind-raw-write" | "watermark-missing";

/** Reason text on the event a POSITIVELY-missing watermark files (alert-class: a mainline commit never becomes unresolvable in normal operation). */
export const MAINLINE_WATERMARK_MISSING_REASON = "watermark commit no longer resolvable (possible reflog expire/prune or force-rewrite)";
/** Reason text on the LOW event a loom-tip CAP skip files (the reflog signal still ran; only the loom-tip signal was blind). */
export const MAINLINE_LOOM_TIP_CAP_REASON = "loom-tip signal skipped (cap)";

/**
 * @decision 4fa36502 — a boot alert is remembered per (project, repoKey) as an `app_meta` marker so it is filed ONCE per move and delivered ONCE to a manager (`nudgedAt`, claimed by compare-and-set).
 * JSON `{branch, from, to, evidence, suspectShas, nudgedAt}`; deleted when the move is settled (W stored) and by `deleteProject`.
 */
export const MAINLINE_BOOT_ALERT_PREFIX = "mainline-boot-alerted:";
export const mainlineBootAlertKey = (projectId: string, repoKey: string): string => `${MAINLINE_BOOT_ALERT_PREFIX}${projectId}:${repoKey}`;
/** `expectedBranch` (set only on a branch-diverted marker) lets a later delivery render the divert text accurately.
 * @decision 2a6a292a — do not infer `source` from `atBoot` at delivery time: a landing-time divert whose own inline nudge failed must be delivered later with landing wording, never boot's "(found when the daemon started)". */
export interface MainlineBootAlert { branch: string; from: string; to: string; evidence: string[]; suspectShas: string[]; nudgedAt: string | null; expectedBranch?: string; source?: "boot" | "landing" }
export function parseMainlineBootAlert(raw: string | undefined): MainlineBootAlert | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<MainlineBootAlert>;
    if (typeof v.branch !== "string" || typeof v.from !== "string" || typeof v.to !== "string") return null;
    return {
      branch: v.branch, from: v.from, to: v.to, evidence: Array.isArray(v.evidence) ? v.evidence.map(String) : [], suspectShas: Array.isArray(v.suspectShas) ? v.suspectShas.map(String) : [], nudgedAt: typeof v.nudgedAt === "string" ? v.nudgedAt : null,
      ...(typeof v.expectedBranch === "string" ? { expectedBranch: v.expectedBranch } : {}),
      ...(v.source === "boot" || v.source === "landing" ? { source: v.source } : {}),
    };
  } catch { return null; }
}

/**
 * THE `[loom:mainline-moved]` nudge text — an addressed directive (exact commands + who to ask), shared by the landing path and the boot-alert delivery so there is ONE copy.
 * @decision 2a6a292a round 2 — a `branch-diverted` move is NOT a mainline-tip move at all (the tip usually hasn't changed; a checkout alone never moves it), so it gets its OWN
 * wording rather than the generic `from -> to` / `git log A..B` text: that text is actively misleading for a divert (an empty `git log X..X` for a same-commit checkout, and
 * "treat as a bypass of the merge gate" when the likely cause is an ordinary checkout, not a forged ref write).
 */
export function mainlineMovedNudgeText(a: { branch: string; repoKey: string; from: string; to: string; evidence: string[]; suspectShas: string[]; atBoot: boolean; expectedBranch?: string }): string {
  const suspects = a.suspectShas.map((x) => x.slice(0, 8)).join(", ") || "none";
  if (a.evidence.includes("branch-diverted")) {
    const expected = a.expectedBranch ?? "(unknown — see the event's own expectedBranch field)";
    return `[loom:mainline-moved] repo "${a.repoKey}" is checked out on "${a.branch}", not the expected mainline branch "${expected}"${a.atBoot ? " (found when the daemon started)" : ""} (evidence: branch-diverted; tip ${a.to.slice(0, 8)}). ` +
      `The likely cause is a checkout away from "${expected}" in the canonical repo — a human REST GitWriter checkout/branch create, the Platform Lead's own git_checkout/git_create_branch, or a stray manual checkout. This is a tripwire, not a block: merges continue, but the NEXT landing would land OFF the expected mainline branch while this persists. ` +
      `ACTION for you (the manager): check out "${expected}" again in the canonical repo to resume normal landings; if "${a.branch}" is actually a deliberate mainline RENAME, ask the owner to reset this project's mainline baseline (POST /api/projects/:id/mainline-watermark/reset, loopback, human-only — the only way to move this baseline onto a new branch name).`;
  }
  return `[loom:mainline-moved] ${a.branch} in repo "${a.repoKey}" moved ${a.from.slice(0, 8)} -> ${a.to.slice(0, 8)} WITHOUT a Loom landing${a.atBoot ? " (found when the daemon started)" : ""} (evidence: ${a.evidence.join(", ")}; suspect ${suspects}). ` +
    `A worker can write refs/heads/${a.branch} through the shared .git; a human's own raw \`git update-ref\` looks the same. This is a tripwire, not a block: merges continue. ` +
    (a.evidence.includes("watermark-missing")
      ? `The baseline ${a.from.slice(0, 8)} no longer exists in the repo (a rewrite plus prune, or a reflog expire). ACTION for you (the manager): in that repo run \`git reflog show ${a.branch}\` and \`git log --oneline -20 ${a.to}\`, ask the owner whether they rewrote or pruned history, and report what you find; if they did not, treat it as a bypass of the merge gate.`
      : `ACTION for you (the manager): in that repo run \`git log --oneline ${a.from}..${a.to}\` and \`git reflog show ${a.branch}\`, ask the owner whether this move was theirs, and report what you find; if it was not, treat it as a bypass of the merge gate.`);
}
export interface MainlineVerdict {
  verdict: "unchanged" | "explained" | "alert" | "unverifiable";
  evidence: MainlineEvidence[];
  suspectShas: string[];
  rawReflogMessages: string[];
}

/** PURE. `W` = the watermark sha. Strong signals only: a benign move (a human commit/merge/pull/reset, a Loom landing) is `explained` and silent. */
export function classifyMainlineMove(watermarkSha: string, f: MainlineFacts): MainlineVerdict {
  const out = (verdict: MainlineVerdict["verdict"], evidence: MainlineEvidence[] = [], suspectShas: string[] = [], raw: string[] = []): MainlineVerdict => ({ verdict, evidence, suspectShas, rawReflogMessages: raw });
  if (f.tip === watermarkSha) return out("unchanged");
  // @decision 4fa36502 — a POSITIVELY missing W is ALERT-class (a mainline commit never becomes unresolvable in normal operation: rewrite + prune, or a reflog expire); "unverifiable" here absorbed a deliberate erasure. An ERROR reading it never reaches here (readMainlineFacts throws).
  if (f.watermarkMissing) return out("alert", ["watermark-missing"], [f.tip]);
  if (f.truncated) return out("unverifiable");
  let raw: string[] = [];
  if (f.reflog) {
    const at = f.reflog.findIndex((e) => e.sha === watermarkSha);
    // W absent from the reflog (deleted/expired) ⇒ the reflog signal is unavailable, never "all entries are newer than W".
    if (at >= 0) raw = f.reflog.slice(0, at).filter((e) => isRawReflogMessage(e.msg)).map((e) => e.msg);
  }
  const evidence: MainlineEvidence[] = [];
  const suspect: string[] = [];
  if (raw.length > 0) {
    if (!f.forward) { evidence.push("rewind-raw-write"); suspect.push(f.tip); } // a rewind/divergence has no in-range commits to name: the tip main was written onto is the suspect
    else if (f.untrailered.length > 0) { evidence.push("reflog-raw-write"); suspect.push(...f.untrailered); }
  }
  if (f.loomTipHits.length > 0) { evidence.push("loom-branch-reachable"); suspect.push(...f.loomTipHits); }
  if (evidence.length === 0) return out("explained");
  return out("alert", evidence, [...new Set(suspect)].slice(0, 10), raw.slice(0, 5));
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string, onTimeout: () => Error = () => new Error(`${what} timed out after ${ms}ms`)): Promise<T> => {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(onTimeout()), ms); })]).finally(() => clearTimeout(t));
};

/** Thrown by {@link readMainlineFacts}'s bounded runner once the aggregate deadline has passed. */
export class MainlineDeadlineError extends Error {
  constructor(what: string) { super(`mainline check deadline exceeded (${what})`); this.name = "MainlineDeadlineError"; }
}

/**
 * Card b801bad0 — PURE parse of `git rev-parse HEAD --symbolic-full-name HEAD`'s two-line output (verified
 * directly: `--symbolic-full-name` applies to args positionally, not invocation-wide, so the FIRST `HEAD`
 * — before the flag — still resolves to the raw sha; the manager's own first-suggested invocation,
 * `--symbolic-full-name HEAD HEAD`, does NOT work — confirmed it prints the symbolic form TWICE, since the
 * flag, appearing before both args, governs both). Line 1 is always the sha; line 2 is either
 * `refs/heads/<branch>` or the literal `HEAD` (git's own documented fallback when nothing nameable
 * resolves — covers detached HEAD). Fails CLOSED (returns `null`) on anything else: wrong line count, an
 * unparseable sha, or a non-`refs/heads/` second line (defensive — never observed for a HEAD resolution,
 * but this function never guesses).
 */
export function parseHeadShaAndBranch(output: string): { sha: string; branch: string | null } | null {
  const lines = output.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length !== 2) return null;
  const sha = lines[0]!, ref = lines[1]!;
  if (!/^[0-9a-f]{40,64}$/.test(sha)) return null;
  if (ref === "HEAD") return { sha, branch: null }; // detached — git's own fallback, never a guess
  if (!ref.startsWith("refs/heads/")) return null; // some other non-branch ref — fail closed
  const branch = ref.slice("refs/heads/".length);
  return branch ? { sha, branch } : null;
}

/** ONE spawn (card b801bad0 — down from two): `git rev-parse HEAD --symbolic-full-name HEAD`, parsed by
 *  {@link parseHeadShaAndBranch}. Never throws — any spawn failure or unparseable output returns `null`. */
export async function readHeadShaAndBranch(
  git: Pick<SimpleGit, "raw">, timeoutMs: number, what: string,
): Promise<{ sha: string; branch: string | null } | null> {
  try {
    const out = await withTimeout(git.raw(["rev-parse", "HEAD", "--symbolic-full-name", "HEAD"]), timeoutMs, what);
    return parseHeadShaAndBranch(out);
  } catch { return null; }
}

/** The canonical checkout's current branch + tip. `null` when detached/unborn (nothing to watch). */
export async function readMainlineHead(repoPath: string, timeoutMs: number): Promise<{ branch: string; tip: string } | null> {
  const r = await readHeadShaAndBranch(canonicalGit(repoPath, timeoutMs), timeoutMs, "git rev-parse HEAD + symbolic-full-name HEAD");
  return r?.branch ? { branch: r.branch, tip: r.sha } : null;
}

/**
 * Does this branch-reflog entry mean the branch CREATED the commit object `sha`? The test is "a new object was made", NOT "the ref moved": a fast-forward
 * (`merge <x>: Fast-forward`, which is also what Loom's own mergeMainIntoWorktree does to a no-commit branch) and a rebase with nothing to replay
 * (`rebase (finish): … onto <sha>` where the tip IS the onto commit) only move the ref onto a commit main already had. `commit`/`cherry-pick`/`am` always make one;
 * a non-fast-forward `merge` makes a merge commit; a rebase finish that replayed something ends on a new tip that differs from its onto sha.
 * Not observable from the branch reflog: a spoofed `update-ref -m "commit: …"` on the branch itself (a worker forging its own branch log) — the raw-write signal still applies to the main move.
 */
export function isAuthoredBranchReflog(msg: string, sha: string): boolean {
  if (/^(commit\b|cherry-pick\b|am\b)/.test(msg)) return true;
  if (/^merge\b/.test(msg)) return !/:\s*Fast-forward\s*$/.test(msg);
  if (/^rebase\b/.test(msg)) {
    const onto = /\bonto ([0-9a-f]{7,64})\s*$/.exec(msg)?.[1];
    return /^rebase \(finish\)/.test(msg) && onto ? !sha.startsWith(onto) : true;
  }
  return false;
}
/**
 * @decision 4fa36502 — a loom/* tip only counts as a bypass when the branch's OWN reflog shows it authored that sha; a branch with no commits of its own (tip == its creation point) is not evidence.
 * A missing/empty branch reflog (logging off, or deleted) reads as "cannot tell" ⇒ NOT a hit: a silent miss beats a false alert on every spawn.
 */
async function branchAuthoredTip(run: (args: string[]) => Promise<string>, ref: string, sha: string): Promise<boolean> {
  const lines = (await run(["reflog", "show", `--max-count=${MAINLINE_RANGE_CAP}`, "--format=%H%x1f%gs", ref])).split("\n").filter(Boolean);
  return lines.some((l) => { const [s = "", msg = ""] = l.split("\x1f"); return s === sha && isAuthoredBranchReflog(msg, sha); });
}

/** The first parent of `sha`, or `null` (root commit / unreadable). */
export async function readFirstParent(repoPath: string, sha: string, timeoutMs: number): Promise<string | null> {
  try {
    const out = (await withTimeout(canonicalGit(repoPath, timeoutMs).raw(["rev-parse", "--verify", "--quiet", `${sha}^1`]), timeoutMs, "git rev-parse")).trim();
    return /^[0-9a-f]{40,64}$/.test(out) ? out : null;
  } catch { return null; }
}

/**
 * Is `ancestor` an ancestor of (or equal to) `descendant`? Compares `merge-base` OUTPUT, never `merge-base --is-ancestor`'s exit status (simple-git's `raw()` resolves a
 * non-zero exit with empty stderr as success — decision bc2240d7). THROWS on a git failure — the caller fails open (no advance). `run` (default: a bounded canonical read) lets
 * {@link readMainlineFacts} route the same check through its deadline-bounded runner: ONE helper, no second copy.
 */
export async function isAncestorCommit(repoPath: string, ancestor: string, descendant: string, timeoutMs: number, run?: (args: string[]) => Promise<string>): Promise<boolean> {
  const args = ["merge-base", ancestor, descendant];
  const out = (await (run ? run(args) : withTimeout(canonicalGit(repoPath, timeoutMs).raw(args), timeoutMs, "git merge-base"))).trim();
  return out === ancestor;
}

/** Reads everything {@link classifyMainlineMove} needs, through `canonicalGit`, every call bounded by `timeoutMs`. THROWS on any git failure — the caller fails open. */
export async function readMainlineFacts(repoPath: string, watermarkSha: string, head: { branch: string; tip: string }, timeoutMs: number, deadlineAt?: number, runOverride?: (args: string[]) => Promise<string>): Promise<MainlineFacts> {
  const git = canonicalGit(repoPath, timeoutMs);
  // Aggregate deadline (card 0eb7ff27; `deadlineAt` is a `performance.now()` value, monotonic): each call is bounded by min(per-call timeout, time left). When the TIME LEFT is what bounds the call,
  // the timer itself rejects with MainlineDeadlineError — the cause is never inferred from the clock afterwards (a timer can fire a hair early, which would read as an ordinary error).
  const runOn = (g: typeof git) => async (args: string[]): Promise<string> => {
    const what = `git ${args[0]}`;
    if (deadlineAt === undefined) return withTimeout(g.raw(args), timeoutMs, what);
    const left = deadlineAt - performance.now();
    if (left <= 0) throw new MainlineDeadlineError(what);
    return left >= timeoutMs ? withTimeout(g.raw(args), timeoutMs, what) : withTimeout(g.raw(args), left, what, () => new MainlineDeadlineError(what));
  };
  const run = runOverride ?? runOn(git);
  // @decision 4fa36502 — the missing-watermark probe reads git's not-found MESSAGE, so it runs with the locale pinned (LC_ALL/LANGUAGE=C): a localized or reworded message would otherwise fail open forever (W stays missing, every check rethrows, nothing is filed).
  const runProbe = runOverride ?? runOn(canonicalGit(repoPath, timeoutMs, localReadGitEnv(process.env, { LC_ALL: "C", LANGUAGE: "C" })));
  const facts: MainlineFacts = { branch: head.branch, tip: head.tip, reflog: null, forward: true, untrailered: [], loomTipHits: [], truncated: false, watermarkMissing: false };
  // @decision 4fa36502 — both reads compare git's OUTPUT, never an exit status (simple-git resolves a non-zero exit with empty stderr as success, bc2240d7), and ANY error here (timeout, spawn
  // failure, deadline) propagates: the caller fails open with W untouched. An error must never be filed as "W missing" or "rewound" — that would store W and absorb the move.
  const resolved = (await run(["rev-parse", "--verify", "--quiet", `${watermarkSha}^{commit}`])).trim();
  if (!/^[0-9a-f]{40,64}$/.test(resolved)) {
    // @decision 4fa36502 — empty output is NOT proof: simple-git resolves an EXTERNALLY killed child (no exit code, empty stderr) as success with empty stdout. "Missing" needs git's OWN answer: `cat-file -t` REJECTS with its not-found message
    // for an absent object (a killed child cannot say that); a `commit` answer means the empty rev-parse was a kill; anything else is a read error.
    let type = "";
    try { type = (await runProbe(["cat-file", "-t", watermarkSha])).trim(); }
    catch (err) { if (err instanceof MainlineDeadlineError || !/could not get object info|not a valid object|bad object|unable to read|invalid object/i.test(err instanceof Error ? err.message : String(err))) throw err; facts.watermarkMissing = true; return facts; }
    if (type && type !== "commit") { facts.watermarkMissing = true; return facts; } // exists but is not a commit: no usable baseline
    throw new Error("watermark rev-parse printed nothing and git gave no positive not-found answer (killed child?): a read error, never 'missing'");
  }
  facts.forward = await isAncestorCommit(repoPath, watermarkSha, head.tip, timeoutMs, run);
  // Reflog (newest-first). One extra entry past the cap distinguishes "cap hit" from "exactly the cap".
  const rl = (await run(["reflog", "show", `--max-count=${MAINLINE_RANGE_CAP + 1}`, "--format=%H%x1f%gs", `refs/heads/${head.branch}`])).split("\n").filter(Boolean);
  facts.reflog = rl.length === 0 ? null : rl.map((l) => { const [sha = "", msg = ""] = l.split("\x1f"); return { sha, msg }; });
  // The cap bounds the WINDOW, not the reflog: a long history BEFORE W is irrelevant. It is only "unverifiable" when the window filled up without ever reaching W.
  if (rl.length > MAINLINE_RANGE_CAP && !(facts.reflog ?? []).some((e) => e.sha === watermarkSha)) { facts.truncated = true; return facts; }
  // @decision 4fa36502 — NO derived fact (forward, …) short-circuits the range read and the loom-tip scan: a divergence has a well-defined `W..tip`, and the loom-tip signal is the only one that sees a forged-message bypass. Only the cap/deadline paths skip it.
  // First-parent range with messages (trailers).
  const log = await run(["log", "--first-parent", `--max-count=${MAINLINE_RANGE_CAP + 1}`, "--format=%x1e%H%x1f%B", `${watermarkSha}..${head.tip}`]);
  const commits = log.split("\x1e").filter((r) => r.trim() !== "");
  if (commits.length > MAINLINE_RANGE_CAP) { facts.truncated = true; return facts; }
  for (const c of commits) {
    const [sha = "", body = ""] = c.split("\x1f");
    if (!parseLoomTrailerBlock(body)) facts.untrailered.push(sha.trim());
  }
  // Loom worker branch tips that became reachable (any parent) — a squash/cherry-pick landing never puts a worker tip into main's history.
  // The loom-tip signal is best-effort: exceeding one of ITS caps — or the aggregate deadline — skips ONLY this signal (recorded in `loomTipsSkipped`); the reflog-raw-write evidence above is independent and still applies.
  // A deadline hit BEFORE the reflog + range reads finish still throws (fail-open, W untouched) — there is no evidence yet to keep.
  // `loomTipsDeadline` marks a skip CAUSED BY THE DEADLINE (unlike a cap skip): the loom-tip signal is the only one that catches a bypass with a porcelain-looking reflog message,
  // so the caller must not treat "explained" as final after it (see checkMainlineMove).
  let hits: string[] | null; let deadlineHit = false;
  try { hits = await collectLoomTipHits(run, watermarkSha, head.tip); }
  catch (err) { if (!(err instanceof MainlineDeadlineError)) throw err; hits = null; deadlineHit = true; }
  if (hits === null) { facts.loomTipsSkipped = true; if (deadlineHit) facts.loomTipsDeadline = true; } else facts.loomTipHits = hits;
  return facts;
}

/** Cap on the sha arguments handed to the single `git log --no-walk` call (Windows command-line limit). */
const MAINLINE_LOOM_TIP_ARGS_CAP = 300;

/** In-range, trailer-less `loom/*` tips whose branch AUTHORED that sha. `null` = a cap was exceeded, the signal was skipped (not "no hits"). */
async function collectLoomTipHits(run: (args: string[]) => Promise<string>, watermarkSha: string, tip: string): Promise<string[] | null> {
  const refs = (await run(["for-each-ref", `--count=${MAINLINE_LOOM_REF_CAP + 1}`, "--format=%(objectname) %(refname)", "refs/heads/loom/"])).split("\n").filter(Boolean);
  if (refs.length > MAINLINE_LOOM_REF_CAP) return null;
  if (refs.length === 0) return [];
  const all = (await run(["rev-list", `--max-count=${MAINLINE_RANGE_CAP + 1}`, `${watermarkSha}..${tip}`])).split("\n").filter(Boolean);
  if (all.length > MAINLINE_RANGE_CAP) return null;
  const inRange = new Set(all);
  const inRangeRefs = refs.map((r) => { const i = r.indexOf(" "); return { sha: r.slice(0, i), ref: r.slice(i + 1) }; }).filter((r) => inRange.has(r.sha));
  if (inRangeRefs.length === 0) return [];
  if (inRangeRefs.length > MAINLINE_LOOM_TIP_ARGS_CAP) return null;
  // ONE call for every candidate tip's message, not one per tip.
  const bodies = (await run(["log", "--no-walk=unsorted", "--format=%x1e%H%x1f%B", ...new Set(inRangeRefs.map((r) => r.sha))])).split("\x1e").filter((r) => r.trim() !== "");
  const trailered = new Set(bodies.filter((b) => parseLoomTrailerBlock(b.split("\x1f")[1] ?? "")).map((b) => (b.split("\x1f")[0] ?? "").trim()));
  // The cap applies to what is LEFT after trailered (Loom-landed) tips are dropped — those need no reflog check.
  const candidates = inRangeRefs.filter((r) => !trailered.has(r.sha));
  if (candidates.length > MAINLINE_LOOM_TIP_CHECK_CAP) return null;
  return authoredTipHits(run, candidates);
}

/**
 * Which candidates' branches AUTHORED their tip. ONE `git log -g` over every candidate ref (the `%gD` selector, the FULL ref as passed, names the ref each entry belongs to, so per-branch discrimination is kept);
 * only when that shared read fills its own cap (a chatty branch could crowd another out of a global count) does it fall back to the exact per-branch {@link branchAuthoredTip} calls.
 */
async function authoredTipHits(run: (args: string[]) => Promise<string>, candidates: Array<{ sha: string; ref: string }>): Promise<string[]> {
  if (candidates.length === 0) return []; // `git log -g` with no ref would walk HEAD's reflog
  const hits: string[] = [];
  const cap = MAINLINE_RANGE_CAP * candidates.length;
  const lines = (await run(["log", "-g", `--max-count=${cap}`, "--format=%H%x1f%gs%x1f%gD", ...candidates.map((c) => c.ref)])).split("\n").filter(Boolean);
  if (lines.length >= cap) {
    for (const r of candidates) { if (await branchAuthoredTip(run, r.ref, r.sha)) hits.push(r.sha); }
    return hits;
  }
  const perRef = new Map<string, Array<{ sha: string; msg: string }>>();
  for (const l of lines) {
    const [s = "", msg = "", gd = ""] = l.split("\x1f");
    const at = gd.lastIndexOf("@{");
    const n = Number(gd.slice(at + 2, -1));
    if (at < 0 || !(n < MAINLINE_RANGE_CAP)) continue; // same per-branch window as branchAuthoredTip
    const sel = gd.slice(0, at);
    const ref = candidates.find((c) => c.ref === sel)?.ref; // EXACT equality: a suffix match would credit one branch with another's entries (refs/heads/loom/0/loom/a vs refs/heads/loom/a)
    if (ref === undefined) continue;
    (perRef.get(ref) ?? perRef.set(ref, []).get(ref)!).push({ sha: s, msg });
  }
  for (const r of candidates) {
    if ((perRef.get(r.ref) ?? []).some((e) => e.sha === r.sha && isAuthoredBranchReflog(e.msg, r.sha))) hits.push(r.sha);
  }
  return hits;
}
