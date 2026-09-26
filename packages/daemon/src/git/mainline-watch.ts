import { canonicalGit } from "./bounded.js";
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
}

export type MainlineEvidence = "reflog-raw-write" | "loom-branch-reachable" | "rewind-raw-write";
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
  if (f.truncated || f.watermarkMissing) return out("unverifiable");
  let raw: string[] = [];
  if (f.reflog) {
    const at = f.reflog.findIndex((e) => e.sha === watermarkSha);
    // W absent from the reflog (deleted/expired) ⇒ the reflog signal is unavailable, never "all entries are newer than W".
    if (at >= 0) raw = f.reflog.slice(0, at).filter((e) => isRawReflogMessage(e.msg)).map((e) => e.msg);
  }
  const evidence: MainlineEvidence[] = [];
  const suspect: string[] = [];
  if (raw.length > 0) {
    if (!f.forward) { evidence.push("rewind-raw-write"); }
    else if (f.untrailered.length > 0) { evidence.push("reflog-raw-write"); suspect.push(...f.untrailered); }
  }
  if (f.loomTipHits.length > 0) { evidence.push("loom-branch-reachable"); suspect.push(...f.loomTipHits); }
  if (evidence.length === 0) return out("explained");
  return out("alert", evidence, [...new Set(suspect)].slice(0, 10), raw.slice(0, 5));
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms); })]).finally(() => clearTimeout(t));
};

/** The canonical checkout's current branch + tip. `null` when detached/unborn (nothing to watch). */
export async function readMainlineHead(repoPath: string, timeoutMs: number): Promise<{ branch: string; tip: string } | null> {
  const git = canonicalGit(repoPath, timeoutMs);
  let branch: string;
  try { branch = (await withTimeout(git.raw(["symbolic-ref", "--short", "-q", "HEAD"]), timeoutMs, "git symbolic-ref HEAD")).trim(); } catch { return null; }
  if (!branch) return null;
  const tip = (await withTimeout(git.raw(["rev-parse", "--verify", `refs/heads/${branch}`]), timeoutMs, "git rev-parse")).trim();
  return /^[0-9a-f]{40,64}$/.test(tip) ? { branch, tip } : null;
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

/** Reads everything {@link classifyMainlineMove} needs, through `canonicalGit`, every call bounded by `timeoutMs`. THROWS on any git failure — the caller fails open. */
export async function readMainlineFacts(repoPath: string, watermarkSha: string, head: { branch: string; tip: string }, timeoutMs: number): Promise<MainlineFacts> {
  const git = canonicalGit(repoPath, timeoutMs);
  const run = (args: string[]) => withTimeout(git.raw(args), timeoutMs, `git ${args[0]}`);
  const facts: MainlineFacts = { branch: head.branch, tip: head.tip, reflog: null, forward: true, untrailered: [], loomTipHits: [], truncated: false, watermarkMissing: false };
  try { await run(["rev-parse", "--verify", "--quiet", `${watermarkSha}^{commit}`]); } catch { facts.watermarkMissing = true; return facts; }
  try { await run(["merge-base", "--is-ancestor", watermarkSha, head.tip]); } catch { facts.forward = false; }
  // Reflog (newest-first). One extra entry past the cap distinguishes "cap hit" from "exactly the cap".
  const rl = (await run(["reflog", "show", `--max-count=${MAINLINE_RANGE_CAP + 1}`, "--format=%H%x1f%gs", `refs/heads/${head.branch}`])).split("\n").filter(Boolean);
  facts.reflog = rl.length === 0 ? null : rl.map((l) => { const [sha = "", msg = ""] = l.split("\x1f"); return { sha, msg }; });
  // The cap bounds the WINDOW, not the reflog: a long history BEFORE W is irrelevant. It is only "unverifiable" when the window filled up without ever reaching W.
  if (rl.length > MAINLINE_RANGE_CAP && !(facts.reflog ?? []).some((e) => e.sha === watermarkSha)) { facts.truncated = true; return facts; }
  if (!facts.forward) return facts;
  // First-parent range with messages (trailers).
  const log = await run(["log", "--first-parent", `--max-count=${MAINLINE_RANGE_CAP + 1}`, "--format=%x1e%H%x1f%B", `${watermarkSha}..${head.tip}`]);
  const commits = log.split("\x1e").filter((r) => r.trim() !== "");
  if (commits.length > MAINLINE_RANGE_CAP) { facts.truncated = true; return facts; }
  for (const c of commits) {
    const [sha = "", body = ""] = c.split("\x1f");
    if (!parseLoomTrailerBlock(body)) facts.untrailered.push(sha.trim());
  }
  // Loom worker branch tips that became reachable (any parent) — a squash/cherry-pick landing never puts a worker tip into main's history.
  // The loom-tip signal is best-effort: exceeding one of ITS caps skips ONLY this signal (recorded in `loomTipsSkipped`) — the reflog-raw-write evidence above is independent and still applies.
  const hits = await collectLoomTipHits(run, watermarkSha, head.tip);
  if (hits === null) facts.loomTipsSkipped = true; else facts.loomTipHits = hits;
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
  const hits: string[] = [];
  for (const r of candidates) {
    // A branch with NO commits of its own has a tip that IS a mainline commit (createWorktree cuts off the current HEAD), so it is reachable from main
    // through any ordinary move. Only a tip the branch itself CREATED can be a bypass — see branchAuthoredTip.
    if (await branchAuthoredTip(run, r.ref, r.sha)) hits.push(r.sha);
  }
  return hits;
}
