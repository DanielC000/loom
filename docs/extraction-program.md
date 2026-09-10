<!-- title: Extraction program — worker doctrine -->

# Extraction program — worker doctrine

This is the **worker's half** of the comment-extraction program: the operational doctrine for a
worker assigned ONE tranche (one source file, one branch, ~350-500 removed comment lines) that
moves Class-B decision-narrative comments out of source into `docs/adr/` or `docs/decisions/`,
leaving a `// @decision <id> — ...` anchor behind. It is self-contained for a worktree-bound
worker — nothing here requires reaching outside this repo checkout.

The class taxonomy itself (what counts as Class A/B/C/D, and the `docs/adr` vs `docs/decisions`
register split) is defined once, authoritatively, in `CLAUDE.md` § "Comment taxonomy — the
source-vs-record split" — read it there rather than trusting a restatement here. This doc adds
the operational rules, traps, and DoD that the taxonomy section doesn't cover: how to classify a
real block, how to key and place a record, the byte-cap ladder, and the checks that catch a lost
clause.

## Step 0: resolve prior tranches on your file

Multiple tranches land on the same file over time. Resolve what already happened **yourself**,
from git, never from a number quoted at you:

```
git log main --oneline --grep="<your file>, tranche"
```

**This is blind to a zero-yield tranche** — a tranche that correctly reports
`noChanges:true` (nothing to extract) makes no commit, so there's nothing here for it to find.
Also check the board (`tasks_list` with `titleContains: "<your file>, tranche"`,
`excludeDone: false` — a `done` card with `merged: null` is a zero-yield tranche) and project
memory for the file name. If a prior tranche was zero-yield and the file is unchanged since
(`git log --oneline --since="<that card's updatedAt>" main -- <file>` is empty), **STOP AND
REPORT** rather than re-classifying it.

**A card id and a short commit sha are the same shape — 8 lowercase hex — and nothing in the
string says which.** Writing one where the other belongs makes a reference silently dead-end (a
board card id is never a valid git object; a commit sha is never a board card). Before citing
either as a fact, check it: `git cat-file -t <hex>` is the one-command type check — decisive, and
cheap enough to run on every hex string you're about to write down or rely on.

## Classifying a block

- **Class A (guard/prohibition) stays inline forever**, compressed to ≤3 lines. Never relocate
  it — prose sitting AT the predicate is what has, more than once, stopped a "fix" from undoing a
  deliberate choice, or stopped a real defect from looking safe unreviewed.
- **Class B (decision record/incident narrative) moves out** to `docs/adr/` or `docs/decisions/`,
  keyed by an id, leaving an anchor.
- **Class C (contract/API docs) and Class D (restates the code)** are not this program's concern
  the way A/B are — leave C as-is; delete D outright.
- **Class A and B are routinely interleaved inside one block.** Read the whole block; split the
  one-line guard that stays from the narrative that goes. This is not mechanical — no automated
  split is safe here.
- **Ambiguous ⇒ leave it inline, and say so per block, with the reason.** A remainder of a third
  to two-thirds of a file's blocks, each individually justified, is the *correct* outcome, not a
  shortfall. **Measured class-B yield across five tranches: 4/18 · 5/15 · 7/15 · 9/19 · 12/15**
  (**14% · 24% · 29% · 44% · 72%** of blocks). Yield varies by *region within a file*, not by
  file identity — no prior tranche's ratio predicts the next one's, on the same file or a
  different one. Don't let an expected yield push a genuine narrative into staying inline, or a
  guard out of the source.

## The anchor grammar

```
// @decision <8hex card id> — <the prohibition or consequence, not a summary>
```

≤3 lines. **Keep `@decision <id>` on one line** (card `ad3a9a85`) — the lint reports a line break
inside the anchor as `brokenAnchors`.

**Never invent, guess, or mint an id you were not handed.** A block citing no id anywhere — not
in the block, not elsewhere in the file, not in `git blame`'s introducing commit — has exactly
two legal outcomes, no third:

- **(a)** leave it inline, and report it as id-less residue; or
- **(b)** the sha-keyed grammar (landed as commit `41336cdb`; verify it resolves with
  `git cat-file -t 41336cdb`):

```
// @decision sha:<8hex commit sha> — <the prohibition or consequence>
```

Source the sha off `git blame -L <range>` **at extraction time** — never guessed.

A resolvable sha isn't necessarily a useful one: if the block cites no id anywhere and `git
blame`'s introducing commit is itself a bulk move or reformat, it tells you nothing about the
decision, and outcome (a) — leaving the block inline — is still correct there, not a fallback
of last resort. See DoD item 9 for reporting a block that lands in this case.

The `sha:` sigil is *required* for the commit id-space; a bare 8-hex after `@decision`, with no
sigil, *always* means a board card. `git blame` hands back a full 40-hex — **truncate to 8**; the
lint flags a pasted 40-hex as `overlongAnchorIds`, but get it right rather than relying on that
net to catch it. Recommended: put a one-line `Source: commit <sha>, no board card` inside the
record body, so a human reader sees the namespace without parsing the anchor. The resolver
verifies the sha with `git rev-parse --verify` and refuses an anchor whose sha doesn't resolve in
this repo.

## One record file per id — mechanical, not stylistic

`packages/daemon/assets/decision-records.mjs`'s `resolveRecord()` resolves an id to **exactly
one file** and **silently drops every other file sharing that id — forever, with no error, and
with no way for a reader to notice.** (Read that function for the current store-precedence
order; it is exactly the kind of enumerable detail that drifts, so don't treat a restatement of
it here as current.)

⇒ **Before writing any record:** `find docs/adr docs/decisions docs/investigations -iname
"<id>*"`. If the id already has a file, your decision is a **new section in that file**, never a
second file. Never overwrite what's already there — another lane's landed work may be in it.
**Run this `find`, for every id, every time — including an id you personally minted a record for
earlier in this same session.** A block that re-cites an id you anchored twenty minutes ago is
exactly where a second record file gets created by accident; recency doesn't exempt it.

**"Every id, every time" covers a `sha:`-derived key exactly like a card id — and it is easy to
miss precisely because a `sha:` key is never grepped from the file's text up front.** A card id is
something you can gather into a pre-check set by reading the block; a `sha:` key is **derived at
write time**, via `git blame`, from a block that cites no id at all. A worker who pre-checks only
the card ids visible in the file's own text never adds that blame-derived sha to the set, so the
`find` silently never runs against it — the gap is in *when* the key exists, not in the rule.

**Why it matters: one commit can fix two files.** Commit `29b22e7e25de03c2c2dc51b4069160eb5453c112`
fixed both the `pty/host.ts` keystroke-confirmation bug and the `pty/claude-settings.ts` resume-gate
env thresholds — one commit, two files, two blocks. An earlier tranche had already recorded it from
the `host.ts` side as `docs/decisions/29b22e7e-….md`. A later `claude-settings.ts` worker blamed its
own id-less block, derived the same sha, and — having pre-checked only the card ids gathered from
its own file's text — wrote a second file for it. `collidingRecords` went **2→3**. The worker's own
DoD-5 lint caught it; it deleted the duplicate, folded the content in as a new section of the
existing record, repointed the anchor's `see` path, and the count returned to **2**.

⇒ **Run the same `find` for a `sha:` key too, at the moment you derive it from `git blame` — before
you write anything, exactly as for a card id.** The obligation is unconditional on *how* the key was
obtained; only the moment it enters the picture differs — a card id is checkable up front, a
blame-derived sha only exists once you've already read the id-less block.

**A `find` hit is not enough — read the returned path before concluding it's unrelated.** A
worker misread its own `find` output once, and that misreading is precisely how a duplicate
record got created.

That warning guards the collision hazard: don't create a second file for the same
decision. A related but distinct case is content duplication inside a file that already
exists: a card id can have sites in several source files, and an earlier tranche may
already have recorded the decision in full at one of them. Measured on one tranche:
roughly half the apparently-new content in three blocks was already captured under
the same ids by an earlier tranche on a different file, restated at the new site's own
derivation point — an avoidable append that is also a real byte-cap driver, not just
duplicate prose. When the existing record already says what you were about to write,
the correct outcome is usually to anchor the new site to it and edit nothing, not to
extend the record with a near-duplicate section.

When two genuinely unrelated decisions legitimately share one card id, append a clearly-labelled
section rather than create a second file: the heading names it *"(unrelated decision, same card
id, `<file>`)"* and carries its own `Source (this section only)` line stating it is **not** the
same decision as the section above it. Prefer appending *before* a trailing `## Source`.

**Worked precedent, copy the shape:** one tranche found card id `a0d912f5` already held an
unrelated decision, and restructured that file into `## Decision A` / `## Decision B`, with a
header line naming the `resolveRecord()` shadowing mechanism as the reason two decisions share
one id. At review, the restructure's only deletions were heading-level demotions — zero prose
was lost.

## The byte-cap ladder

The per-record byte cap lives in `packages/daemon/assets/decision-records.mjs`
(`PER_RECORD_MAX_BYTES`) — read it there; don't trust a number restated here. An over-cap record
still auto-injects on `Read`, but arrives **head+tail truncated**, with the middle elided.

**Ladder: reflow (always legal, mints no id) → split under a different legal key → else
explicitly accept, with a stated reason.** Never trade a truncation for a collision by minting a
new id just to dodge the cap. Never delete content to get under the cap.

**Rung 3 (explicit accept) is legal for exactly one of two cases — check which one you're in
before you reach for it:**

1. **The record was already over cap before your edit, and your edit doesn't extend it** (a
   reflow-only pass, or a brand-new record that can't fit even reflowed/split). Accepting costs
   nothing that was previously delivered in full — a reader already got a truncated view before
   your edit, and still gets one after it.
2. **The record was at-or-under cap before your edit, and your edit is what pushes it over.**
   Accepting here is not neutral: the truncation window is computed against the record's *new*,
   larger size, so the elided middle can land squarely inside content that predates your change —
   bytes that were delivered **in full on every injection** go dark because of an edit that had
   nothing to do with them.

**Extending an already-over-cap record — adding bytes at either its head or its tail — is not
case 1, however over cap it already was.** `truncateRecord` (`packages/daemon/assets/decision-records.mjs`)
keeps a fixed-size head window and a fixed-size tail window and elides the middle — read it there
for the split, don't restate it here. Growing the record moves both windows: prepending pushes old
head bytes into the elided middle, and appending pushes old tail bytes into it just as surely — so
previously-delivered content goes dark exactly as in case 2. Bytes landing strictly in the elided
middle are never delivered, so they don't help either.

**Rung 3 is closed to case 2, and to extending an already-over-cap record as above.** The correct
move in both is the ladder's own first two rungs (reflow, or split under a different legal key) —
and if neither fits, **leave your new content inline and say so in the report**, the same move an
earlier tranche already made for this exact record (specimen below). Extending an existing record
is not licence to accept an overage it didn't have before you touched it.

**The one-line check, before you write:** *was the record ≤ `PER_RECORD_MAX_BYTES` on main before
your edit? If yes, your edit must leave it ≤ the cap — reflow or split, not accept.*

### Measured specimen (case 2), re-derived from `truncateRecord`

One tranche extended a record from 5,704 → 7,857 bytes and accepted the overage, reasoning that a
visible elision marker means nothing is lost. **Re-derived here directly from `truncateRecord` in
`packages/daemon/assets/decision-records.mjs` (read there at extraction time — these offsets track
its current logic and the current `PER_RECORD_MAX_BYTES`, not a restated constant):**

- The marker `"\n\n… [elided — see full record] …\n\n"` is 34 characters, 3 of them (both `…` and
  the one `—`) 3 bytes each in UTF-8, the rest 1 byte ⇒ `markerBytes = 31 + 3×3 = 40`.
- `remaining = PER_RECORD_MAX_BYTES − markerBytes`; `headBudget = Math.ceil(remaining × 0.6)`;
  `tailBudget = remaining − headBudget`; the tail starts at `bufLength − tailBudget`.
- Run against a 7,857-byte buffer at the current `PER_RECORD_MAX_BYTES`, this keeps bytes
  **0–3,576** (head) and **5,473–7,857** (tail) and elides **3,576–5,473** — **1,897 bytes.**

The record was 5,704 bytes *before* this edit — under cap, so fully delivered on every prior
injection — and the elided window (3,576–5,473) falls entirely inside that pre-edit extent. **The
bytes that went dark are not the new content; they are content a reader received in full before
this edit and stopped receiving after it**, regardless of an accept note claiming otherwise.

⚠️ These exact offsets are tied to this record's exact size and the `PER_RECORD_MAX_BYTES` in
effect when computed — re-run the arithmetic against your own record and the live constant; don't
reuse these numbers for a different case.

**Measure the cap on the working tree, after writing:** `wc -c < <path>`. Never
`git show <ref>:<path> | wc -c` — CRLF-on-disk vs LF-in-object makes that read short by *exactly
the file's line count*, and only ever in the "I'm fine" direction. This is measured, twice,
independently, at different scales:

- On a 49-line record, a git-object read (`git show`) returned `5,943` bytes against a real
  on-disk size of `5,992` — short by 49, one per line.
- On a different record, a pre-write LF-only estimate of `5,973` bytes landed at `6,001` on disk
  after the CRLF write — 28 bytes for 28 lines, **1 byte over a cap the author believed was 27
  under.**

⇒ Never accept a pre-write estimate, and never accept a git-object read, as the cap check. `wc -c`
the file **on disk, after writing it.**

**The program itself generates over-cap records over time**, independent of any single worker's
mistake (measured, card `9856e639`): two existing records crossed the cap purely because separate,
concurrent tranches each folded a little more content into an already-anchored record. If you
extend an *existing* record rather than creating a new one, `wc -c` it **before and after** your
edit. If it was already over cap before you touched it, you're in case 1 above and the full ladder,
accept rung included, is open. If it was at-or-under cap before your edit and your edit is what
pushes it over, you're in **case 2** — reflow or split, never accept.

## A rewrite preserves the rule and drops the example — not hypothetical

This project's standing, measured hazard: rewriting a block to fit the record format keeps the
*rule* but drops the *specimen* that made the rule credible. On one tranche, the total character
count of a record actually **grew** while a specific incident clause **vanished** from it. On
another, a worker's own DoD verification pass caught **two clauses it had itself dropped** while
compressing a record to fit the byte cap, and restored them before reporting.

⇒ **Carry the concrete illustrations — the specimen, the command, the exact number — verbatim.**
A doctrine record that keeps every rule and loses the numbers behind them has failed at the one
thing it exists to do.

## Standard DoD for a tranche

1. **No code deleted.** Filter the diff's deleted lines for non-comment content ⇒ expect 0,
   checked against a positive control of the total deletion count (so the filter itself is shown
   capable of returning non-zero). Make the filter recognise `/* */` and JSDoc ` * ` prefixes, not
   just `//`.
2. **Content preserved.** Compare characters removed from source against characters landed in
   records.
3. **A character count cannot prove a specific clause survived — count a distinctive token from
   each touched region, branch-vs-main.** Normalize first (strip comment prefixes, join wrapped
   lines), then expect `base ≥ 1` and `record ≥ 1`. A non-zero branch-source count is *not*
   automatically a loss — a mixed split (guard compressed and stays inline, narrative moves to the
   record) legitimately leaves the same phrase in both; a measured specimen, the phrase
   `"structurally unable to fold"`, read `base=1 / branch=1 / record=1` and was correct as-is.
   Resolve any ambiguity by *line number*, never by count alone — `base=3 / branch=2 / record=1`
   is the correct shape when only one of three occurrences was inside the touched block. Any
   shape you can't explain: read the diff and explain it; don't "fix" it to match a pattern.
4. **Whole-branch loss check.** Take every distinctive token (`[a-z][a-z0-9_]{7,}`, plus 8-hex
   ids, minus stopwords) from the base source's comments; subtract those still present in the
   branch source; every remainder must appear in the branch's new/changed records. Anything in
   neither is a candidate loss to read by hand. Positive-control it — confirm genuinely-removed
   tokens *are* found in the records. Measured on two branches: 63 removed tokens ⇒ 2 candidates,
   27 removed ⇒ 3 candidates — both sets resolved on inspection to legitimate rewording, not loss.
   Its own false-positive mode: an ordinary English word dropped in a rewrite — check whether the
   *constraint* survived under different words before calling it a loss.
   **Scope this check to the files you actually touched, never to all of `docs/`.** Widening the
   "records" set to the whole corpus was tried once and correctly rejected as vacuous — a large
   enough pre-existing corpus makes almost any token "present" somewhere, so the check would pass
   unconditionally. Handle a token that resolves to a pre-existing, unrelated record as a
   separately-explained exception; never fold it into the automated pass condition.
5. **Lint before/after: `orphanAnchors` must not grow, *and* `collidingRecords` must not grow.**
   Checking only `orphanAnchors` is unsafe — a same-id sibling record satisfies "the id still
   resolves" while the other file sharing that id goes permanently dark, and `orphanAnchors` stays
   at 0 throughout. Also check `bareCommitAnchors` stays at 0 — a bare `@decision <id>` you sourced
   off `git blame`/`git log` needs the `sha:` sigil (card `a2fc4031`).
6. **Commit your changes first, then run `pnpm --filter @loom/daemon guards`.** `guards` is not
   `run_gate`. A `git add` short of a commit does not put your work through the diff-scoped core
   scan the merge gate itself re-runs — the guard list lives in `STATIC_GUARD_REPO_PATHS` in
   `packages/daemon/src/git/worktrees.ts`; read it there, it changes over time.
7. **EOL, for any new file you create:** `git check-attr text eol -- <path>` first, then compare
   CR vs LF byte counts against *that* pin. `docs/**` is `text=auto` ⇒ pass is `CR == LF`, not
   `CR == 0`. The `Write` tool lands bare LF and will fail this — one tranche hit exactly this on
   all 5 new files it created in one sitting — repair via commit → `git rm --cached <path>` →
   `git checkout HEAD -- <path>`. Use `Edit` for follow-up changes to the same file, never
   `sed -i` (it rewrites the whole file and flips every ending despite its name).
8. **State your own evidence tier on every claim you report: measured vs inferred vs
   estimated-from-sample.**
9. **Report the id-less residue explicitly:** how many blocks you left inline purely for lack of
   any id, how many you resolved with a `sha:` key, and for any block you still couldn't key, why
   `git blame` didn't produce a usable commit for it.

## Sizing a tranche

**Cost scales with distinct ids per block, not with line count.** A single long block can cite
several distinct ids at once (a re-citation of an id you anchored earlier in this same tranche,
plus several ids never seen before). Each distinct id needs its own read to decide whether it is
a genuinely separate decision, a second site on an id you already anchored this tranche, or a
second site on an id that belongs to a future tranche. One such block, on a real tranche,
contained roughly a dozen distinct ids and was correctly budgeted as an entire tranche's worth of
work on its own — don't measure your progress in lines when a block looks like this; measure it
in ids still to resolve. Stopping short of the nominal ~350-500 line target because you hit a
block like this is a success, not a shortfall — report it as such.

Re-measure your file's remaining unanchored-block count yourself before you start, rather than
trusting a figure quoted at you — main moves under every tranche, and the lint itself has changed
shape more than once during this program (an `overlongAnchorIds` field was added at commit
`7d31044c`, after which point a bare restated block count from an older card is no longer current):

```
node packages/daemon/assets/comment-anchor-lint.mjs .
```

(an asset, not under `scripts/`) — filter its `unanchoredLongBlocks.items` payload to your file.

**Card `01e09f28`** changed how blocks are grouped (splits at a doc-comment boundary, `*/`
immediately followed by a fresh `/**`/`/*`/`//`) — a count that moves against an older tranche's
own note, in *either* direction, is this change, not a regression or a broken lint; see card
`01e09f28`'s own findings and memory `comment-anchor-lint-measured-corpus` before assuming otherwise.

## File-specific doctrine — not in this document

Some clauses on individual extraction-tranche cards are deliberately narrow to the file that
tranche targets, and are **not** generalized here because doing so would tell a worker on an
unrelated file to expect something that isn't there:

- **`packages/daemon/src/pty/host.ts`** — the spawn/PTY host carries the highest concentration of
  load-bearing Class-A guards in the repo; expect a lower Class-B yield there than in a
  data-shape file, and don't let that expectation push a genuine narrative into staying inline.
- **`packages/daemon/src/orchestration/gate-runner.ts`** — this file runs the build/DoD gate
  itself; its comments are unusually likely to be Class-A guards about *ordering* and
  *fail-closed* behavior (step chains, timeout/extension arithmetic, retry classification). An
  ordered enforcement sequence's order is the guarantee — never compress one into prose, never
  relocate it. What's likely Class B there is the incident narrative *behind* such a guard, not
  the guard itself.
- **`packages/shared/src/types.ts`** — the shared contract package (Session FSM, the
  Project/Topic/Session/Task shapes) carries an unusually high proportion of Class C
  (`@param`/`@returns`-style contract docs on a field or type), which this program doesn't move —
  count it separately in your report so a low "moved" count isn't misread as low yield. A
  comment-only change to this package cannot break a build, but that needs proving, not asserting:
  run `pnpm build` (it builds `shared` first) and report the result — that is not `run_gate` and
  is not authorization to run the full test suite.

If your own assigned card carries a file-specific warning like these, it governs your tranche in
addition to everything above; this document is the cross-file floor, not a replacement for it.
