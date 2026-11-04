# 9d01b4c1 — one shared BOM-split helper for both skill permission-widening paths
From the 712148f1 Code Review round 3 (reviewer 3d46b491, 2026-11-03), carded `9d01b4c1`.
The cwd `.claude/skills` permission scan (`skills/permission-scan.ts`'s `scanCwdSkillsForPermissionFrontmatter`)
called `detectPermissionWidening`/`frontmatterReadIncomplete` directly on the raw bytes `readHead` returns.
`skills/permissionGuard.ts`'s refuse (`permissionWideningRefusalError`) and strip (`stripPermissionWidening`)
paths already split off a leading UTF-8 BOM (U+FEFF) first, via a local `splitLeadingBom` helper, because
every pattern in `permissionWidening.ts` (`FRONTMATTER_OPEN_RE`'s `^---` foremost) is anchored at the
literal start of the string. A BOM-prefixed `hooks:`/`allowed-tools:` (or unrecognized-syntax) skill
therefore produced zero scan findings while the refuse path would have caught the identical content —
a two-path asymmetry, not a both-paths blind spot.
Card 22813c50 (item 5, "N2") separately investigates whether Claude Code's own loader honours a BOM-led
SKILL.md at all — that question stays open and unrelated to this fix. This card closes only the
asymmetry: once a BOM is confirmed present, the scan and the refuse/strip path must agree on it, exactly
as they already must on frontmatter shape and every other detected vector.
## Fix
`splitLeadingBom` (plus the `BOM` constant) moved from `skills/permissionGuard.ts` into
`skills/permissionWidening.ts` — the one module both `permission-scan.ts` and `permissionGuard.ts` already
import from — and is exported from there. `permissionGuard.ts` now imports it instead of defining its own
copy. `scanCwdSkillsForPermissionFrontmatter` calls it on `head.content` before calling
`frontmatterReadIncomplete`/`detectPermissionWidening`, exactly mirroring `stripPermissionWidening`'s own
`splitLeadingBom(content).body` call.
## Round 2 (from the 712148f1 CR round 3's own follow-on, carded `9d01b4c1` round 2)
Round 1 (above) fixed the asymmetry at two call sites (`permission-scan.ts`, `permissionGuard.ts`) by
having each one call `splitLeadingBom` BEFORE handing content to the detector — but left a THIRD
raw-content path unfixed: `permissionWideningField` (`permissionWidening.ts` — the response field shared
by `listSkills()`/`store.ts` and the gateway's single-skill REST read, `GET /api/skills/:name`) calls
`detectPermissionWidening` on content neither of those two callers ever splits. A BOM-prefixed hooks skill
therefore showed no permission badge in the Skills UI even though the cwd scan and the refuse/strip path
both already caught it.

The fix moved the invariant OFF every call site and INTO the shared detector itself: `detectPermissionWidening`,
`frontmatterReadIncomplete`, and `frontmatterUnrecognizedSyntax` (`permissionWidening.ts`) now each call
`splitLeadingBom` internally, first thing, before doing anything else. No caller — today's three, or a
future fourth — can forget to split first, because there is no "first" left for a caller to remember:
the split happens inside the function being called. `permission-scan.ts` and `permissionGuard.ts` still
split BEFORE calling too (round 1's fix, left in place) — redundant now, but harmless, since splitting an
already-BOM-free body is a no-op.

## Round 3 (card 22813c50) — the round-2 "same answer either way" claim was FALSE for a double BOM, plus the real loader's own BOM behaviour

Round 2's own "Do not" below said passing split-or-unsplit content to the three self-splitting functions
"get[s] the same correct answer either way." **That is false whenever the original content carries TWO OR
MORE leading BOMs.** A caller that pre-splits ONE BOM itself, then hands the (still one-BOM-prefixed)
result to a function that splits ANOTHER internally, has now stripped TWO BOMs for that one call — while
handing the SAME caller the original, unsplit content only ever strips ONE (the function's own internal
split). For a double-BOM `hooks:`/`allowed-tools:`/unrecognized-syntax skill this is the difference
between "detected" (two strips → a clean `^---` reaches the real frontmatter) and "not detected" (one
strip → a leftover BOM still blocks it).

This exact asymmetry existed in FOUR places at once: `permissionGuard.ts`'s `permissionWideningRefusalError`
and `stripPermissionWidening` (both pre-split before calling a self-splitting function), `permission-scan.ts`'s
`scanCwdSkillsForPermissionFrontmatter` (same shape), and — found during this card's own implementation,
not by the originating CR — `permissionWidening.ts`'s OWN `detectPermissionWidening`, whose
`frontmatterUnrecognizedSyntax(body)` call fed its own pre-split `body` into a function that splits
again, while its sibling `topLevelFrontmatterKeys(body)`/`flowMappingFrontmatterKeys(body)` calls (which
never self-split) saw only the one strip — an inconsistency WITHIN a single call to the shared detector,
not merely a cross-caller one.

**Fix:** dropped the redundant pre-split at all four sites. Each now passes the ORIGINAL, unsplit content
to whichever self-splitting function it calls, so every path strips exactly one leading BOM, never two.
`stripPermissionWidening` still calls `splitLeadingBom` once, for its own two legitimate, non-detection
reasons — learning `hasBom` (to re-prepend onto a successful strip result) and feeding `body` to
`stripFrontmatterKeys`/`stripShellTriggers`, neither of which self-splits — but its own
`detectPermissionWidening`/`frontmatterUnrecognizedSyntax` calls now pass `content`, not `body`.

**Why one strip is the right answer, not a compromise:** a static byte-offset scan of the installed
`claude.exe` (2.1.317 — same binary and method as decision record `712148f1`) found the real frontmatter
reader's own BOM-handling helper: `function cw(e){return e.charCodeAt(0)===65279?e.slice(1):e}` (65279 =
`0xFEFF`), called before the `bk`/`P5` frontmatter-boundary regexes `712148f1` already identified, in the
same module that recognizes `hooks`/`skills`/`agents`/`commands` frontmatter and validates a skill's
`name`/`description` length. It is a single `charCodeAt` check, not a loop — it strips exactly ONE leading
BOM, never more. A double-BOM `SKILL.md` therefore has NO live frontmatter to the real loader either (the
leftover second BOM blocks its own `^---` test), so Loom's single-strip posture is loader-consistent, not
merely "safe by over-caution." UTF-16 BOM needed no separate handling: the only check found is for the
UTF-8 BOM codepoint, and both Loom (`fs.readFileSync(file,"utf8")`) and this real path assume UTF-8-ish
decoding, under which a genuinely UTF-16-encoded file's real bytes garble into U+FFFD + NULs rather than
a clean BOM or `---` — already covered as ordinary "unparseable, no frontmatter" on both sides.
Version-pinned like `712148f1`'s own findings — re-verify after a CLI upgrade, don't trust this scan's
conclusions against a newer build.

See also card `12bb342b` (open, unrelated question: whether `P5` or `bk` is the form that actually FEEDS
the real parse, vs. merely driving an "ambiguous closing ---" warning) — this round's scan corroborates
that `bk` (the lenient, no-EOL-required closer `712148f1` already found) is what the frontmatter-reading
function (`ud`, using `e.match(bk)`) actually extracts from, with `P5` used only in a separate
`quoteLossyValues` ambiguity check nearby — consistent with that card's own hypothesis that Loom's
EOL-less `FRONTMATTER_RE` (mirroring `bk`) already agrees with the loader. Not independently re-verified
to that card's own standard; noted there as a pointer, not a substitute for its own investigation.

## Do not
- Do not hand-roll a second BOM-split helper at a call site — `permissionWidening.ts`'s `splitLeadingBom`
  is the one shared helper; both `permissionGuard.ts` and `permission-scan.ts` import it.
- Do not add a new raw-content call to `detectPermissionWidening`/`frontmatterReadIncomplete`/
  `frontmatterUnrecognizedSyntax` expecting it to need its OWN pre-split — the split happens inside the
  function being called, for exactly this reason.
- ⛔ **RETRACTED (round 3): do NOT trust round 2's "a caller may pass either split or unsplit content...
  and get the same correct answer either way" as a general rule.** It is true only when the original
  content carries AT MOST one leading BOM. A caller that ALSO pre-splits before calling one of these three
  functions double-strips a double-BOM input — see "Round 3" above for the fix (drop the caller-side
  pre-split; call these three with the ORIGINAL content, never a value already run through
  `splitLeadingBom` yourself).
- Do not read `splitLeadingBom` living in `permissionWidening.ts` as that module now stripping or
  rewriting anything — decision record `87a51903`'s "read-only detector" rule is unchanged; this helper
  only separates a BOM from the body so every existing detector keeps scanning from the real start of the
  frontmatter, it rejects nothing itself.
- Do not make `splitLeadingBom` strip more than one leading BOM (recursively or otherwise) to "fully fix"
  the double-BOM case — round 3's static-scan finding is that the real loader strips exactly one too.
  **Correction (card 99f2ae1a): the original wording here said this would make Loom "MORE permissive
  than the loader" — backwards.** Stripping a SECOND BOM would make Loom reach a clean `^---` and treat
  the content as LIVE frontmatter; the real loader's own single strip leaves its leftover BOM blocking
  that same `^---` test, so it treats the identical content as INERT. Widening the strip would make Loom
  MORE STRICT than the loader — flagging/refusing/withholding a file the real loader never actually
  honours as frontmatter at all — not more permissive and not more consistent with it either way.
- Do not re-verify the loader finding above by trusting this scan's conclusions against a NEWER installed
  CLI build — re-run the same static byte-offset method (see `712148f1`'s "Method" section) and update
  this record if anything has changed.
