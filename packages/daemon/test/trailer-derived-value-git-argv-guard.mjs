import "./_guard.mjs";
// Card b8122303 — SOURCE-TEXT guard (no daemon, no build beyond tsc, no real git): no expression reading
// a candidate-supplied, trailer-derived value (`trailers.base`, `trailers.landedTip`, `trailers.pathSet`,
// a MergedMapEntry's `.baseSha`, a direct `parseLoomTrailerBlock(...)?.landedTip`-shaped producer chain,
// or a `readLandedTipTrailer(` call) may appear anywhere in packages/daemon/src EXCEPT a named, allowlisted
// site. docs/decisions/b8122303-*.md has the full mechanism this guard backstops: the shared
// `resolveExactTrailerObjectId` helper (git/worktrees.ts) is the ONE place a hex-shaped trailer value may
// be resolved before use, closing the "a 41-64-hex value can resolve as a REF NAME, not the literal
// object id" class c0d0eac9 round 7 found for `Loom-Worker-Base` and this card found again for
// `Loom-Landed-Tip`.
//
// WHAT IT COVERS: comment-stripped `src/**/*.ts` text, by OCCURRENCE (`String.matchAll`, never a per-line
// `.test()` — a per-line presence check still reads exactly 1 hit no matter how many real uses that one
// line carries, so it cannot see a SECOND raw use added to an already-allowlisted line) — six
// field-access/producer shapes: `trailers.base`/`trailers?.base`, `trailers.landedTip`/`trailers?.landedTip`,
// `trailers.pathSet`/`trailers?.pathSet` (matched WITHOUT requiring a leading `.` before `trailers`, since
// `scanMergedCommitMap`'s own bare `trailers` local variable reads these fields with no object prefix at
// all), `.baseSha` (matched WITH a leading `.`, since `baseSha` alone collides with several unrelated local
// variables elsewhere in this codebase — e.g. `computeStaleBase`'s own worktree-fork-point tracking — that
// have nothing to do with a trailer and would otherwise flood this guard with noise), a direct
// `parseLoomTrailerBlock(...)?.`/`tolerantFindLoomTrailerBlock(...)?.` chain onto `landedTip`/`base`/
// `pathSet` (the PRODUCER shape — a trailer field read straight off the parse call's own result, with no
// intermediate `trailers` identifier for the first four patterns to catch), and a `readLandedTipTrailer(`
// call (its own declaration counts as a site too — this guard cannot distinguish a declaration from a
// call by text alone, and allowlists it explicitly rather than pretending otherwise).
// WHAT IT DOES NOT COVER (stated, not implied): a trailer value reached through an ALIAS variable (e.g.
// `const t = candidate.trailers; use(t.base)` — this guard has no data-flow analysis and cannot see
// `t.base` as the SAME field `candidate.trailers.base` names); a SAME-FILE SWAP (removing one validated
// occurrence of a pattern and adding a DIFFERENT, unvalidated one elsewhere in the SAME file — the
// ALLOWLIST is keyed on [file, pattern name, count] only, with no line or site identity, so the total
// count is unchanged and this guard cannot tell the two apart; occurrence counting (above) closes a count
// INCREASE — a second use added to an existing site — never a same-count substitution); a future field
// name not among the six shapes above; whether a LISTED site actually validates correctly (that is what
// the behavioural tests — tolerant-loom-trailer-discovery.mjs, stale-generation-landedtip-content-check.mjs
// — exist to prove).
// This guard only proves NO UNLISTED FIELD-ACCESS SITE exists; it does not re-prove correctness of the
// listed ones, and every occurrence — whether it reaches git or not — must be named here with a reason,
// so a reviewer can tell at a glance which category it falls into.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./_strip-comments.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "..", "src");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

export const PATTERNS = [
  { name: "trailers.base", re: /\btrailers\??\.base\b/ },
  { name: "trailers.landedTip", re: /\btrailers\??\.landedTip\b/ },
  { name: "trailers.pathSet", re: /\btrailers\??\.pathSet\b/ },
  { name: ".baseSha", re: /\.baseSha\b/ },
  // The PRODUCER shape, card b8122303 Code Review (reviewer 201f0fa5): a trailer field read straight off
  // a parseLoomTrailerBlock/tolerantFindLoomTrailerBlock call's own result — never `.branch` (never used as
  // a git revision anywhere; excluded on purpose).
  { name: "trailer-parse-chain", re: /\b(?:parseLoomTrailerBlock|tolerantFindLoomTrailerBlock)\([^)]*\)\s*\?\.\s*(?:landedTip|base|pathSet)\b/ },
  { name: "readLandedTipTrailer(", re: /\breadLandedTipTrailer\(/ },
];

/** Every occurrence, by [file, pattern name, exact count, reason] — a stale entry (a count that no longer
 *  matches, in EITHER direction) fails exactly as loudly as a genuinely new, unlisted site. */
const ALLOWLIST = [
  ["git/worktrees.ts", "trailers.base", 3,
    "1 validated read (findLandedSquashCommit → verifyGoneBranchLanding → verifyPersistedPathSet → resolveExactTrailerObjectId) " +
    "+ 2 data-copies into a MergedMapEntry's own .baseSha field (scanMergedCommitMap) — never reach git THERE; " +
    "the resulting .baseSha is itself re-validated at ITS OWN read site below"],
  ["git/worktrees.ts", "trailers.pathSet", 3,
    "1 read into `pathSet`, passed only as verifyPersistedPathSet's expectedDigest — a STRING COMPARISON against a locally-computed digest, never a git argv — " +
    "+ 2 data-copies into a MergedMapEntry's own .pathSetDigest field (scanMergedCommitMap), same non-reaching shape"],
  ["git/worktrees.ts", ".baseSha", 2,
    "1 validated read (resolveMergedCommitMapHit → verifyGoneBranchLanding → verifyPersistedPathSet → resolveExactTrailerObjectId) " +
    "+ 1 UNRELATED namesake (computeStaleBase's own worktree-fork-point `info.baseSha`, from a real git merge-base call, never a trailer) — never reaches git either way"],
  ["git/worktrees.ts", "trailer-parse-chain", 1,
    "readLandedTipTrailer's own parse of a LANDING COMMIT's own Loom-Landed-Tip trailer — never attacker-controlled worker content (112b8d5d strips worker-authored subjects " +
    "before this trailer is ever stamped). Flows to sessions/service.ts's heldRecordedTip -> resolveOwedRange's `base`, which DOES reach resolveGitRef/isAncestorCommit without " +
    "this card's exact-match validation — judged NOT exploitable as the same ref-name forgery by this card's own Code Review (reviewer 201f0fa5); validating this producer is a " +
    "SEPARATE follow-up card, deliberately not fixed here. Allowlisted so this guard can see it, not because it is proven safe by this guard."],
  ["git/worktrees.ts", "readLandedTipTrailer(", 1, "the function's own declaration — this guard cannot distinguish a declaration from a call by text alone"],
  ["sessions/service.ts", "trailers.base", 1,
    "attributeStaleGenerationOwnLanding's eligibility gate only (decision c7dc99bf: never a value fed into any check) — never reaches git"],
  ["sessions/service.ts", "trailers.landedTip", 2,
    "1 truthy eligibility check + 1 validated read (verifyReviewedTipChain's own entry validation, resolveExactTrailerObjectId) — the site this card fixed"],
  ["sessions/service.ts", "readLandedTipTrailer(", 2,
    "heldRecordedTip's fallback read (flows to resolveOwedRange's `base`, same not-this-card's-scope flow as the worktrees.ts producer entry above) " +
    "+ pinnedTipForLandedSquash's read (flows to a finalize pin) — neither validated by this card; see the worktrees.ts producer entry's reason"],
  ["mcp/orchestration.ts", ".baseSha", 1,
    "UNRELATED namesake — worker_spawn's STALE BRANCH BASE advisory text (`worker.staleBase.baseSha`), a human-readable string interpolation, never a git argv"],
  ["sessions/worker-prompt.ts", ".baseSha", 1,
    "UNRELATED namesake — the same STALE BRANCH BASE advisory, rendered into a worker's own kickoff prompt text, never a git argv"],
];

/** Scan one file's text; returns [{name, line, text}] for every OCCURRENCE (not merely every matching
 *  line) of a pattern on comment-stripped text — a line with the SAME pattern twice yields two hits. */
export function scanText(text) {
  const hits = [];
  const lines = stripComments(text).split(/\r?\n/);
  lines.forEach((ln, i) => {
    for (const p of PATTERNS) {
      const re = new RegExp(p.re.source, "g");
      for (const m of ln.matchAll(re)) hits.push({ name: p.name, line: i + 1, text: ln.trim(), index: m.index });
    }
  });
  return hits;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

// ===================== (C) positive + negative controls — the scanner discriminates =====================
{
  check("(C) fires on a bare `candidate.trailers.base` use", scanText(`verify(candidate.trailers.base ?? undefined);`).some((h) => h.name === "trailers.base"));
  check("(C) fires on a bare-variable `trailers.landedTip` use (no object prefix)", scanText(`if (trailers.landedTip) { x(); }`).some((h) => h.name === "trailers.landedTip"));
  check("(C) fires on `hit.trailers.pathSet`", scanText(`const d = hit.trailers.pathSet;`).some((h) => h.name === "trailers.pathSet"));
  check("(C) fires on a NEW, unlisted raw git use: `git.raw([\"merge-base\", candidate.trailers.base, x])`", scanText(`git.raw(["merge-base", candidate.trailers.base, x]);`).some((h) => h.name === "trailers.base"));
  check("(C) fires on `.baseSha` member access", scanText(`use(hit.baseSha);`).some((h) => h.name === ".baseSha"));
  check("(C) fires on the optional-chaining form `trailers?.base`", scanText(`const b = trailers?.base;`).some((h) => h.name === "trailers.base"));
  check("(C) fires on the PRODUCER shape `parseLoomTrailerBlock(body)?.landedTip`", scanText(`return parseLoomTrailerBlock(body)?.landedTip ?? null;`).some((h) => h.name === "trailer-parse-chain"));
  check("(C) fires on the PRODUCER shape via tolerantFindLoomTrailerBlock(...)?.base", scanText(`const b = tolerantFindLoomTrailerBlock(msg)?.base;`).some((h) => h.name === "trailer-parse-chain"));
  check("(C) fires on a `readLandedTipTrailer(` call", scanText(`const t = await readLandedTipTrailer(repoPath, sha, deps);`).some((h) => h.name === "readLandedTipTrailer("));
  check("(C) NEGATIVE control: `parseLoomTrailerBlock(body)?.branch` does NOT fire the producer-chain pattern — `branch` is never a git revision",
    scanText(`const b = parseLoomTrailerBlock(body)?.branch;`).every((h) => h.name !== "trailer-parse-chain"));
  check("(C) NEGATIVE control: a bare `baseSha` LOCAL VARIABLE (no leading dot) does NOT fire — the unrelated-namesake false-positive this guard avoids",
    scanText(`const baseSha = (await git.raw(["merge-base", a, b])).trim();`).length === 0);
  check("(C) NEGATIVE control: a bogus/innocuous line returns 0 hits", scanText(`const x = compute(req.method, "GET");`).length === 0);
  check("(C) NEGATIVE control: a mention only in a COMMENT returns 0 hits (comment-stripped)",
    scanText(`// candidate.trailers.base and hit.baseSha are read here\nconst y = 1;`).length === 0);
  check("(C) NEGATIVE control: an unrelated field merely containing the substring does not false-fire (`.base` alone, `.trailersOther`)",
    scanText(`const b = x.base; const t = y.trailersOther; const p = z.pathSetOther;`).length === 0);
  check("(C) NAMED LIMIT: an ALIASED trailer object defeats this guard, by design — `const t = candidate.trailers; use(t.base)` is NOT seen as `trailers.base`",
    scanText(`const t = candidate.trailers; use(t.base);`).length === 0);

  // (C) NAMED LIMIT, round 3 (Lead review correction): a SAME-FILE SWAP — removing one validated
  // occurrence of a pattern and adding a DIFFERENT, unvalidated one elsewhere in the SAME file — keeps
  // the per-file-per-pattern COUNT unchanged, so the (S) corpus check below (keyed on [file, pattern
  // name, count] only, with no line or site identity) cannot tell the two variants apart. Occurrence
  // counting (below) closes a COUNT INCREASE on one line; it does not, and cannot without keying on line
  // identity (which would churn on every unrelated edit — deliberately not done), close a same-count
  // substitution elsewhere in the file.
  {
    const fileBeforeSwap = `function a() {\n  verify(candidate.trailers.base);\n}\nfunction b() {\n  const x = 1;\n}\n`;
    const fileAfterSwap = `function a() {\n  const x = 1;\n}\nfunction b() {\n  git.raw(["merge-base", candidate.trailers.base, y]);\n}\n`;
    const countBeforeSwap = scanText(fileBeforeSwap).filter((h) => h.name === "trailers.base").length;
    const countAfterSwap = scanText(fileAfterSwap).filter((h) => h.name === "trailers.base").length;
    check("(C) NAMED LIMIT: a validated occurrence removed from a() and a DIFFERENT, unvalidated one added to b() — the trailers.base COUNT is identical in both variants (1 and 1), so this guard cannot distinguish them",
      countBeforeSwap === 1 && countAfterSwap === 1 && countBeforeSwap === countAfterSwap);
  }

  // (C) OCCURRENCE COUNTING — the card's own Code Review finding (reviewer 201f0fa5): a per-line
  // presence check (`.test()`) cannot see a SECOND raw use on an already-allowlisted line.
  const doubledLine = `g(candidate.trailers.base, candidate.trailers.base);`; // one legit-shaped use, one NEW, unlisted use — SAME line
  const oldPerLineHitCount = PATTERNS.find((p) => p.name === "trailers.base").re.test(doubledLine) ? 1 : 0; // the OLD (pre-fix) presence-only behavior, reconstructed for contrast
  const newHits = scanText(doubledLine).filter((h) => h.name === "trailers.base");
  check("(C) REGRESSION PROOF: the OLD per-line `.test()` check reads this doubled line as exactly 1 hit (it would silently miss the second use)", oldPerLineHitCount === 1);
  check("(C) THE FIX: the new occurrence-counted scan reads the SAME line as 2 hits, not 1 — a second raw use on an allowlisted line now fails an exact-count check",
    newHits.length === 2);
}

// ===================== (S) the real corpus ================================================================
{
  const files = walk(SRC);
  check(`(S) corpus sanity: scanned a real tree (${files.length} src/**/*.ts files, expect > 100)`, files.length > 100);
  let total = 0;
  const offenders = [];
  const seen = new Map(); // key: `${rel}\u0000${patternName}` -> count
  for (const f of files) {
    const rel = path.relative(SRC, f).split(path.sep).join("/");
    const hits = scanText(fs.readFileSync(f, "utf8"));
    total += hits.length;
    for (const h of hits) {
      const entry = ALLOWLIST.find(([file, name]) => file === rel && name === h.name);
      if (!entry) { offenders.push(`${rel}:${h.line} [${h.name}] ${h.text.slice(0, 100)}`); continue; }
      const key = `${rel}\u0000${h.name}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  }
  check(`(S) the scan is non-vacuous (${total} raw hits across the corpus, all expected in the allowlist)`, total > 0);
  check(`(S) NO unlisted field-access site reaches git — every occurrence is a named, allowlisted site${offenders.length ? `\n      ${offenders.join("\n      ")}` : ""}`, offenders.length === 0);
  for (const [file, name, count, reason] of ALLOWLIST) {
    const key = `${file}\u0000${name}`;
    check(`(S) allowlist entry ${file} [${name}] matches EXACTLY ${count} occurrence(s) (stale entries fail either direction): ${reason.slice(0, 70)}…`, (seen.get(key) ?? 0) === count);
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — no unlisted field-access site reaches git"
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
