# 6d16606e — decision-record injection cost, re-measured post-guard-only (`27ee9f43`): findings

Worker measurement, 2026-09-21. **This is a MEASUREMENT card — no production code was changed.** `filesChanged` for this task is this document alone (plus its throwaway harness, embedded below as an appendix rather than committed as tracked source, since nothing here needs to ship). Levers #2 (`BLOCK_EXPAND_MAX`) and #3 (a per-call record count cap) were **not** implemented — this card only measures. Do not raise `PER_RECORD_MAX_BYTES` or `TOTAL_MAX_BYTES`; nothing here proposes that either.

**Supersedes the cost-only figures of** `C:\Users\danie\.loom\research\decision-record-net-token-measurement-2026-09-12.md` (the "09-12 note", referenced throughout below), whose own injection-cost measurement predates `27ee9f43` ("perf(assets): inject only a record's Do-not section and a pointer", 2026-09-12T11:20:53Z) by ~10 hours and therefore measured the superseded whole-record-injection mechanism. That note's §3 saving-side figures and §5/§6 rationale are **not** superseded and are carried forward unchanged (see "What was NOT remeasured" below).

## Method — matched to the 09-12 note's own stated method, deviations called out explicitly

The 09-12 note's method (§4, verbatim): *"random sample of 150 of the 1,583 current anchor sites, one fresh session per read (no dedupe), 50-line window centred on each anchor."* I matched this shape:

- **Anchor-site population**, re-derived fresh against `main` today (not taken from the card body's stated 1,583→1,757, which was itself a few hours stale by the time I ran this): walked `packages/daemon/{src,assets,scripts}`, `packages/web/src`, `packages/shared/src` (`.ts`/`.tsx`/`.mjs`, excluding `node_modules`/`dist`/`.turbo`/`coverage`/`test`/`tests`/`e2e`/`.git`) — the **exact `SOURCE_ROOTS`/`SOURCE_EXTENSIONS`/`EXCLUDE_SEGMENTS`** `comment-anchor-lint.mjs` already uses as this project's own established anchor-corpus definition, rather than inventing a second one. Found **332 files, 1,829 anchor sites** (occurrences of `ANCHOR_RE`, not deduped by id). This is higher than both the 09-12 note's 1,583 and the card body's same-day 1,757 — expected corpus growth under continuous editing across a day, not a discrepancy to chase down.
- **Sample:** 150 anchor sites drawn without replacement, seeded RNG (mulberry32, seed `20260921`) for reproducibility.
- **Window:** `offset = max(1, anchorLine − 24)`, `limit = 50` — a 50-line window centred on the anchor line (24 before, the anchor line, 25 after). The 09-12 note doesn't spell out its own exact centring formula; this is a direct, ordinary reading of "centred," flagged as an assumption since I can't byte-for-byte confirm theirs.
- **Invocation:** `decision-records.mjs` invoked directly as a subprocess (not a live `claude` session) with a synthetic `PostToolUse` payload on stdin — same as the 09-12 note's own "direct invocation of the hook, not observation of a live session" (§2). One fresh random `session_id` (hence a fresh, empty dedupe file) per read for the 150-sample; a single shared session id + dedupe dir for the 30-read session simulation (§4 below).
- **Harness verified against controls before trusting any result** (per this project's own verification posture): a no-anchor-file read returns 0 bytes (negative control); a known anchor site returns non-zero, well-formed output (positive control); the same anchor read twice under one session id returns content the first time and **exactly 0 bytes the second** (dedupe control) — confirming the one 0-byte entry that shows up in the session simulation below is genuine dedupe, not a harness bug.

## Per-read cost — directly comparable to the 09-12 note's §4 table

| | 09-12 note (whole-record, superseded) | this measurement (guard-only, current) |
|---|---|---|
| injected on | 150 of 150 (100%) | **150 of 150 (100%)** |
| median | 9,956 B (~2,489 tok) | **2,987 B (~747 tok)** |
| mean | 9,168 B (~2,292 tok) | **3,562.6 B (~891 tok)** |
| max | 12,819 B (~3,205 tok) | **11,943 B (~2,986 tok)** |

**Median cost dropped ~3.33×; mean dropped ~2.57×.** The guard-only change (lever #1) delivered a real, large reduction — but not as large as the 09-12 note's own back-of-envelope guess ("median record is ~3.5 KB; a Do-not block is a few hundred [bytes]," §5) implied. The actual Do-not-only payload is a few hundred bytes **per record**, but most reads land on **more than one** record at once (see distribution below), so the per-read total stays in the low thousands, not the low hundreds.

## DoD-3 — is per-call cost still governed by `TOTAL_MAX_BYTES`, or by the records themselves?

**Answer: it depends which read population you're asking about — and the 09-12 note's own methodology (the 50-line targeted window) only samples the population where the answer flipped.**

**For the 50-line-window population the baseline methodology samples (and that dominates ordinary scoped agent reads): the cap is no longer the governor.**
- **0 of 150** random samples hit the cap (no omission, partial or total) — 0%, versus the 09-12 note's implicit ~100% (it stated the observed max, 12,819 B, "is that cap plus envelope," i.e. was routinely saturating it).
- I additionally built a **positive control**: I scanned the *entire* 1,829-site corpus (not just the 150-sample) for the single densest 50-line anchor window that exists anywhere today, to make sure "0/150" wasn't just an artifact of a sample that missed the worst case. It's `packages/daemon/src/deploy-staleness.ts:41-90` (anchor at line 65), with **13 distinct candidate record ids** in-window — the most crowded 50-line window in the whole corpus. Even that produced only **9,341 B**, still under the 12,000 B cap. **The cap is not reachable by any 50-line targeted read in today's corpus, not merely absent from this particular random sample.**
- **Records-injected-per-call distribution** (150-sample): `{1: 32, 2: 32, 3: 28, 4: 18, 5: 9, 6: 14, 7: 4, 8: 5, 9: 5, 10: 2, 12: 1}` — most calls inject 1–3 records; a long tail runs up to 12 in one call (still well under budget at Do-not-section sizes).

**For a different, real scenario the 50-line methodology doesn't sample — a default (no offset/limit, up to 2000-line) `Read` of a very anchor-dense file — the cap still binds hard.** I tested the two busiest files in the corpus directly (`sessions/service.ts`, 544 anchor sites; `pty/host.ts`, 351 anchor sites):

| file | anchor sites in file | records injected | records omitted for budget | total bytes |
|---|---|---|---|---|
| `sessions/service.ts` | 544 | 12 | **32** | 14,863 B |
| `pty/host.ts` | 351 | 14 | **24** | 14,079 B |

63–73% of the candidate records were omitted whole in each case. **So the honest answer to DoD-3 is bimodal, not a single verdict**: governed by the records themselves for a targeted read (the common case, and the one the comparable baseline measures), still governed by the cap for a default whole-file read into an anchor-hot file (a real but narrower case). This is worth naming precisely because "is the cap still the governor" was asked as if it had one answer — it doesn't, and collapsing it to one would misdescribe half the picture either way.

## Session simulation — one session id, dedupe active, same 30 sampled sites in sampled order

Mirrors the 09-12 note's own §4 session-simulation table (its more granular one, which subtracts the saving — see the note on the note's own two slightly different headline/table figures, below):

| reads | injected on | cost | reading saving (carried forward, see below) | net |
|---|---|---|---|---|
| 10 | 10 | 32,271 B (~8,068 tok) | 1,490 B | **+30,781 B (~7,695 tok)** |
| 20 | 19 | 68,439 B (~17,110 tok) | 2,980 B | **+65,459 B (~16,365 tok)** |
| 30 | 29 | 99,687 B (~24,922 tok) | 4,470 B | **+95,217 B (~23,804 tok)** |

09-12 note's own §4 table, for comparison:

| reads | injected on | cost | reading saving | net |
|---|---|---|---|---|
| 10 | 10 | 95,917 B (~23,979 tok) | 1,490 B | +94,427 B |
| 20 | 20 | 180,811 B (~45,202 tok) | 2,980 B | +177,831 B |
| 30 | 26 | 233,917 B (~58,479 tok) | 4,470 B | +229,447 B |

**Net cost at 10 reads is ~3.07× lower (30,781 vs 94,427 B); at 30 reads ~2.41× lower (95,217 vs 229,447 B).** Dedupe caught only 1 of 30 reads in my simulation versus 4 of 30 in the note's — plausible, not alarming: my 30 reads are drawn from a repo-wide random sample (low id-overlap between reads by construction), while the note's own read order isn't fully specified and may have been more clustered. Flagged as a methodology difference, not a re-derivable discrepancy.

**A small inconsistency in the 09-12 note itself, worth naming rather than quietly inheriting:** its §1 headline table labels the SAME figures (95,917 / 233,917 B) as **"net"**, while its own §4 table — the one that actually subtracts the saving — computes net as 94,427 / 229,447 B. The gap is small (saving is under 2% of cost either way) and doesn't change any conclusion, but it's a real instance of a scoped number (cost) getting re-labelled as the broader one (net) between two tables in the same document. This note keeps the two columns separate throughout rather than repeating that collapse.

**Headline, matching the 09-12 note's own form:** injection cost is now **≈20–24× the leaner-source saving** (median-cost / saving: 2,987/149 ≈ 20.0; mean-cost / saving: 3,562.6/149 ≈ 23.9), down from the note's measured **≈60–70×**. Break-even would now need ~20 reads per distinct record injected (down from ~67) — a real, roughly 3× improvement, but **still nowhere close to break-even** for an ordinary session.

## What was NOT remeasured, and why that's a defensible (if conservative) choice

**The reading-saving side (~149 B per 50-line read, and its 10/20/30-read multiples) is carried forward from the 09-12 note UNCHANGED, not remeasured.** That figure comes from the note's own §3 "identical scanner" comment/code density measurement, which is orthogonal to what `27ee9f43` actually changed — `27ee9f43` only touches what gets **injected** on a hit; it does not touch what extraction has removed from source. Re-deriving §3's figure would need the same corpus-density scanner the 09-12 note used, which is out of this card's scope (a cost-side re-measurement card, not a saving-side one).

**This choice likely makes my net-cost figures slightly conservative (an overstatement), not an understatement:** the record count has kept growing since 09-12 (857→948 per the card body, 936 by this project's `comment-anchor-lint.mjs` today, likely from continuing "extract decision prose" work), which means *more* narrative has plausibly left the source since 09-12 than the 149 B/read figure reflects — so the *true* current per-read saving is probably somewhat higher than 149 B, which would make the true net cost somewhat *lower* than what's reported here. I did not verify this directly; it's stated as a bound, not a claim.

## Bounds carried forward from the 09-12 note (per its own §2, unchanged and load-bearing here too)

- **Tokens are bytes ÷ 4, not tokenizer counts.** Every "tok" figure above is a magnitude estimate, not a precise count.
- **The session simulation reads exclusively at anchor sites — the worst case.** Real sessions also read unanchored regions, where the hook costs 0 bytes. **So every session-level figure above is an upper bound on cost, never an expected value.**
- **Nothing here measures whether agents behave better or worse** with the reduced injection. Still unmeasured, same as the 09-12 note said.

## What this does and does not mean

✅ **Lever #1 (`27ee9f43`, guard-only injection) worked as designed and materially cut the cost** — median per-read cost down ~3.33×, session-level net cost down ~2.4–3.1× — without reopening the truncation problem the whole convention exists to solve (title + every Do-not section still injects in full, per `abd049da`/`8449a258`).

⛔ **It does not close the gap.** The net is still a large loss by the same metric the 09-12 note used (~20–24× the saving, not break-even), and — per DoD-3 — the reason has shifted from "we always hit the cap" to "records legitimately co-occur densely enough that even their reduced Do-not-only form adds up," for the common targeted-read case. For the narrower default-whole-file-read-into-a-hot-file case, the cap is still the binding constraint and still drops most candidates.

📌 **Two observations for a possible future card (not proposed or scoped here — measuring, not deciding):** lever #2 (narrowing `BLOCK_EXPAND_MAX`) would have limited value against the population this note's methodology samples, since the cap is essentially unreachable there already — the cost there comes from genuine record co-occurrence, not the 40-line block-expansion widening the window artificially. It would plausibly still help the default-whole-file-read tail case, where the cap does bind. Lever #3 (a per-call record-count cap) is a separate, orthogonal question from either of those. Whether either is worth doing is exactly the judgement `a475f698` (the parent card) owns, on a real number now available for the first time.

## Appendix — harness (throwaway, not committed as tracked source)

Reproducibility only; deliberately not added under `packages/daemon/test` or `scripts` — this is a one-off measurement script, not a maintained check, and this card's own scope is measurement, not new tooling.

```js
// measure.mjs <repoRoot> <outDir> — see method section above for the exact corpus/sample/window params.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const repoRoot = process.argv[2];
const SOURCE_ROOTS = [
  ["packages", "daemon", "src"], ["packages", "daemon", "assets"], ["packages", "daemon", "scripts"],
  ["packages", "web", "src"], ["packages", "shared", "src"],
];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mjs"]);
const EXCLUDE_SEGMENTS = new Set(["node_modules", "dist", ".turbo", "coverage", "test", "tests", "e2e", ".git"]);
const ANCHOR_RE = /@decision\s+(?:sha:([0-9a-f]{8})|([0-9a-f]{8}))\b/gi;

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (EXCLUDE_SEGMENTS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && SOURCE_EXTENSIONS.has(path.extname(e.name))) out.push(full);
  }
}
const files = [];
for (const parts of SOURCE_ROOTS) walk(path.join(repoRoot, ...parts), files);

const anchorSites = [];
for (const f of files) {
  let lines;
  try { lines = fs.readFileSync(f, "utf8").split(/\r?\n/); } catch { continue; }
  lines.forEach((line, i) => {
    ANCHOR_RE.lastIndex = 0;
    let m;
    while ((m = ANCHOR_RE.exec(line))) anchorSites.push({ file: f, line: i + 1 });
  });
}

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20260921);
function sampleWithoutReplacement(arr, n) {
  const pool = arr.slice();
  const out = [];
  for (let i = 0; i < n && pool.length; i++) {
    const idx = Math.floor(rng() * pool.length);
    out.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return out;
}
const sample = sampleWithoutReplacement(anchorSites, 150);

const hookPath = path.join(repoRoot, "packages", "daemon", "assets", "decision-records.mjs");
function invokeHook(filePath, offset, limit, sessionId, dedupeDir) {
  const payload = JSON.stringify({
    tool_name: "Read", tool_input: { file_path: filePath, offset, limit }, session_id: sessionId, cwd: repoRoot,
  });
  let out;
  try {
    out = execFileSync("node", [hookPath, dedupeDir], { input: payload, encoding: "utf8", cwd: repoRoot, timeout: 15000 });
  } catch (e) { return { error: String(e), bytes: 0, injected: false }; }
  if (!out || !out.trim()) return { bytes: 0, injected: false };
  const parsed = JSON.parse(out);
  const ctx = parsed?.hookSpecificOutput?.additionalContext;
  if (typeof ctx !== "string") return { bytes: 0, injected: false };
  const bytes = Buffer.byteLength(ctx, "utf8");
  const recordCount = (ctx.match(/^### decision /gm) || []).length;
  const capHit = /further record\(s\) omitted for byte budget|too large to inject/.test(ctx);
  return { bytes, injected: true, recordCount, capHit };
}

// PHASE 1: per-read, one fresh session per read, no dedupe.
const freshDedupeDir = path.join(os.tmpdir(), "decrec-fresh-" + Date.now());
fs.mkdirSync(freshDedupeDir, { recursive: true });
const perRead = sample.map((site) => {
  const offset = Math.max(1, site.line - 24), limit = 50;
  return { ...site, offset, limit, ...invokeHook(site.file, offset, limit, crypto.randomUUID(), freshDedupeDir) };
});

// PHASE 2: session simulation, one session id, dedupe active, first 30 of the same sample.
const simDedupeDir = path.join(os.tmpdir(), "decrec-sim-" + Date.now());
fs.mkdirSync(simDedupeDir, { recursive: true });
const simSessionId = crypto.randomUUID();
const simReads = sample.slice(0, 30).map((site) => {
  const offset = Math.max(1, site.line - 24), limit = 50;
  return { ...site, ...invokeHook(site.file, offset, limit, simSessionId, simDedupeDir) };
});

console.log(JSON.stringify({ perRead, simReads }, null, 2));
```
