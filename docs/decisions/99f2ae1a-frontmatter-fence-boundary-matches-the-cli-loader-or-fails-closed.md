# 99f2ae1a — match the CLI loader's frontmatter fences or fail closed

From a CRITICAL trust-boundary finding by the `22813c50` Code Review (reviewer `5c3fede0`). Loom's skill
permission-widening detection (badge / refuse / strip / cwd scan / bundled-asset guard lint) shares ONE
set of frontmatter-fence patterns (`FRONTMATTER_OPEN_RE`/`FRONTMATTER_RE`, `skills/permissionWidening.ts`)
across every path. The installed CLI's own skill loader (`claude.exe` 2.1.317; `ud` → `cw` single-BOM
strip → `bk = /^---\s*\n([\s\S]*?)---\s*\n?/`) is WIDER than those patterns on BOTH fences, so a skill
could carry a LIVE `hooks:`/`allowed-tools:` grant to the real loader while reporting fully CLEAN on
every one of Loom's paths — the exact class of silent miss `712148f1`'s own per-form table was supposed
to rule out, but that table only ever covered forms WITHIN an already-agreed frontmatter block, never the
fence boundary itself.

## Re-verification (static read, version-pinned, no real spawn)

Re-ran the same byte-offset string-scan method `712148f1`/`9d01b4c1` used, against the SAME installed
binary (`C:\Users\danie\.local\bin\claude.exe`, `claude --version` → `2.1.317`):

- `function cw(e){return e.charCodeAt(0)===65279?e.slice(1):e}` at byte offset 289579472 — confirmed not
  redefined anywhere between there and its use.
- `var bk=/^---\s*\n([\s\S]*?)---\s*\n?/,P5=/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/;` right
  before `function ud`, at byte offset ~289664517 — byte-for-byte the `bk` this card's title names.
- `function ud(e,n,r){let s=e;e=cw(e);let h=e.indexOf("---",3)<0?null:e.match(bk);if(!h)return{...}` at
  byte offset 289664600 — confirms `cw` → `bk` is the real skill-frontmatter extraction path (the
  `indexOf("---",3)` is a fast-reject before the full match; it doesn't change `bk`'s own semantics).
- All three skill-loading call sites (byte offsets ≈295118945 / ≈296579715 / ≈296586923) call
  `ud(content, path, {normalizeKeys:true, ...})` with no `quoteLossyValues` — `P5` (much closer to Loom's
  own `FRONTMATTER_RE`) is NOT what the skill loader actually uses; only the permissive `bk` is. This
  independently re-confirms `712148f1`'s own hypothesis that `bk`, not `P5`, is what `ud` extracts from.

`bk`'s open-fence `\s*` is JS `\s`, which per the ECMA WhiteSpace production is inclusive of NBSP
(U+00A0), a vertical tab (U+000B), a repeated CR, and — distinct from the file-start BOM `cw` already
strips — a SECOND U+FEFF sitting right after the opening `---` (not at file start). `bk`'s close is a
lazy, UNANCHORED `([\s\S]*?)---` — no `\r?\n` required before it, so a closing `---` that doesn't start
its own line (e.g. embedded in a value like `description: x---`) is live to the real loader.

## Evasion fixtures — LIVE to the real loader, CLEAN to every Loom path before this fix

Built and ran each fixture against both a direct port of the real `cw`+`bk` logic and Loom's live
`permissionWidening.ts` exports, verbatim:

| Fixture | real-loader-live | loom-detects (before) |
|---|---|---|
| close mid-line: `"---\nname: a\nhooks:\n  Stop: []\ndescription: x---\nbody"` | true | `[]` |
| open NBSP: `"---\u00A0\nhooks:...\n---\nbody"` | true | `[]` |
| open repeated CR: `"---\r\r\nhooks:...\n---\nbody"` | true | `[]` |
| open second BOM: `"---\uFEFF\nhooks:...\n---\nbody"` | true | `[]` |
| open vertical tab: `"---\u000B\nhooks:...\n---\nbody"` | true | `[]` |
| control (plain): `"---\nhooks:...\n---\nbody"` | true | `["hooks"]` (sanity check) |

Traced every consumer: `detectPermissionWidening` (badge, refuse, strip, cwd scan all route through it)
and the bundled-asset guard lint's own byte-identical text-copy of the open-fence tolerance — confirmed
blind on all of them, by construction. For an ordinary small `SKILL.md` (under the cwd scan's 4096-byte
read cap), `frontmatterReadIncomplete`'s own secondary "incomplete" signal also does not fire for any of
these — fully, silently clean across the board.

## Design decision: FAIL CLOSED, never align `FRONTMATTER_OPEN_RE`/`FRONTMATTER_RE` to `bk`

Manager-approved (gen, 2026-11-04), exactly as proposed at the investigate-first checkpoint:

1. `REAL_LOADER_FENCE_RE` (`skills/permissionWidening.ts`) — a literal port of `bk`, used ONLY to ask
   "does the real loader see a live frontmatter block here, and with what body". Never a replacement for
   `FRONTMATTER_OPEN_RE`/`FRONTMATTER_RE`.
2. `frontmatterFenceUnrecognized(content)` — true when `REAL_LOADER_FENCE_RE` matches but Loom's own
   `FRONTMATTER_RE` either misses entirely or captures a DIFFERENT body. Self-splits one leading BOM
   internally (same discipline as `frontmatterUnrecognizedSyntax`/`detectPermissionWidening` — card
   `9d01b4c1` round 2), so `detectPermissionWidening` passes it the ORIGINAL `content`, never the
   already-split `body`.
3. A new `frontmatter-fence-unrecognized` vector (`SkillPermissionVector`, `@loom/shared`), folded into
   `detectPermissionWidening` exactly like `frontmatter-unrecognized` is. Because `permissionWideningRefusalError`/
   `stripPermissionWidening`/the cwd scan/the badge field already key off "is the vector array non-empty"
   (or, for the scan, `isScannedPermissionField`'s EXCLUDE shape), this one addition reaches every path at
   once — no further per-path code change needed beyond the exhaustive `Record<SkillPermissionVector,...>`/
   `Record<SkillPermissionField,...>` labels the type system already forces.
4. `stripPermissionWidening` checks `frontmatterFenceUnrecognized` at the SAME early position
   `frontmatterUnrecognizedSyntax` already occupies — before the `stripFrontmatterKeys`/`stripShellTriggers`
   fixpoint loop ever runs — and withholds (`return null`) immediately. No attempt is ever made to
   surgically rewrite a fence shape only the real loader's lazier/wider semantics agree is live.

**Why fail-closed over aligning the regexes themselves:** `bk`'s lazy, unanchored close means a frontmatter
VALUE merely containing the substring `---` becomes the closing fence to the real loader, so its own
captured body can end mid-line with no trailing newline; its open `\s*` can also legitimately swallow
embedded blank lines. `stripFrontmatterKeys`'s line-based reconstruction
(`` `---${eol}${kept.join(eol)}${eol}---` ``) and `topLevelFrontmatterKeys`'s `block.split(/\r?\n/)` both
assume a clean, line-oriented capture — widening `FRONTMATTER_RE` itself to `bk`'s own shape would hand
those functions a body that may not end on a line boundary, with no proof that rewriting it is safe.
Fail-closed avoids that risk: the existing line-oriented logic only ever runs on content BOTH regexes
already agree is a plain, boring block.

## Accepted over-match: a value containing a literal `---`

A frontmatter VALUE that itself contains `---` (e.g. `"---\nname: a---b\nhooks: y\n---\nbody"`) makes the
real loader truncate ITS OWN parse at the embedded dashes — the `hooks:` line past it was never actually
live to the real loader either. Loom's own line-oriented `FRONTMATTER_RE` correctly continues past the
embedded `---` to the TRUE closing fence, so the two captures disagree and `frontmatterFenceUnrecognized`
fires, withholding the file. This is the accepted, safe-direction outcome (same `87a51903` "a lookalike
costs a sentence, a miss costs the whole point" posture, now extended to the fence boundary) even though
the content wasn't actually hazardous to the real loader — Loom cannot tell that from the fence shape
alone, and withholding is cheap. Measured: zero shipped `packages/daemon/assets/skills/**/SKILL.md` file
raises this vector (enumerated, not hand-listed — see the test list below).

## Test list

- `packages/daemon/test/skill-permission-widening-detector.mjs` — the five evasion fixtures, each
  RED-before/GREEN-after via `pnpm --filter @loom/daemon negative-control --ref 8851cf97` (the real
  pre-fix commit — this card's parent — never `HEAD`, which moves as later rounds land on top of it),
  reverting `packages/shared/src/types.ts` + the three touched `skills/*.ts` files together. **That
  full-file revert is a STRUCTURAL proof only** (lesson 298's own category: the new function/export is
  simply ABSENT, so the RED proves nothing about the new LOGIC specifically — a mutant that broke the
  logic while keeping the API would pass it vacuously). The actual BEHAVIOURAL proof is the dedicated
  mutant-isolation fixture + the two direct `frontmatterFenceUnrecognized` unit checks: an API-keeping
  mutant (`frontmatterFenceUnrecognized` present but forced to always return `false`) turns those RED
  while the structural revert's own RED stays uninformative either way. Also: the accepted
  value-contains-`---` over-match, the round-2 false-positive (a) fixtures (blank/whitespace-only line
  after the open — CRLF and LF, plus a control proving it doesn't mask a genuine disagreement further
  in), and a false-positive control enumerating every bundled `SKILL.md` under
  `packages/daemon/assets/skills/**` (found 15, zero raise the new vector).
- `packages/daemon/test/skill-permission-guard.mjs` (PART F) — the same fixtures through
  `permissionWideningRefusalError` (refuses) and `stripPermissionWidening` (withholds, idempotently), plus
  a negative control that an ordinary boring `hooks:` fence still strips.
- `packages/daemon/test/skill-permission-frontmatter-scan.mjs` (PART 1d) — the same fixtures through
  `scanCwdSkillsForPermissionFrontmatter`, plus a negative control and a check that none trips truncation
  or `incomplete`.
- `packages/daemon/test/skill-permission-widening-guard.mjs` — the guard-lint's own text-copy
  `REAL_LOADER_FENCE_RE`/`frontmatterFenceUnrecognized`, folded into `scanContent`, with the same positive/
  negative/accepted-over-match fixtures as self-tests, plus the real scan over every bundled skill.
- `packages/daemon/test/skill-permission-widening-lockstep.mjs` — `REAL_LOADER_FENCE_RE` added to the
  regex-literal-constant lockstep pairs (bare equality), plus a NEW differential check (same shape as the
  existing `frontmatterUnrecognizedSyntax` one) extracting the guard's own `frontmatterFenceUnrecognized`
  source verbatim and running it side by side with the real module's export over a shared fixture corpus.
- `packages/daemon/test/skills-inject-permission-strip.mjs` (PART (q), round 2 item 2) — a REAL,
  non-fault-injected withhold isolating `frontmatter-fence-unrecognized` as the fixture's ONLY vector
  (no hooks/allowed-tools label, no frontmatter-unrecognized), through the real `injectSkills` delivery
  path. Before this fixture existed, an API-keeping mutant forcing `frontmatterFenceUnrecognized` to
  always return `false` left this entire file green — the delivery path's own withhold of a fence
  disagreement had only ever been proven at the unit/detector level, never end-to-end.
- `packages/daemon/test/skill-permission-scan-createpty-wiring.mjs` — re-run as a regression spot-check
  (no new fixture needed — unrelated to this card's own vector).

## Round 2 (Code Review of commit `15347451`, reviewer `8dc2be14`)

**MAJOR (item 1) — the cwd scan silently missed an evasion OPEN fence past the 4096-byte read cap.**
`---<NBSP>\n…hooks:…description: <padding>\n---` (and the other four open-fence evasions), with its
closing fence past `PERMISSION_SCAN_MAX_READ_BYTES`, returned `findings:[]` AND `truncated:[]` — a
silent miss with NO signal anywhere. Root cause: `frontmatterFenceUnrecognized` found no close within
the truncated head (nothing to disagree about — correctly so), and `frontmatterReadIncomplete` never saw
the evasion OPEN at all (gated on `FRONTMATTER_OPEN_RE` alone). Fixed by widening `frontmatterReadIncomplete`
itself: `opened` is now `FRONTMATTER_OPEN_RE.test(body) || REAL_LOADER_FENCE_OPEN_RE.test(body)`, and
`closed` is now `FRONTMATTER_RE.test(body) || REAL_LOADER_FENCE_RE.test(body)` (widening BOTH halves
symmetrically — widening only `opened` would make every small, fully-read evasion-open file read as
"incomplete" too, even though `frontmatterFenceUnrecognized` already flags those correctly as a real
finding). `REAL_LOADER_FENCE_OPEN_RE` (the open half of `bk`, authored as its own primary regex,
`REAL_LOADER_FENCE_RE` now BUILT FROM it — same `FRONTMATTER_OPEN_RE`/`FRONTMATTER_RE` relationship
card `712148f1` round 2 NIT 6 already established) is exported for this.

**Named residual:** this fix restores PARITY with the scan's existing, already-accepted disclosure
mechanism for a plain-open oversized frontmatter (card `015fdb23`'s own `truncated: "readBytes"`
design) — it does **not** add detection past the cap. An evasion-open frontmatter whose HAZARD KEY
itself (not just its closing fence) sits entirely past the 4096-byte read cap is still genuinely
undetected by `detectPermissionWidening` — exactly as a plain-open huge frontmatter already was before
this card. The fix's whole effect is making that miss DISCLOSED (`truncated:"readBytes"`, named) rather
than silent, for the evasion-open case too, never closing the underlying bounded-read tradeoff itself.

**Item 2 — the delivery path's withhold of a fence disagreement was never proven end-to-end.** See the
new `skills-inject-permission-strip.mjs` PART (q) in the test list above.

**Item 4 — the guard-lint's own `frontmatterFenceUnrecognized` copy never split a leading BOM.** The
real module's export self-splits (card 9d01b4c1 round 2's discipline); the guard's hand-mirrored copy
did not, so it disagreed with the real module on a file-start-BOM-plus-evasion fixture. Fixed by adding
the guard's own `BOM`/`splitLeadingBom` text copies (it never imports the real module, per its own
header) and calling `splitLeadingBom` first inside its `frontmatterFenceUnrecognized`, mirroring the real
module exactly. `skill-permission-widening-lockstep.mjs`'s differential extraction now also pulls
`splitLeadingBom`'s source into the rebuilt closure, and a file-start-BOM fixture was added to its corpus.

**Item 5 — false positive (a): a blank/whitespace-only line directly after the opening fence.** `bk`'s
own `\s*` open tolerance swallows such a line whole (the capture starts at the first real content), while
`FRONTMATTER_OPEN_RE` only ever consumes ONE line terminator, leaving that line as a LEADING part of
`FRONTMATTER_RE`'s own capture — the two bodies disagreed even though both readers parse the IDENTICAL
YAML (a leading blank/whitespace line changes nothing structurally). This was a genuine false positive,
not an accepted one like the value-contains-`---` case: withholding a skill over it would have been
wrong. Fixed with `stripLeadingBlankLines` (`/^(?:[ \t]*\r?\n)+/`), applied to BOTH bodies before
comparing, in both the real module and the guard-lint's text copy. A `hooks:`/`allowed-tools:` key
hidden behind such a line is still correctly found by the ordinary per-line scan either way — only the
fence-disagreement vector stops firing; a dedicated fixture (LF, CRLF, and a whitespace-only-not-blank
variant) proves this, plus a control proving the strip never masks a genuine disagreement further into
the block.

Both MAJOR (item 1) and item 5 were proven with `pnpm --filter @loom/daemon negative-control --ref
8851cf97` (the real pre-fix commit, this card's own parent — never `HEAD`, which moves) PLUS a dedicated
API-keeping mutant for each (`frontmatterReadIncomplete`'s widening reverted for item 1;
`stripLeadingBlankLines` made a no-op for item 5) — each mutant turned exactly its own round-2 fixtures
RED while leaving every other fixture green, then was reverted and the tree reconfirmed clean.

## Do not

- Do not widen `FRONTMATTER_OPEN_RE`/`FRONTMATTER_RE` themselves to match `bk`'s own fence tolerance —
  see "Design decision" above for why the strip side's line-oriented logic isn't proven safe against it.
- Do not "fix" the value-contains-`---` over-match — it is an accepted, safe-direction residual (see
  "Accepted over-match" above), not a bug; a dedicated test fixture documents it so it is never mistaken
  for a regression later.
- Do not pre-split a leading BOM before calling `frontmatterFenceUnrecognized` — it self-splits exactly
  one leading BOM internally, same discipline as `frontmatterUnrecognizedSyntax`; a caller-side pre-split
  on top would double-strip a double-BOM input (card `9d01b4c1` round 2's own invariant, now extended).
- Do not let `skill-permission-widening-guard.mjs`'s own text copy of `REAL_LOADER_FENCE_RE`/
  `frontmatterFenceUnrecognized` drift from `permissionWidening.ts`'s real exports — widen both together,
  and let `skill-permission-widening-lockstep.mjs`'s differential check prove they still agree.
- Do not widen only the `opened` half of `frontmatterReadIncomplete` without also widening `closed` (round
  2, MAJOR) — that would make every small, fully-read evasion-open file report incomplete too, duplicating
  what `frontmatterFenceUnrecognized` already correctly flags as a real finding.
- Do not treat round 2's MAJOR fix as closing the bounded-read tradeoff itself — see "Named residual"
  above; it only makes an evasion-open miss past the cap DISCLOSED, the same as a plain-open one already
  was, never detected.
- Do not let the guard-lint's own `BOM`/`splitLeadingBom`/`stripLeadingBlankLines` text copies (round 2,
  items 4/5) drift from `permissionWidening.ts`'s real ones — widen both together, in lockstep.
- Do not cite `HEAD` as the pre-fix ref for this card's own negative-control proofs — `HEAD` moves as
  later rounds land on top of it; cite the real pre-fix commit (`8851cf97`, this card's own parent).
- Do not re-verify any claim in this record by trusting it against a NEWER installed CLI build — re-run
  the same static byte-offset method against whatever `claude --version` reports, and update this record
  if anything has changed.
